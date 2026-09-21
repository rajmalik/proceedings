"""
rename_family_unspecified.py — one-time migration: rewrite the retired tag code
FAMILY-UNSPECIFIED to its replacement FAMILY-IMMIGRATION (features/ui-changes-1/
changes-2-.md) everywhere it was already frozen into published content.

Background
----------
The vocab CSV, tagging prompt, and deterministic fallback dict were renamed for
all NEW postings going forward (backend/tags-cleaned/1.2-greencard-categories.csv,
posting.py's _SYSTEM_PROMPT and _GENERIC_CATEGORY_FALLBACK). That rename does NOT
touch documents already published under the old code — a live BigQuery check found
exactly 6 such postings (channel=app), each carrying FAMILY-UNSPECIFIED in either
current_visa_or_greencard_category or visa_applying_for (never both, never more
than one value in the array). This script rewrites those 6 documents across all
three durable sinks so old and new content agree on the vocab going forward:

  1. Discovery Engine live document (structData) — re-`documents.import`
  2. GCS .json sidecar — rewritten to match
  3. BigQuery postings_metadata row — the array field updated in place

The .md body sidecar is untouched — the tag code is never embedded in the
free-text body, only in the structured tag arrays.

Idempotent: skips a case_id if it no longer carries the old code (e.g. re-run
after a partial failure), so re-running is a no-op / safe.

RUN (from backend/):
    python scripts/rename_family_unspecified.py --dry-run    # log planned changes
    python scripts/rename_family_unspecified.py              # apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_BACKEND, ".env"))

import posting  # noqa: E402
import search_client  # noqa: E402
from google.api_core.client_options import ClientOptions  # noqa: E402
from google.api_core.exceptions import NotFound  # noqa: E402
from google.cloud import discoveryengine_v1 as de  # noqa: E402

OLD = "FAMILY-UNSPECIFIED"
NEW = "FAMILY-IMMIGRATION"

# Known from a live BigQuery check (postings_metadata) before this script existed —
# the exact 6 case_ids carrying the old code, and which field holds it, so BigQuery
# can be updated precisely without a broader table scan.
KNOWN_CASES = {
    "app-2026-07-29-e59f591f": "visa_applying_for",
    "app-2026-07-29-a3087469": "current_visa_or_greencard_category",
    "app-2026-07-29-b1d781da": "current_visa_or_greencard_category",
    "app-2026-07-29-def95875": "visa_applying_for",
    "app-2026-07-29-e2a00858": "visa_applying_for",
    "app-2026-07-29-a4845fff": "current_visa_or_greencard_category",
}


def _fetch_struct(doc_client, parent: str, case_id: str) -> tuple[dict, str] | None:
    """Return (struct_data dict, content.uri) for case_id, or None if not found."""
    name = f"{parent}/documents/{case_id}"
    try:
        doc = doc_client.get_document(name=name)
    except NotFound:
        return None
    return search_client._struct_to_dict(doc.struct_data), (doc.content.uri or "")


def _rewrite_gcs_json(canonical: dict, project: str) -> None:
    from google.cloud import storage

    date_str = canonical["posting_date"]
    case_id = canonical["case_id"]
    channel = canonical["channel"]
    bucket_name = posting._bucket_name()
    base = f"{date_str}/{channel}/{case_id}"
    storage.Client(project=project).bucket(bucket_name).blob(f"{base}.json").upload_from_string(
        json.dumps(canonical, ensure_ascii=False, indent=2), content_type="application/json"
    )


def _bq_update(project: str, case_id: str, field: str, dry: bool, counters: dict) -> None:
    if dry:
        counters["bq_update"] = counters.get("bq_update", 0) + 1
        return
    try:
        from google.cloud import bigquery
    except ImportError:
        return
    table = f"{project}.postings.postings_metadata"
    sql = (
        f"UPDATE `{table}` SET {field} = "
        f"ARRAY(SELECT IF(x = @old, @new, x) FROM UNNEST({field}) AS x) "
        f"WHERE case_id = @case_id"
    )
    params = [
        bigquery.ScalarQueryParameter("old", "STRING", OLD),
        bigquery.ScalarQueryParameter("new", "STRING", NEW),
        bigquery.ScalarQueryParameter("case_id", "STRING", case_id),
    ]
    client = bigquery.Client(project=project)
    client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    counters["bq_update"] = counters.get("bq_update", 0) + 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Rename FAMILY-UNSPECIFIED -> FAMILY-IMMIGRATION in published content.")
    ap.add_argument("--dry-run", action="store_true", help="log planned changes; write nothing")
    args = ap.parse_args()
    dry = args.dry_run

    project = posting._project()
    location, datastore = posting._ds_location(), posting._datastore()
    doc_client = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=project))
    parent = (
        f"projects/{project}/locations/{location}/collections/default_collection"
        f"/dataStores/{datastore}/branches/default_branch"
    )

    mode = "DRY-RUN (no writes)" if dry else "APPLY"
    print(f"rename_family_unspecified — {mode} — project={project}\n")
    print(f"Checking {len(KNOWN_CASES)} known case_id(s):")

    counters: dict = {}
    for case_id, field in KNOWN_CASES.items():
        found = _fetch_struct(doc_client, parent, case_id)
        if found is None:
            print(f"  ! {case_id}: not found in datastore — skipping")
            counters["not_found"] = counters.get("not_found", 0) + 1
            continue
        canonical, md_uri = found
        arr = canonical.get(field) or []
        if OLD not in arr:
            print(f"  - {case_id}: {field}={arr!r} — already migrated or no longer matches, skipping")
            counters["already_ok"] = counters.get("already_ok", 0) + 1
            continue

        new_arr = [NEW if v == OLD else v for v in arr]
        print(f"  * {case_id}: {field} {arr!r} -> {new_arr!r}")
        canonical[field] = new_arr

        if dry:
            counters["planned"] = counters.get("planned", 0) + 1
            continue

        _rewrite_gcs_json(canonical, project)
        posting._import_to_datastore(canonical, md_uri)
        _bq_update(project, case_id, field, dry, counters)
        counters["applied"] = counters.get("applied", 0) + 1

    print("\nSummary:")
    for k in sorted(counters):
        print(f"  {k}: {counters[k]}")
    if dry:
        print("\n(dry-run — nothing was written)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
