#!/usr/bin/env python3
"""Edge-case + coverage tests for the AI-Assist router (assist.py).

Complements the per-phase suites: this file pushes assist.py toward full branch
coverage and pins the router's behavior on malformed model output, overrides, and
boundary conditions. Offline / no-GCP (Gemini + sub-calls monkeypatched).

  R  route_turn — non-dict JSON, bad confidence, empty rewritten_question, the
     history-transcript path, clarify-question capping, ThinkingConfig fallback.
  H  handle_turn — invalid vs valid force_intent (A5), the clarify-streak boundary
     (2 keeps clarifying, 3 coerces), timeline 'unresolved' passthrough, empty
     rewritten_question falling back to the message, and post scrubbing (C3).
  T  resolve_timeline_criteria — 2-digit year, month 0, wrong-case eligibility,
     H-1B without an application type, whitespace trimming.
  C  _community_cards_from_chunks — a chunk with neither source nor id -> no url.

Run:  python tests/test_assist_routing_edges.py
Wired into the no-GCP CI gate.
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import assist  # noqa: E402
import posting  # noqa: E402
import profile as prof  # noqa: E402

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
    def __init__(self, text):
        outer = self
        self._text = text

        class _Models:
            def generate_content(self, model, contents, config):
                return SimpleNamespace(text=outer._text)
        self.models = _Models()


def _route_with(text, message="msg", history=None):
    orig = posting.genai_client
    posting.genai_client = lambda: _FakeClient(text)
    try:
        return assist.route_turn(message, history or [])
    finally:
        posting.genai_client = orig


def _valid(**over):
    base = {
        "intent": "answer-gov", "confidence": 0.9, "rationale": "r",
        "rewritten_question": "rq", "clarify_questions": [], "post_title": "",
        "post_summary": "", "timeline_processing_type": "", "timeline_eligibility": "",
        "timeline_filing_month": "", "timeline_filing_year": "",
    }
    base.update(over)
    return json.dumps(base)


# ---------------------------------------------------------------------------
# R — route_turn edges
# ---------------------------------------------------------------------------

def group_r() -> None:
    print("\nR — route_turn edges")

    # non-dict JSON (array / bare string) -> fallback (line 127)
    d = _route_with("[1, 2, 3]", message="hello")
    check("R1 array JSON -> answer-gov fallback", d["intent"] == "answer-gov" and d["rewritten_question"] == "hello")
    d = _route_with('"just a string"', message="hi")
    check("R2 string JSON -> fallback", d["intent"] == "answer-gov")

    # non-numeric confidence -> 0.0 (lines 135-136)
    d = _route_with(_valid(confidence="high"))
    check("R3 non-numeric confidence -> 0.0", d["confidence"] == 0.0)
    d = _route_with(_valid(confidence=None))
    check("R3b null confidence -> 0.0", d["confidence"] == 0.0)

    # empty rewritten_question -> the original message (line 144)
    d = _route_with(_valid(intent="post", rewritten_question=""), message="carry me")
    check("R4 empty rewritten_question -> message", d["rewritten_question"] == "carry me")
    d = _route_with(_valid(rewritten_question="   "), message="trim me")
    check("R4b whitespace rewritten_question -> message", d["rewritten_question"] == "trim me")
    # defensive: both the model's rewrite AND the message empty -> stays "" (the
    # API validates message non-empty upstream, so this is belt-and-suspenders)
    d = _route_with(_valid(rewritten_question=""), message="")
    check("R4c empty message + empty rewrite -> ''", d["rewritten_question"] == "")

    # history transcript path (lines 157-159) — a non-empty, mixed history
    hist = [{"role": "user", "content": "earlier"}, {"role": "ai", "content": "answered", "intent": "answer-gov"}]
    d = _route_with(_valid(intent="clarify", clarify_questions=["and now?"]), history=hist)
    check("R5 routes with prior history", d["intent"] == "clarify")

    # clarify_questions capped at 3, non-strings dropped/coerced
    d = _route_with(_valid(intent="clarify", clarify_questions=["a", "b", "", "c", "d", 5]))
    cq = d["clarify_questions"]
    check("R6 clarify_questions capped at 3", len(cq) == 3, str(cq))
    check("R6b empties dropped, all strings", "" not in cq and all(isinstance(x, str) for x in cq))

    # ThinkingConfig unavailable (older SDK) -> still routes (lines 179-180)
    orig_tc = assist.genai.types.ThinkingConfig
    def _boom(**k):
        raise AttributeError("no ThinkingConfig on this SDK")
    assist.genai.types.ThinkingConfig = _boom
    try:
        d = _route_with(_valid(intent="post"))
    finally:
        assist.genai.types.ThinkingConfig = orig_tc
    check("R7 missing ThinkingConfig -> still routes", d["intent"] == "post")


# ---------------------------------------------------------------------------
# H — handle_turn edges (overrides, streak boundary, passthrough, scrub)
# ---------------------------------------------------------------------------

def _decision(intent="answer-gov", **over):
    d = {
        "intent": intent, "confidence": 0.8, "rationale": "r", "rewritten_question": "rq",
        "clarify_questions": [], "post_title": "", "post_summary": "",
        "timeline_processing_type": "", "timeline_eligibility": "",
        "timeline_filing_month": "", "timeline_filing_year": "",
    }
    d.update(over)
    return d


class _HandlePatch:
    def __init__(self, decision, cap=None):
        self._d, self.cap = decision, cap if cap is not None else {}

    def __enter__(self):
        self._orig = (assist.route_turn, assist.answer_cascade, assist._post_draft,
                      assist._timeline_handoff, prof.scrub_pii)
        cap = self.cap
        assist.route_turn = lambda m, h=None: dict(self._d)
        def cascade(q, **k):
            cap["cascade_q"] = q
            return {"answer": "A", "source_tier": "gov", "citations": [], "community_cards": [], "is_fallback": False}
        assist.answer_cascade = cascade
        def post_draft(decision, message):
            cap["post_msg"] = message
            return {"title": "PT", "description": "PD", "groups": {}, "key_stages_or_info": {}, "key_dates": {}}
        assist._post_draft = post_draft
        assist._timeline_handoff = lambda decision, db: {"status": "unresolved", "group_id": "", "group_name": "", "criteria": {}}
        prof.scrub_pii = lambda t: (t or "").replace("SECRET", "[x]")
        return cap

    def __exit__(self, *a):
        (assist.route_turn, assist.answer_cascade, assist._post_draft,
         assist._timeline_handoff, prof.scrub_pii) = self._orig


def _ai(intent):
    return {"role": "ai", "content": "...", "intent": intent}


def _user():
    return {"role": "user", "content": "hi"}


def group_h() -> None:
    print("\nH — handle_turn edges")

    # invalid force_intent is ignored (falls back to the router's intent)
    with _HandlePatch(_decision("answer-gov")):
        r = assist.handle_turn("q", [], force_intent="banana", project_id="p", engine_id="e")
    check("H1 invalid force_intent ignored -> router intent", r["intent"] == "answer-gov" and r["answer"] == "A")

    # valid force_intent 'timeline-find' overrides an answer decision
    with _HandlePatch(_decision("answer-gov")):
        r = assist.handle_turn("q", [], force_intent="timeline-find")
    check("H2 force timeline-find overrides", r["intent"] == "timeline-find" and r["timeline"]["status"] == "unresolved")
    check("H2b can_find_timeline set on override", r["can_find_timeline"] is True)

    # clarify streak boundary: 2 prior clarifies still clarifies; 3 coerces to answer
    two = [_ai("clarify"), _user(), _ai("clarify"), _user()]
    with _HandlePatch(_decision("clarify", clarify_questions=["one more?"])) as cap:
        r = assist.handle_turn("q", two, project_id="p", engine_id="e")
    check("H3 streak==2 still clarifies", r["intent"] == "clarify" and "cascade_q" not in cap)
    three = two + [_ai("clarify"), _user()]
    with _HandlePatch(_decision("clarify", clarify_questions=["again?"])):
        r = assist.handle_turn("q", three, project_id="p", engine_id="e")
    check("H3b streak==3 coerces to answer", r["intent"] == "answer-gov")

    # timeline-find with insufficient criteria -> unresolved passthrough
    with _HandlePatch(_decision("timeline-find")):
        r = assist.handle_turn("q", [])
    check("H4 timeline unresolved passthrough", r["intent"] == "timeline-find" and r["timeline"]["status"] == "unresolved")

    # empty rewritten_question -> cascade falls back to the (scrubbed) message
    with _HandlePatch(_decision("answer-gov", rewritten_question="")) as cap:
        assist.handle_turn("original question", [], project_id="p", engine_id="e")
    check("H5 empty rewritten_question -> cascade uses message", cap.get("cascade_q") == "original question")

    # post path: _post_draft receives the SCRUBBED message (C3)
    with _HandlePatch(_decision("post")) as cap:
        assist.handle_turn("my number is SECRET", [])
    check("H6 post path scrubs message before draft", "SECRET" not in (cap.get("post_msg") or ""), cap.get("post_msg"))


# ---------------------------------------------------------------------------
# T — resolve_timeline_criteria edges
# ---------------------------------------------------------------------------

def _tdec(**over):
    d = {"timeline_processing_type": "", "timeline_eligibility": "",
         "timeline_filing_month": "", "timeline_filing_year": ""}
    d.update(over)
    return d


def group_t() -> None:
    print("\nT — resolve_timeline_criteria edges")

    r = assist.resolve_timeline_criteria(_tdec(
        timeline_processing_type="EAD", timeline_eligibility="stem-opt-extension",
        timeline_filing_month="Aug", timeline_filing_year="26"))
    check("T1 2-digit year rejected -> not sufficient", r["sufficient"] is False and r["filing_year"] == "")

    r = assist.resolve_timeline_criteria(_tdec(
        timeline_processing_type="EAD", timeline_eligibility="stem-opt-extension",
        timeline_filing_month="0", timeline_filing_year="2026"))
    check("T2 month 0 rejected -> not sufficient", r["sufficient"] is False and r["filing_month"] == "")

    r = assist.resolve_timeline_criteria(_tdec(
        timeline_processing_type="EAD", timeline_eligibility="STEM-OPT-EXTENSION",
        timeline_filing_month="Aug", timeline_filing_year="2026"))
    check("T3 wrong-case eligibility dropped (exact-match)", r["eligibility"] == "" and r["sufficient"] is False)

    r = assist.resolve_timeline_criteria(_tdec(
        timeline_processing_type="H-1B", timeline_filing_month="Mar", timeline_filing_year="2026"))
    check("T4 H-1B without application type -> not sufficient", r["sufficient"] is False)

    r = assist.resolve_timeline_criteria(_tdec(
        timeline_processing_type="  EAD  ", timeline_eligibility="  stem-opt-extension  ",
        timeline_filing_month="  Aug ", timeline_filing_year=" 2026 "))
    check("T5 whitespace trimmed everywhere -> sufficient",
          r["sufficient"] is True and "EAD" in r["criteria"]["tags"]
          and r["criteria"]["key_stages_or_info"].get("filing_month") == "Aug")


# ---------------------------------------------------------------------------
# C — community card with nothing to link to
# ---------------------------------------------------------------------------

def group_c() -> None:
    print("\nC — community card link edge")
    cards = assist._community_cards_from_chunks([{"chunk_id": "", "source": "", "text": "x", "channel": ""}])
    check("C1 no source + no id -> empty url", cards[0]["url"] == "")
    cards = assist._community_cards_from_chunks([{"chunk_id": "k1", "source": "", "text": "x"}])
    check("C2 id-only -> /case/{id}", cards[0]["url"] == "/case/k1")


def group_fs() -> None:
    print("\nFS — _find_handoff (find-similar -> /find Regular)")
    u = assist._find_handoff({"rewritten_question": "anyone else on H-1B at Mumbai?", "find_visa": "H-1B"})
    check("FS1 type=regular", "type=regular" in u)
    check("FS2 q carried", "q=" in u)
    check("FS3 vocab-valid visa carried", "visa=H-1B" in u)
    u2 = assist._find_handoff({"rewritten_question": "find people like me", "find_visa": "NOT-A-VISA"})
    check("FS4 invalid visa dropped", "visa=" not in u2 and "type=regular" in u2)
    u3 = assist._find_handoff({"rewritten_question": "", "find_visa": ""})
    check("FS5 no q -> just type=regular", u3 == "/find?type=regular")


def main() -> None:
    print("== test_assist_routing_edges ==")
    group_r()
    group_h()
    group_t()
    group_c()
    group_fs()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
