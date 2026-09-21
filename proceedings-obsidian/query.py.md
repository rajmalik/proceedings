# query.py

**Type:** Direct-Gemini fallback + intent classification + Firestore Q&A log
**Location:** `backend/query.py`

---

## Purpose

A trimmed helper module retaining only what [[api.py]] still imports after grounded retrieval moved to [[search_client.py]]. Provides a non-grounded Gemini answer (used ONLY when no Search engine is configured), a chat intent classifier (search vs ask), and the Firestore Q&A log used for history, feedback, and analytics. The old self-managed Vector Search path (embedding, chunking, `find_neighbors`, `chunk_mapping`, the interactive CLI) was retired with the Vector Search index (MEMORY.md D-039) and no longer lives here.

---

## Key functions

| Function | What it does |
|----------|--------------|
| `generate_direct_answer(question)` | Non-grounded Gemini 2.5 Flash answer from general US-immigration knowledge (temp 0.3, top_p 0.8, max 1024 tokens). Fallback path only. |
| `classify_intent(message)` | Classifies a chat message as `search` (browse postings) or `ask` (synthesized answer). Fast Gemini call (`GCP_GEMINI_CLASSIFIER_MODEL`, default `gemini-2.5-flash-lite`, temp 0) with a deterministic keyword heuristic fallback so routing never silently breaks. |
| `save_qa_pair(question, result, db)` | Writes a Q&A doc to Firestore `qa_pairs` (question, answer, retrieved_chunks, sources, is_fallback, helpful=None). Returns the doc id. |
| `get_recent_qa(db, limit, offset)` | Fetches recent Q&A pairs newest-first; ISO-serializes `created_at`. |
| `update_feedback(doc_id, helpful, db)` | Sets `helpful` + `feedback_at` on a Q&A doc. |

---

## Key Details

- **`FALLBACK_MESSAGE`** = `"I don't have that information — please contact the firm directly."` (mirrors the same constant in [[search_client.py]], which is the primary grounding gate).
- **Guardrails** in `generate_direct_answer`: provides factual info (eligibility requirements, processes, fees, timelines, definitions) but forbids case-specific legal advice / qualifying a specific person; steers to an attorney for specific situations. This is the looser, general-knowledge prompt — the strict "answer only from context" grounding now lives in the Discovery Engine Answer API, not here.
- **Shared Gemini client:** reuses `posting.genai_client()` (one process-wide `genai.Client`, Vertex AI, 60 s timeout) rather than constructing a client per call.
- **Firestore collection:** `qa_pairs` (history, feedback, and the source for `GET /api/qa` + `/api/qa/stats`).

---

## Dependencies

- `google-genai` — Gemini (via the shared client in [[posting.py]])
- `google-cloud-firestore` — Q&A log

---

## Related

- Grounded retrieval + ranked search now in [[search_client.py]]
- Consumed by [[api.py]] (`/api/ask`, `/api/chat`, `/api/expert`, `/api/qa*`)
- Shared Gemini client from [[posting.py]]
- [[Proceedings — Project Overview]]
