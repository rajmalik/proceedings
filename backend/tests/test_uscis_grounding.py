#!/usr/bin/env python3
"""Deterministic (no-GCP) end-to-end test: a USCIS question is answered from the
new Tier-1 `official_reference` grounding, with a citation back to the uscis.gov
page — proving the retrieval -> gov-tier answer -> citation wiring for the pages
added in Milestone 1.5a.

`search_client.answer_query` is stubbed (dispatch on filter_expr) so no
network/GCP: for the gov filter it returns a grounded result whose chunk is one
of our registered official_reference docs (uscis.gov/i-765). We assert the
cascade returns a gov-tier answer citing that page, and that the cited URL is in
fact a registered official_reference source. Edge cases: a gov miss and a gov
"decline" both fall through to the ungrounded tier.

(The LIVE round-trip — real DS-1 ingest + Answer API — is covered by
test_official_reference.py integration and test_grounding_e2e.py.)

Run:  python tests/test_uscis_grounding.py
Wired into the no-GCP CI gate.
"""
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

import assist  # noqa: E402
import search_client  # noqa: E402
import official_reference_poll as orp  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


_CITED_URL = "https://www.uscis.gov/i-765"  # a page grounded in Milestone 1.5a


def _official_chunk():
    """A grounded chunk as DS-1 returns for an official_reference doc."""
    return {"chunk_id": "official-uscis-abcd1234", "text":
            "Form I-765 is used to request an Employment Authorization Document (EAD).",
            "source": _CITED_URL, "labels": [], "score": 0.7,
            "as_of": "2026-09-01", "channel": "official"}


def _install(script: dict, calls: list):
    def fake(question, project_id, location, engine_id, max_results=5, filter_expr="", preamble=""):
        calls.append(filter_expr)
        return script.get(filter_expr, {"answer": search_client.FALLBACK_MESSAGE,
                                        "chunks": [], "is_fallback": True})
    orig = search_client.answer_query
    search_client.answer_query = fake
    return orig


def _ask(question):
    return assist.answer_cascade(question, project_id="p", location="global", engine_id="e")


def group_grounded() -> None:
    print("\nA — USCIS question -> gov-tier grounded answer + citation (deterministic)")
    calls = []
    grounded = {"answer": "File Form I-765 to apply for an EAD.",
                "chunks": [_official_chunk()], "is_fallback": False}
    orig = _install({assist._GOV_FILTER: grounded}, calls)
    try:
        res = _ask("How do I apply for an Employment Authorization Document with Form I-765?")
        check("A1 answer is gov-tier (Tier-1 official_reference)", res["source_tier"] == "gov",
              res["source_tier"])
        check("A2 answer is grounded (not fallback)", res["is_fallback"] is False)
        check("A3 answer carries a citation", len(res.get("citations", [])) >= 1)
        check("A4 citation points to the grounded uscis.gov page",
              any(c.get("source") == _CITED_URL for c in res["citations"]),
              str(res.get("citations")))
        check("A5 gov filter targets official_reference/gov_news",
              assist._GOV_FILTER in calls and "official_reference" in assist._GOV_FILTER)
        check("A6 cited page is a REGISTERED official_reference source (config tie-in)",
              _CITED_URL in {s["url"] for s in orp.load_sources()})
    finally:
        search_client.answer_query = orig


def group_edges() -> None:
    print("\nB — edge cases (miss / decline fall through, deterministically)")
    # B1: gov + community both miss -> ungrounded fallback
    calls = []
    orig = _install({}, calls)  # everything misses
    try:
        res = _ask("Some uscis question with no grounded source")
        check("B1 gov+community miss -> ungrounded fallback",
              res["source_tier"] == "ungrounded" and res["is_fallback"] is True, res["source_tier"])
        check("B1b cascade tried gov then community", assist._GOV_FILTER in calls)
    finally:
        search_client.answer_query = orig

    # B2: gov returns references but a DECLINE sentinel -> not treated as grounded
    calls = []
    decline = {"answer": assist._DECLINE_SENTINEL, "chunks": [_official_chunk()], "is_fallback": False}
    orig = _install({assist._GOV_FILTER: decline}, calls)
    try:
        res = _ask("A uscis question the gov docs do not actually answer")
        check("B2 gov decline sentinel -> falls through (not gov)", res["source_tier"] != "gov",
              res["source_tier"])
    finally:
        search_client.answer_query = orig

    # B3: a grounded gov answer with NO chunks -> gov tier, empty citations (no crash)
    calls = []
    nochunks = {"answer": "General EAD info.", "chunks": [], "is_fallback": False}
    orig = _install({assist._GOV_FILTER: nochunks}, calls)
    try:
        res = _ask("EAD question")
        check("B3 grounded-but-no-chunks -> gov tier, empty citations, no crash",
              res["source_tier"] == "gov" and res.get("citations") == [])
    finally:
        search_client.answer_query = orig


def main() -> None:
    print("== test_uscis_grounding ==")
    group_grounded()
    group_edges()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
