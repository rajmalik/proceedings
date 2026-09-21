#!/usr/bin/env python3
"""
seed_immihelp.py — one-time, bounded sample seed of immihelp.com/experiences/
postings. See docs/ingestion/IMMIHELP-SEED-PLAN.md for the full design.

Deliberately NOT a recurring job and NOT wired into the Firestore
news_sources/Cloud Scheduler framework (GOV-NEWS-MULTI-SOURCE-CONFIG.md):
immihelp's Terms of Use §12 reserves all rights and requires prior written
consent for reproduction/commercial use, which this project doesn't have.
Run this by hand, once, for a small sample — not on a schedule.

Fetches page-1 (~10 most recent posts) of every topic listing in
backend/immihelp_seed.py's TOPIC_SLUGS, most-recent-first overall, tags and
publishes each candidate via the SAME tagging/publish backend the live API
uses (posting.publish_immihelp_posting() -> _extract()/build_canonical()/
validate(), same as an app submission), and stops once --limit items have
been successfully published. A candidate validate() rejects (no
visa/status captured, etc.) is skipped, not retried — the sample is
"however many of the fetched candidates turn out to be publishable up to
the limit," not a guaranteed exact count.

Resumable: writes the manifest after every publish/skip, and a re-run
skips any source_item_id already recorded there (--force ignores it and
re-attempts).

Usage:
  cd backend && ../.venv/bin/python ../scripts/curation/seed_immihelp.py --dry-run
  cd backend && ../.venv/bin/python ../scripts/curation/seed_immihelp.py --limit 100
"""

from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "immihelp-seed-manifest.json")


def _load_manifest(path: str) -> dict:
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {"published": {}, "skipped": {}}


def _save_manifest(path: str, manifest: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--limit", type=int, default=100, help="stop after this many successful publishes")
    ap.add_argument("--dry-run", action="store_true",
                     help="run the full tag/validate pipeline (real Gemini calls) but skip the GCS/"
                          "Discovery Engine/BigQuery writes — reports real would-publish/would-skip counts")
    ap.add_argument("--force", action="store_true", help="ignore the manifest, re-attempt already-seen items")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST, help="path to the resumable progress manifest")
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"))
    from dotenv import load_dotenv
    load_dotenv()
    import posting  # noqa: E402
    from immihelp_seed import fetch_candidates  # noqa: E402

    manifest = _load_manifest(args.manifest)
    print("Fetching candidates from immihelp.com/experiences/ (this respects the site's crawl-delay: 3s)...")
    candidates = fetch_candidates()
    print(f"{len(candidates)} candidate postings fetched across all topics\n")

    published = 0
    skipped = 0
    failed = 0
    verb = "Would publish" if args.dry_run else "Published"
    for c in candidates:
        if published >= args.limit:
            break
        sid = c["source_item_id"]
        if not args.force and (sid in manifest["published"] or sid in manifest["skipped"]):
            continue

        try:
            result = posting.publish_immihelp_posting(
                title=c["title"], description=c["content"],
                source_item_id=sid, full_url=c["full_url"],
                posting_date=c["posting_date"], dry_run=args.dry_run,
            )
        except ValueError as e:
            skipped += 1
            if not args.dry_run:
                manifest["skipped"][sid] = {"title": c["title"], "reason": str(e)}
                _save_manifest(args.manifest, manifest)
            print(f"  SKIPPED (not publishable): {c['title']!r} — {e}")
            continue
        except Exception as e:  # noqa: BLE001 - one bad item must not abort the whole run
            failed += 1
            print(f"  FAILED: {c['title']!r} — {type(e).__name__}: {e}")
            continue

        published += 1
        if not args.dry_run:
            manifest["published"][sid] = {
                "title": c["title"], "case_id": result["case_id"],
                "full_url": c["full_url"], "posting_date": c["posting_date"],
            }
            _save_manifest(args.manifest, manifest)
        print(f"  [{published}/{args.limit}] {verb} {c['title']!r} -> {result['case_id']}"
              + (f" tags={result['tags']}" if args.dry_run else ""))

    print(f"\nDone. published={published} skipped={skipped} failed={failed}"
          + ("" if args.dry_run else f" (manifest: {args.manifest})"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
