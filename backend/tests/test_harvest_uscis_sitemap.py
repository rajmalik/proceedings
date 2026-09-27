#!/usr/bin/env python3
"""Offline unit tests for scripts/curation/harvest_uscis_sitemap.py — the Tier-1
candidate-ranking curation tool (Milestone 1.5a). No network: `_fetch` is stubbed
with fixture sitemap XML; everything else is pure.

Covers: sitemap index recursion + urlset parsing (+ dedup + max cap), scoring
(section/form/keyword/recency/depth + demand boosts), exclusion + archived-
snapshot filters, existing-config exclusion, demand-file parsing, and title
derivation — including edge cases.

Run:  python tests/test_harvest_uscis_sitemap.py
Wired into the no-GCP CI gate.
"""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

_ROOT = Path(__file__).resolve().parents[2]  # repo root
_SPEC = importlib.util.spec_from_file_location(
    "harvest_uscis_sitemap", _ROOT / "scripts" / "curation" / "harvest_uscis_sitemap.py"
)
harvest = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(harvest)

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


_NS = "http://www.sitemaps.org/schemas/sitemap/0.9"
_INDEX = f"""<?xml version="1.0"?><sitemapindex xmlns="{_NS}">
  <sitemap><loc>https://www.uscis.gov/sm-a.xml</loc></sitemap>
  <sitemap><loc>https://www.uscis.gov/sm-b.xml</loc></sitemap>
</sitemapindex>"""
_URLSET_A = f"""<?xml version="1.0"?><urlset xmlns="{_NS}">
  <url><loc>https://www.uscis.gov/i-765</loc><lastmod>2026-09-01</lastmod></url>
  <url><loc>https://www.uscis.gov/family</loc></url>
</urlset>"""
_URLSET_B = f"""<?xml version="1.0"?><urlset xmlns="{_NS}">
  <url><loc>https://www.uscis.gov/newsroom/alerts/x</loc><lastmod>2026-09-02</lastmod></url>
</urlset>"""
_FIXTURES = {
    "https://www.uscis.gov/index.xml": _INDEX,
    "https://www.uscis.gov/sm-a.xml": _URLSET_A,
    "https://www.uscis.gov/sm-b.xml": _URLSET_B,
}


def _with_fake_fetch():
    orig = harvest._fetch
    harvest._fetch = lambda url, timeout=25: _FIXTURES[url].encode("utf-8")
    return orig


def group_iter() -> None:
    print("\nA — _iter_sitemap (index recursion + urlset parse)")
    orig = _with_fake_fetch()
    try:
        pairs = harvest._iter_sitemap("https://www.uscis.gov/index.xml", 50, set())
        locs = {loc for loc, _ in pairs}
        check("A1 recurses index into child urlsets", "https://www.uscis.gov/i-765" in locs and
              "https://www.uscis.gov/newsroom/alerts/x" in locs, str(sorted(locs)))
        check("A2 lastmod captured when present",
              any(loc == "https://www.uscis.gov/i-765" and lm == "2026-09-01" for loc, lm in pairs))
        check("A3 missing lastmod tolerated (empty string)",
              any(loc == "https://www.uscis.gov/family" and lm == "" for loc, lm in pairs))
        # max cap: 0 child sitemaps fetched -> no urls
        check("A4 max_sitemaps cap respected",
              harvest._iter_sitemap("https://www.uscis.gov/index.xml", 0, set()) == [])
    finally:
        harvest._fetch = orig


def group_score() -> None:
    print("\nB — _score (value signals)")
    s_form, r_form = harvest._score("https://www.uscis.gov/i-129", "", [])
    check("B1 form page scores the form weight", s_form >= 5, f"{s_form} {r_form}")
    s_sec, _ = harvest._score("https://www.uscis.gov/green-card/x", "", [])
    check("B2 known section adds its weight", s_sec >= 5)
    s_recent, _ = harvest._score("https://www.uscis.gov/family", "2026-02-01", [])
    s_old, _ = harvest._score("https://www.uscis.gov/family", "2019-01-01", [])
    check("B3 recent lastmod boosts over old", s_recent > s_old, f"{s_recent} vs {s_old}")
    s_deep, r_deep = harvest._score("https://www.uscis.gov/a/b/c/d/e/f", "", [])
    check("B4 deep path penalized", "deep(-1)" in ";".join(r_deep))
    # demand boost: a compiled boost matching the slug adds weight
    import re
    s_dem, r_dem = harvest._score("https://www.uscis.gov/naturalization", "",
                                  [(re.compile("naturalization"), 4, "demand:naturalization")])
    check("B5 demand term boosts a matching URL", "demand:naturalization(+4)" in ";".join(r_dem), str(s_dem))


def group_filters() -> None:
    print("\nC — exclusion + archived-snapshot filters")
    check("C1 _EXCLUDE drops newsroom", bool(harvest._EXCLUDE.search("/newsroom/alerts/x")))
    check("C2 _EXCLUDE drops archive", bool(harvest._EXCLUDE.search("/archive/old-thing")))
    check("C3 _EXCLUDE drops es/ locale", bool(harvest._EXCLUDE.search("/es/algo")))
    check("C4 _EXCLUDE keeps a real form page", not harvest._EXCLUDE.search("/i-765"))
    check("C5 archived '-<n>' snapshot detected",
          bool(harvest._ARCHIVE_SUFFIX.search("when-to-file-104")))
    check("C6 non-archive slug not flagged", not harvest._ARCHIVE_SUFFIX.search("i-765"))


def group_config_demand() -> None:
    print("\nD — _load_existing + _load_demand (edge cases)")
    # existing config: dict-with-sources, URLs normalized (trailing slash stripped)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"sources": [{"url": "https://www.uscis.gov/i-765/", "source_system": "uscis"}]}, f)
        cfg = f.name
    ex = harvest._load_existing(Path(cfg))
    check("D1 existing URLs loaded + normalized", "https://www.uscis.gov/i-765" in ex, str(ex))
    check("D2 missing config -> empty set (no crash)",
          harvest._load_existing(Path("/nonexistent/x.json")) == set())

    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
        f.write("naturalization,5\n# comment\nopt\n\n")
        dem = f.name
    boosts = harvest._load_demand(dem)
    check("D3 demand term with explicit weight parsed", any(w == 5 for _, w, _ in boosts))
    check("D4 demand term without weight defaults", any(lbl == "demand:opt" for _, _, lbl in boosts))
    check("D5 comments/blank lines skipped", len(boosts) == 2, str(len(boosts)))
    check("D6 missing demand file -> empty (no crash)", harvest._load_demand("/nope/x.csv") == [])


def group_title() -> None:
    print("\nE — _title_from")
    check("E1 slug -> title-cased", harvest._title_from("https://www.uscis.gov/green-card/adjustment-of-status")
          == "Adjustment Of Status")
    check("E2 trailing slash tolerated (non-empty title)",
          harvest._title_from("https://www.uscis.gov/i-765/") == "I 765")


def main() -> None:
    print("== test_harvest_uscis_sitemap ==")
    group_iter()
    group_score()
    group_filters()
    group_config_demand()
    group_title()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
