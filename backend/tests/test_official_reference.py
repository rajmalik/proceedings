#!/usr/bin/env python3
"""Tests for the official_reference publish path (Phase-2 minimal slice —
docs/ingestion/GROUNDING-INGESTION-PLAN.md):

  unit         (offline, no-GCP) — publish_official_reference_item field logic +
               the seed driver's HTML body extraction. Stubs _extract()/validate()
               and uses dry_run=True so nothing touches GCS/datastore/BigQuery.
  integration  (LIVE GCP, ADC) — a real round-trip: publish a clearly-synthetic
               official_reference doc into DS-1, verify placement + struct fields
               via the DocumentServiceClient, then delete it in cleanup.

Run:  python tests/test_official_reference.py [unit|integration|all]
`unit` is the default and is wired into the no-GCP CI gate.
"""
import hashlib
import os
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))               # backend/ on path
sys.path.insert(0, str(_BACKEND / "scripts"))   # scripts/ on path (seed driver)
import posting  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


URL = "https://www.ice.gov/sevis"
_STUB_EXTRACT = lambda t, d: {  # noqa: E731 - test stub
    "tags": ["student-visa", "sevis", "news-update"],
    "background_summary": "SEVP/SEVIS overview.",
    "concerns_or_questions_summary": "How does SEVIS work?",
    "language": "en",
}


def _publish(**over):
    kw = dict(
        title="Student and Exchange Visitor Program",
        body_text="SEVIS tracks F-1 and M-1 nonimmigrant students and J-1 exchange visitors.",
        source_system="ice",
        full_url=URL,
        as_of_date="2026-09-19",
        author_handle="ICE SEVP",
        dry_run=True,
    )
    kw.update(over)
    return posting.publish_official_reference_item(**kw)


# ---------------------------------------------------------------------------
# Unit — publish_official_reference_item field logic (offline)
# ---------------------------------------------------------------------------

def run_unit_publish() -> None:
    print("\nUnit A/B/C/D — publish_official_reference_item")
    orig_extract, orig_validate = posting._extract, posting.validate
    posting._extract = _STUB_EXTRACT
    posting.validate = lambda c: []  # vocab validation covered by test_posting_tagging
    try:
        res = _publish()
        c = res["canonical"]

        check("A1 dry_run does not index", res["indexed"] is False and res.get("dry_run") is True)
        check("A2 doc_kind == official_reference", c["doc_kind"] == "official_reference")
        check("A3 channel == official", c["channel"] == "official")
        check("A4 ingestion_method == official_fetch", c["ingestion_method"] == "official_fetch")
        check("A5 source_system == ice", c["source_system"] == "ice")
        check("A6 author_handle preserved", c["author_handle"] == "ICE SEVP")
        check("A7 full_url preserved", c["full_url"] == URL)
        check("A8 posting_date == as_of_date", c["posting_date"] == "2026-09-19")

        check("B1 news-update stripped (not news)", "news-update" not in c["tags"])
        check("B2 legitimate tags kept", "sevis" in c["tags"] and "student-visa" in c["tags"])

        short = hashlib.sha256(URL.encode()).hexdigest()[:8]
        check("C1 case_id scheme", c["case_id"] == f"official-ice-2026-09-19-{short}")
        check("C2 gcs prefix under /official/", "/official/" in c["gcs_path"])
        check("C3 idempotent case_id on re-ingest", _publish()["case_id"] == res["case_id"])
        check("C4 new as_of_date supersedes", _publish(as_of_date="2026-10-01")["case_id"] != res["case_id"])
        check("C5 different URL → different case_id",
              _publish(full_url="https://www.ice.gov/other")["case_id"] != res["case_id"])

        try:
            _publish(as_of_date="")
            check("D1 empty as_of_date rejected", False)
        except ValueError:
            check("D1 empty as_of_date rejected", True)

        # D2: extraction failure → publish with minimal tags, does not crash
        posting._extract = lambda t, d: (_ for _ in ()).throw(RuntimeError("gemini down"))
        rf = _publish()
        check("D2 extraction failure still builds official_reference doc",
              rf["canonical"]["doc_kind"] == "official_reference")
        check("D2 extraction failure yields no news-update", "news-update" not in rf["canonical"]["tags"])
    finally:
        posting._extract, posting.validate = orig_extract, orig_validate


# ---------------------------------------------------------------------------
# Unit — seed driver HTML body extraction (offline, mocked fetch)
# ---------------------------------------------------------------------------

def run_unit_driver() -> None:
    print("\nUnit E — seed_official_reference.fetch_page_text")
    import seed_official_reference as driver

    body_para = (
        "SEVIS tracks F-1 and M-1 nonimmigrant students and J-1 exchange visitors. "
        "The I-901 SEVIS fee is required before a student can be issued a visa, and "
        "SEVP certifies the schools that may enroll these students under federal "
        "immigration regulations governing student and exchange visitor status today."
    )
    html = (
        "<html><head><title>t</title><style>.x{}</style></head><body>"
        "<nav>Home About Menu Search</nav><header>Site Header Banner</header>"
        f"<main><article><h1>SEVP</h1><p>{body_para}</p></article></main>"
        "<footer>Footer privacy links contact</footer>"
        "<script>console.log('tracker')</script></body></html>"
    )

    class _FakeResp:
        text = html
        def raise_for_status(self):  # noqa: D401
            return None

    orig_get = driver.requests.get
    driver.requests.get = lambda *a, **k: _FakeResp()
    try:
        text = driver.fetch_page_text("https://example.test/x")
        check("E1 body text extracted", "SEVIS tracks F-1 and M-1" in text)
        check("E2 nav chrome stripped", "Home About Menu" not in text)
        check("E3 footer chrome stripped", "Footer privacy links" not in text)
        check("E4 script stripped", "tracker" not in text)
    finally:
        driver.requests.get = orig_get


# ---------------------------------------------------------------------------
# Unit — dedup guardrail (skip_if_unchanged), offline
# ---------------------------------------------------------------------------

def run_unit_dedup() -> None:
    print("\nUnit F — dedup guardrail (skip_if_unchanged)")
    names = ("_extract", "validate", "_bq_content_hash",
             "_write_gcs", "_import_to_datastore", "_write_bigquery")
    orig = {n: getattr(posting, n) for n in names}
    posting._extract = _STUB_EXTRACT
    posting.validate = lambda c: []
    posting._write_gcs = lambda c, body: ("gs://test/md", "gs://test/json")
    posting._import_to_datastore = lambda c, uri: None
    posting._write_bigquery = lambda c, **k: None
    same_hash = posting.content_hash_for("T", "B")

    def pub(**over):
        kw = dict(title="T", body_text="B", source_system="ice", full_url=URL,
                  as_of_date="2026-09-19", dry_run=False)
        kw.update(over)
        return posting.publish_official_reference_item(**kw)

    try:
        posting._bq_content_hash = lambda ss, sid: same_hash  # unchanged
        r1 = pub()
        check("F1 unchanged content is skipped (no write)",
              r1.get("skipped") is True and r1.get("indexed") is False)

        r2 = pub(dry_run=True)
        check("F2 dry_run bypasses dedup (not skipped)",
              not r2.get("skipped") and "canonical" in r2)

        posting._bq_content_hash = lambda ss, sid: "a-different-hash"  # changed
        r3 = pub()
        check("F3 changed content publishes (indexed)",
              r3.get("indexed") is True and not r3.get("skipped"))

        posting._bq_content_hash = lambda ss, sid: None  # never ingested
        r4 = pub()
        check("F4 new source publishes (indexed)",
              r4.get("indexed") is True and not r4.get("skipped"))

        posting._bq_content_hash = lambda ss, sid: same_hash  # matches, but flag off
        r5 = pub(skip_if_unchanged=False)
        check("F5 skip_if_unchanged=False publishes despite match",
              r5.get("indexed") is True and not r5.get("skipped"))
    finally:
        for n, v in orig.items():
            setattr(posting, n, v)


# ---------------------------------------------------------------------------
# Integration — live round-trip into DS-1 with cleanup
# ---------------------------------------------------------------------------

def run_integration() -> None:
    print("\nIntegration — live round-trip (publish → verify placement → delete)")
    project = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
    if not project:
        print("  SKIP: GCP_PROJECT_ID not set (live GCP required)")
        return
    import secrets
    from google.api_core.client_options import ClientOptions
    from google.cloud import discoveryengine_v1 as de

    tag = secrets.token_hex(4)
    url = f"https://example.test/official-ref-e2e-{tag}"
    res = posting.publish_official_reference_item(
        title=f"E2E official reference {tag}",
        body_text=(f"Synthetic official-reference doc {tag}. Concerns F-1 and M-1 student "
                   "visas and the SEVIS system. Created by test_official_reference."),
        source_system="test-official",
        full_url=url,
        as_of_date="2026-09-19",
        author_handle="E2E Official",
        dry_run=False,
    )
    case_id = res["case_id"]
    try:
        check("INT1 published + indexed", res.get("indexed") is True, case_id)
        loc = os.getenv("GCP_VERTEX_DATASTORE_LOCATION", "global")
        client = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=project))
        name = (f"projects/{project}/locations/{loc}/collections/default_collection"
                f"/dataStores/imm-postings-datastore/branches/default_branch/documents/{case_id}")
        got = client.get_document(name=name)
        sd = dict(got.struct_data)
        check("INT2 doc present in DS-1", got.id == case_id, got.id)
        check("INT3 doc_kind == official_reference", sd.get("doc_kind") == "official_reference",
              str(sd.get("doc_kind")))
        check("INT4 channel == official", sd.get("channel") == "official", str(sd.get("channel")))
        check("INT5 source_system == test-official", sd.get("source_system") == "test-official")
    finally:
        try:
            posting.delete_content(case_id)
            print(f"  (cleanup) deleted synthetic doc {case_id}")
        except Exception as e:  # noqa: BLE001
            print(f"  (cleanup) WARNING could not delete {case_id}: {e}")


def main() -> None:
    scope = sys.argv[1] if len(sys.argv) > 1 else "unit"
    print("== test_official_reference ==")
    if scope in ("unit", "all"):
        run_unit_publish()
        run_unit_driver()
        run_unit_dedup()
    if scope in ("integration", "all"):
        run_integration()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
