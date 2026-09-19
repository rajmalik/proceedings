#!/usr/bin/env python3
"""Deterministic unit tests for the official_reference publish path
(posting.publish_official_reference_item) — the Phase-2 minimal slice in
docs/ingestion/GROUNDING-INGESTION-PLAN.md.

Offline / no-GCP: stubs _extract() (no Gemini) and validate() (the tag vocab is
already covered by test_posting_tagging.py), and uses dry_run=True so nothing
touches GCS/datastore/BigQuery. Wired into the no-GCP CI gate.

Run: python tests/test_official_reference.py [unit|all]
"""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path
import posting  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool) -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
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


def run_unit() -> None:
    orig_extract, orig_validate = posting._extract, posting.validate
    posting._extract = _STUB_EXTRACT
    posting.validate = lambda c: []  # vocab validation covered elsewhere
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

        # `news-update` is stripped — official reference is not news
        check("B1 news-update stripped from tags", "news-update" not in c["tags"])
        check("B2 legitimate tags kept", "sevis" in c["tags"] and "student-visa" in c["tags"])

        # Deterministic, idempotent case_id keyed on the URL + as_of date
        short = hashlib.sha256(URL.encode()).hexdigest()[:8]
        check("C1 case_id scheme", c["case_id"] == f"official-ice-2026-09-19-{short}")
        check("C2 gcs prefix under /official/", "/official/" in c["gcs_path"])
        res2 = _publish()
        check("C3 idempotent case_id on re-ingest", res2["case_id"] == res["case_id"])
        res3 = _publish(as_of_date="2026-10-01")
        check("C4 new as_of_date supersedes (different case_id)", res3["case_id"] != res["case_id"])

        # Guardrail: empty as_of_date is rejected (prevents daily-drifting case_id)
        try:
            _publish(as_of_date="")
            check("D1 empty as_of_date rejected", False)
        except ValueError:
            check("D1 empty as_of_date rejected", True)
    finally:
        posting._extract, posting.validate = orig_extract, orig_validate


def main() -> None:
    scope = sys.argv[1] if len(sys.argv) > 1 else "unit"
    print("== test_official_reference ==")
    if scope in ("unit", "all"):
        run_unit()
    print(f"SUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
