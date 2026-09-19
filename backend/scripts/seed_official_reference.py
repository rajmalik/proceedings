#!/usr/bin/env python3
"""Seed one authoritative official-reference page into DS-1 — the Phase-2
minimal slice (docs/ingestion/GROUNDING-INGESTION-PLAN.md). Defaults to the ICE
SEVIS page.

SAFETY: this is a DRY RUN by default (fetch + build + validate, no writes). Pass
`--commit` to actually write to the live datastore/GCS/BigQuery. Not wired to any
schedule or HTTP route.

Usage:
  python scripts/seed_official_reference.py                       # ICE SEVIS, dry run
  python scripts/seed_official_reference.py --as-of 2026-09-19    # pin a stable effective date
  python scripts/seed_official_reference.py --commit --as-of 2026-09-19
  python scripts/seed_official_reference.py --url <URL> --source-system <slug> \
         --title "<title>" --author "<handle>" --as-of YYYY-MM-DD [--commit]

Pass a STABLE `--as-of` (the page's effective / "last updated" date): re-running
with the same value upserts in place; a new value publishes the next version.
"""
import argparse
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

import requests  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

import posting  # noqa: E402

DEFAULT_URL = "https://www.ice.gov/sevis"
DEFAULT_TITLE = "Student and Exchange Visitor Program (SEVP) / SEVIS"
DEFAULT_SOURCE_SYSTEM = "ice"
DEFAULT_AUTHOR = "ICE SEVP"

# Try progressively broader containers; strip chrome first.
_BODY_SELECTORS = ["main article", "article", "main", "#main-content", "#content", "body"]
_MIN_WORDS = 50


def fetch_page_text(url: str) -> str:
    """Best-effort single-page body-text extraction. Strips script/style/nav/
    header/footer chrome, then takes the first container with real content."""
    r = requests.get(url, timeout=20, headers={"User-Agent": "meridianjourney-grounding-bot/1.0"})
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "form", "noscript"]):
        tag.decompose()
    for sel in _BODY_SELECTORS:
        el = soup.select_one(sel)
        if el:
            txt = el.get_text(separator=" ", strip=True)
            if len(txt.split()) >= _MIN_WORDS:
                return txt
    return soup.get_text(separator=" ", strip=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed an official-reference page into DS-1 (dry run by default).")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--title", default=DEFAULT_TITLE)
    ap.add_argument("--source-system", default=DEFAULT_SOURCE_SYSTEM)
    ap.add_argument("--author", default=DEFAULT_AUTHOR)
    ap.add_argument("--as-of", default="", help="stable effective date YYYY-MM-DD (defaults to today)")
    ap.add_argument("--commit", action="store_true", help="actually write to the live datastore (default: dry run)")
    args = ap.parse_args()

    as_of = args.as_of or date.today().isoformat()
    if not args.as_of:
        print(f"WARNING: no --as-of given; using today ({as_of}). For idempotent re-ingests, pin a stable date.")

    print(f"Fetching {args.url} ...")
    body = fetch_page_text(args.url)
    words = len(body.split())
    print(f"  extracted {words} words")
    if words < _MIN_WORDS:
        print("  ABORT: too little body text extracted — check the page/selectors.")
        sys.exit(1)

    res = posting.publish_official_reference_item(
        title=args.title,
        body_text=body,
        source_system=args.source_system,
        full_url=args.url,
        as_of_date=as_of,
        author_handle=args.author,
        dry_run=not args.commit,
    )
    print(f"  case_id : {res['case_id']}")
    print(f"  gcs_path: {res['gcs_path']}")
    print(f"  doc_kind: official_reference | indexed: {res.get('indexed')}")
    if args.commit:
        print("  ✅ ingested into DS-1 (imm-postings-datastore)")
    else:
        print("  DRY RUN — nothing written. Re-run with --commit to ingest into the live datastore.")


if __name__ == "__main__":
    main()
