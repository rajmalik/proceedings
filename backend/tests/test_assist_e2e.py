#!/usr/bin/env python3
"""LIVE end-to-end checks for AI-Assist (Phase 9 / §5.9 verification pass).

Unlike the other test_assist_* suites (offline, in the CI gate), this one hits
LIVE GCP (Vertex AI Search Answer API + Firestore, via ADC) and REAL Gemini. It
is NOT wired into the no-GCP gate — run it by hand before enabling the flag /
after a backend deploy:

    GCP_PROJECT_ID=proceedings-490601 \
    GCP_VERTEX_SEARCH_APP_ID=imm-postings-search-app \
    GCP_VERTEX_DATASTORE_LOCATION=global \
    .venv/bin/python tests/test_assist_e2e.py integration

It resolves the §5.9 open items:
  I1  the doc_kind filter is ACCEPTED by the ANSWER API (only the Search path had
      confirmed live doc_kind usage) — the key unverified assumption.
  I1b when gov-filtered retrieval grounds, the returned docs really are
      gov_news / official_reference (strict filter check).
  I2  the community negation filter is accepted, and its chunks carry a resolvable
      source link (Q9 — cards must link back to the posting).
  I3  answer_cascade returns a valid tier + answer end to end.
  I4  the PUBLIC timeline group search runs against live Firestore.
  I5  handle_turn runs end to end against live Gemini + grounding (tolerant: any
      valid intent + a disclaimer).

`unit` here is a no-op so the runner stays uniform; real coverage is `integration`.
"""
import os
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


def _fetch_doc_kind(project: str, loc: str, case_id: str) -> str:
    """doc_kind for one datastore doc, to strictly verify the gov filter."""
    from google.api_core.client_options import ClientOptions
    from google.cloud import discoveryengine_v1 as de
    client = de.DocumentServiceClient(client_options=ClientOptions(quota_project_id=project))
    name = (f"projects/{project}/locations/{loc}/collections/default_collection"
            f"/dataStores/imm-postings-datastore/branches/default_branch/documents/{case_id}")
    got = client.get_document(name=name)
    return str(dict(got.struct_data).get("doc_kind") or "")


def run_integration() -> None:
    print("\nIntegration — LIVE Vertex AI Search + Firestore + Gemini")
    project = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
    if not project:
        print("  SKIP: GCP_PROJECT_ID not set (live GCP required)")
        return
    engine = os.getenv("GCP_VERTEX_SEARCH_APP_ID", "imm-postings-search-app")
    loc = os.getenv("GCP_VERTEX_DATASTORE_LOCATION", "global")

    import assist
    import search_client
    import matching

    # I1 — the gov doc_kind filter is accepted by the Answer API (§5.9 gate).
    gov = search_client.answer_query("What is SEVIS and how does the student visa system work?",
                                     project, loc, engine, filter_expr=assist._GOV_FILTER)
    check("I1 gov doc_kind filter ACCEPTED by the Answer API (no 400)",
          isinstance(gov, dict) and "is_fallback" in gov, str(list(gov)[:4]))
    print(f"     gov tier grounded={not gov['is_fallback']} chunks={len(gov.get('chunks', []))}")

    # I1b — strict: grounded gov results really are gov_news / official_reference.
    if not gov["is_fallback"] and gov["chunks"]:
        kinds = set()
        for c in gov["chunks"]:
            try:
                kinds.add(_fetch_doc_kind(project, loc, c["chunk_id"]))
            except Exception as e:  # noqa: BLE001
                print(f"     (could not fetch doc_kind for {c['chunk_id']}: {e})")
        if kinds:
            check("I1b grounded gov docs are gov_news/official_reference only",
                  kinds <= {"gov_news", "official_reference"}, str(kinds))
    else:
        print("     (I1b skipped — gov tier returned no chunks for this question)")

    # I2 — community negation filter accepted + resolvable source links (Q9).
    comm = search_client.answer_query("What did people experience getting a 221g at Mumbai?",
                                      project, loc, engine, filter_expr=assist._COMMUNITY_FILTER)
    check("I2 community negation filter ACCEPTED", isinstance(comm, dict) and "is_fallback" in comm)
    if not comm["is_fallback"] and comm["chunks"]:
        cards = assist._community_cards_from_chunks(comm["chunks"])
        check("I2b every community card links back to a posting (Q9)",
              all(c["url"] for c in cards), str([c["url"] for c in cards][:3]))
    else:
        print("     (I2b skipped — community tier returned no chunks for this question)")

    # I3 — full answer cascade end to end.
    casc = assist.answer_cascade("What is the H-1B grace period after job loss?",
                                 project_id=project, location=loc, engine_id=engine)
    check("I3 cascade returns a valid tier + answer",
          casc["source_tier"] in {"gov", "community", "ungrounded"} and bool(casc["answer"]),
          f"tier={casc['source_tier']}")

    # I4 — PUBLIC timeline group search against live Firestore.
    from google.cloud import firestore
    db = firestore.Client(project=project)
    crit = assist.resolve_timeline_criteria({
        "timeline_processing_type": "EAD", "timeline_eligibility": "stem-opt-extension",
        "timeline_filing_month": "Aug", "timeline_filing_year": "2026",
    })["criteria"]
    groups = matching.search_groups(db, crit, "timeline", "balanced", 0)
    check("I4 public timeline search runs (returns a list)", isinstance(groups, list),
          f"{len(groups)} match(es)")

    # I5 — handle_turn end to end (real Gemini router + grounding). Tolerant.
    out = assist.handle_turn("What is the H-1B grace period?", [],
                             project_id=project, location=loc, engine_id=engine, db=db)
    check("I5 handle_turn returns a valid intent", out.get("intent") in assist.INTENTS, str(out.get("intent")))
    check("I5b handle_turn always attaches a disclaimer", bool(out.get("disclaimer")))
    print(f"     handle_turn intent={out.get('intent')} tier={out.get('source_tier')}")


def main() -> None:
    scope = sys.argv[1] if len(sys.argv) > 1 else "integration"
    print("== test_assist_e2e (LIVE — not in the no-GCP gate) ==")
    if scope in ("unit",):
        print("  (no offline unit checks here — see test_assist*.py; run 'integration')")
    if scope in ("integration", "all"):
        run_integration()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
