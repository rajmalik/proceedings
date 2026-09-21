"""
news_sources.py — Firestore-backed, deploy-free registry of content
sources: official-site news updates AND forum postings (e.g. Reddit).

See docs/ingestion/GOV-NEWS-INGESTION-PLAN.md §4 for the original design,
and docs/ingestion/GOV-NEWS-MULTI-SOURCE-CONFIG.md for why this moved from
a hardcoded Python dict to Firestore, and for §5's `content_type` design.

Sources live in the `news_sources` Firestore collection (one document per
source, document id = slug) — NOT in this file. Adding a new source is a
Firestore write (via scripts/curation/manage_news_sources.py), not a code
change and not a deploy: gov_news_poll.py's poll_all() calls
get_enabled_sources() fresh at the start of every run, so a newly-added
source is picked up automatically the next time the scheduled job fires.

Two independent safety gates, both required for a source to be auto-polled
— see get_enabled_sources():

- `content_license` — must never be assumed, see GOV-NEWS-INGESTION-PLAN.md
  §4.2. `public_domain` (federal government works, 17 U.S.C. § 105) must be
  independently confirmed per source, not inherited from any other entry. A
  `copyrighted` source (e.g. any forum/Reddit source) needs the Reddit-style
  paraphrase posture (D-017), which this pipeline does not implement — it's
  deliberately excluded from automated publishing, matching how
  `publish_reddit_posting()` has stayed a manually-invoked, human-curated
  path from the start (see PATH-B-PROVENANCE-PLAN.md), never a polled one.
- `content_type` — "news" (official-site updates, e.g. USCIS/gov agencies)
  is the only type with a publish handler today (`publish_gov_news_item()`,
  which assumes official/authoritative content: no PII scrub, no moderation
  check, a fixed per-source author handle). "forum_posting" (community
  forums like Reddit — genuinely different concerns: user-generated
  content, PII risk, needs human curation) is a valid, storable value —
  representing a source like this in the same registry is the point of
  this field — but is never auto-published through the news pipeline,
  regardless of `content_license`, because that pipeline is simply the
  wrong handler for that content's risk profile.

A misconfigured entry can never silently start auto-publishing something
unsafe: get_enabled_sources() excludes (with a loud warning, not a silent
skip) any source failing either gate.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

REQUIRED_FIELDS = {
    "display_name", "site_url", "fetch_method", "feed_url",
    "source_category", "content_license", "content_type", "channel",
}

# The only values this pipeline is actually safe to run unattended for —
# see the module docstring. Anything else is excluded from
# get_enabled_sources() regardless of the source's `enabled` flag.
_SAFE_TO_AUTOMATE_LICENSE = "public_domain"
_SAFE_TO_AUTOMATE_CONTENT_TYPE = "news"

# Documented, valid values — not enforced here (that's
# manage_news_sources.py's job, at add-time), but the canonical list this
# module's docstring and get_enabled_sources() refer to.
VALID_CONTENT_TYPES = {"news", "forum_posting"}

_COLLECTION = "news_sources"


def _db():
    from google.cloud import firestore
    project = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
    return firestore.Client(project=project)


def list_all_sources() -> dict[str, dict]:
    """Every configured source, including disabled ones and any with a
    content_license this pipeline can't safely automate yet — for the
    management CLI's listing. Use get_enabled_sources() for the poll job."""
    docs = _db().collection(_COLLECTION).stream()
    return {d.id: d.to_dict() for d in docs}


def get_enabled_sources() -> dict[str, dict]:
    """Sources the poll job should actually process this run: `enabled` is
    not False, all required fields present, content_license is
    "public_domain", AND content_type is "news" — see the module docstring
    for why both gates are independently required (license = "is this
    legally safe to store verbatim", content_type = "does a publish
    handler for this content's risk profile even exist"). Read fresh from
    Firestore on every call (no caching), so a config change is visible on
    the very next poll run, scheduled or manual, with no restart or
    redeploy needed."""
    out: dict[str, dict] = {}
    for slug, cfg in list_all_sources().items():
        if cfg.get("enabled") is False:
            continue
        missing = REQUIRED_FIELDS - set(cfg)
        if missing:
            print(f"news_sources: skipping {slug!r} — missing required field(s): {sorted(missing)}")
            continue
        if cfg.get("content_license") != _SAFE_TO_AUTOMATE_LICENSE:
            print(f"news_sources: skipping {slug!r} — content_license={cfg.get('content_license')!r} "
                  f"is not automatable yet (only {_SAFE_TO_AUTOMATE_LICENSE!r} is); "
                  f"see GOV-NEWS-INGESTION-PLAN.md §4.2")
            continue
        if cfg.get("content_type") != _SAFE_TO_AUTOMATE_CONTENT_TYPE:
            print(f"news_sources: skipping {slug!r} — content_type={cfg.get('content_type')!r} "
                  f"has no automated publish handler yet (only {_SAFE_TO_AUTOMATE_CONTENT_TYPE!r} "
                  f"does); see GOV-NEWS-MULTI-SOURCE-CONFIG.md §5")
            continue
        out[slug] = cfg
    return out


def get_source(slug: str) -> dict | None:
    snap = _db().collection(_COLLECTION).document(slug).get()
    return snap.to_dict() if snap.exists else None


def upsert_source(slug: str, **fields) -> None:
    """Create or update a source. Only touches the fields passed — an
    upsert, not a full replace, so e.g. `set_enabled()` doesn't clobber
    everything else. Stamps created_at (once) / updated_at (always)."""
    now = datetime.now(timezone.utc).isoformat()
    ref = _db().collection(_COLLECTION).document(slug)
    existing = ref.get()
    payload = dict(fields)
    payload["updated_at"] = now
    if not existing.exists:
        payload["created_at"] = now
    ref.set(payload, merge=True)


def set_enabled(slug: str, enabled: bool) -> None:
    upsert_source(slug, enabled=enabled)


def remove_source(slug: str) -> bool:
    """Hard delete. Returns False if the slug didn't exist."""
    ref = _db().collection(_COLLECTION).document(slug)
    if not ref.get().exists:
        return False
    ref.delete()
    return True
