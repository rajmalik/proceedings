#!/usr/bin/env python3
"""Offline unit tests for the AI-Assist **Phase 2** router core
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 2 — `assist.py`).

All offline / no-GCP: the single Gemini call in `route_turn` is exercised by
monkeypatching `posting.genai_client()` to return canned JSON, so no network,
no credentials, no live model. Phases 3-6 (cascade, /post handoff, timeline,
the HTTP route) are NOT covered here.

Covers:
  A  module surface — INTENTS, _assist_model() default + env override.
  B  ASSIST_SYSTEM_PROMPT guardrails — taxonomy tokens, timeline-preempts-post,
     the reused legal-advice sentence, the rationale-boundary line.
  C  route_turn happy path — parses a well-formed decision for each intent.
  D  route_turn robustness — malformed/exception -> answer-gov fallback (never
     raises); unknown intent coerced; missing fields defaulted; full schema.
  E  _trailing_clarify_streak — counts trailing consecutive clarify ai-turns.

Run:  python tests/test_assist.py
Wired into the no-GCP CI gate.
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import posting  # noqa: E402
import assist  # noqa: E402
import query  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


# The full router schema every route_turn result must expose.
_SCHEMA_KEYS = {
    "intent", "confidence", "rationale", "rewritten_question", "clarify_questions",
    "post_title", "post_summary", "timeline_processing_type", "timeline_eligibility",
    "timeline_filing_month", "timeline_filing_year",
}


class _FakeClient:
    """Stands in for posting.genai_client(): .models.generate_content -> canned."""
    def __init__(self, text=None, raise_exc=None):
        self._text, self._raise = text, raise_exc
        outer = self

        class _Models:
            def generate_content(self, model, contents, config):
                if outer._raise:
                    raise outer._raise
                return SimpleNamespace(text=outer._text)
        self.models = _Models()


def _with_fake_client(text=None, raise_exc=None):
    """Context: monkeypatch posting.genai_client for one route_turn call."""
    orig = posting.genai_client
    posting.genai_client = lambda: _FakeClient(text=text, raise_exc=raise_exc)
    return orig


# ---------------------------------------------------------------------------
# A — module surface
# ---------------------------------------------------------------------------

def group_a() -> None:
    print("\nA — module surface")
    check("A1 INTENTS = the routing taxonomy",
          set(assist.INTENTS) == {"answer-gov", "answer-community", "post",
                                  "timeline-find", "find-similar", "clarify"}, str(assist.INTENTS))
    check("A2 INTENTS is a tuple (extensible, not an Enum)", isinstance(assist.INTENTS, tuple))

    orig = os.environ.pop("GCP_GEMINI_ASSIST_MODEL", None)
    try:
        check("A3 model default is gemini-2.5-flash (probe-confirmed)",
              assist._assist_model() == "gemini-2.5-flash", assist._assist_model())
        os.environ["GCP_GEMINI_ASSIST_MODEL"] = "gemini-3-flash"
        check("A4 model overridable via env (one-line flip)",
              assist._assist_model() == "gemini-3-flash")
    finally:
        os.environ.pop("GCP_GEMINI_ASSIST_MODEL", None)
        if orig is not None:
            os.environ["GCP_GEMINI_ASSIST_MODEL"] = orig


# ---------------------------------------------------------------------------
# B — system prompt guardrails
# ---------------------------------------------------------------------------

def group_b() -> None:
    print("\nB — ASSIST_SYSTEM_PROMPT guardrails")
    p = assist.ASSIST_SYSTEM_PROMPT
    for tok in ("answer-gov", "answer-community", "post", "timeline-find", "clarify"):
        check(f"B taxonomy mentions '{tok}'", tok in p)
    check("B timeline-preempts-post rule present",
          "EAD" in p and "H-1B" in p and "/find" in p)
    check("B clarify budget (<=3 + status/process) present",
          "3" in p and ("status" in p.lower()) and ("process" in p.lower()))
    # The legal-advice sentence reused verbatim from query.generate_direct_answer.
    legal = "Do NOT provide case-specific legal advice or assess whether a specific person qualifies."
    check("B reuses the query.py legal-advice sentence verbatim", legal in p)
    check("B rationale-boundary line present (no eligibility/case assessment)",
          "rationale" in p and "eligibility" in p.lower())


# ---------------------------------------------------------------------------
# C — route_turn happy path (canned JSON per intent)
# ---------------------------------------------------------------------------

def _decision_json(**over) -> str:
    import json
    base = {
        "intent": "answer-gov", "confidence": 0.9, "rationale": "because",
        "rewritten_question": "what is the H-1B grace period?",
        "clarify_questions": [], "post_title": "", "post_summary": "",
        "timeline_processing_type": "", "timeline_eligibility": "",
        "timeline_filing_month": "", "timeline_filing_year": "",
    }
    base.update(over)
    return json.dumps(base)


def group_c() -> None:
    print("\nC — route_turn happy path")
    for intent in assist.INTENTS:
        orig = _with_fake_client(text=_decision_json(intent=intent))
        try:
            d = assist.route_turn("some message", [])
        finally:
            posting.genai_client = orig
        check(f"C intent '{intent}' parsed", d["intent"] == intent, str(d.get("intent")))
        check(f"C intent '{intent}' full schema present", _SCHEMA_KEYS <= set(d.keys()))

    # A post decision carries the best-effort draft fields (single-call design).
    orig = _with_fake_client(text=_decision_json(
        intent="post", post_title="H-1B transfer", post_summary="moving employers"))
    try:
        d = assist.route_turn("I'm switching jobs on H-1B", [])
    finally:
        posting.genai_client = orig
    check("C post decision keeps post_title/summary",
          d["post_title"] == "H-1B transfer" and d["post_summary"] == "moving employers")

    # A timeline decision carries the extracted keying fields.
    orig = _with_fake_client(text=_decision_json(
        intent="timeline-find", timeline_processing_type="EAD",
        timeline_eligibility="stem-opt-extension",
        timeline_filing_month="08", timeline_filing_year="2026"))
    try:
        d = assist.route_turn("how long is EAD taking for STEM OPT filed Aug 2026?", [])
    finally:
        posting.genai_client = orig
    check("C timeline decision keeps processing_type/eligibility/date",
          d["timeline_processing_type"] == "EAD" and d["timeline_eligibility"] == "stem-opt-extension"
          and d["timeline_filing_month"] == "08" and d["timeline_filing_year"] == "2026")


# ---------------------------------------------------------------------------
# D — route_turn robustness (never raises)
# ---------------------------------------------------------------------------

def group_d() -> None:
    print("\nD — route_turn robustness")

    # malformed / non-JSON -> fallback
    orig = _with_fake_client(text="not json at all {")
    try:
        d = assist.route_turn("q", [])
    finally:
        posting.genai_client = orig
    check("D1 malformed JSON -> answer-gov fallback", d["intent"] == "answer-gov")
    check("D1b fallback still has full schema", _SCHEMA_KEYS <= set(d.keys()))
    check("D1c fallback rewritten_question falls back to the message", d["rewritten_question"] == "q")

    # exception from the model call -> fallback (never raises)
    orig = _with_fake_client(raise_exc=RuntimeError("gemini down"))
    try:
        d = assist.route_turn("q2", [])
    finally:
        posting.genai_client = orig
    check("D2 model exception -> answer-gov fallback (no raise)", d["intent"] == "answer-gov")

    # unknown intent from the model -> coerced to a safe default
    orig = _with_fake_client(text=_decision_json(intent="frobnicate"))
    try:
        d = assist.route_turn("q3", [])
    finally:
        posting.genai_client = orig
    check("D3 unknown intent coerced to answer-gov", d["intent"] == "answer-gov")

    # missing fields -> defaulted, provided fields preserved
    orig = _with_fake_client(text='{"intent":"clarify","clarify_questions":["a","b"]}')
    try:
        d = assist.route_turn("q4", [])
    finally:
        posting.genai_client = orig
    check("D4 missing fields defaulted (full schema)", _SCHEMA_KEYS <= set(d.keys()))
    check("D4b provided clarify_questions preserved", d["clarify_questions"] == ["a", "b"])
    check("D4c defaulted confidence is a float", isinstance(d["confidence"], float))
    check("D4d defaulted string fields are ''", d["post_title"] == "" and d["rationale"] == "")

    # fences tolerated (```json ... ```)
    orig = _with_fake_client(text="```json\n" + _decision_json(intent="post") + "\n```")
    try:
        d = assist.route_turn("q5", [])
    finally:
        posting.genai_client = orig
    check("D5 fenced JSON tolerated", d["intent"] == "post")


# ---------------------------------------------------------------------------
# E — _trailing_clarify_streak
# ---------------------------------------------------------------------------

def _ai(intent):
    return {"role": "ai", "content": "...", "intent": intent}


def _user(text="hi"):
    return {"role": "user", "content": text}


def group_e() -> None:
    print("\nE — _trailing_clarify_streak")
    tcs = assist._trailing_clarify_streak
    check("E0 empty history -> 0", tcs([]) == 0)
    check("E1 no clarify -> 0", tcs([_user(), _ai("answer-gov")]) == 0)
    check("E2 one clarify round -> 1", tcs([_user(), _ai("clarify")]) == 1)
    check("E3 interleaved user turns still counted",
          tcs([_ai("clarify"), _user(), _ai("clarify"), _user()]) == 2)
    check("E4 three consecutive clarifies -> 3",
          tcs([_ai("clarify"), _user(), _ai("clarify"), _user(), _ai("clarify"), _user()]) == 3)
    check("E5 streak stops at a non-clarify ai turn",
          tcs([_ai("clarify"), _ai("answer-gov"), _user(), _ai("clarify")]) == 1)
    # tolerate object-style turns (getattr access), not just dicts
    ns_hist = [SimpleNamespace(role="ai", content="x", intent="clarify")]
    check("E6 tolerates object turns", tcs(ns_hist) == 1)


def main() -> None:
    print("== test_assist (AI-Assist Phase 2 — router core) ==")
    group_a()
    group_b()
    group_c()
    group_d()
    group_e()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
