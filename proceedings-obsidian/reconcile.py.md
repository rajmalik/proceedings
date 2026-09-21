# reconcile.py

**Type:** Profile ↔ message reconciliation (deterministic)
**Location:** `backend/reconcile.py`

---

## Purpose

At publish time, merges a user's saved profile (Firestore `users/{id}`) with an in-progress message/posting being composed (phase-J, D-042). Because both use the SAME controlled vocabulary and field names, reconciliation is a deterministic field-level projection — there is no full reconcile agent in v1. It emits the values to use FOR THIS POSTING plus a list of conflicts, and a small LLM turns those conflicts into one friendly "update your profile?" prompt. The profile is never indexed; this only shapes the single posting sidecar JSON.

---

## Key functions

| Function | What it does |
|----------|--------------|
| `reconcile_profile_message(profile, message)` | Field-level merge → `{merged, conflicts, prefilled}`. Message wins on conflict; profile pre-fills blanks; backgrounds unioned. |
| `explain_conflicts(conflicts)` | One friendly plain-English prompt offering to update the profile; deterministic sentence fallback if the LLM is unavailable. |

---

## Key Details

- **Merge rules:**
  - List fields (`current_visa_or_greencard_category`, `visa_applying_for`, `consulates`): if both set and differ → conflict + message wins; else message, else profile (marked `prefilled`), else empty.
  - `primary_consulate` (scalar): message > profile > first consulate; disagreement is a conflict.
  - Map fields (`key_stages_or_info`, `key_dates`): union; on a key collision with a different value → conflict + message wins; profile-only keys mark the field `prefilled`.
  - `background_text`: unioned (message then profile) so the user needn't re-enter profile background.
- **Vocabulary reuse:** all values are cleaned through [[posting.py]]'s `_clean_group`, `_clean_stages`, `_clean_dates`, and `_Vocab` before comparison — reconciliation compares only valid controlled-vocab values.
- **Conflict explainer:** builds a deterministic `field: profile says X but your message says Y` fallback, then asks Gemini (`posting.genai_client()` + `posting._gemini_model()`, thinking disabled) to phrase it gently in 1–2 sentences without answering any immigration question.
- **Stateless / no persistence:** returns data to [[api.py]]; it does not write the profile. Updating the profile to match is a separate explicit `PUT /api/profile`.

---

## Dependencies

- `posting` ([[posting.py]]) — shared vocab cleaners + Gemini client/model config
- `google-genai` — conflict explainer LLM (optional; deterministic fallback)

---

## Related

- Consumed by [[api.py]] (`POST /api/reconcile`)
- Profile source + save path: [[profile.py]]
- Posting build/publish: [[posting.py]]
- [[Proceedings — Project Overview]]
