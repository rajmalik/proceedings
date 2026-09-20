#!/usr/bin/env python3
"""Offline unit tests for the AI-Assist **Phase 4** post handoff (backend half)
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 4 — _post_draft).

Offline / no-GCP: posting.suggest_tags (which would call Gemini) and
profile.scrub_pii are monkeypatched. The frontend half (sessionStorage draft
contract + /post mount effect) is covered by the website vitest suite
(assistDraft.test.ts, postReconcile.test.ts).

Covers:
  A  _post_draft — maps a router decision -> the /post draft shape, PII scrubbed
     BEFORE Gemini (C3) and in the returned draft; sensible fallbacks.

Run:  python tests/test_assist_post.py
Wired into the no-GCP CI gate.
"""
import sys
from pathlib import Path

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


_DRAFT_KEYS = {"title", "description", "groups", "key_stages_or_info", "key_dates"}

_TAGS_RETURN = {
    "groups": {"visa_applying_for": ["H-1B"], "tags": ["timeline"]},
    "relevant_sections": ["visa_applying_for"],
    "posting_type": "experience-posting",
    "key_stages_or_info": {"filing": "receipt"},
    "key_dates": {"filing_date": "2026-08-01"},
}


def _decision(**over):
    d = assist._fallback_decision("the original message")
    d["intent"] = "post"
    d.update(over)
    return d


def _install_stubs(suggest_calls: list):
    """Stub suggest_tags (records its args) + a visible scrub_pii; return restore."""
    orig_suggest, orig_scrub = posting.suggest_tags, prof.scrub_pii
    posting.suggest_tags = lambda title, description: (
        suggest_calls.append((title, description)) or _TAGS_RETURN)
    prof.scrub_pii = lambda t: t.replace("SECRET", "[redacted]")
    return orig_suggest, orig_scrub


def group_a() -> None:
    print("\nA — _post_draft")
    calls = []
    orig_suggest, orig_scrub = _install_stubs(calls)
    try:
        d = assist._post_draft(
            _decision(post_title="My H-1B transfer", post_summary="Moving employers next month"),
            "Moving employers next month")
    finally:
        posting.suggest_tags, prof.scrub_pii = orig_suggest, orig_scrub

    check("A1 full draft schema", _DRAFT_KEYS <= set(d.keys()), str(set(d.keys())))
    check("A2 title from post_title", d["title"] == "My H-1B transfer", d["title"])
    check("A3 description from post_summary", d["description"] == "Moving employers next month")
    check("A4 groups from suggest_tags", d["groups"] == _TAGS_RETURN["groups"])
    check("A5 stages from suggest_tags", d["key_stages_or_info"] == _TAGS_RETURN["key_stages_or_info"])
    check("A6 dates from suggest_tags", d["key_dates"] == _TAGS_RETURN["key_dates"])

    # C3 — PII scrubbed before Gemini AND in the returned draft.
    calls = []
    orig_suggest, orig_scrub = _install_stubs(calls)
    try:
        d = assist._post_draft(
            _decision(post_title="Case for SECRET", post_summary="my A-number is SECRET here"),
            "my A-number is SECRET here")
    finally:
        posting.suggest_tags, prof.scrub_pii = orig_suggest, orig_scrub
    check("A7 title scrubbed in draft", "SECRET" not in d["title"], d["title"])
    check("A8 description scrubbed in draft", "SECRET" not in d["description"], d["description"])
    check("A9 suggest_tags received scrubbed input (no PII to Gemini)",
          calls and all("SECRET" not in a for a in calls[0]), str(calls))

    # Fallbacks: empty post_title/summary -> derive from the (scrubbed) message.
    calls = []
    orig_suggest, orig_scrub = _install_stubs(calls)
    try:
        d = assist._post_draft(_decision(post_title="", post_summary=""),
                               "a plain message about OPT with SECRET token")
    finally:
        posting.suggest_tags, prof.scrub_pii = orig_suggest, orig_scrub
    check("A10 empty title -> derived, non-empty", bool(d["title"]))
    check("A11 empty summary -> falls back to message", "OPT" in d["description"])
    check("A12 fallback path still scrubbed", "SECRET" not in d["description"] and "SECRET" not in d["title"])


def main() -> None:
    print("== test_assist_post (AI-Assist Phase 4 — post handoff, backend) ==")
    group_a()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
