#!/usr/bin/env python3
"""Offline unit tests for the AI-Assist **web-search tier** (Option B, Phase 1)
— assist._web_search_answer + [cite] cleaning + citation/chip mapping. The
Gemini grounding call is monkeypatched (posting.genai_client), so no network.
Not yet wired into the cascade (that's a later phase).

Run:  python tests/test_assist_websearch.py
Wired into the no-GCP CI gate.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import assist  # noqa: E402
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


class _FakeClient:
    def __init__(self, resp=None, raise_exc=None):
        outer = self
        self._resp, self._raise = resp, raise_exc

        class _Models:
            def generate_content(self, model, contents, config):
                if outer._raise:
                    raise outer._raise
                return outer._resp
        self.models = _Models()


def _web(uri, title):
    return SimpleNamespace(web=SimpleNamespace(uri=uri, title=title))


def _resp(text, chunks=None, chips="<div>Suggestions</div>", with_meta=True, candidates=True):
    if not candidates:
        return SimpleNamespace(text=text, candidates=[])
    gm = None
    if with_meta:
        gm = SimpleNamespace(
            grounding_chunks=chunks if chunks is not None else [],
            search_entry_point=SimpleNamespace(rendered_content=chips),
        )
    return SimpleNamespace(text=text, candidates=[SimpleNamespace(grounding_metadata=gm)])


def _with_client(resp=None, raise_exc=None):
    orig = posting.genai_client
    posting.genai_client = lambda: _FakeClient(resp, raise_exc)
    return orig


def _call(resp=None, raise_exc=None):
    orig = _with_client(resp, raise_exc)
    try:
        return assist._web_search_answer("How long is naturalization taking?")
    finally:
        posting.genai_client = orig


_KEYS = {"answer", "source_tier", "citations", "community_cards", "is_fallback", "search_suggestions_html"}


# ---------------------------------------------------------------------------
# A — _strip_cite_markers
# ---------------------------------------------------------------------------

def group_a() -> None:
    print("\nA — _strip_cite_markers")
    s = assist._strip_cite_markers
    check("A1 strips [cite: 1, 3]", s("The rule [cite: 1, 3] applies.") == "The rule applies.")
    check("A2 strips [citation:2]", s("Answer [citation:2].") == "Answer.")
    check("A3 strips [cites: 4]", s("Text [cites: 4] more") == "Text more")
    check("A4 no markers unchanged", s("Just a plain answer.") == "Just a plain answer.")
    check("A5 empty -> ''", s("") == "" and s(None) == "")
    check("A6 only-markers -> ''", s("[cite: 1] [cite: 2]") == "")


# ---------------------------------------------------------------------------
# B — happy path
# ---------------------------------------------------------------------------

def group_b() -> None:
    print("\nB — _web_search_answer happy path")
    r = _call(_resp(
        "You must be an LPR for 5 years [cite: 1, 2] to naturalize.",
        chunks=[_web("https://vertexaisearch.cloud.google.com/redirect/A", "uscis.gov"),
                _web("https://vertexaisearch.cloud.google.com/redirect/B", "dhs.gov")],
        chips="<div class='chips'>Suggestions</div>",
    ))
    check("B1 source_tier == web", r["source_tier"] == "web")
    check("B2 not fallback", r["is_fallback"] is False)
    check("B3 [cite] stripped from answer", "[cite" not in r["answer"] and "naturalize." in r["answer"])
    check("B4 two citations mapped", len(r["citations"]) == 2)
    check("B5 citation keeps redirect uri + domain title",
          r["citations"][0]["source"].startswith("https://") and r["citations"][0]["title"] == "uscis.gov")
    check("B6 search-suggestion chips captured", r["search_suggestions_html"] == "<div class='chips'>Suggestions</div>")
    check("B7 full answer schema", _KEYS <= set(r.keys()), str(_KEYS ^ set(r.keys())))


# ---------------------------------------------------------------------------
# C — miss / empty -> None
# ---------------------------------------------------------------------------

def group_c() -> None:
    print("\nC — empty answer -> None (cascade falls through)")
    check("C1 empty text -> None", _call(_resp("")) is None)
    check("C2 only-markers text -> None", _call(_resp("[cite: 1]")) is None)


# ---------------------------------------------------------------------------
# D — robustness (never raises)
# ---------------------------------------------------------------------------

def group_d() -> None:
    print("\nD — robustness")
    check("D1 model exception -> None", _call(raise_exc=RuntimeError("grounding down")) is None)
    # no grounding metadata -> still returns the answer, no citations/chips
    r = _call(_resp("A grounded answer.", with_meta=False))
    check("D2 no metadata -> answer kept, citations empty", r is not None and r["citations"] == [] and r["search_suggestions_html"] == "")
    # empty candidates -> inner metadata read fails gracefully
    r2 = _call(_resp("Answer without candidates.", candidates=False))
    check("D3 no candidates -> answer kept, no citations", r2 is not None and r2["citations"] == [])
    # a chunk without a web uri is skipped
    r3 = _call(_resp("Answer.", chunks=[SimpleNamespace(web=None), _web("https://x/redirect/C", "uscis.gov")]))
    check("D4 chunk without web uri skipped", len(r3["citations"]) == 1 and r3["citations"][0]["title"] == "uscis.gov")


# ---------------------------------------------------------------------------
# E — shape + flag defaults
# ---------------------------------------------------------------------------

def group_e() -> None:
    print("\nE — shape + flag")
    check("E1 _answer_shape carries search_suggestions_html",
          "search_suggestions_html" in assist._answer_shape("a", "gov"))
    check("E1b default empty for non-web tiers", assist._answer_shape("a", "gov")["search_suggestions_html"] == "")
    check("E2 web tier default off (AI_ASSIST_WEB_SEARCH unset)", assist._WEB_SEARCH_ENABLED is False)


def main() -> None:
    print("== test_assist_websearch (web-search tier, Phase 1) ==")
    group_a()
    group_b()
    group_c()
    group_d()
    group_e()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
