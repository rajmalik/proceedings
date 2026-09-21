# posting.py

**Type:** Posting auto-tagging + publish-to-datastore module
**Location:** `backend/posting.py`
**Grounding sink:** managed Vertex AI Search datastore `imm-postings-datastore` (DS-1), via `documents.import`

---

## Purpose

Implements the "post a new message" flow. Two core capabilities: (1) `suggest_tags` runs the Gemini tagging engine over a composer draft and returns controlled-vocabulary tags grouped by schema section (pure read); (2) `publish_posting` builds the canonical sidecar JSON, validates it against the master vocab, writes `.md` + `.json` to GCS, `documents.import`s it into DS-1 so it's searchable within minutes, and appends a row to BigQuery. Also owns the shared Gemini client and the master vocabulary loader reused by [[profile.py]] and [[reconcile.py]].

---

## Key functions

| Function | What it does |
|----------|--------------|
| `genai_client()` | Process-wide `genai.Client` (Vertex AI, 60 s timeout) reused across tagging/answers/onboarding/moderation. |
| `suggest_tags(title, description)` | Gemini extraction → cleaned controlled-vocab groups + relevant sections + posting_type + key stages/dates. No side effects. |
| `vocab_lists()` | Cached controlled vocabularies (visa/consulate/tag/stage/date/outcome/country + profile-only sets) for composer autocomplete. |
| `publish_posting(title, description, tags, …)` | Full publish path (PII scrub → moderation → extract → build → validate → GCS → import → BQ). Returns `{case_id, gcs_path, indexed, author_handle}`. |
| `build_canonical(…)` | Assembles the full sidecar JSON (user-edited tags/stages/dates override the model; context from `extracted`). |
| `validate(canonical)` | Vocabulary + schema validation (returns error list; raised as HTTP 422 by [[api.py]]). |
| `publish_experience(profile, entry)` | Projects one consented profile experience to its own searchable `doc_kind=experience` doc (phase-J / D-041). |
| `publish_connect_card(profile, note)` | Publishes a `doc_kind=connect_card` from the profile's current state. |
| `delete_content(case_id)` | Removes a published doc from the datastore + its GCS sidecars (best-effort). |

---

## Key Details

- **Channel / provenance:** `channel = "app"` (D-036/D-038 controlled pathway token the search boost/filters key on — the domain never goes here). Provenance identity is env-driven: `APP_SOURCE_SYSTEM` (default `meridianjourney`) and `APP_BASE_URL` (default `https://meridianjourney.ai`) — registering a domain later is a config flip, not a code change.
- **Case IDs:** `app-<date>-<hex>` (posts), `app-exp-<date>-<hex>` (experiences), `app-connect-<date>-<hex>` (connect cards). Author is an anonymous `_synthetic_handle()` (adjective-noun-NNNN) — no PII in the datastore.
- **Tagging engine:** Gemini (`GCP_GEMINI_MODEL`, default `gemini-2.5-flash`) with a strict Immigration-Tagging-Engine system prompt; JSON response mode, thinking disabled so the full budget goes to the JSON; `_retry` on transient GCP errors. The master tag block is built from `tags-cleaned/*.csv` (sections 1.1–1.10). Output is cleaned/deduped against the vocab (`_clean_group`, `_dedup_buckets`, `_normalize_groups`); a tag may appear in at most one bucket.
- **Publish pipeline order (`publish_posting`):** `scrub_pii` (from [[profile.py]]) → `moderation.check_text` (App Store 1.2, raises → 422) → Gemini extraction for summaries/context → `build_canonical` → `validate` → GCS sidecar (`.md` then `.json`) → `_import_to_datastore` → `_write_bigquery`.
- **GCS sidecar:** written to `gs://<GCP_BUCKET_NAME|imm-postings-ingestion>/<date>/app/<case_id>.{md,json}`.
- **Datastore import:** inline `documents.import` (INCREMENTAL, idempotent by `case_id`) with backoff retry — this inline path is the ONLY way app posts reach Vertex AI Search (the datastore's daily GCS auto-sync is scoped to the `reddit/` prefix), so a transient blip must not silently drop a post; persistent failure raises so `indexed: True` is never falsely reported.
- **BigQuery:** appends to `<project>.postings.postings_metadata` (self-provisions dataset+table, partitioned by `posting_date`); non-blocking. `pipeline_run_id` (`POSTING_PIPELINE_RUN_ID`, default `web-composer`) marks rows; `purge_test_bq_rows` cleans test markers.
- **Experience tagging (phase-J):** facets extracted from the experience TEXT (a past event), never the profile's current state; every experience is tagged `past-experience` + `experience-posting`, `timeline` if dated, `visa-interview-experience` for interview milestones, and NEVER carries concerns/questions tags. Linked to the author via their handle.
- **Env vars:** `GCP_PROJECT_ID`/`GCP_PROJECT`, `GCP_REGION`/`GCP_GEMINI_LOCATION`, `GCP_BUCKET_NAME`/`GCP_BUCKET`, `GCP_VERTEX_DATASTORE_ID`, `GCP_VERTEX_DATASTORE_LOCATION`, `GCP_GEMINI_MODEL`, `APP_SOURCE_SYSTEM`, `APP_BASE_URL`, `POSTING_PIPELINE_RUN_ID`.

---

## Dependencies

- `google-genai` — tagging engine + shared client
- `google-cloud-discoveryengine` — `documents.import` / delete
- `google-cloud-storage` — GCS sidecars
- `google-cloud-bigquery` — analytics rows (optional)
- `tags-cleaned/*.csv` — master controlled vocabulary
- `moderation` ([[moderation.py]]), `profile.scrub_pii` ([[profile.py]]) — imported at publish time

---

## Related

- Retrieval/search over the published docs: [[search_client.py]]
- Consumed by [[api.py]] (`/api/postings`, `/api/tag-suggest`, `/api/tag-vocab`, `/api/connect-card`)
- Vocab + Gemini client reused by [[profile.py]] and [[reconcile.py]]
- [[Proceedings — Project Overview]], [[Deployment]]
