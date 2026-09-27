#!/usr/bin/env python3
"""harvest_uscis_sitemap.py — propose high-value uscis.gov pages to ground.

Milestone 1.5a (docs/ingestion/USCIS-TIER1-GROUNDING-PLAN.md): harvest the
uscis.gov sitemap, rank candidate pages by value signals, and emit a
human-review list of URLs to add to
backend/config/official_reference_sources.default.json (doc_kind=official_reference,
Tier-1 gov grounding into DS-1).

SAFETY: 100% read-only. It makes plain GET requests to the public uscis.gov
sitemap only, reads the local config to EXCLUDE already-grounded URLs, and
writes a local candidate file (or stdout). It imports nothing from the backend,
touches no GCP resource (no datastore / GCS / BigQuery / Firestore), and
publishes nothing. Nothing here is scheduled or deployed — it's a curation aid.
Candidates are PROPOSED only; a human reviews + fetchability-verifies (via
backend/scripts/seed_official_reference.py) before any URL is added to the config.

Usage:
  python scripts/curation/harvest_uscis_sitemap.py                      # top 40 to stdout (table)
  python scripts/curation/harvest_uscis_sitemap.py --limit 100 --out uscis_candidates.csv
  python scripts/curation/harvest_uscis_sitemap.py --format json --out uscis_candidates.json
  python scripts/curation/harvest_uscis_sitemap.py --demand-file top_missed_terms.csv
  python scripts/curation/harvest_uscis_sitemap.py --min-score 3 --include-pdf

`--demand-file` is an optional CSV of "term[,weight]" per line (e.g. exported
top-asked / gov-tier-miss terms from our query log); URLs whose slug matches a
term get boosted. Everything else works with no credentials and no GCP access.
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

import requests

_UA = {"User-Agent": "meridianjourney-grounding-bot/1.0"}
_SM_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
_DEFAULT_SITEMAP = "https://www.uscis.gov/sitemap.xml"
_DEFAULT_CONFIG = (
    Path(__file__).resolve().parents[2]
    / "backend" / "config" / "official_reference_sources.default.json"
)

# --- value signals -----------------------------------------------------------
# Section (first path segment) → base weight. Immigration-operational areas we
# want grounded rank highest; chrome/about/careers rank at/below zero.
_SECTION_WEIGHTS = {
    "green-card": 5, "family": 5, "working-in-the-united-states": 5,
    "humanitarian": 4, "citizenship": 4, "adoption": 3, "military": 3,
    "forms": 3, "i-9-central": 2, "scams-fraud-and-misconduct": 1,
    "tools": 1, "records": 1, "laws-and-policy": 3, "policy-manual": 4,
}
# Keyword hits anywhere in the path → additive boosts.
_KEYWORD_WEIGHTS = [
    (re.compile(r"/[ing]-\d{1,4}(?:[a-z]?)(?:$|/)", re.I), 5, "form page"),   # /i-765, /n-400, /g-28
    (re.compile(r"adjustment-of-status", re.I), 3, "AOS"),
    (re.compile(r"priority-date|visa-availability|visa-bulletin", re.I), 3, "priority dates"),
    (re.compile(r"employment-authorization|\bead\b", re.I), 3, "EAD"),
    (re.compile(r"naturaliz|citizenship", re.I), 3, "naturalization"),
    (re.compile(r"green-card-eligibility|how-to-apply", re.I), 3, "GC eligibility/how-to"),
    (re.compile(r"asylum|refugee|tps|parole|humanitarian", re.I), 3, "humanitarian"),
    (re.compile(r"students?-and-employment|f-1|m-1|stem|opt\b", re.I), 3, "students"),
    (re.compile(r"h-1b|h1b|l-1|o-1|permanent-workers|temporary-workers", re.I), 3, "workers"),
    (re.compile(r"processing-times|case-status|check", re.I), 2, "case ops"),
    (re.compile(r"fee|g-1055", re.I), 2, "fees"),
]
# Path substrings that disqualify a URL (news is handled by the gov_news RSS
# path; the rest is chrome / non-authoritative-reference).
_EXCLUDE = re.compile(
    r"/(newsroom|news|archive|about-us|careers|about|outreach|e-verify|i-9-central/resources|"
    r"contactcenter|forms/filing-fees|multilingual-resources|es|zh-hans|tools/uscis-tools-and-resources)"
    r"(?:/|$)", re.I,
)
# uscis.gov's sitemap includes hundreds of ARCHIVED monthly snapshots whose slug
# is a descriptive base slug + "-<n>" (e.g. .../when-to-file-...-based-104) —
# stale duplicates of a base page. Match a multi-token slug ending in "-<n>", so
# we DON'T mis-flag bare form codes like "i-765" / "n-400" (single-hyphen). Drop
# archives by default (keep the canonical base); --include-archives keeps them.
_ARCHIVE_SUFFIX = re.compile(r"-[^-]+-\d+$")


def _fetch(url: str, timeout: int = 25) -> bytes:
    r = requests.get(url, headers=_UA, timeout=timeout)
    r.raise_for_status()
    return r.content


def _iter_sitemap(url: str, max_sitemaps: int, seen: set) -> list:
    """Return [(loc, lastmod)] from a sitemap or sitemap index (recurses into
    child sitemaps, capped by --max-sitemaps)."""
    out: list = []
    try:
        root = ET.fromstring(_fetch(url))
    except Exception as e:  # noqa: BLE001 - report and continue
        print(f"  ! could not parse sitemap {url}: {type(e).__name__}: {e}", file=sys.stderr)
        return out
    tag = root.tag.replace(_SM_NS, "")
    if tag == "sitemapindex":
        child_urls = [s.findtext(f"{_SM_NS}loc") for s in root.findall(f"{_SM_NS}sitemap")]
        for child in [c for c in child_urls if c][:max_sitemaps]:
            if child in seen:
                continue
            seen.add(child)
            out.extend(_iter_sitemap(child, max_sitemaps, seen))
    else:  # urlset
        for u in root.findall(f"{_SM_NS}url"):
            loc = u.findtext(f"{_SM_NS}loc")
            if loc:
                out.append((loc.strip(), (u.findtext(f"{_SM_NS}lastmod") or "").strip()))
    return out


def _load_existing(config_path: Path) -> set:
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
        rows = data.get("sources") if isinstance(data, dict) else data
        return {(s.get("url") or "").rstrip("/") for s in (rows or [])}
    except Exception:  # noqa: BLE001 - missing config just means nothing excluded
        return set()


def _load_demand(path: str) -> list:
    """CSV of 'term[,weight]' per line → [(compiled_regex, weight, label)]."""
    boosts = []
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split(",")]
            term = parts[0]
            weight = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 3
            if term:
                boosts.append((re.compile(re.escape(term).replace(r"\ ", "[-/ ]"), re.I),
                               weight, f"demand:{term}"))
    except FileNotFoundError:
        print(f"  ! demand file not found: {path}", file=sys.stderr)
    return boosts


def _score(url: str, lastmod: str, demand: list) -> tuple:
    """Return (score, reasons[]) for a candidate URL."""
    path = urlparse(url).path
    section = path.strip("/").split("/", 1)[0] if path.strip("/") else ""
    reasons, score = [], 0
    if section in _SECTION_WEIGHTS:
        score += _SECTION_WEIGHTS[section]
        reasons.append(f"section:{section}(+{_SECTION_WEIGHTS[section]})")
    for rx, w, label in _KEYWORD_WEIGHTS + demand:
        if rx.search(path):
            score += w
            reasons.append(f"{label}(+{w})")
    if lastmod[:4].isdigit() and lastmod[:4] >= "2025":  # recently updated → minor boost
        score += 1
        reasons.append("recent(+1)")
    # Shallow, topical pages are more likely to be a clean reference page.
    depth = len([p for p in path.split("/") if p])
    if depth > 4:
        score -= 1
        reasons.append("deep(-1)")
    return score, reasons


def _title_from(url: str) -> str:
    slug = urlparse(url).path.rstrip("/").split("/")[-1] or "uscis"
    return slug.replace("-", " ").title()


def main() -> None:
    ap = argparse.ArgumentParser(description="Propose high-value uscis.gov pages to ground (read-only).")
    ap.add_argument("--sitemap-url", default=_DEFAULT_SITEMAP)
    ap.add_argument("--config", default=str(_DEFAULT_CONFIG), help="official_reference config to exclude already-grounded URLs")
    ap.add_argument("--demand-file", default="", help="optional CSV of top-asked/miss terms to boost")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--min-score", type=int, default=3)
    ap.add_argument("--max-sitemaps", type=int, default=50, help="cap child sitemaps fetched from an index")
    ap.add_argument("--include-pdf", action="store_true")
    ap.add_argument("--include-archives", action="store_true", help="keep archived '-<n>' snapshot pages (default: drop)")
    ap.add_argument("--format", choices=["table", "csv", "json"], default="table")
    ap.add_argument("--out", default="", help="write full ranked output here (default: stdout)")
    args = ap.parse_args()

    existing = _load_existing(Path(args.config))
    demand = _load_demand(args.demand_file) if args.demand_file else []

    print(f"Harvesting sitemap: {args.sitemap_url}", file=sys.stderr)
    pairs = _iter_sitemap(args.sitemap_url, args.max_sitemaps, set())
    print(f"  {len(pairs)} URLs in sitemap(s); {len(existing)} already in config", file=sys.stderr)

    seen, candidates = set(), []
    for loc, lastmod in pairs:
        host = urlparse(loc).netloc.lower()
        if not host.endswith("uscis.gov"):
            continue
        norm = loc.rstrip("/")
        if norm in seen or norm in existing:
            continue
        if _EXCLUDE.search(urlparse(loc).path):
            continue
        if not args.include_pdf and loc.lower().endswith(".pdf"):
            continue
        last_seg = urlparse(loc).path.rstrip("/").split("/")[-1]
        if not args.include_archives and _ARCHIVE_SUFFIX.search(last_seg):
            continue  # archived monthly snapshot (-0/-10/-104…) — keep the canonical base only
        seen.add(norm)
        score, reasons = _score(loc, lastmod, demand)
        if score < args.min_score:
            continue
        candidates.append({
            "score": score, "url": loc,
            "section": urlparse(loc).path.strip("/").split("/", 1)[0],
            "lastmod": lastmod, "suggested_source_system": "uscis",
            "suggested_title": _title_from(loc), "reasons": "; ".join(reasons),
        })

    candidates.sort(key=lambda c: (-c["score"], c["url"]))
    ranked = candidates[: args.limit] if args.limit else candidates
    print(f"  {len(candidates)} candidates ≥ score {args.min_score}; showing {len(ranked)}", file=sys.stderr)

    fields = ["score", "url", "section", "lastmod", "suggested_source_system", "suggested_title", "reasons"]
    out = open(args.out, "w", encoding="utf-8", newline="") if args.out else sys.stdout
    try:
        if args.format == "json":
            json.dump(ranked, out, indent=2)
            out.write("\n")
        elif args.format == "csv":
            w = csv.DictWriter(out, fieldnames=fields)
            w.writeheader()
            w.writerows(ranked)
        else:  # table
            for c in ranked:
                out.write(f"{c['score']:>3}  {c['url']}\n       {c['lastmod'] or '(no lastmod)'} · {c['reasons']}\n")
    finally:
        if args.out:
            out.close()
            print(f"  wrote {len(ranked)} candidates → {args.out}", file=sys.stderr)

    print("\nNEXT: human-review these, then fetchability-verify each keeper with\n"
          "  python backend/scripts/seed_official_reference.py --url <URL> --source-system uscis --title \"…\"\n"
          "and add survivors to backend/config/official_reference_sources.default.json.", file=sys.stderr)


if __name__ == "__main__":
    main()
