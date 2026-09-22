#!/usr/bin/env python3
"""Offline unit tests for the AI-Assist **Phase 6** wiring
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 6):
handle_turn orchestration + POST /api/assist + the anonymous rate limiter.

Offline / no-GCP:
  - handle_turn's sub-calls (route_turn, answer_cascade, _post_draft,
    _timeline_handoff) and profile.scrub_pii are monkeypatched.
  - The route is exercised by calling api.assist_turn() directly with a fake
    Request (no TestClient/startup, so no GCP init); _optional_user is stubbed,
    _db is None so nothing hits Firestore.

Covers:
  H  handle_turn — dispatch per intent, clarify-streak default (Q17), force_intent
     override (A5), PII scrubbed before Gemini (C3), disclaimer/affordances.
  L  check_assist_anon_limit — N-then-block, per-key isolation.
  R  assist_turn route — anon cap + nudge, authenticated path, response mapping.

Run:  python tests/test_assist_route.py
Wired into the no-GCP CI gate.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import assist  # noqa: E402
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


def _decision(intent="answer-gov", **over):
    d = {
        "intent": intent, "confidence": 0.8, "rationale": "why",
        "rewritten_question": "rewritten q", "clarify_questions": [],
        "post_title": "", "post_summary": "",
        "timeline_processing_type": "", "timeline_eligibility": "",
        "timeline_filing_month": "", "timeline_filing_year": "",
    }
    d.update(over)
    return d


_ANSWER = {"answer": "A", "source_tier": "gov", "citations": [{"source": "https://uscis.gov", "title": "t", "as_of": "2026-01-01"}],
           "community_cards": [], "is_fallback": False}


class _Patch:
    """Monkeypatch assist.* + profile.scrub_pii for one handle_turn scenario."""
    def __init__(self, decision, *, answer=None, post_draft=None, timeline=None, capture=None):
        self._decision, self._answer = decision, answer or _ANSWER
        self._post_draft = post_draft or {"title": "PT", "description": "PD", "groups": {}, "key_stages_or_info": {}, "key_dates": {}}
        self._timeline = timeline or {"status": "found", "group_id": "g1", "group_name": "EAD-x", "criteria": {}}
        self._capture = capture if capture is not None else {}

    def __enter__(self):
        self._orig = (assist.route_turn, assist.answer_cascade, assist._post_draft,
                      assist._timeline_handoff, prof.scrub_pii)
        cap = self._capture

        def route_turn(message, history=None):
            cap["route_msg"] = message
            cap["route_hist"] = history
            return self._decision

        def answer_cascade(q, **k):
            cap["cascade_q"] = q
            return self._answer

        assist.route_turn = route_turn
        assist.answer_cascade = answer_cascade
        assist._post_draft = lambda decision, message: dict(self._post_draft)
        assist._timeline_handoff = lambda decision, db: dict(self._timeline)
        prof.scrub_pii = lambda t: (t or "").replace("SECRET", "[x]")
        return cap

    def __exit__(self, *a):
        (assist.route_turn, assist.answer_cascade, assist._post_draft,
         assist._timeline_handoff, prof.scrub_pii) = self._orig


_RESULT_KEYS = {"intent", "confidence", "answer", "source_tier", "citations", "community_cards",
                "clarify_questions", "post_draft", "timeline", "find_url", "search_suggestions_html",
                "disclaimer", "can_post", "can_find_timeline", "can_find_similar", "rationale", "is_fallback"}


def group_h() -> None:
    print("\nH — handle_turn orchestration")

    with _Patch(_decision("answer-gov")) as cap:
        r = assist.handle_turn("q", [], project_id="p", engine_id="e")
    check("H0 full result schema", _RESULT_KEYS <= set(r.keys()), str(set(r.keys()) ^ _RESULT_KEYS))
    check("H1 answer intent -> cascade answer mapped",
          r["intent"] == "answer-gov" and r["answer"] == "A" and r["source_tier"] == "gov" and len(r["citations"]) == 1)
    check("H1b cascade got the rewritten question", cap.get("cascade_q") == "rewritten q")
    check("H1c disclaimer always present", bool(r["disclaimer"]))
    check("H1d can_post always true", r["can_post"] is True)

    with _Patch(_decision("post", post_title="X")):
        r = assist.handle_turn("q", [])
    check("H2 post intent -> post_draft built", r["intent"] == "post" and r["post_draft"]["title"] == "PT")
    check("H2b post intent has no answer", r["answer"] == "")

    with _Patch(_decision("timeline-find", timeline_processing_type="EAD")):
        r = assist.handle_turn("q", [])
    check("H3 timeline-find -> timeline handoff", r["intent"] == "timeline-find" and r["timeline"]["group_id"] == "g1")
    check("H3b can_find_timeline true", r["can_find_timeline"] is True)

    with _Patch(_decision("find-similar")):
        r = assist.handle_turn("anyone else on H-1B at Mumbai?", [])
    check("H3c find-similar -> /find regular deep-link",
          r["intent"] == "find-similar" and r["can_find_similar"] is True
          and r["find_url"].startswith("/find?type=regular"), r.get("find_url"))

    with _Patch(_decision("clarify", clarify_questions=["a", "b"])):
        r = assist.handle_turn("q", [])
    check("H4 clarify -> questions surfaced", r["intent"] == "clarify" and r["clarify_questions"] == ["a", "b"])

    # Q17: after 3 clarify rounds already in history, don't clarify again — answer.
    streak_hist = [{"role": "ai", "intent": "clarify"}, {"role": "user"},
                   {"role": "ai", "intent": "clarify"}, {"role": "user"},
                   {"role": "ai", "intent": "clarify"}, {"role": "user"}]
    with _Patch(_decision("clarify", clarify_questions=["again?"])) as cap:
        r = assist.handle_turn("q", streak_hist, project_id="p", engine_id="e")
    check("H5 3-clarify streak -> coerced to answer", r["intent"] == "answer-gov" and r["answer"] == "A")
    check("H5b coerced path actually ran the cascade", cap.get("cascade_q") == "rewritten q")

    # A5 override: router said answer, user forced 'post'.
    with _Patch(_decision("answer-gov", post_title="Y")):
        r = assist.handle_turn("q", [], force_intent="post")
    check("H6 force_intent overrides router", r["intent"] == "post" and r["post_draft"]["title"] == "PT")

    # C3: PII scrubbed before route_turn (Gemini).
    with _Patch(_decision("answer-gov")) as cap:
        assist.handle_turn("my SSN is SECRET", [])
    check("H7 message scrubbed before route_turn", "SECRET" not in (cap.get("route_msg") or ""), cap.get("route_msg"))

    # can_find_timeline surfaces on a non-timeline turn that still carried a timeline signal.
    with _Patch(_decision("answer-gov", timeline_processing_type="H-1B")):
        r = assist.handle_turn("q", [], project_id="p", engine_id="e")
    check("H8 answer turn w/ timeline signal -> can_find_timeline", r["can_find_timeline"] is True)

    # web-tier answer carries source_tier + the Search-Suggestion chips (Phase 3).
    orig = (assist.route_turn, assist.answer_cascade)
    assist.route_turn = lambda m, h=None: _decision("answer-gov")
    assist.answer_cascade = lambda q, **k: {
        "answer": "live web answer", "source_tier": "web",
        "citations": [{"source": "https://r", "title": "uscis.gov", "as_of": ""}],
        "community_cards": [], "is_fallback": False, "search_suggestions_html": "<div>chips</div>"}
    try:
        r = assist.handle_turn("q", [], project_id="p", engine_id="e")
    finally:
        assist.route_turn, assist.answer_cascade = orig
    check("H9 web tier carries source_tier + chips",
          r["source_tier"] == "web" and r.get("search_suggestions_html") == "<div>chips</div>")


def group_l() -> None:
    print("\nL — check_assist_anon_limit")
    import api
    api._assist_anon_rate.clear()
    n = api.ASSIST_ANON_MAX
    ok = all(api.check_assist_anon_limit("k1") for _ in range(n))
    check("L1 allows up to the cap", ok)
    check("L2 blocks past the cap", api.check_assist_anon_limit("k1") is False)
    check("L3 a different key is independent", api.check_assist_anon_limit("k2") is True)


def group_r() -> None:
    print("\nR — assist_turn route")
    import api

    def _req(host="9.9.9.9"):
        return SimpleNamespace(client=SimpleNamespace(host=host))

    canned = {
        "intent": "answer-gov", "confidence": 0.7, "answer": "hi", "source_tier": "gov",
        "citations": [{"source": "https://uscis.gov", "title": "t", "as_of": "2026"}],
        "community_cards": [{"case_id": "c1", "title": "T", "snippet": "s", "url": "/case/c1", "channel": "app"}],
        "clarify_questions": [], "post_draft": {"title": "PT", "description": "PD", "groups": {}, "key_stages_or_info": {}, "key_dates": {}},
        "timeline": {"status": "not_found", "group_id": "", "group_name": "EAD-x", "criteria": {}},
        "search_suggestions_html": "<div>chips</div>",
        "disclaimer": "not legal advice", "can_post": True, "can_find_timeline": True,
        "rationale": "why", "is_fallback": False,
    }
    orig_uid, orig_handle, orig_db = api._optional_user, assist.handle_turn, api._db
    api._db = None
    assist.handle_turn = lambda *a, **k: dict(canned)
    try:
        # R1 anonymous under cap
        api._optional_user = lambda r: ""
        api._assist_anon_rate.clear()
        resp = api.assist_turn(api.AssistRequest(message="hi", session_id="sess-A"), _req())
        check("R1 returns AssistResponse", isinstance(resp, api.AssistResponse))
        check("R1b fields mapped", resp.intent == "answer-gov" and resp.answer == "hi" and resp.disclaimer == "not legal advice")
        check("R1c nested models coerced",
              resp.post_draft.title == "PT" and resp.timeline.status == "not_found"
              and resp.citations[0].as_of == "2026" and resp.community_cards[0].url == "/case/c1")
        check("R1e search-suggestion chips mapped to the response", resp.search_suggestions_html == "<div>chips</div>")
        check("R1d anon turns_used counted", resp.turns_used == 1)

        # R2 anonymous over cap -> 429 with a sign-in nudge
        api._assist_anon_rate.clear()
        for _ in range(api.ASSIST_ANON_MAX):
            api.assist_turn(api.AssistRequest(message="x", session_id="sess-B"), _req())
        raised = None
        try:
            api.assist_turn(api.AssistRequest(message="x", session_id="sess-B"), _req())
        except Exception as e:  # fastapi.HTTPException
            raised = e
        check("R2 over cap raises 429", raised is not None and getattr(raised, "status_code", None) == 429)
        check("R2b nudge mentions signing in", "sign in" in str(getattr(raised, "detail", "")).lower())

        # R3 authenticated uses the standard limiter, not the anon cap
        api._optional_user = lambda r: "uid-1"
        api._rate_limit.clear()
        resp = api.assist_turn(api.AssistRequest(message="hi"), _req())
        check("R3 authenticated ok", isinstance(resp, api.AssistResponse) and resp.turns_used == 0)
    finally:
        api._optional_user, assist.handle_turn, api._db = orig_uid, orig_handle, orig_db


def main() -> None:
    print("== test_assist_route (AI-Assist Phase 6 — wiring) ==")
    group_h()
    group_l()
    group_r()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
