# matching.py

**Type:** Backend module (FastAPI-wired, Firestore + Gemini)
**Location:** `backend/matching.py`

---

## Purpose

"Find users in the same boat" (phase-M, D-051). Captures an applicant's matching criteria through a short US-immigration-expert Gemini chat, then ranks other registered users by weighted tag-overlap similarity so the user can form or join a group. This phase finds matches and forms groups; group chat is [[group_messages.py]]. Reuses profile/posting validators rather than re-implementing them.

---

## Key functions

| Function | What it does |
|----------|--------------|
| `find_turn(messages, draft)` | One stateless expert-chat turn capturing criteria via `profile._gen_json`; returns `{reply, criteria (validated), done}`. |
| `find_matches(db, user_id, criteria, top_n=20, min_score=MIN_SCORE)` | Ranks other users by `_score` overlap; excludes self, drops zero-overlap/below-threshold, returns top-N. |
| `find_or_create_group(db, user_id, criteria_text, criteria, members=None)` | Joins the existing group for the criteria signature or creates it; adds the caller (+ provided peers); `joined=True` when an existing group was joined. |
| `join_group(db, group_id, user_id)` | Browse → add user to an existing group. |
| `list_all_groups(db, viewer_id="")` / `my_groups(db, user_id)` | All groups (newest first, membership-flagged) / only the user's groups. |
| `list_candidate_profiles(db, exclude_id="")` | All `users/{id}` profiles, cleaned, minus `exclude_id`. |
| `_score(criteria, prof)` | Pure weighted overlap: visa/category, consulate, shared status fact, date proximity. |

---

## Key Details

- **Firestore collections:** reads candidate profiles from `users/{id}` (via `profile.clean_profile`); writes groups to `groups/{auto_id}` = `{name, signature, criteria_text, criteria_tags, members:[{user_id, username}], created_by, status, created_at, updated_at}`.
- **Criteria fields** (`CRITERIA_FIELDS`): the controlled-vocab matchable subset of a profile (visa category, visa applying for, consulates, key_stages_or_info, key_dates, background_text) minus journey/PII — so criteria double as a reconcile `message`.
- **Similarity weights:** `W_VISA=3.0`, `W_CONSULATE=1.5`, `W_STAGE=1.0`, `MIN_SCORE=1.0`. Date proximity credits same-milestone dates: exact `1.5`; buckets ±30d→1.0, ±90d→0.6, ±180d→0.3; shared-key floor `0.1`. The ±30-day bucket is the "approximate match" boundary (scores exactly `MIN_SCORE`).
- **Group identity:** `_signature` = distinctive facets (visa ∪, consulates ∪, citizen/resident country) — same signature ⇒ same group, so peers converge rather than duplicate. `_group_name` generates a human label like `H-1B → EB-2 at BOM (IN)`.
- **Gemini:** `_find_system_prompt` embeds today's date + `posting._master_tags_block()` controlled vocabulary, forbids PII, requires ISO-2 country codes, returns one JSON object; called through `profile._gen_json`.
- **Reuse:** `posting._Vocab`/`_master_tags_block`, `profile.clean_profile`/`merge_profile`/`_gen_json`/`username_for`/`_COUNTRY_STAGE_KEYS`. Validate-vs-profile + offer-to-update is delegated to the existing [[reconcile.py]] feature; matching itself always uses the entered criteria.
- **[[api.py]] wiring:** `POST /api/find/turn` → `find_turn`; `POST /api/find/matches` → `find_matches`; `POST /api/groups` → `find_or_create_group`; `GET /api/groups` → `my_groups`; `GET /api/groups/all` → `list_all_groups`; `POST /api/groups/{group_id}/join` → `join_group`; `GET /api/groups/{group_id}` → single group via `list_all_groups`.

---

## Related

- [[group_messages.py]] — chat inside the groups formed here
- [[profile.py]] — profile validators, `_gen_json`, seed usernames (candidate source)
- [[posting.py]] — controlled-vocabulary tag blocks
- [[reconcile.py]] — validate-vs-profile + offer-to-update reuse
- [[api.py]] — HTTP routes
- [[Mobile App]], [[Website]]
- [[Proceedings — Project Overview]]
