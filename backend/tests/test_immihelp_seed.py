"""
test_immihelp_seed.py — pure parsing logic for the one-time immihelp sample
seed. See docs/ingestion/IMMIHELP-SEED-PLAN.md for the design.

All checks here are PURE/no-network (fixture HTML strings, no real fetch)
— fetch_candidates() itself (the networked half) is exercised manually via
scripts/curation/seed_immihelp.py --dry-run against the real site, not
here, same split as gov_news_poll.py's _parse_feed() vs. poll_all().

Run:  .venv/bin/python tests/test_immihelp_seed.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed, bool(detail)))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def _fixture_html(posts: list[dict]) -> str:
    blob = json.dumps({"status": "success", "totalPosts": len(posts), "posts": posts})
    return (
        "<html><head></head><body><script>\n"
        f"window.immiObj = {{}};\nwindow.immiObj.posts = {blob};\n"
        "console.log('other unrelated JS after the blob');\n"
        "</script></body></html>"
    )


_GOOD_POST = {
    "id": 123456, "title": "My H1B approval story", "content": "Filed in Jan.<br>\nApproved in March!",
    "createdOn": "2026-03-15T10:30:00.000-04:00", "postedOn": "03/15/2026 10:30 AM EDT",
    "createdBy": "realusername123", "postedBy": "realusername123", "username": "realusername123",
    "ipAddress": "203.0.113.42", "permalink": "/experiences/post/my-h1b-approval-story-123456/",
    "status": "Active", "categoryName": "H1B, H4 Visa",
}


def group_a_parse_topic_posts() -> None:
    print("\nA — parse_topic_posts()")
    from immihelp_seed import parse_topic_posts

    html = _fixture_html([_GOOD_POST])
    posts = parse_topic_posts(html, topic_name="h1b-h4-visa-experiences")
    check("A1 extracts exactly one post from the embedded JSON blob",
          len(posts) == 1, str(posts))
    p = posts[0] if posts else {}
    check("A2 source_item_id captured as a string",
          p.get("source_item_id") == "123456", str(p))
    check("A3 title captured verbatim",
          p.get("title") == "My H1B approval story", str(p))
    check("A4 HTML content cleaned (br stripped, text preserved)",
          p.get("content") == "Filed in Jan.\nApproved in March!", repr(p.get("content")))
    check("A5 posting_date is the ORIGINAL source date, taken as-is (not UTC-shifted)",
          p.get("posting_date") == "2026-03-15", str(p))
    check("A6 full_url resolved against the site root",
          p.get("full_url") == "https://www.immihelp.com/experiences/post/my-h1b-approval-story-123456/",
          str(p))
    check("A7 real username/postedBy/createdBy NEVER carried into the candidate dict",
          not any(k in p for k in ("username", "postedBy", "createdBy")), str(p))
    check("A8 ipAddress NEVER carried into the candidate dict",
          "ipAddress" not in p and "ip_address" not in p, str(p))
    check("A9 topic name passed through for logging/manifest use",
          p.get("topic") == "h1b-h4-visa-experiences", str(p))


def group_b_filtering() -> None:
    print("\nB — status/malformed filtering")
    from immihelp_seed import parse_topic_posts

    inactive = dict(_GOOD_POST, id=2, status="Deleted")
    malformed_no_title = dict(_GOOD_POST, id=3, title="")
    malformed_no_content = dict(_GOOD_POST, id=4, content="")
    good2 = dict(_GOOD_POST, id=5)
    html = _fixture_html([_GOOD_POST, inactive, malformed_no_title, malformed_no_content, good2])
    posts = parse_topic_posts(html)
    ids = {p["source_item_id"] for p in posts}
    check("B1 non-Active status posts are dropped",
          "2" not in ids, str(ids))
    check("B2 posts missing title are dropped, not crashed on",
          "3" not in ids, str(ids))
    check("B3 posts missing content are dropped, not crashed on",
          "4" not in ids, str(ids))
    check("B4 valid posts among the mix are still all kept",
          {"123456", "5"} == ids, str(ids))


def group_c_no_blob_present() -> None:
    print("\nC — no embedded blob (e.g. a changed/broken page)")
    from immihelp_seed import parse_topic_posts

    check("C1 empty list, not a crash, when the JS marker isn't found",
          parse_topic_posts("<html><body>nothing here</body></html>") == [])
    check("C2 empty list, not a crash, on truncated/invalid JSON after the marker",
          parse_topic_posts("window.immiObj.posts = {not valid json;") == [])


def main() -> int:
    group_a_parse_topic_posts()
    group_b_filtering()
    group_c_no_blob_present()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = [n for n, ok, _ in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All immihelp_seed checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
