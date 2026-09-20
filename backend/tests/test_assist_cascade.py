#!/usr/bin/env python3
"""Offline unit tests for the AI-Assist **Phase 3** answer path
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 3 — the cascade).

All offline / no-GCP: `search_client.answer_query` and `query.generate_direct_answer`
are monkeypatched, so no network / credentials / live model.

Covers:
  A  citation + community-card builders — incl. Q9 "must link back to the original
     posting" URL resolution (external permalink vs /case/{id}).
  B  _gov_answer — grounded -> gov tier + citations; miss -> None; gov filter used.
  C  _community_answer — grounded -> linked cards; miss -> None; negation filter.
  D  _ungrounded_answer — labelled "general information / not legal advice".
  E  answer_cascade — gov -> community -> ungrounded, miss-signalled by is_fallback
     (Q3/Q10); no engine -> ungrounded directly.
  F  search_client._reference_to_chunk now also carries `channel` (for the cards).

Run:  python tests/test_assist_cascade.py
Wired into the no-GCP CI gate.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import assist  # noqa: E402
import query  # noqa: E402
import search_client  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


_ANSWER_KEYS = {"answer", "source_tier", "citations", "community_cards", "is_fallback"}


def _chunk(chunk_id="c1", source="https://www.reddit.com/r/x/abc",
           as_of="2026-01-01", channel="reddit", text="Applied at Mumbai, got 221g."):
    return {"chunk_id": chunk_id, "text": text, "source": source,
            "labels": [], "score": 0.5, "as_of": as_of, "channel": channel}


def _grounded(chunks):
    return {"answer": "grounded answer", "chunks": chunks, "is_fallback": False}


def _miss():
    return {"answer": search_client.FALLBACK_MESSAGE, "chunks": [], "is_fallback": True}


def _install_fake_answer(script: dict, calls: list):
    """Fake search_client.answer_query dispatching on filter_expr; records calls."""
    def fake(question, project_id, location, engine_id, max_results=5, filter_expr=""):
        calls.append(filter_expr)
        return script.get(filter_expr, _miss())
    orig = search_client.answer_query
    search_client.answer_query = fake
    return orig


# ---------------------------------------------------------------------------
# A — citation + community-card builders
# ---------------------------------------------------------------------------

def group_a() -> None:
    print("\nA — citation + community-card builders")

    cits = assist._citations_from_chunks([_chunk(source="https://uscis.gov/x", as_of="2026-09-01")])
    check("A1 citation has source", cits[0]["source"] == "https://uscis.gov/x")
    check("A2 citation carries as_of", cits[0]["as_of"] == "2026-09-01")
    check("A3 citation has a title", bool(cits[0].get("title")))

    # Q9: external permalink is used verbatim.
    ext = assist._community_cards_from_chunks([_chunk(chunk_id="p1", source="https://reddit.com/p1")])
    check("A4 http source -> external permalink url", ext[0]["url"] == "https://reddit.com/p1")
    check("A5 card carries case_id + channel + snippet",
          ext[0]["case_id"] == "p1" and ext[0]["channel"] == "reddit" and bool(ext[0]["snippet"]))

    # Q9: internal app posting (no external url, source is a bare case_id) -> /case/{id}.
    internal = assist._community_cards_from_chunks(
        [_chunk(chunk_id="app-42", source="app-42", channel="app")])
    check("A6 bare case_id source -> /case/{id}", internal[0]["url"] == "/case/app-42")

    # empty source but chunk_id present -> still linkable via /case/{id}.
    empty_src = assist._community_cards_from_chunks([_chunk(chunk_id="k9", source="")])
    check("A7 empty source falls back to /case/{chunk_id}", empty_src[0]["url"] == "/case/k9")

    # every card must be linkable (Q9 — never a card with no way back to the posting).
    check("A8 no card ever has an empty url",
          all(c["url"] for c in ext + internal + empty_src))


# ---------------------------------------------------------------------------
# B — _gov_answer
# ---------------------------------------------------------------------------

def group_b() -> None:
    print("\nB — _gov_answer")
    calls = []
    orig = _install_fake_answer({assist._GOV_FILTER: _grounded([_chunk(source="https://uscis.gov/g")])}, calls)
    try:
        d = assist._gov_answer("q", project_id="p", location="global", engine_id="e")
    finally:
        search_client.answer_query = orig
    check("B1 grounded -> gov tier", d and d["source_tier"] == "gov")
    check("B2 grounded -> citations built", d and len(d["citations"]) == 1)
    check("B3 grounded -> not fallback, no community cards",
          d and d["is_fallback"] is False and d["community_cards"] == [])
    check("B4 uses the gov doc_kind filter",
          assist._GOV_FILTER == 'doc_kind: ANY("gov_news","official_reference")' and calls[0] == assist._GOV_FILTER)

    calls2 = []
    orig = _install_fake_answer({}, calls2)  # everything misses
    try:
        none_res = assist._gov_answer("q", project_id="p", location="global", engine_id="e")
    finally:
        search_client.answer_query = orig
    check("B5 miss -> None (cascade signal)", none_res is None)


# ---------------------------------------------------------------------------
# C — _community_answer
# ---------------------------------------------------------------------------

def group_c() -> None:
    print("\nC — _community_answer")
    calls = []
    orig = _install_fake_answer(
        {assist._COMMUNITY_FILTER: _grounded([_chunk(chunk_id="p1", source="https://reddit.com/p1")])}, calls)
    try:
        d = assist._community_answer("q", project_id="p", location="global", engine_id="e")
    finally:
        search_client.answer_query = orig
    check("C1 grounded -> community tier", d and d["source_tier"] == "community")
    check("C2 grounded -> linked cards", d and len(d["community_cards"]) == 1 and d["community_cards"][0]["url"])
    check("C3 grounded -> not fallback", d and d["is_fallback"] is False)
    check("C4 uses the community negation filter",
          assist._COMMUNITY_FILTER == '(NOT doc_kind: ANY("gov_news","official_reference"))'
          and calls[0] == assist._COMMUNITY_FILTER)

    calls2 = []
    orig = _install_fake_answer({}, calls2)
    try:
        none_res = assist._community_answer("q", project_id="p", location="global", engine_id="e")
    finally:
        search_client.answer_query = orig
    check("C5 miss -> None", none_res is None)


# ---------------------------------------------------------------------------
# D — _ungrounded_answer
# ---------------------------------------------------------------------------

def group_d() -> None:
    print("\nD — _ungrounded_answer")
    orig = query.generate_direct_answer
    query.generate_direct_answer = lambda q: f"body about {q}"
    try:
        d = assist._ungrounded_answer("H-1B grace period?")
    finally:
        query.generate_direct_answer = orig
    check("D1 source_tier ungrounded", d["source_tier"] == "ungrounded")
    check("D2 marked is_fallback (not grounded)", d["is_fallback"] is True)
    check("D3 body included", "body about" in d["answer"])
    low = d["answer"].lower()
    check("D4 labelled 'general information' + 'not legal advice'",
          "general information" in low and "not legal advice" in low)
    check("D5 no citations / cards", d["citations"] == [] and d["community_cards"] == [])


# ---------------------------------------------------------------------------
# E — answer_cascade (gov -> community -> ungrounded)
# ---------------------------------------------------------------------------

def group_e() -> None:
    print("\nE — answer_cascade")
    orig_gda = query.generate_direct_answer
    query.generate_direct_answer = lambda q: "ungrounded body"
    try:
        # E1 gov grounds -> gov; community NOT queried.
        calls = []
        og = _install_fake_answer({assist._GOV_FILTER: _grounded([_chunk(source="https://uscis.gov/g")])}, calls)
        try:
            d = assist.answer_cascade("q", project_id="p", location="global", engine_id="e")
        finally:
            search_client.answer_query = og
        check("E1 gov grounds -> gov tier", d["source_tier"] == "gov")
        check("E1b community not queried once gov grounds", calls == [assist._GOV_FILTER])

        # E2 gov miss, community grounds -> community; both filters tried in order.
        calls = []
        og = _install_fake_answer(
            {assist._COMMUNITY_FILTER: _grounded([_chunk(chunk_id="p1", source="https://reddit.com/p1")])}, calls)
        try:
            d = assist.answer_cascade("q", project_id="p", location="global", engine_id="e")
        finally:
            search_client.answer_query = og
        check("E2 gov miss -> community tier", d["source_tier"] == "community")
        check("E2b gov tried before community", calls == [assist._GOV_FILTER, assist._COMMUNITY_FILTER])

        # E3 both miss -> ungrounded.
        calls = []
        og = _install_fake_answer({}, calls)
        try:
            d = assist.answer_cascade("q", project_id="p", location="global", engine_id="e")
        finally:
            search_client.answer_query = og
        check("E3 both miss -> ungrounded", d["source_tier"] == "ungrounded" and "ungrounded body" in d["answer"])
        check("E3b both tiers were tried", calls == [assist._GOV_FILTER, assist._COMMUNITY_FILTER])

        # E4 no engine configured -> ungrounded directly, no retrieval.
        calls = []
        og = _install_fake_answer({assist._GOV_FILTER: _grounded([_chunk()])}, calls)
        try:
            d = assist.answer_cascade("q", project_id="p", location="global", engine_id="")
        finally:
            search_client.answer_query = og
        check("E4 no engine -> ungrounded, retrieval skipped", d["source_tier"] == "ungrounded" and calls == [])

        # E5 result always has the full answer shape.
        check("E5 cascade result has full answer schema", _ANSWER_KEYS <= set(d.keys()))
    finally:
        query.generate_direct_answer = orig_gda


# ---------------------------------------------------------------------------
# F — _reference_to_chunk channel field (Phase-3 additive)
# ---------------------------------------------------------------------------

def _structured_ref(struct: dict):
    sdi = SimpleNamespace(document="projects/x/.../documents/case-1",
                          struct_data=struct, uri="https://x.gov", title="T")
    return SimpleNamespace(structured_document_info=sdi, chunk_info=None,
                           unstructured_document_info=None)


def group_f() -> None:
    print("\nF — _reference_to_chunk channel")
    with_ch = search_client._reference_to_chunk(_structured_ref({"channel": "reddit", "post_title": "P"}))
    check("F1 channel carried from struct_data", with_ch.get("channel") == "reddit", str(with_ch))
    no_ch = search_client._reference_to_chunk(_structured_ref({"post_title": "P"}))
    check("F2 missing channel -> ''", no_ch.get("channel") == "")
    check("F3 channel key always present", "channel" in no_ch)


def main() -> None:
    print("== test_assist_cascade (AI-Assist Phase 3 — answer path) ==")
    group_a()
    group_b()
    group_c()
    group_d()
    group_e()
    group_f()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
