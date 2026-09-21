"""
gov_news_poll.py — core poll/classify/publish logic for government-agency
news sources. See docs/ingestion/GOV-NEWS-INGESTION-PLAN.md for the design.

Shared by two callers:
  - scripts/curation/poll_gov_news.py — manual CLI runs
  - api.py's POST /internal/gov-news/poll — the Cloud Scheduler target

Sources come from news_sources.get_enabled_sources() (Firestore-backed,
read fresh every run — see docs/ingestion/GOV-NEWS-MULTI-SOURCE-CONFIG.md).
Adding a source there is picked up here with no code change or deploy.

For each enabled source with fetch_method="rss":
  1. Query BigQuery for every already-known source_item_id + content_hash
     for that source (latest row per id, in case a recently-ingested-edit
     duplicate is briefly present — see GOV-NEWS-INGESTION-PLAN.md §5.3).
  2. Fetch + parse the RSS feed.
  3. Classify each item as new / unchanged / edited against the map above.
  4. Publish new/edited items via posting.publish_gov_news_item(). A single
     item's failure is logged and skipped, not fatal to the run — its
     source_item_id will simply still look "new" (or "edited") on the next
     scheduled run and retry itself, since case_id is deterministic.
"""

from __future__ import annotations

import os
import time
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

import requests
from bs4 import BeautifulSoup

import posting
from news_sources import get_enabled_sources

GCP_PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")


def _timed(label: str, start: float) -> None:
    """Checkpoint logging added 2026-07-27 to diagnose a production hang in
    /internal/gov-news/poll: two consecutive real Cloud Scheduler triggers
    each ran for exactly the Cloud Run request timeout (300s) and were
    killed, regardless of whether there was 0 or 1 new item to publish —
    the identical work completed in 146s when run directly (not through the
    HTTP route), so the hang is somewhere in this call chain but specific to
    that invocation path. No application-level print() output survived
    either killed request (block-buffered stdout, fixed alongside this via
    Dockerfile's PYTHONUNBUFFERED=1) — these checkpoints exist to show,
    next time, exactly which step never returns."""
    print(f"  [timing] {label}: {time.monotonic() - start:.2f}s", flush=True)

# Below this length (words), the RSS description is treated as too thin to
# tag well and the full article page is fetched as a fallback — decided in
# GOV-NEWS-INGESTION-PLAN.md §3.5. Kept small/simple deliberately: this is a
# rare-case fallback, not the common path (RSS descriptions have been full
# paragraphs for every real item checked while designing this).
_THIN_DESCRIPTION_WORDS = 40

# Selector for the article body on a USCIS newsroom page (Drupal). Falls back
# to `main article` (noisier — includes title/date) if the primary selector
# isn't found, since page templates can differ across alerts/news-releases/
# fact-sheets.
_ARTICLE_BODY_SELECTORS = ["article .field--name-body", "main article"]


def _fetch_full_article_text(url: str) -> str:
    """Best-effort fallback fetch for a thin RSS description. Returns "" on
    any failure — the caller falls back to the (thin) RSS description rather
    than blocking the whole item on this."""
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        for sel in _ARTICLE_BODY_SELECTORS:
            el = soup.select_one(sel)
            if el:
                return el.get_text(separator=" ", strip=True)
    except Exception as e:  # noqa: BLE001 - best-effort fallback only
        print(f"  WARNING: full-article fetch failed for {url}: {type(e).__name__}: {e}")
    return ""


def _parse_feed(feed_url: str) -> list[dict]:
    r = requests.get(feed_url, timeout=30)
    r.raise_for_status()
    root = ElementTree.fromstring(r.text)
    items = []
    for el in root.findall(".//item"):
        title = (el.findtext("title") or "").strip()
        link = (el.findtext("link") or "").strip()
        description = (el.findtext("description") or "").strip()
        pub_date_raw = (el.findtext("pubDate") or "").strip()
        guid = (el.findtext("guid") or "").strip()
        if not (title and link and guid):
            continue  # malformed item — skip rather than crash the whole run
        try:
            posting_date = parsedate_to_datetime(pub_date_raw).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001 - fall back to today rather than fail the item
            posting_date = ""
        items.append({
            "title": title, "link": link, "description": description,
            "posting_date": posting_date, "guid": guid,
        })
    return items


def _existing_hashes(source_slug: str) -> dict[str, str]:
    """{source_item_id: content_hash} for the latest row per id — a
    recently-ingested edit can briefly leave a stale duplicate row (§5.3), so
    this always picks the most recent by ingestion_timestamp, never an
    arbitrary one."""
    try:
        from google.cloud import bigquery
        from google.api_core.exceptions import NotFound
    except ImportError:
        return {}
    client = bigquery.Client(project=GCP_PROJECT)
    table_id = f"{GCP_PROJECT}.postings.postings_metadata"
    sql = (
        f"SELECT source_item_id, content_hash FROM `{table_id}` "
        f"WHERE source_system = @source_system AND source_item_id != '' "
        f"QUALIFY ROW_NUMBER() OVER ("
        f"  PARTITION BY source_item_id ORDER BY ingestion_timestamp DESC"
        f") = 1"
    )
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("source_system", "STRING", source_slug)])
    try:
        return {row["source_item_id"]: row["content_hash"] for row in client.query(sql, job_config=cfg).result()}
    except NotFound:
        return {}  # table doesn't exist yet — first-ever run, everything is new
    except Exception as e:  # noqa: BLE001 - treat as "nothing known yet" rather than crash the run
        print(f"  WARNING: could not load existing hashes ({type(e).__name__}: {e}); treating all items as new")
        return {}


def poll_source(source_slug: str, source: dict, dry_run: bool = False, force: bool = False) -> dict:
    """Poll one already-resolved source config. Returns a JSON-serializable
    summary dict — used both for the CLI's printed output and the internal
    API route's response body.

    Takes `source` as a plain dict rather than looking it up itself, so this
    function has no dependency on *how* sources are stored (Firestore today)
    — that's entirely news_sources.py's concern; poll_all() below resolves
    the registry once per run and passes each source in.

    `force=True` bypasses the content_hash dedup check entirely (every item
    is republished as an edit) — NOT for normal/scheduled runs, only for a
    corrective re-publish after fixing a bug that affected already-published
    items but couldn't be reflected in BigQuery's dedup map yet (e.g. rows
    still in BigQuery's ~90-min streaming buffer, so a DELETE-based cleanup
    couldn't run — the Discovery Engine/GCS side can still be corrected
    immediately since those aren't subject to the same restriction)."""
    t0 = time.monotonic()
    if source["fetch_method"] != "rss":
        return {"source": source_slug, "skipped": True,
                "reason": f"fetch_method={source['fetch_method']!r} has no adapter yet"}

    known = {} if force else _existing_hashes(source_slug)
    _timed(f"{source_slug}: _existing_hashes ({len(known)} known)", t0)
    items = _parse_feed(source["feed_url"])
    _timed(f"{source_slug}: _parse_feed ({len(items)} items)", t0)

    counts = {"new": 0, "edited": 0, "unchanged": 0, "failed": 0}
    published: list[dict] = []
    failures: list[dict] = []
    for i, item in enumerate(items):
        # Resolve the description BEFORE hashing, not after — content_hash
        # must be computed from the exact text that gets published (and
        # therefore stored), or classification permanently disagrees with
        # itself. Bug found live: hashing the raw RSS description here,
        # while the thin-description fallback below could substitute a
        # fetched full-article text for the description that actually gets
        # stored, meant the STORED hash (post-fallback) could never match a
        # freshly-computed classification hash (pre-fallback) for any item
        # whose RSS description was thin — every poll re-classified those
        # items as "edited" forever, even completely unchanged ones.
        if i > 0 and i % 50 == 0:
            _timed(f"{source_slug}: loop checkpoint ({i}/{len(items)} items processed)", t0)

        description = item["description"]
        if len(description.split()) < _THIN_DESCRIPTION_WORDS:
            t_fetch = time.monotonic()
            fuller = _fetch_full_article_text(item["link"])
            fetch_elapsed = time.monotonic() - t_fetch
            # ~170/250 USCIS items hit this path every run (thin RSS
            # descriptions) — logging every one is too noisy for daily
            # production logs (confirmed via this exact instrumentation,
            # 2026-07-27: 170 fetches, ~0.12-0.3s each, ~37s total, not the
            # root cause of that day's failures). Only flag a genuine
            # outlier, so a future real stall is still visible without the
            # noise.
            if fetch_elapsed > 3.0:
                _timed(f"{source_slug}: SLOW thin-description fallback fetch for {item['guid']!r}", t_fetch)
            if fuller:
                description = fuller

        content_hash = posting.content_hash_for(item["title"], description)
        prior_hash = known.get(item["guid"])
        if not force and prior_hash == content_hash:
            counts["unchanged"] += 1
            continue
        is_edit = prior_hash is not None
        counts["edited" if is_edit else "new"] += 1

        if dry_run:
            published.append({"title": item["title"], "guid": item["guid"],
                              "action": "edited" if is_edit else "new", "dry_run": True})
            continue
        try:
            t_pub = time.monotonic()
            result = posting.publish_gov_news_item(
                title=item["title"], description=description,
                source_system=source_slug, author_handle=source["display_name"],
                source_item_id=item["guid"], full_url=item["link"],
                posting_date=item["posting_date"] or "", channel=source["channel"],
                content_type=source.get("content_type", "news"),
                is_edit=is_edit,
            )
            _timed(f"{source_slug}: publish_gov_news_item for {item['guid']!r}", t_pub)
            published.append({"title": item["title"], "case_id": result["case_id"],
                              "action": "edited" if is_edit else "new"})
        except Exception as e:  # noqa: BLE001 - one bad item must not abort the whole run
            counts["failed"] += 1
            failures.append({"title": item["title"], "guid": item["guid"],
                             "error": f"{type(e).__name__}: {e}"})

    _timed(f"{source_slug}: poll_source total", t0)
    return {
        "source": source_slug, "display_name": source["display_name"],
        "items_in_feed": len(items), "already_known": len(known),
        **counts, "published": published, "failures": failures,
    }


def poll_all(source_slug: str = "", dry_run: bool = False, force: bool = False) -> list[dict]:
    """Poll one source (if source_slug given) or every enabled source.
    Resolves the registry from Firestore exactly once per call — a fresh
    read every run, so a source added/edited/disabled since the last run is
    reflected immediately, with no restart or redeploy needed."""
    t0 = time.monotonic()
    sources = get_enabled_sources()
    _timed(f"poll_all: get_enabled_sources ({len(sources)} enabled)", t0)
    if source_slug:
        if source_slug not in sources:
            return [{"source": source_slug, "skipped": True,
                     "reason": "not found, disabled, or not automatable (wrong content_license) — see news_sources.get_enabled_sources()"}]
        sources = {source_slug: sources[source_slug]}
    return [poll_source(slug, cfg, dry_run=dry_run, force=force) for slug, cfg in sources.items()]
