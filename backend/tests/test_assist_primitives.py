#!/usr/bin/env python3
"""Offline unit tests for the AI-Assist **Phase 1** backend primitives
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 1). All additive,
no-GCP: they exercise the pieces the router (Phases 2-6) builds on without any
network or credentials.

Covers:
  A  FALLBACK_MESSAGE — self-service wording + kept in sync across the two copies.
  B  search_client.answer_query(filter_expr=...) — the doc_kind filter is applied
     to the retrieval request when given, and NOT set (unfiltered) by default.
  C  search_client._reference_to_chunk — the new `as_of` field (from posting_date)
     is populated in all three reference sub-types, "" when absent.
  D  query.save_qa_pair(route, source_tier) — both persisted; default "" so the
     existing /api/ask, /api/chat callers are unaffected.
  E  api.SourceInfo.as_of — present when the chunk carries it, "" otherwise.

Run:  python tests/test_assist_primitives.py
Wired into the no-GCP CI gate.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import search_client  # noqa: E402
import query  # noqa: E402
from google.cloud import discoveryengine_v1 as de  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


# ---------------------------------------------------------------------------
# A — FALLBACK_MESSAGE wording + sync
# ---------------------------------------------------------------------------

def group_a() -> None:
    print("\nA — FALLBACK_MESSAGE (self-service + in sync)")
    check("A1 both copies byte-identical",
          search_client.FALLBACK_MESSAGE == query.FALLBACK_MESSAGE,
          "search_client vs query drift")
    lowered = search_client.FALLBACK_MESSAGE.lower()
    check("A2 no 'contact the firm' wording", "firm" not in lowered and "attorney" not in lowered,
          search_client.FALLBACK_MESSAGE)
    check("A3 non-empty guidance", len(search_client.FALLBACK_MESSAGE) > 20)


# ---------------------------------------------------------------------------
# B — answer_query filter_expr wiring (fake client, no network)
# ---------------------------------------------------------------------------

def _fake_answer_empty():
    # An answer with no references -> answer_query returns its fallback, but the
    # request (which carries the filter) has already been built + captured.
    return SimpleNamespace(
        answer=SimpleNamespace(answer_text="", state=de.Answer.State.SUCCEEDED, references=[])
    )


def _capture_request(monkey_filter: str, preamble: str = "") -> object:
    """Call answer_query with a fake client that records the built request."""
    captured = {}

    class _FakeClient:
        def answer_query(self, request):
            captured["request"] = request
            return _fake_answer_empty()

    orig_client, orig_retry = search_client._client, search_client._retry
    search_client._client = lambda pid, loc: _FakeClient()
    search_client._retry = lambda fn, **k: fn()
    try:
        kw = {}
        if monkey_filter:
            kw["filter_expr"] = monkey_filter
        if preamble:
            kw["preamble"] = preamble
        search_client.answer_query("test question", "proj", "global", "engine", **kw)
    finally:
        search_client._client, search_client._retry = orig_client, orig_retry
    return captured["request"]


def group_b() -> None:
    print("\nB — answer_query(filter_expr=...) request wiring")
    import inspect
    check("B0 signature exposes filter_expr",
          "filter_expr" in inspect.signature(search_client.answer_query).parameters)

    gov = 'doc_kind: ANY("gov_news","official_reference")'
    req = _capture_request(gov)
    got = req.search_spec.search_params.filter
    check("B1 filter_expr applied to search_params.filter", got == gov, got)

    req2 = _capture_request("")
    got2 = req2.search_spec.search_params.filter
    check("B2 default is unfiltered (empty filter)", got2 == "", repr(got2))

    community = '(NOT doc_kind: ANY("gov_news","official_reference"))'
    req3 = _capture_request(community)
    check("B3 community negation filter applied",
          req3.search_spec.search_params.filter == community)

    # preamble -> AnswerGenerationSpec.prompt_spec.preamble (item 6)
    req4 = _capture_request("", preamble="Be concise.")
    check("B4 preamble sets the answer-generation prompt",
          req4.answer_generation_spec.prompt_spec.preamble == "Be concise.")
    req5 = _capture_request("")
    check("B5 no preamble -> empty prompt preamble (stock behavior)",
          req5.answer_generation_spec.prompt_spec.preamble == "")


# ---------------------------------------------------------------------------
# C — _reference_to_chunk carries as_of (from posting_date), all 3 sub-types
# ---------------------------------------------------------------------------

def _structured_ref(struct: dict):
    sdi = SimpleNamespace(
        document="projects/x/.../documents/case-123",
        struct_data=struct, uri="https://example.gov/page", title="T",
    )
    return SimpleNamespace(structured_document_info=sdi, chunk_info=None,
                           unstructured_document_info=None)


def _chunk_ref(struct: dict, uri: str = "https://example.gov/chunk"):
    dm = SimpleNamespace(struct_data=struct, document="projects/x/.../documents/case-456",
                         uri=uri, title="CT")
    ci = SimpleNamespace(content="some chunk content", chunk="", document_metadata=dm,
                         relevance_score=0.7)
    return SimpleNamespace(structured_document_info=None, chunk_info=ci,
                           unstructured_document_info=None)


def _unstructured_ref(struct: dict):
    udi = SimpleNamespace(document="projects/x/.../documents/case-789",
                          struct_data=struct, chunk_contents=[SimpleNamespace(content="u body")],
                          title="UT", uri="https://example.gov/u")
    return SimpleNamespace(structured_document_info=None, chunk_info=None,
                           unstructured_document_info=udi)


def group_c() -> None:
    print("\nC — _reference_to_chunk as_of field")
    r2c = search_client._reference_to_chunk

    s = r2c(_structured_ref({"posting_date": "2026-09-19", "post_title": "X"}))
    check("C1 structured ref carries as_of", s.get("as_of") == "2026-09-19", str(s))
    check("C1b structured chunk_id derived", s.get("chunk_id") == "case-123")

    c = r2c(_chunk_ref({"posting_date": "2026-08-01"}))
    check("C2 chunk_info ref carries as_of", c.get("as_of") == "2026-08-01", str(c))

    u = r2c(_unstructured_ref({"posting_date": "2026-07-15"}))
    check("C3 unstructured ref carries as_of", u.get("as_of") == "2026-07-15", str(u))

    none_date = r2c(_structured_ref({"post_title": "no date"}))
    check("C4 missing posting_date -> as_of == ''", none_date.get("as_of") == "", str(none_date))
    check("C4b as_of key always present", "as_of" in none_date)

    # C5/C6: a chunk whose document_metadata.uri is a gs:// sidecar path must cite
    # the doc's real full_url (usable link), never the gs:// path.
    gsv = r2c(_chunk_ref({"full_url": "https://www.uscis.gov/ar-11"}, uri="gs://bucket/official/uscis/x.md"))
    check("C5 chunk_info prefers full_url over gs://", gsv.get("source") == "https://www.uscis.gov/ar-11")
    gsn = r2c(_chunk_ref({}, uri="gs://bucket/official/uscis/x.md"))
    check("C6 chunk_info never emits a gs:// source", not str(gsn.get("source", "")).startswith("gs://"))


# ---------------------------------------------------------------------------
# D — save_qa_pair(route, source_tier) — fake Firestore .add()
# ---------------------------------------------------------------------------

class _FakeDocRef:
    id = "fake-doc-id"


class _FakeColl:
    def __init__(self, sink):
        self._sink = sink

    def add(self, doc):
        self._sink.append(doc)
        return (None, _FakeDocRef())


class _FakeDB:
    def __init__(self):
        self.docs = []

    def collection(self, name):
        assert name == "qa_pairs", name
        return _FakeColl(self.docs)


_RESULT = {"answer": "an answer", "chunks": [{"source": "https://s"}], "is_fallback": False}


def group_d() -> None:
    print("\nD — save_qa_pair(route, source_tier)")

    db = _FakeDB()
    doc_id = query.save_qa_pair("q?", _RESULT, db, route="answer-gov", source_tier="gov")
    check("D1 returns doc id", doc_id == "fake-doc-id")
    doc = db.docs[-1]
    check("D2 route persisted", doc.get("route") == "answer-gov", str(doc.get("route")))
    check("D3 source_tier persisted", doc.get("source_tier") == "gov", str(doc.get("source_tier")))

    db2 = _FakeDB()
    query.save_qa_pair("q2?", _RESULT, db2)  # existing callers omit the new kwargs
    doc2 = db2.docs[-1]
    check("D4 route defaults to '' (back-compat)", doc2.get("route") == "")
    check("D5 source_tier defaults to '' (back-compat)", doc2.get("source_tier") == "")
    check("D6 legacy fields intact", doc2.get("is_fallback") is False and "created_at" in doc2)


# ---------------------------------------------------------------------------
# E — api.SourceInfo.as_of
# ---------------------------------------------------------------------------

def group_e() -> None:
    print("\nE — api.SourceInfo.as_of")
    from api import SourceInfo

    with_date = SourceInfo(**{"chunk_id": "a", "text": "t", "source": "s",
                              "labels": [], "score": 0.0, "as_of": "2026-09-19"})
    check("E1 as_of preserved from chunk", with_date.as_of == "2026-09-19")

    without = SourceInfo(chunk_id="b", text="t", source="s", labels=[], score=0.0)
    check("E2 as_of defaults to '' (search-mode chunks)", without.as_of == "")


def main() -> None:
    print("== test_assist_primitives (AI-Assist Phase 1) ==")
    group_a()
    group_b()
    group_c()
    group_d()
    group_e()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
