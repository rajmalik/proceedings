#!/usr/bin/env python3
"""Offline hardening tests for AI-Assist **Phase 8**
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 8 + the risk list).

Covers:
  A  _clean_rationale — the shown "why I routed you here" line (A5) must never
     read as an eligibility / case-outcome assessment (E2). Benign rationales are
     kept; assessments are blanked.
  B  handle_turn — the returned rationale is run through _clean_rationale.
  C  _save_assist — analytics: route + source_tier + sources persisted (Q15).
  D  anonymous-posting invariant — /api/postings stays anon-capable server-side
     (uses _optional_user, never _active_user); the login gate is the /post page.

Run:  python tests/test_assist_hardening.py
Wired into the no-GCP CI gate.
"""
import inspect
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))  # backend/ on path

import assist  # noqa: E402

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
# A — _clean_rationale (E2 guardrail on the shown routing explanation)
# ---------------------------------------------------------------------------

_KEEP = [
    "This looks like a general information question.",
    "Routing to post because it's specific to your situation.",
    "About EAD processing times — suggesting your timeline group.",
    "Suggesting you post this to the community.",
]
_BLANK = [
    "You qualify for a marriage-based green card.",
    "You are eligible for STEM OPT.",
    "You will likely be approved.",
    "Your case will probably be denied.",
    "This makes you ineligible.",
    "Approval is likely for your petition.",
]


def group_a() -> None:
    print("\nA — _clean_rationale")
    for s in _KEEP:
        check(f"A keep: {s[:40]}", assist._clean_rationale(s) == s)
    for s in _BLANK:
        check(f"A blank: {s[:40]}", assist._clean_rationale(s) == "", assist._clean_rationale(s))
    check("A empty -> ''", assist._clean_rationale("") == "")
    check("A None -> ''", assist._clean_rationale(None) == "")


# ---------------------------------------------------------------------------
# B — handle_turn cleans the rationale
# ---------------------------------------------------------------------------

def group_b() -> None:
    print("\nB — handle_turn sanitizes rationale")
    import posting
    orig = (assist.route_turn, assist.answer_cascade)

    def fake_route(message, history=None):
        d = {
            "intent": "answer-gov", "confidence": 0.9,
            "rationale": "You qualify for asylum.",  # an eligibility assessment
            "rewritten_question": "q", "clarify_questions": [],
            "post_title": "", "post_summary": "",
            "timeline_processing_type": "", "timeline_eligibility": "",
            "timeline_filing_month": "", "timeline_filing_year": "",
        }
        return d

    assist.route_turn = fake_route
    assist.answer_cascade = lambda q, **k: {"answer": "a", "source_tier": "gov", "citations": [], "community_cards": [], "is_fallback": False}
    try:
        r = assist.handle_turn("q", [], project_id="p", engine_id="e")
    finally:
        assist.route_turn, assist.answer_cascade = orig
    check("B eligibility-assessment rationale blanked in output", r["rationale"] == "", r["rationale"])

    # a benign rationale survives
    def fake_route2(message, history=None):
        d = fake_route(message, history)
        d["rationale"] = "This is a general information question."
        return d
    assist.route_turn = fake_route2
    assist.answer_cascade = lambda q, **k: {"answer": "a", "source_tier": "gov", "citations": [], "community_cards": [], "is_fallback": False}
    try:
        r = assist.handle_turn("q", [], project_id="p", engine_id="e")
    finally:
        assist.route_turn, assist.answer_cascade = orig
    check("B benign rationale kept", r["rationale"] == "This is a general information question.")


# ---------------------------------------------------------------------------
# C — _save_assist analytics (route + source_tier + sources)
# ---------------------------------------------------------------------------

class _Ref:
    id = "doc-9"


class _Coll:
    def __init__(self, sink):
        self.sink = sink

    def add(self, doc):
        self.sink.append(doc)
        return (None, _Ref())


class _DB:
    def __init__(self):
        self.docs = []

    def collection(self, name):
        assert name == "qa_pairs", name
        return _Coll(self.docs)


def group_c() -> None:
    print("\nC — _save_assist analytics")
    import api
    orig_db = api._db
    db = _DB()
    api._db = db
    try:
        doc_id = api._save_assist("how long for EAD?", {
            "intent": "answer-community", "source_tier": "community",
            "answer": "Community members report ~3 months.", "is_fallback": False,
            "citations": [{"source": "https://uscis.gov"}],
            "community_cards": [{"url": "/case/c1"}],
        })
    finally:
        api._db = orig_db
    check("C1 returns doc id", doc_id == "doc-9")
    doc = db.docs[-1]
    check("C2 route persisted", doc.get("route") == "answer-community", str(doc.get("route")))
    check("C3 source_tier persisted", doc.get("source_tier") == "community")
    check("C4 sources include the citation + card link",
          set(doc.get("sources", [])) == {"https://uscis.gov", "/case/c1"}, str(doc.get("sources")))
    check("C5 is_fallback recorded", doc.get("is_fallback") is False)


# ---------------------------------------------------------------------------
# D — anonymous-posting invariant (the gate is the /post page, not the API)
# ---------------------------------------------------------------------------

def group_d() -> None:
    print("\nD — anonymous-posting invariant")
    import api
    src = inspect.getsource(api.create_posting)
    check("D1 /api/postings is anon-capable (uses _optional_user)", "_optional_user" in src)
    check("D2 /api/postings is NOT server-gated (no _active_user)", "_active_user" not in src,
          "posting must stay anon-reachable — the login gate lives in /post (useRequireUser)")


def main() -> None:
    print("== test_assist_hardening (AI-Assist Phase 8) ==")
    group_a()
    group_b()
    group_c()
    group_d()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
