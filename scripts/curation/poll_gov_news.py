#!/usr/bin/env python3
"""
poll_gov_news.py — manual CLI for backend/gov_news_poll.py. See
docs/ingestion/GOV-NEWS-INGESTION-PLAN.md for the full design.

The Cloud Scheduler job runs this same logic via api.py's
POST /internal/gov-news/poll route (§5) — this script is for manual runs
(first-time verification, ad-hoc backfills, debugging a specific source).

Usage:
  cd backend && ../.venv/bin/python ../scripts/curation/poll_gov_news.py [--source uscis] [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"))
load_dotenv()

from gov_news_poll import poll_all  # noqa: E402


def _print_summary(r: dict) -> None:
    if r.get("skipped"):
        print(f"\n{r['source']}: skipped — {r['reason']}")
        return
    print(f"\n=== {r['source']} ({r['display_name']}) ===")
    print(f"{r['items_in_feed']} items in feed, {r['already_known']} already known")
    for p in r["published"]:
        label = "EDIT" if p["action"] == "edited" else "NEW"
        suffix = " (dry-run)" if p.get("dry_run") else f" -> {p.get('case_id', '')}"
        print(f"  [{label}] {p['title']}{suffix}")
    for f in r["failures"]:
        print(f"  FAILED: {f['title']} — {f['error']}")
    print(f"{r['source']}: new={r['new']} edited={r['edited']} "
          f"unchanged={r['unchanged']} failed={r['failed']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    # No fixed --source choices: sources are Firestore-backed and can be
    # added at any time (scripts/curation/manage_news_sources.py) without a
    # deploy, so this CLI can't know the valid slugs at parse time. An
    # unknown/disabled slug is reported gracefully by poll_all() itself.
    ap.add_argument("--source", default="", help="poll only this source slug (default: all enabled sources)")
    ap.add_argument("--dry-run", action="store_true", help="classify and print, but don't publish")
    ap.add_argument("--force", action="store_true",
                     help="republish every item regardless of BigQuery dedup state — "
                          "corrective runs only, not for normal use")
    args = ap.parse_args()

    results = poll_all(source_slug=args.source or "", dry_run=args.dry_run, force=args.force)
    for r in results:
        _print_summary(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
