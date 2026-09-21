"""
immihelp_seed.py — fetch/parse logic for a one-time, bounded sample seed of
immihelp.com/experiences/ postings. See docs/ingestion/IMMIHELP-SEED-PLAN.md
for the full design.

NOT part of the Firestore-backed news_sources framework
(docs/ingestion/GOV-NEWS-MULTI-SOURCE-CONFIG.md) and deliberately never
registered there or polled by Cloud Scheduler: immihelp's Terms of Use §12
reserves all rights and requires prior written consent for reproduction/
commercial use, which this project doesn't have. This module only backs
scripts/curation/seed_immihelp.py's bounded one-time run (default: 100
published items), never an ongoing automated source.

Unlike RSS-based gov-news sources, an immihelp topic listing page embeds a
JSON blob (`window.immiObj.posts`) with each post's full body already
inline — no per-post detail-page fetch needed, and no headless browser
required (a plain HTTP GET is enough).
"""

from __future__ import annotations

import json
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

SITE_ROOT = "https://www.immihelp.com"

# robots.txt (https://www.immihelp.com/robots.txt) sets crawl-delay: 3 for
# all user agents — honored between every HTTP request fetch_candidates()
# makes.
_CRAWL_DELAY_SECONDS = 3

_POSTS_JS_MARKER = "window.immiObj.posts = "

# Topics under the Immigration/Visa sections likely to contain a personal
# visa/status narrative — what backend/posting.py's validate() requires
# (GROUP_FIELDS/tags vocab). Topics under USA/Insurance/Travel/Student
# (banking, hotels, telecom, university admissions, etc.) are excluded up
# front: they're consistently off-topic for this product's tag vocabulary
# and would just waste fetch budget on candidates validate() will reject
# anyway.
TOPIC_SLUGS = [
    "adjustment-of-status-i-485-experiences",
    "employment-based-greencard-experiences",
    "family-based-greencard-experiences",
    "i-140-experiences",
    "labor-certification-experiences",
    "usa-citizenship-experiences",
    "usa-immigrant-visa-experiences",
    "nvc-process-experiences",
    "priority-date-retrogression-experiences",
    "greencard-renewal-experiences",
    "h1b-h4-visa-experiences",
    "h4-ead-experiences",
    "l1-l2-visa-experiences",
    "student-visa-f1-f2-m1-m2-experiences",
    "fiance-visa-k1-k2-k3-k4-experiences",
    "visitor-visa-b2-experiences",
    "visa-stamping-from-canada-mexico-experiences",
    "us-visa-premium-processing-experiences",
    "opt-cpt-employment-experiences",
    "ead-workpermit-experiences",
]

_USER_AGENT = "Mozilla/5.0 (compatible; ProceedingsSeed/1.0; one-time sample run)"


def _fetch_topic_html(slug: str) -> str:
    url = f"{SITE_ROOT}/{slug}/"
    r = requests.get(url, timeout=30, headers={"User-Agent": _USER_AGENT})
    r.raise_for_status()
    return r.text


def _clean_html_text(raw: str) -> str:
    """Strip tags/decode entities from a post's raw `content` field — the
    JSON literal itself is already unescaped JSON, but the value contains
    inline HTML (<br>, &amp; etc.) from the site's rich-text post editor."""
    return BeautifulSoup(raw or "", "html.parser").get_text(separator="\n", strip=True)


def parse_topic_posts(html: str, topic_name: str = "") -> list[dict]:
    """Extract the embedded `window.immiObj.posts` JSON blob from a topic
    listing page's HTML into a list of normalized candidate dicts. Pure/no
    network — see tests/test_immihelp_seed.py.

    Deliberately drops fields we must never carry into our system:
    `ipAddress` (present in the site's own public payload — not something
    we should propagate) and the real `username`/`postedBy`/`createdBy`
    (no consent to attribute a real, identifiable person's forum handle on
    our commercial product — see posting.publish_immihelp_posting())."""
    start = html.find(_POSTS_JS_MARKER)
    if start == -1:
        return []
    start += len(_POSTS_JS_MARKER)
    try:
        obj, _end = json.JSONDecoder().raw_decode(html, start)
    except (json.JSONDecodeError, ValueError):
        return []

    out = []
    for p in obj.get("posts") or []:
        if p.get("status") != "Active":
            continue
        title = str(p.get("title") or "").strip()
        content = _clean_html_text(str(p.get("content") or ""))
        created_on = str(p.get("createdOn") or "")
        permalink = str(p.get("permalink") or "")
        post_id = p.get("id")
        if not (title and content and created_on and permalink and post_id):
            continue  # malformed entry — skip rather than crash the whole run
        out.append({
            "source_item_id": str(post_id),
            "title": title,
            "content": content,
            # the source's own recorded local date, taken as-is (not
            # converted through UTC) — the "original event_date" that must
            # be captured/retained, per IMMIHELP-SEED-PLAN.md.
            "posting_date": created_on.split("T")[0],
            "full_url": urljoin(SITE_ROOT, permalink),
            "topic": topic_name,
        })
    return out


def fetch_candidates(topic_slugs: list[str] | None = None, sleep: bool = True) -> list[dict]:
    """Fetch page-1 candidates (the ~10 most-recent posts) across every
    given topic, honoring robots.txt's crawl-delay between requests, then
    sort the combined pool most-recent-first overall. Page 2+ is
    deliberately never fetched: the site's own pagination is a client-side
    call to /api/*, which robots.txt explicitly disallows — enough topics
    are listed here that page-1-only comfortably yields well over 100
    candidates before any validate()-based filtering."""
    slugs = topic_slugs if topic_slugs is not None else TOPIC_SLUGS
    candidates = []
    for i, slug in enumerate(slugs):
        if i > 0 and sleep:
            time.sleep(_CRAWL_DELAY_SECONDS)
        try:
            html = _fetch_topic_html(slug)
        except Exception as e:  # noqa: BLE001 - one bad topic must not abort the whole run
            print(f"  WARNING: fetch failed for {slug}: {type(e).__name__}: {e}")
            continue
        candidates.extend(parse_topic_posts(html, topic_name=slug))
    candidates.sort(key=lambda c: c["posting_date"], reverse=True)
    return candidates
