# profile.py

**Type:** User profile CRUD + two-stage AI onboarding
**Location:** `backend/profile.py`
**Store:** Firestore `users/{id}` (D-035)

---

## Purpose

Manages a PII-free structured profile of an applicant's US-immigration situation (phase-I). Two capabilities: (1) profile CRUD + controlled-vocabulary validation, reusing the [[posting.py]] tagger's vocab as the single source of truth; (2) a stateless two-stage AI onboarding conversation that captures the profile from natural chat. The profile itself is NEVER indexed into the search datastore — only explicitly consented experiences and connect cards are projected as their own searchable docs.

---

## Key functions

| Function | What it does |
|----------|--------------|
| `empty_profile()` | The canonical profile shape (visa fields, consulates, tags, key_stages/dates, background_text, journey). |
| `clean_profile(p)` | Coerces an incoming profile to valid controlled-vocab values (reuses posting cleaners); scrubs PII; normalizes journey + dates. |
| `validate_profile(p)` | Non-fatal hints about dropped/invalid values for the UI. |
| `merge_profile(base, incoming)` | Merges an onboarding draft onto an existing profile (lists unioned, scalars overwrite when set, journeys merged). |
| `get_profile(db, uid)` / `save_profile(db, uid, p)` | Read / validate + persist against `users/{uid}`; save projects consented experiences (D-041). |
| `project_experiences(profile)` | Publishes newly-shared journey experiences as searchable docs and deletes newly-unshared ones (best-effort). |
| `onboard_turn(messages, draft, stage)` | One conversational turn → `{reply, profile (validated), done}`. |
| `scrub_pii(text)` / `normalize_date(value)` | Redact emails/phones/A-numbers; parse any common date format to YYYY-MM-DD (also used by [[posting.py]]). |
| `seed_users()` / `seed_ids()` / `username_for(uid)` | Baked dev roster from `seed_users.json`. |

---

## Key Details

- **Firestore store:** `users/{id}`. `save_profile` does an authoritative full overwrite (NOT `merge=True`) so removed `key_stages_or_info`/`key_dates` entries don't linger; preserves the original `created_at`, stamps `updated_at`. Username precedence: submitted > stored > seed-roster fallback.
- **Two-stage onboarding:**
  - **Stage 1 — basics:** captures current status, journey dates, forms+outcomes, misc topic tags, and a background_text. Never asks the user to recount experience stories. Emits a validated `profile` draft each turn; `merge_profile` folds it into the running draft (journey untouched).
  - **Stage 2 — experiences (post-save):** infers already-crossed milestones from the saved profile and gathers their lived-experience TEXT into `journey` entries only. Never changes current-state tag fields, never tags past experiences.
- **Guardrails (both stages):** never ask for / store PII; use only controlled-vocabulary tag strings (no invented tags); `*_of_country` values must be ISO-2; profile-setup only (redirect questions/concerns to a separate posting); never use section-1.6 visa-form-action tags in a profile.
- **Vocabulary reuse:** validation delegates to `posting._clean_group`, `posting.clean_misc_tags`, `posting.clean_stages_profile`, and the master tag block (`posting._master_tags_block`) embedded in the onboarding system prompts. Profile tags are restricted to 1.3 abbreviations + 1.10 topics; forms/outcomes live under `key_stages_or_info`.
- **PII scrub:** email / 10+-digit phone / A-number patterns; deliberately does not redact ISO dates or short counts. Applied to `background_text` and every journey experience.
- **Journey:** free-text milestone log (`{milestone, date, experience, shared, experience_case_id}`), chronologically sorted; per-entry `shared` consent (default on) drives experience projection.
- **Gemini:** onboarding uses `posting.genai_client()` + `posting._gemini_model()` with JSON response mode and thinking disabled (`_gen_json`).

---

## Dependencies

- `google-genai` — onboarding LLM (via the shared client in [[posting.py]])
- `google-cloud-firestore` — `users/{id}` store (passed in from [[api.py]])
- `posting` ([[posting.py]]) — vocab cleaners, master tag block, experience projection, Gemini client
- `python-dateutil` — flexible date parsing
- `seed_users.json`, `tags-cleaned/*.csv`

---

## Related

- Consumed by [[api.py]] (`/api/profile`, `/api/onboard`, `/api/users*`, public profiles)
- Experience/connect-card projection via [[posting.py]]
- Profile↔message reconciliation: [[reconcile.py]]; matching on profiles: [[matching.py]]
- [[Proceedings — Project Overview]]
