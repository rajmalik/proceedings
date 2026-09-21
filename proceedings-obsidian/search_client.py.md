# search_client.py

**Type:** Grounded-answer + ranked-search client
**Location:** `backend/search_client.py`
**Grounding sink:** managed Vertex AI Search (Discovery Engine) datastore `imm-postings-datastore`, engine `imm-postings-search-app`

---

## Purpose

The live retrieval layer. Replaces the retired self-managed Vector Search path with the managed Discovery Engine **Search + Answer API** over `imm-postings-datastore`. Provides three surfaces: a grounded synthesized answer with citations (`:answer`), ranked posting cards (`:search`), and context-aware refinement facets with live counts. Reddit ingests and first-party app/website posts both live in this one datastore (D-016 single managed sink, D-034 BFF via Search/Answer, D-039 three-tier grounding).

---

## Key functions

| Function | What it does |
|----------|--------------|
| `answer_query(question, project, location, engine)` | Grounds a question via the Answer API; returns `{answer, chunks[], is_fallback}`. Grounded iff the datastore returned citable references. |
| `search_postings(query, …, filter_expr, boost)` | Ranked `:search` posting cards ordered `ingestion_timestamp desc`; returns `{results[], next_page_token, total}`. |
| `search_with_strictness(query, …, strictness, extra_filter)` | Applies `strict` (hard filter, relaxes to balanced if empty) / `balanced` (boost matching facets) / `broad` (pure semantic). Adds `applied_filters`, `relaxed`, `effective_strictness`. |
| `extract_filters(query)` | NL → tagged facet values across all registered facets (consulate/visa/category/outcome/tag) using the controlled tag CSVs. |
| `suggested_filters(query, …)` | Situation-relevant refinement chips with live Discovery Engine facet counts, anchored on the extracted visa/category and ranked hierarchy-related-first. |
| `get_posting(case_id, …, datastore_id)` | Full detail: structData card fields + `tag_sections` + `author_handle` + the Markdown body read from the GCS sidecar (`content.uri`). |
| `postings_by_handle(handle, …)` | All postings under a synthetic author handle, backed by a short-lived (120 s TTL) in-process index built by listing the datastore branch. |

---

## Key Details

- **Grounding gate:** `answer_query` deliberately disables the Answer API's adversarial / non-answer-seeking / low-relevance skip classifiers (non-deterministic, dropped legitimate imperative questions) and instead grounds purely on whether the datastore returned citable references. No references / no answer text / not SUCCEEDED → `FALLBACK_MESSAGE` (`"I don't have that information — please contact the firm directly."`).
- **Reference mapping:** `_reference_to_chunk` handles all three Answer.Reference sub-types (structured sidecar, chunked, unstructured); dedupes recurring references by `chunk_id` and caps at `max_results`.
- **Facet registry (`_FACET_SPECS` / `_facet_registry`):** the single place facets are enumerated — each entry maps a controlled tag vocabulary (`tags-cleaned/*.csv`) to the datastore field(s) it filters, with a match kind, boost weight, and min length. Adding a new facet = one entry. Includes informal consulate aliases (delhi→DEL, bombay→BOM, …).
- **Strictness mechanics:** field-agnostic filter/boost/semantic. `extra_filter` (explicitly selected chips) is ALWAYS applied as a hard filter regardless of strictness.
- **Precedence boost (D-039):** `_boost_spec` ranks app > reddit > rest, gated by `VERTEX_SEARCH_BOOST=1` (default off until the `channel` facet + app posts exist; the current corpus is all Reddit).
- **Env vars:** `GCP_PROJECT_ID`/`GCP_PROJECT`, `GCP_VERTEX_SEARCH_APP_ID`, `GCP_VERTEX_DATASTORE_LOCATION` (default `global`), `VERTEX_SEARCH_BOOST`. ADC needs an explicit `quota_project_id` for `discoveryengine.googleapis.com`; a non-global location switches to a regional endpoint.
- **Resilience:** `_retry` wraps calls with exponential backoff on transient gRPC errors (`ServiceUnavailable`/`DeadlineExceeded`/`InternalServerError`).
- **Detail body:** posting bodies live in GCS `.md` sidecars referenced by the document's `content.uri` (`gs://…`), fetched best-effort.
- Standalone smoke test: `python search_client.py "your question"`.

---

## Dependencies

- `google-cloud-discoveryengine` (`ConversationalSearchServiceClient`, `SearchServiceClient`, `DocumentServiceClient`)
- `google-cloud-storage` — read posting `.md` bodies
- `tags-cleaned/*.csv` — controlled facet vocabularies + tag hierarchy (`1.6-visa-form-actions.csv`)

---

## Related

- Consumed by [[api.py]] (`/api/ask`, `/api/chat`, `/api/search`, `/api/postings/{case_id}`, author pages)
- Documents indexed by [[posting.py]] (`documents.import` into the same datastore)
- Direct-Gemini fallback + Q&A log in [[query.py]]
- [[Proceedings — Project Overview]], [[Deployment]]
