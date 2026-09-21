# moderation.py

**Type:** Backend module (FastAPI-wired, Firestore + Gemini)
**Location:** `backend/moderation.py`

---

## Purpose

User-generated-content safety for App Store Guideline 1.2. Three Firestore-backed responsibilities: content filtering on create, reporting/flagging with auto-takedown, and user blocking. All state lives in Firestore (never the Vertex grounding datastore, which holds the anonymous posting corpus). Every report and block also emails the developer, per Apple's "act within 24 hours" requirement.

---

## Key functions

| Function | What it does |
|----------|--------------|
| `check_text(text, *, use_llm=True)` | Rejects objectionable text: fast wordlist pass then best-effort Gemini safety pass; raises `ValueError(_REJECTION)` (→ HTTP 422). |
| `report_content(db, *, content_id, content_type, reporter_uid, reason="other", container_id="")` | Records one report per reporter (idempotent), counts distinct reporters, stamps `content_meta`, auto-hides at threshold, notifies dev. |
| `hidden_content_ids(db, content_ids)` | Subset of ids whose `content_meta.hidden` is set (feed filtering). |
| `block_user` / `unblock_user(db, blocker_uid, blocked_uid)` | Add/remove from block list (`ArrayUnion`/`ArrayRemove`); block notifies dev. |
| `blocked_uids(db, blocker_uid)` | Set of uids a user has blocked. |
| `_takedown(db, content_type, content_id, container_id)` | Posting → `posting.delete_content` (datastore + GCS); reply/message → Firestore soft-delete; flags `content_meta.hidden`. |
| `_resolve_author(...)` | Looks up the author uid of reported content by type. |

---

## Key Details

- **Firestore collections/fields:**
  - `reports/{content_id}__{reporter_uid}` = `{content_id, content_type, container_id, author_uid, reporter_uid, reason, status, created_at}` (stable id ⇒ re-report is a no-op)
  - `blocks/{blocker_uid}` = `{blocked_uids: [...], updated_at}`
  - `content_meta/{id}` += `{reported, report_count, hidden}` — the SAME doc [[interactions.py]] stores vote tallies in, so feed/reply readers get `hidden` for free
  - `_resolve_author` reads `posting_authors/{id}`, `replies/{id}`, or `groups/{cid}/messages/{id}`
- **Content filtering:** `_BLOCKLIST` is a short high-precision slur/sexual/violent wordlist matched on word boundaries after leet normalization (`_LEET`); nuanced abuse handled by `_gemini_flag` (temp 0, JSON, thinking disabled, via `posting.genai_client()`/`posting._gemini_model()`). Gemini pass is **fail-open** — infra errors or `MODERATION_DISABLE_LLM=1` return clean so outages never block legitimate posting.
- **Auto-takedown:** `AUTO_TAKEDOWN_REPORTS` (default 3, env `MODERATION_AUTO_TAKEDOWN_REPORTS`) distinct reporters trigger `_takedown`. Distinct count uses server-side `count()` aggregation with a streaming fallback. `VALID_CONTENT_TYPES = {posting, reply, message}`, `VALID_REPORT_REASONS` includes harassment/hate/violence/sexual/spam/self_harm/illegal/other.
- **Dev notification:** `_notify_dev` sends via Resend (`RESEND_API_KEY`) to `MODERATION_ALERT_EMAIL` (default `support@meridianjourney.ai`); no-ops with a log line if unset and never fails the request.
- **Called from other modules:** `check_text` is invoked by `group_messages._clean_text` and `interactions.add_reply` (and posting.py) before storage.
- **[[api.py]] wiring:** `POST /api/reports` → `report_content`; `POST /api/blocks` → `block_user`; `DELETE /api/blocks/{blocked_uid}` → `unblock_user`; `GET /api/blocks` → `blocked_uids`; `POST /api/admin/takedown` → `_takedown`/`_resolve_author`. Feed and reply endpoints call `blocked_uids` + `hidden_content_ids` to filter results.

---

## Related

- [[interactions.py]] — shares the `content_meta` doc; replies gated by `check_text`
- [[group_messages.py]] — messages gated by `check_text`; block filtering
- [[posting.py]] — `delete_content` takedown, shared Gemini client/model config
- [[profile.py]] — companion PII-scrub seam
- [[api.py]] — HTTP routes
- [[Mobile App]], [[Website]]
- [[Proceedings — Project Overview]]
