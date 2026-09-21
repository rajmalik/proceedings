# interactions.py

**Type:** Backend module (FastAPI-wired, Firestore)
**Location:** `backend/interactions.py`

---

## Purpose

Lightweight social layer — flat replies and up/down votes on postings and replies (phase-L, D-050). Kept deliberately OUT of the GCS→datastore→BigQuery posting pipeline so it never pollutes search/grounding. One vote-tally path serves both content types (`score = up - down`), where a `contentId` is either a posting `case_id` or a reply id.

---

## Key functions

| Function | What it does |
|----------|--------------|
| `cast_vote(db, content_id, user_id, target_dir)` | Sets the user's vote to `target_dir ∈ {-1,0,1}` (0 clears) and updates the aggregate tally in one Firestore transaction. Idempotent — frontend sends the desired resulting direction. |
| `vote_state(db, content_ids, viewer_id="")` | Batch tally + the viewer's own vote for each content id. |
| `add_reply(db, parent_case_id, body, user_id, author_handle)` | Creates a flat reply (validate → `moderation.check_text` → `profile.scrub_pii` → store). |
| `list_replies(db, parent_case_id, viewer_id="", sort="top")` | Non-deleted replies on a posting merged with tally + viewer vote; `sort` = 'top' (score, recency) or 'new'. |
| `list_user_replies(db, user_id, limit=50)` | Replies authored by a user, newest first (profile "your activity"). |
| `delete_reply(db, reply_id, user_id)` | Author-only soft-delete. |
| `_apply_vote(old_dir, new_dir)` | Pure vote math → `(d_up, d_down)` deltas; unit-tested directly. |

---

## Key Details

- **Firestore collections:**
  - `replies/{auto_id}` = `{parent_case_id, body, author_handle, user_id, created_at, deleted, deleted_at?}`
  - `votes/{contentId}__{uid}` = `{dir: -1|1, updated_at}` (deleted when cleared)
  - `content_meta/{contentId}` = `{up, down, score, updated_at}` — the shared tally doc (also carries [[moderation.py]] `hidden`/`reported` flags)
- **Flat model:** a reply links only to its parent posting via `parent_case_id`; listing is a single-equality query sorted in Python, so no composite index is required.
- **Identity/PII:** `user_id` stored only for author-only delete + per-user vote dedup, never serialized; `author_handle` is the stable seed username. `author_id` is surfaced (blanked on own replies) to enable blocking (Apple 1.2). `MAX_BODY` = 5000.
- **Atomic votes:** `cast_vote` uses `@firestore.transactional`, floors `up`/`down` at 0.
- **[[api.py]] wiring:** `POST /api/votes` → `cast_vote`; `GET/POST/DELETE /api/postings/{case_id}/replies[/{reply_id}]` → `list_replies`/`add_reply`/`delete_reply`; `GET /api/users/{uid}/replies` → `list_user_replies`; feed/reply reads also load `content_meta` via `vote_state` and drop `moderation.hidden_content_ids` / `blocked_uids`.

---

## Related

- [[moderation.py]] — shares `content_meta`; `check_text` gate; report/hide/block filters
- [[profile.py]] — `scrub_pii`, seed usernames
- [[group_messages.py]] — sibling Firestore social feature
- [[posting.py]] — postings that replies/votes attach to (`case_id`)
- [[api.py]] — HTTP routes
- [[Mobile App]], [[Website]]
- [[Proceedings — Project Overview]]
