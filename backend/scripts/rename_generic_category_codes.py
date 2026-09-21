"""
rename_generic_category_codes.py — one-time migration for the 1.2 casing change:
rewrite the three UPPERCASE generic greencard codes to their lowercase-kebab
replacements wherever they were already frozen into stored content.

  ADJUSTMENT-OF-STATUS   -> adjustment-of-status
  FAMILY-IMMIGRATION     -> family-immigration
  EMPLOYMENT-IMMIGRATION -> employment-immigration

Background
----------
1.2-greencard-categories.csv was uniformly uppercase, which put these three
DESCRIPTIVE codes in the same visual class as real category codes (EB-2, IR-1,
DV). Uppercase is now reserved for codes and abbreviations; a descriptive phrase
is lowercase-kebab, matching 1.6 and 1.10. See
docs/tagging/VISA-VOCAB-GAPS-AND-CURATION-BLOCKERS.md.

The CSV, the tagging prompt and the deterministic fallback dict were renamed for
all NEW content. This script covers content stored under the OLD codes.

**A live check at rename time found NOTHING to migrate** — zero Firestore
groups, zero profiles, zero indexed postings carried any of the three. This
script exists because that gap between "renamed in code" and "deployed" is not
instantaneous: anything published in between would still carry an old code.
Run it (--dry-run first) before deploying, and it will almost certainly report
zero changes, which is the expected result.

Unlike rename_family_unspecified.py this does NOT hardcode case_ids — there was
no known-bad set to enumerate — so it scans instead:

  1. Firestore `groups`      — criteria.{current_visa_or_greencard_category,
                               visa_applying_for, tags}
  2. Firestore `users`       — profile.{current_visa_or_greencard_category,
                               visa_applying_for}
  3. Discovery Engine        — reported only. Rewriting a published posting
                               needs the GCS sidecar + BigQuery row updated in
                               the same pass; rename_family_unspecified.py is
                               the worked example to copy if this ever fires.

Idempotent: a doc that no longer carries an old code is skipped, so re-running
after a partial failure is safe.

RUN (from backend/):
    python scripts/rename_generic_category_codes.py --dry-run   # log planned changes
    python scripts/rename_generic_category_codes.py             # apply
"""

from __future__ import annotations

import argparse
import os
import sys

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_BACKEND, ".env"))

from google.cloud import firestore  # noqa: E402

RENAMES = {
    "ADJUSTMENT-OF-STATUS": "adjustment-of-status",
    "FAMILY-IMMIGRATION": "family-immigration",
    "EMPLOYMENT-IMMIGRATION": "employment-immigration",
}

# Every field, in either collection, whose value is a list of 1.2/1.1 codes.
LIST_FIELDS = ("current_visa_or_greencard_category", "visa_applying_for", "tags")


def _migrate_lists(container: dict) -> tuple[dict, list[str]]:
    """Return (patch, notes) for the renameable list fields of one dict.
    `patch` is empty when nothing in this container needs changing."""
    patch: dict = {}
    notes: list[str] = []
    for field in LIST_FIELDS:
        arr = container.get(field)
        if not isinstance(arr, list):
            continue
        new_arr = [RENAMES.get(v, v) for v in arr]
        if new_arr != arr:
            patch[field] = new_arr
            notes.append(f"{field}: {arr!r} -> {new_arr!r}")
    return patch, notes


def _migrate_groups(db, dry: bool, counters: dict) -> None:
    print("\ngroups/ — criteria")
    for doc in db.collection("groups").stream():
        data = doc.to_dict() or {}
        criteria = data.get("criteria")
        if not isinstance(criteria, dict):
            continue
        patch, notes = _migrate_lists(criteria)
        if not patch:
            continue
        print(f"  * {doc.id}: " + "; ".join(notes))
        counters["groups"] = counters.get("groups", 0) + 1
        if not dry:
            doc.reference.update({f"criteria.{k}": v for k, v in patch.items()})


def _migrate_profiles(db, dry: bool, counters: dict) -> None:
    print("\nusers/ — profile")
    for doc in db.collection("users").stream():
        data = doc.to_dict() or {}
        patch, notes = _migrate_lists(data)
        if not patch:
            continue
        print(f"  * {doc.id}: " + "; ".join(notes))
        counters["profiles"] = counters.get("profiles", 0) + 1
        if not dry:
            doc.reference.update(patch)


def _report_postings(counters: dict) -> None:
    """Published postings are reported, never rewritten here — see the module
    docstring. A hit means a three-sink rewrite is needed, not a quick patch.

    Needs Discovery Engine credentials, which plain local ADC does not have
    (it 400s with RESOURCE_PROJECT_INVALID). The skip is printed rather than
    swallowed, so a run that could NOT check says so instead of looking clean;
    treat a skip as "unknown", not "none". Cross-check with the deployed API's
    /api/search if it matters."""
    print("\npostings — datastore (report only)")
    try:
        import search_client
        # Resolved exactly as api.py does — the search ENGINE (app) id, which
        # is not the datastore id, and the datastore location, which is not
        # GCP_REGION. Getting either wrong 400s with RESOURCE_PROJECT_INVALID.
        project = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
        location = os.getenv("GCP_VERTEX_DATASTORE_LOCATION", "global")
        engine = os.getenv("GCP_VERTEX_SEARCH_APP_ID", "imm-postings-search-app")
        hits = 0
        for old in RENAMES:
            res = search_client.search_postings(
                query=old, project_id=project, location=location,
                engine_id=engine, page_size=50) or {}
            for r in (res.get("results") or []):
                if old in " ".join(str(v) for v in (r.get("tags") or [])):
                    hits += 1
                    print(f"  ! {r.get('case_id')}: carries {old} — needs a "
                          f"datastore+GCS+BigQuery rewrite (see "
                          f"rename_family_unspecified.py)")
        counters["postings_needing_rewrite"] = hits
        if not hits:
            print("  none")
    except Exception as e:  # search is optional/credentialed — never fail the run
        print(f"  (skipped: {type(e).__name__}: {e})")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Rename the 3 uppercase generic 1.2 codes to lowercase-kebab.")
    ap.add_argument("--dry-run", action="store_true", help="log planned changes; write nothing")
    args = ap.parse_args()
    dry = args.dry_run

    print(f"rename_generic_category_codes — {'DRY-RUN (no writes)' if dry else 'APPLY'}")
    for old, new in RENAMES.items():
        print(f"  {old} -> {new}")

    db = firestore.Client()
    counters: dict = {}
    _migrate_groups(db, dry, counters)
    _migrate_profiles(db, dry, counters)
    _report_postings(counters)

    print("\nSummary:")
    if not counters:
        print("  nothing to migrate")
    for k in sorted(counters):
        print(f"  {k}: {counters[k]}")
    if dry:
        print("\n(dry-run — nothing was written)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
