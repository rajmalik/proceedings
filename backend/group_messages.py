"""
group_messages.py — group chat messages (Firestore), phase-N (D-054).

Persistent member-to-member messages within a phase-M group. Lives entirely in
Firestore (app-state) — **never** the Vertex datastore (grounding) — under the
group document:

    groups/{group_id}/messages/{auto_id} = {
        author_uid, author_handle, text, created_at, deleted, deleted_at?
    }

Authorization: only a group's members (`uid ∈ groups/{id}.members`) may read or
post; the BFF mediates every write (membership check + PII scrub). `author_uid`
is stored for author-only delete but is **never serialized** — clients see only
`author_handle` (the stable seed username, no PII) + an `is_author` boolean.

v1 real-time is **client polling** with a `since` cursor; message text is
PII-scrubbed via `profile.scrub_pii`. The full real-time design (Firebase Auth +
client-direct listeners + FCM + mobile) is sequenced later — see
docs/app/realtime-communication-options.md.
"""
from __future__ import annotations

from datetime import datetime, timezone

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

import profile

MAX_TEXT = 4000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Pure text cleaning (strip + length + PII scrub) — unit-tested directly
# ---------------------------------------------------------------------------

def _clean_text(text: str) -> str:
    t = (text or "").strip()
    if not t:
        raise ValueError("Message is empty.")
    if len(t) > MAX_TEXT:
        raise ValueError(f"Message is too long (max {MAX_TEXT} characters).")
    # Content moderation (App Store Guideline 1.2): reject objectionable messages
    # before storage. Raises ValueError → HTTP 422 at the post_message route.
    import moderation
    moderation.check_text(t)
    return profile.scrub_pii(t)  # redacts email / phone / A-number


def _message_view(doc: dict, viewer_id: str) -> dict:
    """Client-facing message shape. `author_id` (the author's uid) is exposed so a
    member can block an abusive author (App Store Guideline 1.2); it is blanked on
    the viewer's OWN messages. `is_author` still drives author-only delete."""
    deleted = bool(doc.get("deleted"))
    is_author = bool(viewer_id) and doc.get("author_uid") == viewer_id
    return {
        "id": doc["id"],
        "author_handle": doc.get("author_handle", ""),
        "author_id": "" if is_author else doc.get("author_uid", ""),
        "text": "" if deleted else doc.get("text", ""),
        "created_at": doc.get("created_at", ""),
        "deleted": deleted,
        "is_author": is_author,
    }


# ---------------------------------------------------------------------------
# Membership (authorization)
# ---------------------------------------------------------------------------

def _group_members(db, group_id: str) -> list[dict]:
    snap = db.collection("groups").document(group_id).get()
    if not snap.exists:
        raise KeyError("Group not found.")
    return (snap.to_dict() or {}).get("members") or []


def _require_member(db, group_id: str, user_id: str) -> None:
    """Raise KeyError if the group is missing, PermissionError if not a member."""
    members = _group_members(db, group_id)
    if user_id not in {m.get("user_id") for m in members}:
        raise PermissionError("Only group members can access this chat.")


def _messages_ref(db, group_id: str):
    return db.collection("groups").document(group_id).collection("messages")


# ---------------------------------------------------------------------------
# Post / list / delete
# ---------------------------------------------------------------------------

def post_message(db, group_id: str, user_id: str, text: str) -> dict:
    """Post a message to a group (members only). Text is PII-scrubbed."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    if not user_id:
        raise ValueError("A user id is required to post.")
    _require_member(db, group_id, user_id)   # KeyError → 404, PermissionError → 403
    clean = _clean_text(text)                # ValueError → 422
    now = _now_iso()
    doc = {
        "author_uid": user_id,
        "author_handle": profile.handle_for(db, user_id),
        "text": clean,
        "created_at": now,
        "deleted": False,
    }
    ref = _messages_ref(db, group_id).document()
    ref.set(doc)
    # Drives the group's "last activity" metadata — every post is activity,
    # not just joins (matching.py's join_group/invite_member bump it too).
    db.collection("groups").document(group_id).update({"last_activity_at": now})
    return _message_view({**doc, "id": ref.id}, user_id)


def list_messages(db, group_id: str, viewer_id: str, since: str = "", limit: int = 200) -> list[dict]:
    """Messages in a group (members only), oldest→newest. With `since` (an ISO
    `created_at`), returns only newer messages — the polling delta. Without it,
    returns the most recent `limit` messages."""
    if db is None:
        return []
    _require_member(db, group_id, viewer_id)
    ref = _messages_ref(db, group_id)
    capped = max(1, min(limit, 500))
    if since:
        q = ref.where(filter=FieldFilter("created_at", ">", since)).order_by("created_at").limit(capped)
        docs = list(q.stream())
    else:
        # newest `capped`, returned oldest→newest for rendering
        q = ref.order_by("created_at", direction=firestore.Query.DESCENDING).limit(capped)
        docs = list(reversed(list(q.stream())))
    return [_message_view({**d.to_dict(), "id": d.id}, viewer_id) for d in docs]


def delete_message(db, group_id: str, message_id: str, user_id: str) -> None:
    """Soft-delete a message. Author-only: PermissionError otherwise, KeyError
    if the message does not exist."""
    if db is None:
        raise RuntimeError("Firestore unavailable")
    ref = _messages_ref(db, group_id).document(message_id)
    snap = ref.get()
    if not snap.exists:
        raise KeyError("Message not found.")
    if (snap.to_dict() or {}).get("author_uid") != user_id:
        raise PermissionError("Only the author can delete this message.")
    ref.update({"deleted": True, "deleted_at": _now_iso()})
