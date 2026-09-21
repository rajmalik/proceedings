# group_messages.py

**Type:** Backend module (FastAPI-wired, Firestore)
**Location:** `backend/group_messages.py`

---

## Purpose

Persistent member-to-member group chat for the phase-M "same boat" groups (D-054). Messages live entirely in Firestore app-state — never the Vertex grounding datastore — under each group document. Only a group's members may read or post; the backend mediates every write with a membership check plus PII scrub. v1 real-time is client polling with a `since` cursor.

---

## Key functions

| Function | What it does |
|----------|--------------|
| `post_message(db, group_id, user_id, text)` | Members-only post. Cleans text (strip → length ≤ `MAX_TEXT` 4000 → moderation → PII scrub) and writes the message doc; returns the client view. |
| `list_messages(db, group_id, viewer_id, since="", limit=200)` | Members-only list, oldest→newest. With `since` (ISO `created_at`) returns only newer messages (polling delta); else the most recent `limit` (capped 1–500). |
| `delete_message(db, group_id, message_id, user_id)` | Author-only soft-delete (`deleted=True`, `deleted_at`). |
| `_clean_text(text)` | Pure text pipeline: validate non-empty/length, call `moderation.check_text`, then `profile.scrub_pii`. |
| `_message_view(doc, viewer_id)` | Client-facing shape; blanks `text` when deleted, exposes `author_id` (blanked on own messages) for blocking, sets `is_author`. |
| `_require_member(db, group_id, user_id)` | Raises `KeyError` if group missing, `PermissionError` if not a member. |

---

## Key Details

- **Firestore path:** `groups/{group_id}/messages/{auto_id}` = `{author_uid, author_handle, text, created_at, deleted, deleted_at?}`. Membership read from `groups/{id}.members` (list of `{user_id, ...}`).
- **Identity/PII:** `author_uid` is stored only for author-only delete and is never serialized directly — clients see `author_handle` (stable seed username via `profile.username_for`) plus `is_author`; `author_id` is exposed (except on own messages) purely to enable blocking (Apple 1.2).
- **Moderation:** `_clean_text` calls `moderation.check_text` (wordlist + Gemini) before storage; rejection raises `ValueError` → HTTP 422.
- **Error mapping:** `KeyError` → 404, `PermissionError` → 403, `ValueError` → 422, `db is None` → `RuntimeError`.
- **[[api.py]] wiring:** `GET /api/groups/{group_id}/messages` → `list_messages` (also filters blocked authors via `moderation.blocked_uids`); `POST /api/groups/{group_id}/messages` → `post_message`; `DELETE /api/groups/{group_id}/messages/{message_id}` → `delete_message`.
- Real-time via Firebase Auth + client-direct listeners + FCM is deferred (docs/app/realtime-communication-options.md).

---

## Related

- [[matching.py]] — creates the `groups/{id}` documents whose members chat here
- [[moderation.py]] — `check_text` gate on post; `blocked_uids` feed filtering
- [[profile.py]] — `scrub_pii`, `username_for`
- [[interactions.py]] — sibling Firestore social feature (replies/votes)
- [[api.py]] — HTTP routes
- [[Mobile App]], [[Website]]
- [[Proceedings — Project Overview]]
