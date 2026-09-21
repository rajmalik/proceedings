"""
test_group_messages.py — phase-N group chat messages.

Groups:
  A  pure: text cleaning + PII scrub (redact + don't over-redact) + view — always runs
  B  live Firestore: post/list/since-delta/membership/author-delete — INTEGRATION
  C  HTTP API via FastAPI TestClient (gating, 403, PII, delete authz, GET group) — INTEGRATION
  D  live Firestore edges: ordering/limit/since-boundary/join/idempotent delete — INTEGRATION

Run:  .venv/bin/python tests/test_group_messages.py [unit|integration|all]
"""

import os
import secrets
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

import group_messages as G  # noqa: E402

PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
_results: list[tuple[str, bool]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def _seed_group(db, gid: str, members: list[tuple[str, str]]) -> None:
    db.collection("groups").document(gid).set({
        "name": "Test group", "members": [{"user_id": u, "username": n} for u, n in members],
        "status": "formed", "created_at": G._now_iso(),
    })


def _cleanup_group(db, gid: str) -> None:
    try:
        for d in db.collection("groups").document(gid).collection("messages").stream():
            d.reference.delete()
        db.collection("groups").document(gid).delete()
    except Exception as e:  # noqa: BLE001
        print(f"  cleanup note: {e}")


# ---------------------------------------------------------------------------
# A — pure
# ---------------------------------------------------------------------------

def group_a_pure() -> None:
    print("\nA — text cleaning + PII scrub + view (pure)")
    cleaned = G._clean_text("Reach me at 415-555-1234 or me@example.com — case A12345678")
    check("A1 PII scrubbed (phone/email/A-number redacted)",
          "415-555-1234" not in cleaned and "me@example.com" not in cleaned and "A12345678" not in cleaned, cleaned)
    try:
        G._clean_text("   "); check("A2 empty rejected", False, "no raise")
    except ValueError:
        check("A2 empty rejected (ValueError)", True)
    try:
        G._clean_text("x" * (G.MAX_TEXT + 1)); check("A3 over-long rejected", False, "no raise")
    except ValueError:
        check("A3 over-long rejected (ValueError)", True)

    doc = {"id": "m1", "author_uid": "demo-arjun", "author_handle": "arjun-h1b",
           "text": "hello", "created_at": "2026-06-07T00:00:00Z", "deleted": False}
    v_self = G._message_view(doc, "demo-arjun")
    v_other = G._message_view(doc, "demo-mei")
    check("A4 view omits author_uid", "author_uid" not in v_self)
    check("A5 is_author reflects the viewer", v_self["is_author"] is True and v_other["is_author"] is False)
    v_del = G._message_view({**doc, "deleted": True}, "x")
    check("A6 soft-deleted message hides text", v_del["deleted"] is True and v_del["text"] == "")

    # PII scrub — positive (redact) and negative (don't over-redact)
    multi = G._clean_text("call 415-555-1234 or 408-555-9999, A12345678, a@b.com")
    check("A7 multiple PII items all redacted",
          all(s not in multi for s in ("415-555-1234", "408-555-9999", "A12345678", "a@b.com")), multi)
    keep_date = G._clean_text("My priority date is 2022-01-01 and I filed on 2026-06-07")
    check("A8 dates are NOT treated as phone numbers (kept)",
          "2022-01-01" in keep_date and "2026-06-07" in keep_date, keep_date)
    keep_short = G._clean_text("Form I-140 receipt WAC2190 — visa H-1B")
    check("A9 short codes / visa tags preserved (no false redaction)",
          "I-140" in keep_short and "H-1B" in keep_short, keep_short)

    # length boundary + whitespace
    exact = G._clean_text("x" * G.MAX_TEXT)
    check("A10 exactly MAX_TEXT chars allowed", len(exact) == G.MAX_TEXT)
    try:
        G._clean_text("x" * (G.MAX_TEXT + 1)); check("A11 MAX_TEXT+1 rejected", False, "no raise")
    except ValueError:
        check("A11 MAX_TEXT+1 rejected (ValueError)", True)
    check("A12 surrounding whitespace trimmed", G._clean_text("   hello team   ") == "hello team")


# ---------------------------------------------------------------------------
# B — live Firestore
# ---------------------------------------------------------------------------

def group_b_firestore() -> None:
    print("\nB — live Firestore messages (integration)")
    from google.cloud import firestore
    db = firestore.Client(project=PROJECT)
    gid = f"test-group-{secrets.token_hex(4)}"
    a, b, c = "test-user-a", "test-user-b", "test-user-c"  # c is NOT a member
    try:
        # demo-arjun is a real registered (seed-roster) user with a Firestore
        # `users/{uid}.username` of "arjun-h1b" — included so B1b/B1c below can
        # prove post_message() resolves the REAL handle via handle_for(), not
        # the raw uid (a/b/c are synthetic test uids with no registered
        # handle at all, so they can't demonstrate the fix either way).
        _seed_group(db, gid, [(a, "alpha"), (b, "bravo"), ("demo-arjun", "unused-stale-placeholder")])

        m1 = G.post_message(db, gid, a, "first message")
        check("B1 post returns view (no author_uid, is_author)",
              "author_uid" not in m1 and m1["is_author"] is True and m1["text"] == "first message")
        m2 = G.post_message(db, gid, b, "second message")

        listed = G.list_messages(db, gid, viewer_id=a)
        ids = [m["id"] for m in listed]
        check("B2 list returns both oldest→newest", ids == [m1["id"], m2["id"]], str(ids))
        check("B3 is_author per viewer",
              next(m for m in listed if m["id"] == m1["id"])["is_author"] is True
              and next(m for m in listed if m["id"] == m2["id"])["is_author"] is False)

        # since cursor → only newer than m1
        delta = G.list_messages(db, gid, viewer_id=a, since=m1["created_at"])
        check("B4 since cursor returns only newer", [m["id"] for m in delta] == [m2["id"]], str([m["id"] for m in delta]))

        # non-member denied
        try:
            G.list_messages(db, gid, viewer_id=c); check("B5 non-member list denied", False, "no raise")
        except PermissionError:
            check("B5 non-member list denied (PermissionError)", True)
        try:
            G.post_message(db, gid, c, "intruder"); check("B6 non-member post denied", False, "no raise")
        except PermissionError:
            check("B6 non-member post denied (PermissionError)", True)

        # missing group
        try:
            G.post_message(db, "no-such-group", a, "hi"); check("B7 missing group raises", False, "no raise")
        except KeyError:
            check("B7 missing group raises (KeyError)", True)

        # author-only delete
        try:
            G.delete_message(db, gid, m1["id"], b); check("B8 non-author delete denied", False, "no raise")
        except PermissionError:
            check("B8 non-author delete denied (PermissionError)", True)
        G.delete_message(db, gid, m1["id"], a)
        after = G.list_messages(db, gid, viewer_id=a)
        m1_after = next((m for m in after if m["id"] == m1["id"]), None)
        check("B9 soft-deleted message present but text hidden",
              m1_after is not None and m1_after["deleted"] is True and m1_after["text"] == "")

        # PII scrub persists
        mp = G.post_message(db, gid, a, "call 415-555-9999")
        check("B10 PII scrubbed on write", "415-555-9999" not in mp["text"], mp["text"])

        # B11-B12: the handle-not-uid fix (post_message → profile.handle_for)
        # and the last_activity_at bump (matching.py's join/invite bump it
        # too) — placed last so the extra post doesn't perturb B2/B4/B9's
        # exact-message-count/ordering assumptions above.
        before_activity = (db.collection("groups").document(gid).get().to_dict() or {}).get("last_activity_at", "")
        m_arjun = G.post_message(db, gid, "demo-arjun", "hi from a real registered user")
        check("B11 post_message resolves the REAL registered handle, not the raw uid",
              m_arjun["author_handle"] == "arjun-h1b", m_arjun["author_handle"])
        after_activity = (db.collection("groups").document(gid).get().to_dict() or {}).get("last_activity_at", "")
        check("B12 posting bumps the parent group doc's last_activity_at",
              bool(after_activity) and after_activity != before_activity,
              f"before={before_activity!r} after={after_activity!r}")
    finally:
        _cleanup_group(db, gid)
        print("  cleaned up test docs")


# ---------------------------------------------------------------------------
# C — HTTP API via TestClient
# ---------------------------------------------------------------------------

def group_c_api() -> None:
    print("\nC — HTTP API via TestClient (integration)")
    from fastapi.testclient import TestClient
    from google.cloud import firestore
    import api
    api.RATE_LIMIT_MAX = 100000

    db = firestore.Client(project=PROJECT)
    gid = f"test-group-api-{secrets.token_hex(4)}"
    A = {"X-User-Id": "demo-arjun"}
    M = {"X-User-Id": "demo-mei"}
    S = {"X-User-Id": "demo-sofia"}  # NOT a member
    try:
        _seed_group(db, gid, [("demo-arjun", "arjun-h1b"), ("demo-mei", "mei-f1")])
        with TestClient(api.app) as c:
            check("C1 post without user → 400",
                  c.post(f"/api/groups/{gid}/messages", json={"text": "hi"}).status_code == 400)
            check("C2 unknown user → 404",
                  c.post(f"/api/groups/{gid}/messages", json={"text": "hi"},
                         headers={"X-User-Id": "ghost"}).status_code == 404)
            check("C3 non-member list → 403", c.get(f"/api/groups/{gid}/messages", headers=S).status_code == 403)
            check("C4 non-member post → 403",
                  c.post(f"/api/groups/{gid}/messages", json={"text": "hi"}, headers=S).status_code == 403)
            check("C5 empty text → 422",
                  c.post(f"/api/groups/{gid}/messages", json={"text": "   "}, headers=A).status_code == 422)

            r = c.post(f"/api/groups/{gid}/messages",
                       json={"text": "Hello team — email me@example.com"}, headers=A)
            rj = r.json()
            check("C6 post 200 + MessageCard (handle/is_author, no author_uid, PII scrubbed)",
                  r.status_code == 200 and rj.get("author_handle") == "arjun-h1b" and rj.get("is_author") is True
                  and "author_uid" not in rj and "me@example.com" not in rj.get("text", ""), f"status={r.status_code}")
            mid = rj["id"]

            g = c.get(f"/api/groups/{gid}/messages", headers=M).json()
            mine = next(m for m in g["messages"] if m["id"] == mid)
            check("C7 member list shows the message; is_author=false for the other member",
                  g["total"] >= 1 and mine["is_author"] is False)

            gg = c.get(f"/api/groups/{gid}", headers=A).json()
            check("C8 GET /api/groups/{id} returns group + is_member",
                  gg.get("group_id") == gid and gg.get("is_member") is True)

            check("C9 DELETE by non-author (mei) → 403",
                  c.delete(f"/api/groups/{gid}/messages/{mid}", headers=M).status_code == 403)
            check("C10 DELETE by author (arjun) → 200",
                  c.delete(f"/api/groups/{gid}/messages/{mid}", headers=A).status_code == 200)
            check("C11 DELETE missing message → 404",
                  c.delete(f"/api/groups/{gid}/messages/no-such", headers=A).status_code == 404)

            # GET /api/groups/{id} — browse-style: non-member sees metadata with is_member=false
            ng = c.get(f"/api/groups/{gid}", headers=S)
            check("C12 GET group as non-member → 200 + is_member=false",
                  ng.status_code == 200 and ng.json().get("is_member") is False, f"status={ng.status_code}")
            check("C13 GET unknown group → 404", c.get("/api/groups/no-such-group", headers=A).status_code == 404)
            check("C14 GET group without user → 400", c.get(f"/api/groups/{gid}").status_code == 400)
            check("C15 over-long message → 422",
                  c.post(f"/api/groups/{gid}/messages", json={"text": "x" * 4001}, headers=A).status_code == 422)
    finally:
        _cleanup_group(db, gid)
        print("  cleaned up API test docs")


def group_d_edges() -> None:
    print("\nD — ordering / limit / since-boundary / join / idempotent delete (integration)")
    from google.cloud import firestore
    db = firestore.Client(project=PROJECT)
    gid = f"test-group-edge-{secrets.token_hex(4)}"
    a, b = "test-user-a", "test-user-b"
    try:
        # empty group lists nothing
        _seed_group(db, gid, [(a, "alpha")])
        check("D1 empty group → no messages", G.list_messages(db, gid, viewer_id=a) == [])

        m1 = G.post_message(db, gid, a, "one")
        m2 = G.post_message(db, gid, a, "two")
        m3 = G.post_message(db, gid, a, "three")

        # chronological order
        full = [m["text"] for m in G.list_messages(db, gid, viewer_id=a)]
        check("D2 messages returned oldest→newest", full == ["one", "two", "three"], str(full))

        # limit returns the NEWEST n (still chronological)
        last2 = [m["text"] for m in G.list_messages(db, gid, viewer_id=a, limit=2)]
        check("D3 limit caps to the newest n (chronological)", last2 == ["two", "three"], str(last2))

        # since cursor is STRICTLY greater (excludes the boundary message)
        delta = [m["id"] for m in G.list_messages(db, gid, viewer_id=a, since=m2["created_at"])]
        check("D4 since is strictly-greater (boundary excluded)", delta == [m3["id"]], str(delta))
        check("D5 since == latest → empty delta", G.list_messages(db, gid, viewer_id=a, since=m3["created_at"]) == [])

        # a user added to the group later gains access
        try:
            G.list_messages(db, gid, viewer_id=b); check("D6 pre-join non-member denied", False, "no raise")
        except PermissionError:
            check("D6 pre-join non-member denied (PermissionError)", True)
        db.collection("groups").document(gid).update(
            {"members": [{"user_id": a, "username": "alpha"}, {"user_id": b, "username": "bravo"}]})
        joined = G.list_messages(db, gid, viewer_id=b)
        check("D7 after being added, the new member can read", len(joined) == 3)

        # idempotent author delete (deleting twice doesn't raise; stays hidden)
        G.delete_message(db, gid, m1["id"], a)
        G.delete_message(db, gid, m1["id"], a)
        m1_after = next((m for m in G.list_messages(db, gid, viewer_id=a) if m["id"] == m1["id"]), None)
        check("D8 double delete is idempotent; message stays soft-deleted",
              m1_after is not None and m1_after["deleted"] is True and m1_after["text"] == "")
    finally:
        _cleanup_group(db, gid)
        print("  cleaned up edge test docs")


def main() -> int:
    if not PROJECT:
        print("GCP_PROJECT_ID must be set")
        return 2
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"Group-messages tests — project={PROJECT}  (scope={only})")

    group_a_pure()
    if only in ("all", "integration"):
        group_b_firestore()
        group_c_api()
        group_d_edges()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in _results if ok)
    failed = [n for n, ok in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All group-message checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
