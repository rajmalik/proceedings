#!/usr/bin/env python3
"""SPIKE — a Vertex AI Search *website* data store (DS-2 public tier) scoped to a
few authoritative USCIS areas, to measure how well a BASIC (unverified-domain)
website data store grounds broad "answerable from uscis.gov" questions.

This is the option-(a) spike from docs/ingestion — NOT wired into the app. It
creates real GCP resources (a data store + a search engine + target sites); use
`delete` to tear them down.

  python scripts/spike_public_website_datastore.py create   # data store + engine + target sites
  python scripts/spike_public_website_datastore.py status   # indexing status of each target site
  python scripts/spike_public_website_datastore.py query "How long is adjustment of status taking?"
  python scripts/spike_public_website_datastore.py delete   # tear it all down

Env: GCP_PROJECT_ID (+ ADC). Basic website indexing does NOT require domain
verification, but coverage/features are limited vs. advanced indexing (which we
can't use — we don't own uscis.gov).
"""
import os
import sys
from pathlib import Path

from google.api_core.client_options import ClientOptions
from google.cloud import discoveryengine_v1 as de

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

_PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
_LOCATION = "global"
_DS_ID = "uscis-public-ref"
_ENGINE_ID = "uscis-public-search"
_COLLECTION = f"projects/{_PROJECT}/locations/{_LOCATION}/collections/default_collection"

# The five USCIS areas to include (provided_uri_pattern — no scheme, trailing * to
# include everything under the path). These "do not need daily refresh."
_URI_PATTERNS = [
    "egov.uscis.gov/processing-times*",
    "www.uscis.gov/green-card/green-card-processes-and-procedures/adjustment-of-status*",
    "www.uscis.gov/green-card/green-card-processes-and-procedures/employment-authorization-document*",
    "www.uscis.gov/green-card/green-card-processes-and-procedures/visa-availability-and-priority-dates*",
    "www.uscis.gov/family*",
]


def _opts():
    return ClientOptions(quota_project_id=_PROJECT)


def _require_project():
    if not _PROJECT:
        print("ERROR: set GCP_PROJECT_ID")
        sys.exit(1)


def create() -> None:
    _require_project()
    ds_client = de.DataStoreServiceClient(client_options=_opts())
    # 1) website data store (basic public-website indexing)
    ds_name = f"{_COLLECTION}/dataStores/{_DS_ID}"
    try:
        ds_client.get_data_store(name=ds_name)
        print(f"data store exists: {_DS_ID}")
    except Exception:
        print(f"creating website data store {_DS_ID} ...")
        op = ds_client.create_data_store(
            parent=_COLLECTION, data_store_id=_DS_ID,
            data_store=de.DataStore(
                display_name="USCIS public reference (spike)",
                industry_vertical=de.IndustryVertical.GENERIC,
                solution_types=[de.SolutionType.SOLUTION_TYPE_SEARCH],
                content_config=de.DataStore.ContentConfig.PUBLIC_WEBSITE,
            ),
        )
        op.result(timeout=180)
        print("  data store created")

    # 2) target sites (INCLUDE patterns) on the data store's site search engine
    site_client = de.SiteSearchEngineServiceClient(client_options=_opts())
    sse = f"{ds_name}/siteSearchEngine"
    for pat in _URI_PATTERNS:
        try:
            op = site_client.create_target_site(
                parent=sse,
                target_site=de.TargetSite(provided_uri_pattern=pat, type_=de.TargetSite.Type.INCLUDE),
            )
            op.result(timeout=120)
            print(f"  + target site: {pat}")
        except Exception as e:  # noqa: BLE001 - already-exists etc.
            print(f"  (target site {pat}: {type(e).__name__}: {str(e)[:80]})")

    # 3) a search engine (STANDARD tier + LLM add-on) over the data store
    eng_client = de.EngineServiceClient(client_options=_opts())
    eng_name = f"{_COLLECTION}/engines/{_ENGINE_ID}"
    try:
        eng_client.get_engine(name=eng_name)
        print(f"engine exists: {_ENGINE_ID}")
    except Exception:
        print(f"creating engine {_ENGINE_ID} ...")
        op = eng_client.create_engine(
            parent=_COLLECTION, engine_id=_ENGINE_ID,
            engine=de.Engine(
                display_name="USCIS public search (spike)",
                solution_type=de.SolutionType.SOLUTION_TYPE_SEARCH,
                industry_vertical=de.IndustryVertical.GENERIC,
                data_store_ids=[_DS_ID],
                search_engine_config=de.Engine.SearchEngineConfig(
                    search_tier=de.SearchTier.SEARCH_TIER_STANDARD,
                    search_add_ons=[de.SearchAddOn.SEARCH_ADD_ON_LLM],
                ),
            ),
        )
        op.result(timeout=180)
        print("  engine created")
    print(f"\nDONE. engine_id = {_ENGINE_ID}. Basic website indexing runs async — "
          "check `status`, then `query` in a while (initial crawl can take a while).")


def status() -> None:
    _require_project()
    site_client = de.SiteSearchEngineServiceClient(client_options=_opts())
    sse = f"{_COLLECTION}/dataStores/{_DS_ID}/siteSearchEngine"
    print("target sites:")
    for ts in site_client.list_target_sites(parent=sse):
        pat = ts.provided_uri_pattern or ts.generated_uri_pattern
        print(f"  {ts.indexing_status.name:28s}  {pat}"
              + (f"  (failure: {ts.failure_reason})" if ts.failure_reason else ""))


def query(q: str) -> None:
    _require_project()
    import search_client
    res = search_client.answer_query(q, _PROJECT, _LOCATION, _ENGINE_ID)
    print(f"is_fallback: {res['is_fallback']}  | chunks: {len(res['chunks'])}")
    for c in res["chunks"]:
        print(f"  source: {c.get('source')}")
    print("\nanswer:\n" + (res["answer"][:800]))


def delete() -> None:
    _require_project()
    eng_client = de.EngineServiceClient(client_options=_opts())
    ds_client = de.DataStoreServiceClient(client_options=_opts())
    try:
        eng_client.delete_engine(name=f"{_COLLECTION}/engines/{_ENGINE_ID}").result(timeout=180)
        print("engine deleted")
    except Exception as e:  # noqa: BLE001
        print(f"engine delete: {type(e).__name__}: {str(e)[:80]}")
    try:
        ds_client.delete_data_store(name=f"{_COLLECTION}/dataStores/{_DS_ID}").result(timeout=180)
        print("data store deleted")
    except Exception as e:  # noqa: BLE001
        print(f"data store delete: {type(e).__name__}: {str(e)[:80]}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "create":
        create()
    elif cmd == "status":
        status()
    elif cmd == "query":
        query(sys.argv[2] if len(sys.argv) > 2 else "How long is adjustment of status taking?")
    elif cmd == "delete":
        delete()
    else:
        print(__doc__)
