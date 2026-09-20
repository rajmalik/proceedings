"""official_reference_poll.py — scheduled ingestion of authoritative official
reference pages into DS-1 (the Phase-2 path in
docs/ingestion/GROUNDING-INGESTION-PLAN.md).

Mirrors gov_news_poll.py, but for static gov *reference* pages (not RSS news):
each SOURCES entry is fetched, its body extracted, and upserted via
posting.publish_official_reference_item() — which keys the doc on the URL (one
stable doc per page) and SKIPS unchanged pages (content_hash guardrail). Safe to
run on any cadence; an unchanged run is a no-op.

Triggered by Cloud Scheduler → POST /internal/official-reference/poll (api.py),
gated by _require_internal(). One source failing is logged and skipped, never
fatal to the run.
"""
import json
import os
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# Registry of authoritative reference pages to keep grounded — now CONFIGURABLE
# via config/official_reference_sources.default.json (add/remove sources there,
# no code change). Still version-controlled (a trust-sensitive, slowly-changing
# set) rather than the Firestore news_sources registry, which is scoped to RSS
# *news*. Override the path with OFFICIAL_REFERENCE_SOURCES_PATH. The built-in
# default below is the safety net if the file is missing/unreadable.
_CONFIG_PATH = os.getenv(
    "OFFICIAL_REFERENCE_SOURCES_PATH",
    str(Path(__file__).resolve().parent / "config" / "official_reference_sources.default.json"),
)

_DEFAULT_SOURCES = [
    {
        "url": "https://www.ice.gov/sevis",
        "title": "Student and Exchange Visitor Program (SEVP) / SEVIS",
        "source_system": "ice",
        "author": "ICE SEVP",
    },
    {
        "url": "https://studyinthestates.dhs.gov/students",
        "title": "Study in the States — Students (F/M)",
        "source_system": "study-in-the-states",
        "author": "DHS Study in the States",
    },
]


def load_sources(path: str = _CONFIG_PATH) -> list[dict]:
    """Load the source registry from the JSON config. Only entries with a `url`
    and a `source_system` are kept. Falls back to the built-in default if the
    file is missing/unreadable/empty — the scheduled poll must never crash on a
    bad config."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("sources") if isinstance(data, dict) else data
        valid = [s for s in (raw or []) if s.get("url") and s.get("source_system")]
        if valid:
            return valid
        print(f"official-reference: sources config {path} had no valid entries; using built-in default")
    except FileNotFoundError:
        print(f"official-reference: sources config {path} not found; using built-in default")
    except Exception as e:  # noqa: BLE001 - never let a bad config crash the poll
        print(f"official-reference: could not load sources config {path} ({type(e).__name__}: {e}); using built-in default")
    return list(_DEFAULT_SOURCES)


SOURCES = load_sources()

_BODY_SELECTORS = ["main article", "article", "main", "#main-content", "#content", "body"]
_MIN_WORDS = 50


def fetch_page_text(url: str) -> str:
    """Best-effort single-page body-text extraction: strip script/style/nav/
    header/footer chrome, then take the first container with real content."""
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


def poll_all(dry_run: bool = False) -> list[dict]:
    """Fetch + upsert every registered reference page. Returns a per-source
    summary (`status`: published | skipped | failed). One source's failure is
    logged and skipped — never fatal to the run (same contract as gov-news)."""
    import posting

    results: list[dict] = []
    for src in load_sources():  # re-read each run so a config change is picked up
        url = src["url"]
        row: dict = {"url": url, "source_system": src["source_system"]}
        try:
            body = fetch_page_text(url)
            words = len(body.split())
            if words < _MIN_WORDS:
                row.update(status="failed", reason=f"thin content ({words} words)")
                print(f"official-reference: {url} — thin content ({words} words); skipping")
                results.append(row)
                continue
            res = posting.publish_official_reference_item(
                title=src["title"], body_text=body, source_system=src["source_system"],
                full_url=url, author_handle=src.get("author", ""), dry_run=dry_run,
            )
            if res.get("skipped"):
                row.update(status="skipped", reason="unchanged")
                print(f"official-reference: {url} — unchanged; skipped")
            else:
                row.update(status="published", case_id=res.get("case_id"),
                           indexed=res.get("indexed"), words=words)
                print(f"official-reference: {url} — published {res.get('case_id')} ({words} words)")
        except Exception as e:  # noqa: BLE001 - one source must not kill the whole run
            row.update(status="failed", reason=f"{type(e).__name__}: {e}")
            print(f"official-reference: {url} — FAILED: {type(e).__name__}: {e}")
        results.append(row)
    return results
