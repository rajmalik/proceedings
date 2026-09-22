#!/usr/bin/env python3
"""Offline hardening tests for AI-Assist **Phase 8**
(features/ai-assist-8/ai-assist-implementation-plan-8.md §Phase 8 + the risk list).

Covers:
  A  _clean_rationale — the shown "why I routed you here" line (A5) must never
     read as an eligibility / case-outcome assessment (E2). Benign rationales are
     kept; assessments are blanked.
  B  handle_turn — the returned rationale is run through _clean_rationale.
  C  _save_assist — analytics: route + source_tier + sources persisted (Q15).
  D  posting gate (source-level) — /api/postings requires a signed-in user with a
     set-up profile (visa/status) for a personal-case post, and EXEMPTS a general
     discussion/blog from that profile requirement.
  E  posting gate (behavioral) — the same rule exercised through the API with the
     GCP writes stubbed: empty-profile personal post -> 422; discussion/blog -> ok.

Run:  python tests/test_assist_hardening.py
Wired into the no-GCP CI gate.
"""
import inspect
import os
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
# D — posting validation: signed-in + non-empty profile (server-side)
# ---------------------------------------------------------------------------

def group_d() -> None:
    print("\nD — posting requires sign-in + a non-empty profile")
    import api
    src = inspect.getsource(api.create_posting)
    check("D1 /api/postings requires sign-in (_active_user, server-side)", "_active_user" in src)
    check("D2 /api/postings validates a non-empty profile (visa/status)",
          "current_visa_or_greencard_category" in src and "422" in src,
          "posting must reject an empty profile with a 422")
    check("D3 discussion/blog postings are EXEMPT from the profile requirement",
          "is_discussion" in src and '"discussion"' in src and '"blog"' in src
          and "if not is_discussion:" in src,
          "a general discussion/blog is not tied to the author's case → no profile gate")


# ---------------------------------------------------------------------------
# E — posting gate BEHAVIOR + discussion/blog exemption (offline)
#     Driven through /api/postings with the GCP writes stubbed. TestClient is
#     used WITHOUT its context manager on purpose, so the GCP-touching lifespan
#     startup never runs — this stays in the no-GCP gate.
# ---------------------------------------------------------------------------

def group_e() -> None:
    print("\nE — posting gate + discussion/blog exemption (behavioral)")
    from fastapi.testclient import TestClient
    import api
    import posting
    import profile

    # Dev/test identity via X-User-Id, limiter lifted, GCP writes stubbed.
    api.ALLOW_USER_IMPERSONATION = True
    api.RATE_LIMIT_MAX = 10_000
    orig_get_profile = profile.get_profile
    orig_publish = posting.publish_posting
    profile.get_profile = lambda db, uid: {}          # EMPTY author profile (no visa/status)
    posting.publish_posting = lambda *a, **k: {         # never touch GCS / the datastore
        "case_id": "app-e2e-test", "gcs_path": "gs://test/x",
        "indexed": True, "author_handle": "anon-test",
    }
    hdr = {"X-User-Id": "demo-arjun"}                    # a baked seed id (accepted)
    client = TestClient(api.app)                          # no `with` -> lifespan not run
    try:
        # A personal-case post from an empty-profile author is still gated (422).
        normal = client.post("/api/postings", headers=hdr, json={
            "title": "A personal H-1B question",
            "description": "Details about my own case that I want help with.",
            "tags": {"tags": ["general-inquiry"]},
        })
        check("E1 empty-profile personal post -> 422 (profile gate holds)",
              normal.status_code == 422, f"status={normal.status_code}")

        # A discussion is not tied to the author's case -> EXEMPT (publishes).
        disc = client.post("/api/postings", headers=hdr, json={
            "title": "How premium processing actually works",
            "description": "A general explainer for everyone, not my own case.",
            "tags": {"tags": ["discussion"]},
        })
        check("E2 empty-profile DISCUSSION post -> 200 (exempt from the profile gate)",
              disc.status_code == 200 and disc.json().get("case_id") == "app-e2e-test",
              f"status={disc.status_code} body={disc.json()}")

        # blog is exempt on the same footing.
        blog = client.post("/api/postings", headers=hdr, json={
            "title": "How to respond to an RFE",
            "description": "A generic step-by-step how-to guide.",
            "tags": {"tags": ["blog"]},
        })
        check("E3 empty-profile BLOG post -> 200 (exempt)", blog.status_code == 200,
              f"status={blog.status_code}")

        # Curated/offline publish: a trusted caller carrying the internal secret
        # bypasses the signed-in-user gate (fix for the manual publish.sh, which
        # posts to /api/postings with no app auth and 401'd after the hardening).
        _prev = os.environ.get("GOV_NEWS_POLL_SECRET")
        os.environ["GOV_NEWS_POLL_SECRET"] = "test-internal-secret"
        try:
            curated = client.post(
                "/api/postings",
                headers={"X-Internal-Poll-Secret": "test-internal-secret"},  # note: NO X-User-Id
                json={"title": "A curated tip", "description": "A curated how-to guide for everyone.",
                      "tags": {"tags": ["general-inquiry"]}},
            )
            check("E4 valid internal secret publishes with NO signed-in user (curated bypass)",
                  curated.status_code == 200 and curated.json().get("case_id") == "app-e2e-test",
                  f"status={curated.status_code} body={curated.json()}")

            # Valid title/body so this reaches the auth gate (not request
            # validation): a wrong secret must NOT bypass -> no signed-in user
            # here, so it is rejected (4xx), never published.
            bad = client.post(
                "/api/postings",
                headers={"X-Internal-Poll-Secret": "wrong-secret"},
                json={"title": "A wrong-secret attempt", "description": "a general explainer, also long enough",
                      "tags": {"tags": ["general-inquiry"]}},
            )
            check("E5 wrong internal secret -> still gated (4xx, not published)",
                  bad.status_code != 200 and 400 <= bad.status_code < 500,
                  f"status={bad.status_code}")
        finally:
            if _prev is None:
                os.environ.pop("GOV_NEWS_POLL_SECRET", None)
            else:
                os.environ["GOV_NEWS_POLL_SECRET"] = _prev
    finally:
        profile.get_profile = orig_get_profile
        posting.publish_posting = orig_publish


def main() -> None:
    print("== test_assist_hardening (AI-Assist Phase 8) ==")
    group_a()
    group_b()
    group_c()
    group_d()
    group_e()
    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
