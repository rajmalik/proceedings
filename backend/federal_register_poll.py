"""
federal_register_poll.py — Federal Register (federalregister.gov JSON API)
adapter for the gov-news pipeline. Design: docs/ingestion/FEDERAL-REGISTER-GROUNDING-PLAN.md.

Dispatched from gov_news_poll.poll_source() for a `news_sources` entry with
fetch_method="federalregister_api" — so it rides the existing daily
`gov-news-poll-uscis` Cloud Scheduler job, endpoint and secret (zero net-new
GCP resources). Publishes through posting.publish_gov_news_item() as
doc_kind="gov_news", i.e. straight into the assist gov tier.

Immigration-only (plan §4), all deterministic — no LLM in the filter:
  L1  two server-side selectors (union by document_number):
        R: RULE/PRORULE whose CFR references hit the allowlist (8 CFR; 20 CFR
           655/656; 22 CFR 40-42)
        N: NOTICE from USCIS / ICE / EOIR (CBP excluded — customs/trade)
  L2  Paperwork-Reduction/admin exclusion over `action + title`
  L3  title denylist + CFR-part denylist (8 CFR port-designation housekeeping)
  L4  must carry >=1 immigration signal (allowlisted CFR, agency, keyword)

Incremental (plan §5): FR documents are immutable once published (a
correction / final rule / delay is a NEW document_number), so a stateless
rolling window (`lookback_days`) + the already-ingested id set from BigQuery
is sufficient. A known id is skipped BEFORE any full-text fetch, Gemini tag
call, or GCS/Discovery Engine/BigQuery write. The only re-publish of a known
doc is explicit: marking a proposed rule SUPERSEDED when its final rule
(same RIN) is ingested (plan §6.3).

CLI (read-only dry run — never publishes, never touches Firestore):
  cd backend && ../.venv/bin/python federal_register_poll.py --since 2024-09-27 [--show 3]
"""

from __future__ import annotations

import html
import json
import os
import re
import time
from datetime import date, timedelta
from pathlib import Path

import requests

_CONFIG_PATH = os.getenv(
    "FEDERAL_REGISTER_SELECTORS_PATH",
    str(Path(__file__).resolve().parent / "config" / "federal_register_selectors.json"),
)
_UA = {"User-Agent": "meridianjourney-grounding-bot/1.0"}
_FIELDS = [
    "document_number", "type", "title", "action", "abstract", "dates",
    "publication_date", "effective_on", "comments_close_on", "agencies",
    "cfr_references", "regulation_id_numbers", "docket_ids", "citation",
    "correction_of", "html_url", "pdf_url", "raw_text_url",
]

# The registry entry this adapter expects (for the dry-run CLI, and the exact
# values to register at go-live — see plan §9). NOT written anywhere by code.
DEFAULT_SOURCE = {
    "display_name": "Federal Register",
    "site_url": "https://www.federalregister.gov",
    "fetch_method": "federalregister_api",
    "feed_url": "https://www.federalregister.gov/api/v1/documents.json",
    "source_category": "government",
    "content_license": "public_domain",
    "content_type": "news",
    "channel": "gov_news",
}

_FILTER_REASONS = ("filtered_pra", "filtered_title_deny", "filtered_cfr_deny", "filtered_no_signal")
# A "Rule"-type doc only supersedes a proposal when it is actually a final
# rule — not a comment-period extension, delay, correction or withdrawal
# that happens to share the RIN.
_FINAL_ACTION = re.compile(r"final rule", re.I)
_NOT_FINAL_ACTION = re.compile(r"extension|delay|correction|comment period|withdraw", re.I)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config(path: str = _CONFIG_PATH) -> dict:
    """Load + validate the selector config. Raises ValueError on anything
    malformed — the caller turns that into a skipped source, never a crash
    (and never a silently-unfiltered run: there is no permissive fallback)."""
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for key in ("api_base", "rule_selectors", "notice_agencies", "exclude_pattern",
                "title_deny_pattern", "immigration_keyword_pattern"):
        if not cfg.get(key):
            raise ValueError(f"federal-register config missing {key!r}")
    for sel in cfg["rule_selectors"]:
        if not isinstance(sel.get("cfr_title"), int):
            raise ValueError(f"rule selector needs an int cfr_title: {sel}")
    cfg["_exclude_re"] = re.compile(cfg["exclude_pattern"], re.I)
    cfg["_title_deny_re"] = re.compile(cfg["title_deny_pattern"], re.I)
    cfg["_keyword_re"] = re.compile(cfg["immigration_keyword_pattern"], re.I)
    cfg["_cfr_deny"] = {(int(d["title"]), str(d["part"])) for d in cfg.get("cfr_deny", [])}
    cfg.setdefault("lookback_days", 21)
    cfg.setdefault("max_publish_per_run", 25)
    cfg.setdefault("digest_max_words", 2500)
    cfg.setdefault("excerpt_max_words", 1800)
    return cfg


# ---------------------------------------------------------------------------
# HTTP (module-level so tests can stub them — no network in the CI gate)
# ---------------------------------------------------------------------------

def _get_json(url: str, params: dict) -> dict:
    r = requests.get(url, params=params, headers=_UA, timeout=60)
    r.raise_for_status()
    return r.json()


def _get_text(url: str) -> str:
    r = requests.get(url, headers=_UA, timeout=60)
    r.raise_for_status()
    return r.text


def _paged(cfg: dict, params: dict) -> list[dict]:
    out: list[dict] = []
    page = 1
    while True:
        data = _get_json(f"{cfg['api_base']}/documents.json",
                         {**params, "per_page": 1000, "page": page, "order": "oldest", "fields[]": _FIELDS})
        out.extend(data.get("results") or [])
        if not data.get("next_page_url") or page >= 20:  # hard stop: never loop on a bad API
            return out
        page += 1


def fetch_candidates(cfg: dict, since: str) -> dict[str, dict]:
    """L1: run the rule + notice selectors, union by document_number."""
    docs: dict[str, dict] = {}
    date_cond = {"conditions[publication_date][gte]": since}
    for sel in cfg["rule_selectors"]:
        params = {**date_cond, "conditions[type][]": ["RULE", "PRORULE"],
                  "conditions[cfr][title]": sel["cfr_title"]}
        if sel.get("cfr_part"):
            params["conditions[cfr][part]"] = sel["cfr_part"]
        for d in _paged(cfg, params):
            docs.setdefault(d["document_number"], d)
    notice_params = {**date_cond, "conditions[type][]": ["NOTICE"],
                     "conditions[agencies][]": list(cfg["notice_agencies"])}
    for d in _paged(cfg, notice_params):
        docs.setdefault(d["document_number"], d)
    return docs


# ---------------------------------------------------------------------------
# Filter (L2-L4) — pure
# ---------------------------------------------------------------------------

def _allowlist(cfg: dict) -> tuple[set[int], set[tuple[int, str]]]:
    whole = {s["cfr_title"] for s in cfg["rule_selectors"] if not s.get("cfr_part")}
    parts = {(s["cfr_title"], str(s["cfr_part"])) for s in cfg["rule_selectors"] if s.get("cfr_part")}
    return whole, parts


def _cfr_refs(doc: dict) -> list[tuple[int, str]]:
    refs = []
    for r in doc.get("cfr_references") or []:
        try:
            refs.append((int(r.get("title")), str(r.get("part") or "")))
        except (TypeError, ValueError):
            continue
    return refs


def classify(doc: dict, cfg: dict) -> tuple[bool, str]:
    """(keep, reason). reason is "kept" or one of _FILTER_REASONS."""
    title = doc.get("title") or ""
    # L2 applies to NOTICES only: PRA/Privacy-Act/meeting items are always
    # notices (all 130 dropped in the 24-month dry run were), while a real rule
    # can legitimately say "Meeting ..." or "Collection of Information ..." in
    # its title — never silently drop a rule on those words.
    if doc.get("type") == "Notice" and cfg["_exclude_re"].search(f"{doc.get('action') or ''} {title}"):
        return False, "filtered_pra"
    if cfg["_title_deny_re"].search(title):
        return False, "filtered_title_deny"
    refs = _cfr_refs(doc)
    if refs and all(r in cfg["_cfr_deny"] for r in refs):
        return False, "filtered_cfr_deny"
    whole, parts = _allowlist(cfg)
    agency_slugs = {a.get("slug") for a in doc.get("agencies") or []}
    signal = (any(t in whole or (t, p) in parts for t, p in refs)
              or bool(agency_slugs & set(cfg["notice_agencies"]))
              or bool(cfg["_keyword_re"].search(f"{title} {doc.get('abstract') or ''}")))
    return (True, "kept") if signal else (False, "filtered_no_signal")


# ---------------------------------------------------------------------------
# Digest (plan §6.2) — pure given the raw text
# ---------------------------------------------------------------------------

def is_correction(doc: dict) -> bool:
    return bool(doc.get("correction_of")) or bool(re.match(r"^C\d+-", doc.get("document_number") or ""))


def is_final_rule(doc: dict) -> bool:
    action = doc.get("action") or ""
    return (doc.get("type") == "Rule" and not is_correction(doc)
            and bool(_FINAL_ACTION.search(action)) and not _NOT_FINAL_ACTION.search(action))


def status_label(doc: dict) -> str:
    if is_correction(doc):
        return "Correction"
    t, action = doc.get("type") or "", (doc.get("action") or "").lower()
    if t == "Proposed Rule":
        return "Proposed rule (not in effect)"
    if t == "Rule":
        if "interim final" in action:
            return "Interim final rule"
        return "Final rule" if "final rule" in action else "Rule"
    return t or "Document"


def headline(doc: dict, superseded: bool = False) -> str:
    label = "Proposed rule (superseded by final rule)" if superseded else status_label(doc)
    return f"{label}: {doc.get('title') or doc.get('document_number')}"


def _plain(raw_html: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", raw_html or ""))


# FR raw text (GPO <pre>): prose paragraphs start with a 4-space indent and
# wrap at ~70 chars; headings and abbreviation lists are not indented, and ToC
# sub-entries, though indented, are outline items ("A. ...", "1. ...",
# "b. ...", "(2) ..."). So a prose line = indented, not an outline marker, and
# >=50 chars long. The ToC also lists "Executive Summary" (always BEFORE the
# real section), so the LAST such heading with prose after it is the section.
_PROSE_LINE = re.compile(r"\n {4}(?!(?:[A-Za-z0-9]{1,4}\.|\([A-Za-z0-9]{1,4}\))\s)\S[^\n]{50,}")
_EXEC_SUMMARY = re.compile(r"\n[ \t]*(?:[IVX]+\.\s*)?Executive Summary[ \t]*\n", re.I)
_FOOTNOTE = re.compile(r"\\\d+\\|\[\[Page \d+\]\]")


def excerpt(raw_html: str, max_words: int, min_para_words: int = 40) -> str:
    """Operational prose from the official text, capped at max_words: the
    Executive Summary when there is one, else the first indented prose
    paragraph after SUPPLEMENTARY INFORMATION (skipping the ToC / abbreviation
    list), else (non-GPO layout) the first sentence-y paragraph."""
    if max_words <= 0:
        return ""
    text = _plain(raw_html)
    idx = text.find("SUPPLEMENTARY INFORMATION")
    body = text[idx:] if idx >= 0 else text
    start, prefix = None, ""
    for m in reversed(list(_EXEC_SUMMARY.finditer(body))):
        # Start AT the first prose line (not the heading): the section often
        # opens with its own mini-ToC of sub-headings before any prose.
        nxt = _PROSE_LINE.search(body, m.end())
        if nxt:
            start, prefix = nxt.start(), "Executive Summary: "
            break
    if start is None:
        m = _PROSE_LINE.search(body)
        start = m.start() if m else None
    if start is not None:
        chunk = prefix + body[start:]
    else:
        paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", body)]
        first = next((i for i, p in enumerate(paras)
                      if len(p.split()) >= min_para_words and re.search(r"[a-z]{2}[.?] [A-Z]", p)), None)
        if first is None:
            return ""
        chunk = " ".join(paras[first:])
    words = _FOOTNOTE.sub("", chunk).split()
    return " ".join(words[:max_words]) + (" …" if len(words) > max_words else "")


def _agency_names(doc: dict) -> str:
    names = [a.get("name") or a.get("raw_name") or "" for a in doc.get("agencies") or []]
    return ", ".join(n for n in names if n) or "not stated"


def _cfr_text(doc: dict) -> str:
    refs = _cfr_refs(doc)
    return ", ".join(f"{t} CFR {p}" if p else f"{t} CFR" for t, p in refs) or "none"


def build_digest(doc: dict, raw_html: str, cfg: dict,
                 superseded_by: dict | None = None) -> tuple[str, str]:
    """(body, tag_text). Operational facts first, legal text second; body is
    word-capped (DS-1 indexes whole docs, no chunking). tag_text = header +
    SUMMARY only, so Gemini tagging stays cheap on 20k-word rules."""
    label = status_label(doc)
    status = label.upper()
    if doc.get("type") == "Proposed Rule" and not is_correction(doc):
        status = ("PROPOSED RULE — NOT IN EFFECT. A proposal for public comment; it does not "
                  "change current law unless and until a final rule is published.")
    header = [f"STATUS: {status}"]
    if superseded_by:
        header.append(
            f"SUPERSEDED: a final rule was published on {superseded_by.get('publication_date')} "
            f"({superseded_by.get('html_url')}), effective {superseded_by.get('effective_on') or 'see final rule'}. "
            "Rely on that final rule, not this proposal.")
    header += [
        f"Agencies: {_agency_names(doc)}",
        f"Action: {doc.get('action') or 'not stated'}",
        f"Published: {doc.get('publication_date')} ({doc.get('citation') or 'FR'}; document {doc.get('document_number')})",
    ]
    if doc.get("type") == "Proposed Rule":
        header.append("Effective: n/a (proposal)")
    elif doc.get("type") == "Rule":
        header.append(f"Effective: {doc.get('effective_on') or 'see DATES below'}")
    if doc.get("comments_close_on"):
        header.append(f"Comments close: {doc['comments_close_on']}")
    header.append(f"CFR affected: {_cfr_text(doc)}")
    rins, dockets = doc.get("regulation_id_numbers") or [], doc.get("docket_ids") or []
    if rins or dockets:
        header.append(f"RIN / Docket: {', '.join(rins + dockets)}")
    header.append(f"Official text: {doc.get('html_url')}" + (f" (PDF: {doc['pdf_url']})" if doc.get("pdf_url") else ""))

    summary = (doc.get("abstract") or "").strip()
    head_txt = "\n".join(header)
    parts = [head_txt]
    if summary:
        parts.append(f"SUMMARY: {summary}")
    if doc.get("dates"):
        parts.append(f"DATES: {doc['dates'].strip()}")
    tag_text = "\n\n".join(parts)

    footer = ("Source: Federal Register (Office of the Federal Register / National Archives) — "
              "US-government work, public domain. Not legal advice; read the official text.")
    budget = cfg["digest_max_words"] - len(tag_text.split()) - len(footer.split())
    ex = excerpt(raw_html, max(0, min(cfg["excerpt_max_words"], budget)),
                 min_para_words=40 if summary else 15)
    if ex:
        parts.append(f"KEY EXCERPT (from the official text): {ex}")
    parts.append(footer)
    return "\n\n".join(parts), tag_text


# ---------------------------------------------------------------------------
# Supersession (plan §6.3)
# ---------------------------------------------------------------------------

def _rin_family(cfg: dict, rin: str, cache: dict) -> list[dict]:
    if rin not in cache:
        cache[rin] = _paged(cfg, {"conditions[regulation_id_number]": rin})
    return cache[rin]


def find_superseding_final(doc: dict, cfg: dict, cache: dict) -> dict | None:
    """For a proposed rule: the earliest LATER final rule sharing a RIN."""
    if doc.get("type") != "Proposed Rule" or is_correction(doc):
        return None
    finals = [d for rin in doc.get("regulation_id_numbers") or [] for d in _rin_family(cfg, rin, cache)
              if is_final_rule(d) and (d.get("publication_date") or "") > (doc.get("publication_date") or "")]
    return min(finals, key=lambda d: d["publication_date"]) if finals else None


def proposals_superseded_by(final: dict, cfg: dict, cache: dict) -> list[dict]:
    """For a new final rule: every EARLIER proposed rule sharing a RIN."""
    if not is_final_rule(final):
        return []
    seen, out = set(), []
    for rin in final.get("regulation_id_numbers") or []:
        for d in _rin_family(cfg, rin, cache):
            if (d.get("type") == "Proposed Rule" and not is_correction(d)
                    and (d.get("publication_date") or "") < (final.get("publication_date") or "")
                    and d["document_number"] not in seen):
                seen.add(d["document_number"])
                out.append(d)
    return out


# ---------------------------------------------------------------------------
# Poll
# ---------------------------------------------------------------------------

def _publish_kwargs(slug: str, source: dict, doc: dict, body: str, tag_text: str, is_edit: bool,
                    superseded: bool = False) -> dict:
    return dict(
        title=headline(doc, superseded), description=body, source_system=slug,
        author_handle=source["display_name"], source_item_id=doc["document_number"],
        full_url=doc.get("html_url") or "", posting_date=doc.get("publication_date") or "",
        channel=source["channel"], content_type=source.get("content_type", "news"),
        is_edit=is_edit, tag_text=tag_text, ingestion_method="api",
    )


def poll_source(source_slug: str, source: dict, dry_run: bool = False, force: bool = False,
                since: str = "", max_publish: int | None = None, *,
                known: dict | None = None, publish=None, today: date | None = None) -> dict:
    """Same summary contract as gov_news_poll.poll_source(), plus per-reason
    filter counters and `deferred` (over the per-run cap — picked up next run).
    `known` / `publish` / `today` are injection points for tests."""
    t0 = time.monotonic()
    try:
        cfg = load_config()
    except Exception as e:  # noqa: BLE001 - bad config => skip this source, never crash the run
        return {"source": source_slug, "skipped": True, "reason": f"config error: {type(e).__name__}: {e}"}

    since = since or ((today or date.today()) - timedelta(days=int(cfg["lookback_days"]))).isoformat()
    cap = int(max_publish if max_publish is not None else cfg["max_publish_per_run"])
    if known is None:
        from gov_news_poll import _existing_hashes
        known = {} if force else _existing_hashes(source_slug)
    if publish is None and not dry_run:
        import posting
        publish = posting.publish_gov_news_item

    try:
        candidates = fetch_candidates(cfg, since)
    except Exception as e:  # noqa: BLE001 - API down => skip this run; the window self-heals
        return {"source": source_slug, "skipped": True,
                "reason": f"federalregister.gov API error: {type(e).__name__}: {e}"}

    counts = {"new": 0, "edited": 0, "unchanged": 0, "failed": 0, "deferred": 0,
              **{r: 0 for r in _FILTER_REASONS}}
    published: list[dict] = []
    failures: list[dict] = []
    filtered: list[dict] = []
    rin_cache: dict = {}
    run_ids: set[str] = set()

    def _do_publish(doc: dict, body: str, tag_text: str, is_edit: bool, action: str,
                    superseded: bool = False) -> None:
        entry = {"title": headline(doc, superseded), "guid": doc["document_number"], "action": action,
                 "url": doc.get("html_url"), "words": len(body.split())}
        if dry_run:
            published.append({**entry, "dry_run": True, "digest": body})
            return
        result = publish(**_publish_kwargs(source_slug, source, doc, body, tag_text, is_edit, superseded))
        published.append({**entry, "case_id": result["case_id"]})

    for doc in sorted(candidates.values(), key=lambda d: (d.get("publication_date") or "", d["document_number"])):
        keep, reason = classify(doc, cfg)
        if not keep:
            counts[reason] += 1
            filtered.append({"guid": doc["document_number"], "title": doc.get("title"), "reason": reason})
            continue
        dn = doc["document_number"]
        if dn in known and not force:
            counts["unchanged"] += 1  # immutable source: known id => skip before ANY fetch/tag/write
            continue
        if counts["new"] + counts["edited"] >= cap:
            counts["deferred"] += 1
            continue
        try:
            raw = ""
            try:
                raw = _get_text(doc["raw_text_url"]) if doc.get("raw_text_url") else ""
            except Exception as e:  # noqa: BLE001 - publish the metadata digest rather than drop the doc
                print(f"  WARNING: FR full text fetch failed for {dn}: {type(e).__name__}: {e}")
            if not raw and not (doc.get("abstract") or "").strip():
                raise ValueError("no abstract and no full text — nothing groundable")
            final = find_superseding_final(doc, cfg, rin_cache)
            body, tag_text = build_digest(doc, raw, cfg, superseded_by=final)
            is_edit = dn in known
            _do_publish(doc, body, tag_text, is_edit, "edited" if is_edit else "new", superseded=bool(final))
            counts["edited" if is_edit else "new"] += 1
            run_ids.add(dn)
            # A new final rule marks its already-ingested proposals SUPERSEDED
            # (explicit, one-time edit — the only re-publish of a known doc).
            for prop in proposals_superseded_by(doc, cfg, rin_cache):
                pdn = prop["document_number"]
                if pdn not in known or pdn in run_ids:
                    continue  # not ingested yet (or built this run, already labelled at build time)
                try:
                    praw = _get_text(prop["raw_text_url"]) if prop.get("raw_text_url") else ""
                    pbody, ptag = build_digest(prop, praw, cfg, superseded_by=doc)
                    _do_publish(prop, pbody, ptag, True, "superseded", superseded=True)
                    counts["edited"] += 1
                    run_ids.add(pdn)
                except Exception as e:  # noqa: BLE001 - don't block the final rule on its proposal
                    counts["failed"] += 1
                    failures.append({"title": prop.get("title"), "guid": pdn,
                                     "error": f"supersede: {type(e).__name__}: {e}"})
        except Exception as e:  # noqa: BLE001 - one bad doc must not abort the run; retries next run
            counts["failed"] += 1
            failures.append({"title": doc.get("title"), "guid": dn, "error": f"{type(e).__name__}: {e}"})

    print(f"  [timing] {source_slug}: federal-register poll total: {time.monotonic() - t0:.2f}s", flush=True)
    return {
        "source": source_slug, "display_name": source["display_name"], "since": since,
        "items_in_feed": len(candidates), "already_known": len(known),
        **counts, "published": published, "failures": failures, "filtered": filtered,
    }


def _main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="READ-ONLY dry run of the Federal Register adapter "
                                             "(never publishes, never touches Firestore).")
    ap.add_argument("--since", default="", help="YYYY-MM-DD (default: today - lookback_days)")
    ap.add_argument("--show", type=int, default=2, help="print N full sample digests")
    ap.add_argument("--no-bq", action="store_true", help="don't read the known-id set from BigQuery")
    args = ap.parse_args()
    r = poll_source("federal-register", DEFAULT_SOURCE, dry_run=True, since=args.since,
                    max_publish=10**6, known={} if args.no_bq else None)
    if r.get("skipped"):
        print(f"skipped: {r['reason']}")
        return 1
    print(f"\n=== Federal Register dry run since {r['since']} ===")
    print(f"candidates={r['items_in_feed']} known={r['already_known']} new={r['new']} "
          f"superseded_edits={sum(p['action'] == 'superseded' for p in r['published'])} "
          f"unchanged={r['unchanged']} failed={r['failed']}")
    print("filtered: " + ", ".join(f"{k}={r[k]}" for k in _FILTER_REASONS))
    print("\n-- KEPT --")
    for p in r["published"]:
        print(f"  [{p['action']:<10}] {p['guid']:<16} {p['words']:>5}w  {p['title'][:95]}")
    print("\n-- FILTERED --")
    for f in r["filtered"]:
        print(f"  {f['reason']:<20} {f['guid']:<16} {(f['title'] or '')[:90]}")
    for f in r["failures"]:
        print(f"  FAILED {f['guid']}: {f['error']}")
    for p in r["published"][-args.show:] if args.show else []:
        print(f"\n===== SAMPLE DIGEST {p['guid']} =====\n{p['digest']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
