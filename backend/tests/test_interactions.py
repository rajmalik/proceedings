"""
test_interactions.py — phase-L replies + votes (Firestore interactions store).

Groups:
  A  pure vote math + serialization (no network) — always runs
  B  live Firestore: add/list/delete replies + vote toggling — INTEGRATION
  C  HTTP API via FastAPI TestClient (auth gating, validation, shapes) — INTEGRATION

Run:  .venv/bin/python tests/test_interactions.py [unit|integration|all]
      unit         → group A only (no GCP)
      integration  → group A + B + C (needs Firestore ADC)
      all (default)→ same as integration
"""

import os
import secrets
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

import interactions as I  # noqa: E402

PROJECT = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")

_results: list[tuple[str, bool]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# A — pure vote math + serialization (no Firestore)
# ---------------------------------------------------------------------------

def group_a_pure() -> None:
    print("\nA — pure vote math + serialization")

    # _apply_vote truth table over every (old, new) in {-1,0,1}^2
    expected = {
        (0, 1): (1, 0), (0, -1): (0, 1), (0, 0): (0, 0),
        (1, 0): (-1, 0), (1, -1): (-1, 1), (1, 1): (0, 0),
        (-1, 0): (0, -1), (-1, 1): (1, -1), (-1, -1): (0, 0),
    }
    bad = {k: I._apply_vote(*k) for k in expected if I._apply_vote(*k) != expected[k]}
    check("A1 _apply_vote truth table (all 9 transitions)", not bad, str(bad))

    # Tally invariant: applying deltas keeps up/down ≥ 0 and score = up-down
    up = down = 0
    seq = [1, 1, -1, 0, -1, -1, 0]  # a user clicking around
    prev = 0
    for nxt in seq:
        d_up, d_down = I._apply_vote(prev, nxt)
        up, down = up + d_up, down + d_down
        prev = nxt
    check("A2 single-user vote sequence stays sane", up in (0, 1) and down in (0, 1) and up + down <= 1,
          f"up={up} down={down}")

    check("A3 _norm_dir clamps to -1/0/1", (I._norm_dir(9), I._norm_dir(-2), I._norm_dir(0)) == (1, -1, 0))
    check("A4 _vote_id composes content+user", I._vote_id("cid", "u1") == "cid__u1")

    t = I._tally({"up": 5, "down": 2})
    check("A5 _tally computes score", t == {"up": 5, "down": 2, "score": 3}, str(t))
    check("A6 _tally tolerates missing", I._tally(None) == {"up": 0, "down": 0, "score": 0})

    # _reply_view never leaks user_id; is_author reflects the viewer
    doc = {"id": "r1", "parent_case_id": "p1", "body": "hi", "author_handle": "arjun-h1b",
           "user_id": "demo-arjun", "created_at": "2026-06-07T00:00:00Z", "deleted": False}
    v_author = I._reply_view(doc, {"up": 2, "down": 0, "score": 2}, 1, "demo-arjun")
    v_other = I._reply_view(doc, {"up": 2, "down": 0, "score": 2}, 0, "demo-mei")
    check("A7 _reply_view omits user_id", "user_id" not in v_author)
    check("A8 _reply_view is_author for the author", v_author["is_author"] is True and v_other["is_author"] is False)
    check("A9 _reply_view carries tally + your_vote", v_author["score"] == 2 and v_author["your_vote"] == 1)

    deleted_doc = {**doc, "deleted": True}
    v_del = I._reply_view(deleted_doc, {"up": 0, "down": 0, "score": 0}, 0, "x")
    check("A10 deleted reply hides body", v_del["deleted"] is True and v_del["body"] == "")

    # parent_reply_id round-trips through the client view (empty = top-level)
    v_thread = I._reply_view({**doc, "parent_reply_id": "rp-1"}, {"up": 0, "down": 0, "score": 0}, 0, "x")
    check("A11 _reply_view carries parent_reply_id", v_thread["parent_reply_id"] == "rp-1")
    check("A12 _reply_view defaults parent_reply_id to '' (top-level)",
          I._reply_view(doc, {"up": 0, "down": 0, "score": 0}, 0, "x")["parent_reply_id"] == "")


# ---------------------------------------------------------------------------
# A3 — _prune_deleted tombstone logic (pure, no network): a deleted reply is
#      dropped UNLESS it still has a live descendant, in which case it's kept as
#      a tombstone so the thread beneath it isn't orphaned.
# ---------------------------------------------------------------------------

def group_a3_prune_deleted() -> None:
    print("\nA3 — _prune_deleted tombstone logic (pure, no network)")

    def d(i: str, parent: str = "", deleted: bool = False) -> dict:
        return {"id": i, "parent_reply_id": parent, "deleted": deleted}

    def kept(docs: list[dict]) -> set[str]:
        return {x["id"] for x in I._prune_deleted(docs)}

    r = kept([d("a"), d("b", deleted=True)])
    check("A3.1 live kept, childless-deleted dropped", r == {"a"}, str(r))

    r = kept([d("p", deleted=True), d("c", parent="p")])
    check("A3.2 deleted parent w/ live child kept as tombstone", r == {"p", "c"}, str(r))

    r = kept([d("p", deleted=True), d("c", parent="p", deleted=True)])
    check("A3.3 fully-deleted subtree dropped", r == set(), str(r))

    r = kept([d("a", deleted=True), d("b", parent="a", deleted=True), d("c", parent="b")])
    check("A3.4 deleted ancestors of a live reply all retained", r == {"a", "b", "c"}, str(r))

    r = kept([d("root", deleted=True), d("live", parent="root"),
              d("dead", parent="root", deleted=True)])
    check("A3.5 mixed branches: keep root+live, drop dead leaf", r == {"root", "live"}, str(r))

    r = kept([d("x"), d("y", parent="x")])
    check("A3.6 nothing deleted → everything kept", r == {"x", "y"}, str(r))


# ---------------------------------------------------------------------------
# A2 — list_user_replies query logic, exercised against a fake Firestore
#      (no network): filtering by author, dropping deletes, newest-first,
#      field projection, and the empty-uid / no-db short-circuits.
# ---------------------------------------------------------------------------

class _FakeDoc:
    def __init__(self, doc_id: str, data: dict):
        self.id = doc_id
        self._data = data

    def to_dict(self) -> dict:
        return dict(self._data)


class _FakeQuery:
    """Honors a single FieldFilter('user_id','==',value) equality, like the real query."""
    def __init__(self, docs: list, value):
        self._docs = docs
        self._value = value

    def stream(self):
        for d in self._docs:
            if d._data.get("user_id") == self._value:
                yield d


class _FakeCollection:
    def __init__(self, docs: list):
        self._docs = docs

    def where(self, filter=None):  # noqa: A002 — mirror Firestore's kwarg name
        value = getattr(filter, "value", None)
        return _FakeQuery(self._docs, value)


class _FakeDB:
    def __init__(self, docs: list):
        self._docs = docs

    def collection(self, name: str):
        assert name == "replies"
        return _FakeCollection(self._docs)


def group_a2_user_replies() -> None:
    print("\nA2 — list_user_replies (fake Firestore, no network)")

    docs = [
        _FakeDoc("r-old", {"user_id": "demo-arjun", "parent_case_id": "p1", "body": "older",
                           "created_at": "2026-06-01T00:00:00Z"}),
        _FakeDoc("r-new", {"user_id": "demo-arjun", "parent_case_id": "p2", "body": "newer",
                           "created_at": "2026-06-09T00:00:00Z"}),
        _FakeDoc("r-del", {"user_id": "demo-arjun", "parent_case_id": "p3", "body": "gone",
                           "created_at": "2026-06-10T00:00:00Z", "deleted": True}),
        _FakeDoc("r-other", {"user_id": "demo-mei", "parent_case_id": "p4", "body": "not mine",
                             "created_at": "2026-06-11T00:00:00Z"}),
    ]
    db = _FakeDB(docs)

    out = I.list_user_replies(db, "demo-arjun")
    ids = [r["id"] for r in out]
    check("A2.1 only the author's non-deleted replies", ids == ["r-new", "r-old"], str(ids))
    check("A2.2 newest-first ordering", out[0]["id"] == "r-new")
    check("A2.3 deleted reply excluded", "r-del" not in ids)
    check("A2.4 other users' replies excluded", "r-other" not in ids)
    check("A2.5 projected fields only",
          set(out[0]) == {"id", "parent_case_id", "body", "created_at"}, str(set(out[0])))
    check("A2.6 parent_case_id carried for back-link", out[0]["parent_case_id"] == "p2")

    check("A2.7 limit truncates after sort", [r["id"] for r in I.list_user_replies(db, "demo-arjun", limit=1)] == ["r-new"])
    check("A2.8 empty uid short-circuits to []", I.list_user_replies(db, "") == [])
    check("A2.9 None db short-circuits to []", I.list_user_replies(None, "demo-arjun") == [])
    check("A2.10 unknown author yields []", I.list_user_replies(db, "nobody") == [])


# ---------------------------------------------------------------------------
# B — live Firestore: replies + votes
# ---------------------------------------------------------------------------

def _hard_cleanup(db, parent_case_id: str, reply_ids: list[str]) -> None:
    """Best-effort hard delete of everything a test run created."""
    try:
        from google.cloud.firestore_v1.base_query import FieldFilter
        for d in db.collection("replies").where(
                filter=FieldFilter("parent_case_id", "==", parent_case_id)).stream():
            reply_ids.append(d.id)
        for rid in set(reply_ids):
            db.collection("replies").document(rid).delete()
            db.collection("content_meta").document(rid).delete()
        db.collection("content_meta").document(parent_case_id).delete()
        # votes created during the run (posting + replies, both test users)
        for cid in set([parent_case_id, *reply_ids]):
            for uid in ("test-user-a", "test-user-b", "demo-arjun", "demo-mei"):
                db.collection("votes").document(I._vote_id(cid, uid)).delete()
    except Exception as e:  # noqa: BLE001
        print(f"  cleanup note: {e}")


def group_b_firestore() -> None:
    print("\nB — live Firestore replies + votes (integration)")
    from google.cloud import firestore

    db = firestore.Client(project=PROJECT)
    parent = f"test-posting-{secrets.token_hex(4)}"   # synthetic; never a real case_id
    user_a, user_b = "test-user-a", "test-user-b"
    created: list[str] = []

    try:
        # --- replies ---
        r1 = I.add_reply(db, parent, "First reply from A", user_a, "arjun-h1b")
        created.append(r1["id"])
        check("B1 add_reply returns view (no user_id, is_author)",
              "user_id" not in r1 and r1["is_author"] is True and r1["body"] == "First reply from A")

        r2 = I.add_reply(db, parent, "Second reply from B", user_b, "mei-f1")
        created.append(r2["id"])

        try:
            I.add_reply(db, parent, "   ", user_a, "arjun-h1b")
            check("B2 empty reply rejected", False, "no raise")
        except ValueError:
            check("B2 empty reply rejected (ValueError)", True)

        listed = I.list_replies(db, parent, viewer_id=user_a)
        ids = {r["id"] for r in listed}
        check("B3 list_replies returns both", {r1["id"], r2["id"]}.issubset(ids), str(ids))
        check("B4 viewer is_author only on own reply",
              next(r for r in listed if r["id"] == r1["id"])["is_author"] is True
              and next(r for r in listed if r["id"] == r2["id"])["is_author"] is False)

        # --- voting on a reply: up, then switch to down, then clear ---
        v_up = I.cast_vote(db, r1["id"], user_b, 1)
        check("B5 upvote → up=1 score=1 your_vote=1",
              v_up["up"] == 1 and v_up["down"] == 0 and v_up["score"] == 1 and v_up["your_vote"] == 1, str(v_up))

        v_re = I.cast_vote(db, r1["id"], user_b, 1)   # idempotent re-up
        check("B6 re-upvote idempotent (still up=1)", v_re["up"] == 1 and v_re["score"] == 1, str(v_re))

        v_down = I.cast_vote(db, r1["id"], user_b, -1)  # switch
        check("B7 switch to downvote → up=0 down=1 score=-1",
              v_down["up"] == 0 and v_down["down"] == 1 and v_down["score"] == -1 and v_down["your_vote"] == -1, str(v_down))

        v_clear = I.cast_vote(db, r1["id"], user_b, 0)  # clear
        check("B8 clear vote → up=0 down=0 score=0 your_vote=0",
              v_clear["up"] == 0 and v_clear["down"] == 0 and v_clear["score"] == 0 and v_clear["your_vote"] == 0, str(v_clear))

        # --- two distinct users both upvote the posting itself ---
        I.cast_vote(db, parent, user_a, 1)
        post_tally = I.cast_vote(db, parent, user_b, 1)
        check("B9 two users upvote posting → up=2 score=2", post_tally["up"] == 2 and post_tally["score"] == 2, str(post_tally))

        # --- vote_state hydration reflects each viewer's own vote ---
        st_a = I.vote_state(db, [parent], viewer_id=user_a)[parent]
        st_anon = I.vote_state(db, [parent], viewer_id="")[parent]
        check("B10 vote_state your_vote per viewer",
              st_a["your_vote"] == 1 and st_anon["your_vote"] == 0 and st_a["up"] == 2, f"{st_a} / {st_anon}")

        # --- list reflects scores in sort order (top) ---
        I.cast_vote(db, r2["id"], user_a, 1)  # give r2 a +1 so it outranks r1 (score 0)
        top = I.list_replies(db, parent, viewer_id=user_a, sort="top")
        check("B11 sort=top orders by score", top[0]["id"] == r2["id"],
              str([(r["id"], r["score"]) for r in top]))

        # --- delete: author-only ---
        try:
            I.delete_reply(db, r2["id"], user_a)   # user_a is NOT the author of r2
            check("B12 non-author delete blocked", False, "no raise")
        except PermissionError:
            check("B12 non-author delete blocked (PermissionError)", True)

        I.delete_reply(db, r2["id"], user_b)        # real author
        after = I.list_replies(db, parent, viewer_id=user_a)
        check("B13 soft-deleted reply hidden from list", r2["id"] not in {r["id"] for r in after})

        try:
            I.delete_reply(db, "no-such-reply-id", user_a)
            check("B14 deleting missing reply raises", False, "no raise")
        except KeyError:
            check("B14 deleting missing reply raises (KeyError)", True)

        # --- validation edges ---
        try:
            I.add_reply(db, parent, "x" * (I.MAX_BODY + 1), user_a, "arjun-h1b")
            check("B15 over-long reply rejected", False, "no raise")
        except ValueError:
            check("B15 over-long reply rejected (ValueError)", True)
        try:
            I.add_reply(db, "", "orphan", user_a, "arjun-h1b")
            check("B16 missing parent rejected", False, "no raise")
        except ValueError:
            check("B16 missing parent rejected (ValueError)", True)

        # --- downvote drives score negative ---
        r3 = I.add_reply(db, parent, "third reply", user_a, "arjun-h1b")
        created.append(r3["id"])
        dn = I.cast_vote(db, r3["id"], user_b, -1)
        check("B17 downvote → score -1", dn["score"] == -1 and dn["down"] == 1, str(dn))

        # --- sort=new orders by recency (r3 is newest) ---
        newest = I.list_replies(db, parent, viewer_id=user_a, sort="new")
        check("B18 sort=new puts newest first", newest and newest[0]["id"] == r3["id"],
              str([r["id"] for r in newest]))

        # --- anonymous viewer never carries a your_vote ---
        anon = I.list_replies(db, parent, viewer_id="", sort="top")
        check("B19 anonymous list → your_vote all 0", all(r["your_vote"] == 0 for r in anon))

        # --- vote_state batch hydrates posting + reply together, per viewer ---
        st = I.vote_state(db, [parent, r3["id"]], viewer_id=user_b)
        check("B20 vote_state batch per-id", st[parent]["up"] == 2 and st[r3["id"]]["your_vote"] == -1, str(st))

        # --- threading: reply-to-reply round-trips parent_reply_id ---
        rt = I.add_reply(db, parent, "nested under r3", user_b, "mei-f1", parent_reply_id=r3["id"])
        created.append(rt["id"])
        check("B21 reply-to-reply stores parent_reply_id", rt["parent_reply_id"] == r3["id"])
        threaded = {r["id"]: r for r in I.list_replies(db, parent, viewer_id=user_a)}
        check("B22 parent_reply_id round-trips through list_replies",
              threaded.get(rt["id"], {}).get("parent_reply_id") == r3["id"])
        check("B23 top-level reply keeps empty parent_reply_id",
              threaded.get(r3["id"], {}).get("parent_reply_id") == "")

        # --- unknown parent_reply_id rejected ---
        try:
            I.add_reply(db, parent, "ghost parent", user_a, "arjun-h1b", parent_reply_id="does-not-exist")
            check("B24 unknown parent_reply_id rejected", False, "no raise")
        except ValueError:
            check("B24 unknown parent_reply_id rejected (ValueError)", True)

        # --- cross-posting attachment rejected (parent reply on a different posting) ---
        other_parent = f"test-posting-{secrets.token_hex(4)}"
        try:
            ro = I.add_reply(db, other_parent, "on another posting", user_a, "arjun-h1b")
            created.append(ro["id"])
            try:
                I.add_reply(db, parent, "steal", user_a, "arjun-h1b", parent_reply_id=ro["id"])
                check("B25 cross-posting parent_reply_id rejected", False, "no raise")
            except ValueError:
                check("B25 cross-posting parent_reply_id rejected (ValueError)", True)
        finally:
            _hard_cleanup(db, other_parent, [])

        # --- depth ceiling: monkeypatch low so we don't create 40 live docs.
        # With MAX=3, replies at depths 0..3 are accepted; a reply beneath depth 3
        # (new depth 4) is rejected. ---
        orig_max = I.MAX_REPLY_DEPTH
        I.MAX_REPLY_DEPTH = 3
        try:
            prev = ""  # "" = top-level
            chain_ids: list[str] = []
            for i in range(4):  # depths 0,1,2,3
                rr = I.add_reply(db, parent, f"chain {i}", user_a, "arjun-h1b", parent_reply_id=prev)
                created.append(rr["id"])
                chain_ids.append(rr["id"])
                prev = rr["id"]
            check("B26 nesting up to the ceiling accepted (depths 0..3)", len(chain_ids) == 4)
            try:
                I.add_reply(db, parent, "too deep", user_a, "arjun-h1b", parent_reply_id=prev)
                check("B27 nesting past the ceiling rejected", False, "no raise")
            except ValueError:
                check("B27 nesting past the ceiling rejected (ValueError)", True)
        finally:
            I.MAX_REPLY_DEPTH = orig_max

        # --- tombstone: deleting a mid-thread reply keeps a blank stub so its
        # live descendants aren't orphaned; a childless deleted reply is dropped
        # (already covered by B13). ---
        I.delete_reply(db, chain_ids[1], user_a)  # chain_ids[1] has descendants [2],[3]
        tomb = {r["id"]: r for r in I.list_replies(db, parent, viewer_id=user_a)}
        check("B28 deleted mid-thread reply kept as blank tombstone",
              chain_ids[1] in tomb and tomb[chain_ids[1]]["deleted"] is True
              and tomb[chain_ids[1]]["body"] == "", str(tomb.get(chain_ids[1])))
        check("B29 live descendants of a deleted reply still listed",
              chain_ids[2] in tomb and chain_ids[3] in tomb)

    finally:
        _hard_cleanup(db, parent, created)
        print("  cleaned up test docs")


def group_c_api() -> None:
    print("\nC — HTTP API via TestClient (integration)")
    from fastapi.testclient import TestClient
    from google.cloud import firestore
    import api
    api.RATE_LIMIT_MAX = 100000  # don't trip the limiter during the run

    db = firestore.Client(project=PROJECT)
    parent = f"test-posting-api-{secrets.token_hex(4)}"
    created: list[str] = []
    A = {"X-User-Id": "demo-arjun"}
    M = {"X-User-Id": "demo-mei"}
    try:
        with TestClient(api.app) as c:
            # anonymous read works + response shape
            g = c.get(f"/api/postings/{parent}/replies")
            gj = g.json()
            check("C1 GET replies anon 200 + {replies,posting,total}",
                  g.status_code == 200 and {"replies", "posting", "total"} <= set(gj) and gj["total"] == 0,
                  f"status={g.status_code}")

            # auth gating
            check("C2 POST reply without user → 400",
                  c.post(f"/api/postings/{parent}/replies", json={"body": "x"}).status_code == 400)
            check("C3 POST vote without user → 400",
                  c.post("/api/votes", json={"content_id": parent, "dir": 1}).status_code == 400)
            check("C4 DELETE reply without user → 400",
                  c.delete(f"/api/postings/{parent}/replies/whatever").status_code == 400)
            check("C5 unknown user → 404",
                  c.post(f"/api/postings/{parent}/replies", json={"body": "x"},
                         headers={"X-User-Id": "ghost"}).status_code == 404)

            # body / payload validation → 422
            check("C6 empty body → 422",
                  c.post(f"/api/postings/{parent}/replies", json={"body": ""}, headers=A).status_code == 422)
            check("C7 whitespace-only body → 422",
                  c.post(f"/api/postings/{parent}/replies", json={"body": "   "}, headers=A).status_code == 422)
            check("C8 over-long body → 422",
                  c.post(f"/api/postings/{parent}/replies", json={"body": "x" * 5001}, headers=A).status_code == 422)
            check("C9 vote empty content_id → 422",
                  c.post("/api/votes", json={"content_id": "", "dir": 1}, headers=A).status_code == 422)

            # happy path: reply create + shape (and no user_id leak)
            rp = c.post(f"/api/postings/{parent}/replies", json={"body": "API reply"}, headers=A)
            rj = rp.json()
            rid = rj.get("id", "")
            if rid:
                created.append(rid)
            check("C10 POST reply 200 + ReplyCard (handle/is_author/score, no user_id)",
                  rp.status_code == 200 and rj.get("author_handle") == "arjun-h1b"
                  and rj.get("is_author") is True and rj.get("score") == 0 and "user_id" not in rj,
                  f"status={rp.status_code}")

            # vote shape + value
            v = c.post("/api/votes", json={"content_id": rid, "dir": 1}, headers=M)
            vj = v.json()
            check("C11 POST vote 200 + VoteResponse (score/your_vote/content_id)",
                  v.status_code == 200 and vj.get("score") == 1 and vj.get("your_vote") == 1
                  and vj.get("content_id") == rid, str(vj))

            # per-viewer your_vote
            mine = c.get(f"/api/postings/{parent}/replies", headers=M).json()["replies"][0]
            anon = c.get(f"/api/postings/{parent}/replies").json()["replies"][0]
            check("C12 your_vote per viewer (mei=1, anon=0)",
                  mine["your_vote"] == 1 and anon["your_vote"] == 0)

            # delete authorization
            check("C13 DELETE wrong user → 403",
                  c.delete(f"/api/postings/{parent}/replies/{rid}", headers=M).status_code == 403)
            check("C14 DELETE missing reply → 404",
                  c.delete(f"/api/postings/{parent}/replies/no-such-id", headers=A).status_code == 404)
            check("C15 DELETE author → 200",
                  c.delete(f"/api/postings/{parent}/replies/{rid}", headers=A).status_code == 200)

            # threaded reply via API: parent_reply_id round-trips on the ReplyCard
            top = c.post(f"/api/postings/{parent}/replies", json={"body": "top"}, headers=A).json()
            tid = top.get("id", "")
            if tid:
                created.append(tid)
            child = c.post(f"/api/postings/{parent}/replies",
                           json={"body": "child", "parent_reply_id": tid}, headers=M)
            cj = child.json()
            if cj.get("id"):
                created.append(cj["id"])
            check("C16 POST reply with parent_reply_id round-trips",
                  child.status_code == 200 and cj.get("parent_reply_id") == tid, str(cj))

            # cross-posting parent_reply_id (points at a reply on a different posting) → 422
            other = f"test-posting-api-{secrets.token_hex(4)}"
            bad = c.post(f"/api/postings/{other}/replies",
                         json={"body": "x", "parent_reply_id": tid}, headers=A)
            check("C17 cross-posting parent_reply_id → 422", bad.status_code == 422, f"status={bad.status_code}")
    finally:
        _hard_cleanup(db, parent, created)
        print("  cleaned up API test docs")


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    if not PROJECT and only != "unit":
        print("GCP_PROJECT_ID must be set")
        return 2
    print(f"Interactions tests — project={PROJECT or '(none)'}  (scope={only})")

    group_a_pure()
    group_a2_user_replies()
    group_a3_prune_deleted()
    if only in ("all", "integration"):
        group_b_firestore()
        group_c_api()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in _results if ok)
    failed = [n for n, ok in _results if not ok]
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All interactions checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
