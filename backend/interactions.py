"""
interactions.py — replies + votes (Firestore), phase-L (D-050).

Replies and votes live entirely in Firestore — the lightweight "interactions"
store — deliberately kept OUT of the GCS→datastore→BigQuery posting pipeline so
they never pollute search/grounding (which read the datastore). Three collections:

    replies/{auto_id}        = {parent_case_id, parent_reply_id, body,
                                author_handle, user_id, created_at, deleted,
                                deleted_at?}
    votes/{contentId}__{uid} = {dir: -1 | 1, updated_at}
    content_meta/{contentId} = {up, down, score, updated_at}

`contentId` is a posting `case_id` OR a reply id — one vote-tally path serves
both (`score = up - down`). Replies support threading: `parent_case_id` always
points at the posting, and `parent_reply_id` (empty string = top-level) links a
reply to the reply it answers. Listing stays a single-equality query on
`parent_case_id` (every reply for a posting in one shot), sorted in Python, and
each client builds the hierarchy from `parent_reply_id` — so no composite
Firestore index is required. The visual indent cap (6) is a client concern; the
backend only enforces a high `MAX_REPLY_DEPTH` abuse ceiling so a caller cannot
force arbitrarily deep nesting via the API directly.

Identity: replying/voting require an active user id (the caller passes the
resolved `X-User-Id`); `author_handle` is the user's stable seed username (not
PII, not the raw user id). `user_id` is stored only to enforce author-only
delete and per-user vote dedup; it is never serialized to clients.
"""
from __future__ import annotations

from datetime import datetime, timezone

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

import profile  # reuse scrub_pii (single source of truth for PII redaction)

MAX_BODY = 5000
# Hard abuse ceiling on reply nesting depth (depth 0 = top-level reply). This is
# NOT the product's visual indent cap (6, enforced client-side) — it only stops a
# direct API caller from forcing pathologically deep chains. Kept well above the
# visual cap so "Continue this thread" (UI-SPEC §2) has content to show past 6.
MAX_REPLY_DEPTH = 40
_ZERO = {"up": 0, "down": 0, "score": 0}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _vote_id(content_id: str, user_id: str) -> str:
    return f"{content_id}__{user_id}"


def _tally(d: dict | None) -> dict:
    d = d or {}
    up, down = int(d.get("up", 0)), int(d.get("down", 0))
    return {"up": up, "down": down, "score": up - down}


# ---------------------------------------------------------------------------
# Pure vote math (no Firestore) — the toggle brain, unit-tested directly.
# ---------------------------------------------------------------------------

def _apply_vote(old_dir: int, new_dir: int) -> tuple[int, int]:
    """Deltas (d_up, d_down) when a user's vote on a content item moves from
    `old_dir` to `new_dir`, each in {-1, 0, 1} (0 = no vote). Examples:
      none→up  = (+1,  0)   up→none = (-1, 0)   up→down = (-1, +1)
    """
    d_up = (1 if new_dir == 1 else 0) - (1 if old_dir == 1 else 0)
    d_down = (1 if new_dir == -1 else 0) - (1 if old_dir == -1 else 0)
    return d_up, d_down


def _norm_dir(value: int) -> int:
    return 1 if value > 0 else (-1 if value < 0 else 0)


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

def _reply_view(doc: dict, tally: dict, your_vote: int, viewer_id: str) -> dict:
    """Client-facing reply shape. `author_id` (the author's uid) is exposed so a
    reader can block an abusive author (App Store Guideline 1.2); it is omitted
    (blanked) on the reader's OWN replies to avoid leaking it needlessly, and
    `is_author` still drives author-only affordances like delete."""
    deleted = bool(doc.get("deleted"))
    is_author = bool(viewer_id) and doc.get("user_id") == viewer_id
    return {
        "id": doc["id"],
        "parent_case_id": doc.get("parent_case_id", ""),
        "parent_reply_id": doc.get("parent_reply_id", ""),
        "body": "" if deleted else doc.get("body", ""),
        "author_handle": doc.get("author_handle", ""),
        "author_id": "" if is_author else doc.get("user_id", ""),
        "created_at": doc.get("created_at", ""),
        "deleted": deleted,
        "up": tally["up"],
        "down": tally["down"],
        "score": tally["score"],
        "your_vote": your_vote,
        "is_author": is_author,
    }


# ---------------------------------------------------------------------------
# Batch reads (tallies + the viewer's own votes)
# ---------------------------------------------------------------------------

def _batch_tallies(db, content_ids: list[str]) -> dict:
    if not content_ids:
        return {}
    refs = [db.collection("content_meta").document(c) for c in content_ids]
    out = {c: dict(_ZERO) for c in content_ids}
    for snap in db.get_all(refs):
        if snap.exists:
            out[snap.id] = _tally(snap.to_dict())
    return out


def _viewer_votes(db, content_ids: list[str], viewer_id: str) -> dict:
    """Map content_id → the viewer's current dir (-1/1). Absent ⇒ no vote."""
    if not viewer_id or not content_ids:
        return {}
    suffix = len(viewer_id) + 2  # strip "__<viewer_id>"
    refs = [db.collection("votes").document(_vote_id(c, viewer_id)) for c in content_ids]
    out: dict[str, int] = {}
    for snap in db.get_all(refs):
        if snap.exists:
            out[snap.id[:-suffix]] = int((snap.to_dict() or {}).get("dir", 0))
    return out


def vote_state(db, content_ids: list[str], viewer_id: str = "") -> dict:
    """Tally + the viewer's vote for each content id (posting case_id or reply id)."""
    if db is None:
        return {c: {**_ZERO, "your_vote": 0} for c in content_ids}
    tallies = _batch_tallies(db, content_ids)
    votes = _viewer_votes(db, content_ids, viewer_id)
    return {c: {**tallies.get(c, dict(_ZERO)), "your_vote": votes.get(c, 0)} for c in content_ids}


# ---------------------------------------------------------------------------
# Votes (write) — one transaction keeps the per-user vote + tally consistent.
# ---------------------------------------------------------------------------

def cast_vote(db, content_id: str, user_id: str, target_dir: int) -> dict:
    """Set the user's vote on `content_id` to `target_dir` ∈ {-1, 0, 1}
    (0 clears it) and update the aggregate tally atomically. Idempotent: the
    frontend decides toggling and sends the desired resulting direction.
    Returns {content_id, up, down, score, your_vote}."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    if not content_id:
        raise ValueError("content_id is required.")
    if not user_id:
        raise ValueError("A user id is required to vote.")
    target = _norm_dir(target_dir)
    vote_ref = db.collection("votes").document(_vote_id(content_id, user_id))
    meta_ref = db.collection("content_meta").document(content_id)

    @firestore.transactional
    def _txn(txn):
        vsnap = vote_ref.get(transaction=txn)
        old_dir = int((vsnap.to_dict() or {}).get("dir", 0)) if vsnap.exists else 0
        msnap = meta_ref.get(transaction=txn)
        m = msnap.to_dict() if msnap.exists else {}
        up, down = int(m.get("up", 0)), int(m.get("down", 0))
        d_up, d_down = _apply_vote(old_dir, target)
        up, down = max(0, up + d_up), max(0, down + d_down)
        ts = _now_iso()
        txn.set(meta_ref, {"up": up, "down": down, "score": up - down, "updated_at": ts})
        if target == 0:
            if vsnap.exists:
                txn.delete(vote_ref)
        else:
            txn.set(vote_ref, {"dir": target, "updated_at": ts})
        return {"content_id": content_id, "up": up, "down": down,
                "score": up - down, "your_vote": target}

    return _txn(db.transaction())


# ---------------------------------------------------------------------------
# Replies
# ---------------------------------------------------------------------------

def _reply_depth(db, parent_reply_id: str) -> int:
    """Depth a NEW reply would occupy if it answered `parent_reply_id`: 1 for a
    reply to a top-level reply, +1 per further ancestor. Walks the
    `parent_reply_id` chain upward, guarding against cycles and stopping once the
    abuse ceiling is exceeded (the exact depth past the ceiling doesn't matter)."""
    depth = 1  # the new reply itself sits one level below its parent
    ancestor = parent_reply_id
    seen: set[str] = set()
    while ancestor:
        if ancestor in seen or depth > MAX_REPLY_DEPTH:
            break
        seen.add(ancestor)
        snap = db.collection("replies").document(ancestor).get()
        if not snap.exists:
            break
        ancestor = (snap.to_dict() or {}).get("parent_reply_id", "")
        if ancestor:
            depth += 1
    return depth


def add_reply(db, parent_case_id: str, body: str, user_id: str, author_handle: str,
              parent_reply_id: str = "") -> dict:
    """Create a reply on a posting. `parent_reply_id` (empty = top-level) threads
    the reply under another reply. Returns the client-facing reply view."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    parent_case_id = (parent_case_id or "").strip()
    parent_reply_id = (parent_reply_id or "").strip()
    body = (body or "").strip()
    if not parent_case_id:
        raise ValueError("parent_case_id is required.")
    if not body:
        raise ValueError("Reply body is empty.")
    if len(body) > MAX_BODY:
        raise ValueError(f"Reply is too long (max {MAX_BODY} characters).")
    if not user_id:
        raise ValueError("A user id is required to reply.")

    # Threading validation: the target reply must exist and belong to THIS
    # posting (block cross-posting attachment from a client bug or bad actor),
    # and the resulting chain must stay under the abuse ceiling. All raise
    # ValueError → HTTP 422 at the create_reply route.
    if parent_reply_id:
        psnap = db.collection("replies").document(parent_reply_id).get()
        if not psnap.exists:
            raise ValueError("The reply you're responding to no longer exists.")
        if (psnap.to_dict() or {}).get("parent_case_id") != parent_case_id:
            raise ValueError("Reply target does not belong to this posting.")
        if _reply_depth(db, parent_reply_id) > MAX_REPLY_DEPTH:
            raise ValueError("This thread is nested too deeply to reply to.")

    # Content moderation (App Store Guideline 1.2): reject objectionable replies
    # before storage. Raises ValueError → HTTP 422 at the create_reply route.
    import moderation
    moderation.check_text(body)

    # Redact PII (email / phone / A-number) before storing — same defensive
    # scrub applied to profiles and group messages, so a reply can never expose
    # contact info to other users. Validation above runs on the raw input.
    body = profile.scrub_pii(body)

    doc = {
        "parent_case_id": parent_case_id,
        "parent_reply_id": parent_reply_id,
        "body": body,
        "author_handle": author_handle or user_id,
        "user_id": user_id,
        "created_at": _now_iso(),
        "deleted": False,
    }
    ref = db.collection("replies").document()
    ref.set(doc)
    return _reply_view({**doc, "id": ref.id}, dict(_ZERO), 0, user_id)


def _prune_deleted(docs: list[dict]) -> list[dict]:
    """Drop deleted replies, EXCEPT ones that still have a non-deleted descendant
    — those are kept as tombstones (body already blanked by `_reply_view`) so a
    deleted mid-thread reply doesn't orphan the live replies beneath it. Any
    ancestor of a live reply is retained, keeping the chain to the root intact."""
    children: dict[str, list[dict]] = {}
    for d in docs:
        children.setdefault(d.get("parent_reply_id", ""), []).append(d)

    memo: dict[str, bool] = {}

    def has_live_descendant(reply_id: str) -> bool:
        if reply_id in memo:
            return memo[reply_id]
        memo[reply_id] = False  # cycle guard: assume none while recursing
        result = any(
            (not child.get("deleted")) or has_live_descendant(child["id"])
            for child in children.get(reply_id, [])
        )
        memo[reply_id] = result
        return result

    return [d for d in docs
            if not d.get("deleted") or has_live_descendant(d["id"])]


def list_replies(db, parent_case_id: str, viewer_id: str = "", sort: str = "top") -> list[dict]:
    """Every displayable reply on a posting (flat list; the client nests them by
    `parent_reply_id`), each merged with its tally + the viewer's vote. Deleted
    replies are dropped unless they still have a live descendant, in which case a
    blank tombstone is kept to preserve the thread. `sort` = 'top' (score, then
    recency) | 'new' (recency) — applied per sibling group client-side."""
    if db is None:
        return []
    q = db.collection("replies").where(filter=FieldFilter("parent_case_id", "==", parent_case_id))
    docs = [{**d.to_dict(), "id": d.id} for d in q.stream()]
    docs = _prune_deleted(docs)
    ids = [d["id"] for d in docs]
    tallies = _batch_tallies(db, ids)
    votes = _viewer_votes(db, ids, viewer_id)
    views = [_reply_view(d, tallies.get(d["id"], dict(_ZERO)), votes.get(d["id"], 0), viewer_id)
             for d in docs]
    if sort == "new":
        views.sort(key=lambda r: r["created_at"], reverse=True)
    else:
        views.sort(key=lambda r: (r["score"], r["created_at"]), reverse=True)
    return views


def list_user_replies(db, user_id: str, limit: int = 50) -> list[dict]:
    """All non-deleted replies AUTHORED by a user, newest first. Each item carries
    the parent posting id so the client can link back to the posting. Powers the
    profile 'your activity' section."""
    if not user_id or db is None:
        return []
    q = db.collection("replies").where(filter=FieldFilter("user_id", "==", user_id))
    docs = [{**d.to_dict(), "id": d.id} for d in q.stream()]
    docs = [d for d in docs if not d.get("deleted")]
    docs.sort(key=lambda d: d.get("created_at", ""), reverse=True)
    return [{
        "id": d["id"],
        "parent_case_id": d.get("parent_case_id", ""),
        "body": d.get("body", ""),
        "created_at": d.get("created_at", ""),
    } for d in docs[:limit]]


def delete_reply(db, reply_id: str, user_id: str) -> None:
    """Soft-delete a reply. Author-only: raises PermissionError otherwise,
    KeyError if the reply does not exist."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = db.collection("replies").document(reply_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Reply not found.")
    if (snap.to_dict() or {}).get("user_id") != user_id:
        raise PermissionError("Only the author can delete this reply.")
    ref.update({"deleted": True, "deleted_at": _now_iso()})
