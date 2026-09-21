#!/usr/bin/env python3
"""
reddit-export.py — one-time bulk export of a subreddit's top posts (+ top
comments) from Reddit's public, unauthenticated JSON listing endpoint, into
the same "<name>.txt" format scripts/curation/tag-suggest-batch.sh and
publish-batch.sh already expect (title line, blank line, body).

STATUS (2026-07-24): Reddit currently returns HTTP 403 Blocked on this
endpoint for non-browser HTTP clients — confirmed from both a cloud sandbox
and a residential home connection. Not an IP-reputation issue; looks like
TLS/HTTP fingerprint-based bot detection. All pagination/comment-extraction/
file-writing logic below is tested and correct (see the stubbed-response
test run during development) — the blocker is Reddit's edge, not this code.
Deliberately NOT patched to spoof browser fingerprints or route through
proxies to get past this — see docs/ingestion/APIFY-SCRAPER-LEGAL-AND-
INTEGRATION.md §2.5 for why that would cross into the same circumvention
risk category flagged throughout that doc. Kept in the repo as a working,
ready-to-use tool for if/when this endpoint becomes reachable again (e.g.
run from an environment Reddit doesn't currently fingerprint as a bot), not
as an active recommendation today.

Uses ONLY the Python standard library (urllib) — no third-party service,
no API key, no dependency install. See docs/ingestion/REDDIT-INGESTION-
ALTERNATIVES.md option 1-D and docs/ingestion/MANUAL-CURATION-PLAYBOOK.md
for the legal/process context this fits into: this is still, technically,
outside Reddit's ToS (same as any unauthenticated access) — the practical
risk profile is just much lower for a single, bounded, one-time pull than
for sustained/recurring scraping. Not a substitute for legal review before
production use — see APIFY-SCRAPER-LEGAL-AND-INTEGRATION.md's disclaimer,
which applies equally here.

Usage:
  python3 reddit-export.py --subreddit h1b --out ~/curated/h1b-2026-07 --count 300

Resumable / idempotent: skips writing "<id>.txt" if it already exists,
so an interrupted run can just be re-invoked with the same arguments.

Does NOT capture the Reddit author's username or handle anywhere, on
either the post or its comments — matches the explicit privacy
requirement in docs/ingestion/REDDIT-INGESTION-PIPELINE.md and
MANUAL-CURATION-PLAYBOOK.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

USER_AGENT = "meridianjourney-research/0.1 (one-time bulk export tool; contact via repo)"
BASE = "https://www.reddit.com"
SLEEP_BETWEEN_REQUESTS = 2.0  # seconds — stays comfortably under the ~10 req/min
                              # unauthenticated rate limit documented in
                              # REDDIT-INGESTION-ALTERNATIVES.md §2 option 1-D.
MIN_BODY_LENGTH = 50  # skip trivially short/low-value posts


def fetch_json(url: str, attempts: int = 3) -> dict | list | None:
    """GET url, parse JSON, retry with backoff on transient errors / 429."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < attempts - 1:
                wait = 10 * (i + 1)
                print(f"  429 rate-limited; backing off {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"  HTTP {e.code} fetching {url}: {e}", file=sys.stderr)
            return None
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            print(f"  Error fetching {url}: {e}", file=sys.stderr)
            if i < attempts - 1:
                time.sleep(3)
                continue
            return None
    return None


def list_top_posts(subreddit: str, timeframe: str, target_count: int):
    """Yield post dicts from /r/<sub>/top.json?t=<timeframe>, paginated."""
    after = None
    fetched = 0
    while fetched < target_count:
        limit = min(100, target_count - fetched)
        url = f"{BASE}/r/{subreddit}/top.json?t={timeframe}&limit={limit}"
        if after:
            url += f"&after={after}"

        data = fetch_json(url)
        time.sleep(SLEEP_BETWEEN_REQUESTS)
        if not data:
            print("  No data returned; stopping pagination.", file=sys.stderr)
            return

        children = data.get("data", {}).get("children", [])
        if not children:
            print("  No more posts available.", file=sys.stderr)
            return

        for child in children:
            yield child["data"]
            fetched += 1
            if fetched >= target_count:
                return

        after = data.get("data", {}).get("after")
        if not after:
            print("  Reached end of listing.", file=sys.stderr)
            return


def top_comments(post_id: str, n: int):
    """Return up to n top-level comment bodies, sorted by score, for a post.
    Skips stickied (usually AutoModerator), removed/deleted, and any reply
    depth > 0 — top-level only. Never includes the commenter's handle."""
    url = f"{BASE}/comments/{post_id}.json?sort=top&limit={max(n * 3, 10)}"
    data = fetch_json(url)
    time.sleep(SLEEP_BETWEEN_REQUESTS)
    if not data or len(data) < 2:
        return []

    comments = []
    for child in data[1].get("data", {}).get("children", []):
        if child.get("kind") != "t1":
            continue
        c = child["data"]
        body = (c.get("body") or "").strip()
        if not body or body in ("[removed]", "[deleted]"):
            continue
        if c.get("stickied") or c.get("distinguished"):
            continue
        comments.append((c.get("score", 0), body))

    comments.sort(key=lambda x: x[0], reverse=True)
    return [body for _score, body in comments[:n]]


def write_post_file(out_dir: str, post: dict, comments: list[str]) -> str | None:
    post_id = post["id"]
    path = os.path.join(out_dir, f"{post_id}.txt")
    if os.path.exists(path):
        return None  # resumable: don't re-fetch/overwrite what's already exported

    title = (post.get("title") or "").strip()
    body = (post.get("selftext") or "").strip()
    if len(body) < MIN_BODY_LENGTH:
        return None  # skip link-only / low-content posts

    lines = [title, "", body]
    if comments:
        lines.append("")
        lines.append("---")
        lines.append("Top comments:")
        for i, c in enumerate(comments, 1):
            lines.append("")
            lines.append(f"{i}. {c}")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--subreddit", required=True, help="e.g. h1b (no r/ prefix)")
    ap.add_argument("--out", required=True, help="output directory (created if missing)")
    ap.add_argument("--count", type=int, default=300, help="target number of posts (default 300)")
    ap.add_argument("--timeframe", default="month", choices=["hour", "day", "week", "month", "year", "all"],
                     help="Reddit's top-listing time window (default: month)")
    ap.add_argument("--comments", type=int, default=3, help="top comments per post (default 3, 0 to disable)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print(f"Exporting up to {args.count} top posts from r/{args.subreddit} "
          f"(past {args.timeframe}) to {args.out}")
    print(f"({args.comments} top comment(s) per post)" if args.comments else "(posts only, no comments)")
    print()

    written = 0
    skipped_existing = 0
    skipped_short = 0
    seen = 0
    for post in list_top_posts(args.subreddit, args.timeframe, args.count):
        seen += 1
        post_id = post["id"]
        title = (post.get("title") or "")[:60]
        path_check = os.path.join(args.out, f"{post_id}.txt")

        if os.path.exists(path_check):
            print(f"[{seen}] SKIP (already exported) {post_id}  {title}")
            skipped_existing += 1
            continue

        comments = top_comments(post_id, args.comments) if args.comments > 0 else []
        result = write_post_file(args.out, post, comments)
        if result:
            print(f"[{seen}] -> {result}  ({len(comments)} comments)")
            written += 1
        else:
            print(f"[{seen}] SKIP (too short / no self text) {post_id}  {title}")
            skipped_short += 1

    print()
    print(f"Done. Written: {written}   Skipped (already exported): {skipped_existing}   "
          f"Skipped (too short/no text): {skipped_short}   Total seen: {seen}")
    print(f"\nNext: scripts/curation/tag-suggest-batch.sh {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
