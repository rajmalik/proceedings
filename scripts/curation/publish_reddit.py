#!/usr/bin/env python3
"""
publish_reddit.py — Path B publish for backend-ingested (Reddit) content.
See docs/ingestion/PATH-B-PROVENANCE-PLAN.md for the full design.

Unlike publish.sh/publish-batch.sh (which POST to the public /api/postings
route), this imports backend/posting.py directly and calls
posting.publish_reddit_posting() — the function that sets real
channel="reddit"/source_system="reddit"/subreddit/reddit_post_id/full_url/
posting_date, none of which the public route accepts (deliberately — see
the plan doc for why that needs to stay a non-public code path).

Requires running from an environment with the backend's dependencies
installed and GCP credentials with access to proceedings-490601 — same
requirements as running backend/tests/test_posting_tagging.py locally (see
docs/app/NESTED-REPLIES-HANDOFF.md's ADC-vs-gcloud-CLI note if a 403 shows
up here; it's the same gotcha).

Usage:
  cd backend && ../.venv/bin/python ../scripts/curation/publish_reddit.py \
    ~/curated/072326/i485-approved.txt \
    --subreddit h1b \
    --reddit-post-id 1abc2de \
    --posting-date 2026-06-15 \
    --full-url https://www.reddit.com/r/h1b/comments/1abc2de/some_title/

Reads "<name>.tags.json" next to the given .txt file (the reviewed draft
from tag-suggest.sh) — same convention as publish.sh. Writes
"<name>.published.json" as a completion marker, same as publish-batch.sh,
so it's safe to re-run without creating a duplicate (skips if the marker
already exists, unless --force).
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("post_file", help="path to <name>.txt (title line, blank line, body)")
    ap.add_argument("--subreddit", required=True)
    ap.add_argument("--reddit-post-id", required=True)
    ap.add_argument("--posting-date", required=True, help="YYYY-MM-DD, the REAL original Reddit post date")
    ap.add_argument("--full-url", required=True, help="the real reddit.com permalink")
    ap.add_argument("--force", action="store_true", help="republish even if already published")
    args = ap.parse_args()

    if not os.path.isfile(args.post_file):
        print(f"Error: '{args.post_file}' not found", file=sys.stderr)
        return 1

    base = args.post_file[:-4] if args.post_file.endswith(".txt") else args.post_file
    tags_file = f"{base}.tags.json"
    result_file = f"{base}.published.json"

    if not os.path.isfile(tags_file):
        print(f"Error: '{tags_file}' not found — run tag-suggest.sh first", file=sys.stderr)
        return 1

    if os.path.isfile(result_file) and not args.force:
        with open(result_file) as f:
            existing = json.load(f)
        print(f"SKIPPED — already published as {existing.get('case_id', 'unknown')} "
              f"(pass --force to republish)")
        return 0

    with open(args.post_file, encoding="utf-8") as f:
        lines = f.read().split("\n")
    title = lines[0]
    description = "\n".join(lines[2:]).strip()

    with open(tags_file, encoding="utf-8") as f:
        draft = json.load(f)

    # backend/ must be importable — run this from within backend/, or adjust sys.path.
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"))
    import posting  # noqa: E402

    try:
        result = posting.publish_reddit_posting(
            title, description, draft.get("groups", {}),
            subreddit=args.subreddit,
            reddit_post_id=args.reddit_post_id,
            full_url=args.full_url,
            posting_date=args.posting_date,
            key_stages=draft.get("key_stages_or_info"),
            key_dates=draft.get("key_dates"),
        )
    except ValueError as e:
        print(f"FAILED validation: {e}", file=sys.stderr)
        return 1

    with open(result_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"Published as {result['case_id']}")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
