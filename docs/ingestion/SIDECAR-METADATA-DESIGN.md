# Sidecar Metadata Design — Why the per-document `.json`, and the Source-of-Truth Model

**Status**: DRAFT for review
**Companion to**: [PIPELINE-ARCHITECTURE-WORKFLOW.md](PIPELINE-ARCHITECTURE-WORKFLOW.md) (§4 Sidecar JSON + GCS layout, §17 event-driven import), [DEPLOYMENT.md](DEPLOYMENT.md), [schema.py](schema.py)
**Answers**: "What is the per-document `.json` sidecar for, is it worth generating, and what are the alternatives?"
**Decision recorded in**: MEMORY.md `D-031`

---

## 1. TL;DR

Every accepted document is stored in GCS as a **sidecar pair** with the same basename in the same prefix:

```
gs://imm-postings-ingestion/<YYYY-MM-DD>/reddit/<case_id>.md     # unstructured post body (title + text)
gs://imm-postings-ingestion/<YYYY-MM-DD>/reddit/<case_id>.json   # canonical structured metadata
```

The `.json` is **worth generating and keeping**. It is the canonical interchange artifact for the production sink, the cheap LLM-free replay source, and the audit/lineage + gold-training record. It is **not** redundant with BigQuery or with the Vertex AI Search document — those are *projections* derived from it.

The one thing that genuinely needs governance is **consistency**: the same metadata physically exists in three places (GCS `.json`, the BigQuery row, the data-store `structData`). We resolve that by declaring **the GCS sidecar pair the single source of truth (SoT)**; BigQuery and the Vertex AI Search data store are derived projections, rebuilt/re-imported from GCS — never hand-edited independently.

---

## 2. What the `.json` carries that the `.md` does not

The `.md` is only the unstructured post body. The `.json` holds the entire **structured layer**, defined by [schema.py](schema.py) `PostingMetadata`:

- Identity & provenance: `case_id`, `reddit_post_id`, `full_url`, `subreddit`, `posting_date`, `ingestion_method`, `source_system`, `gcs_path`, timestamps.
- Tag layer (5 fields): `current_visa_or_greencard_category`, `visa_applying_for`, `consulates` (+ `primary_consulate`), `tags`, `concerns_or_questions_tags`.
- Structured attributes: `key_stages_or_info`, `key_dates`, `severity`, `resolution_status`, `employer_type`, `principal_country_of_chargeability`, `derived_topic_cluster`.
- Search/grounding: `background_summary`, `concerns_or_questions_summary`, `embedding_text`, `tagging_confidence`.
- Pipeline bookkeeping: `index_state` (+ ts), `pipeline_run_id`.

None of this exists in the `.md`. So the real question is never "md vs json" — it is *where the structured metadata should live*, and whether a per-document GCS file is the right home for it.

---

## 3. Where the `.json` is consumed — Phase 1 vs Phase 2

There is an important difference between the current manual batch and the production target.

### Phase 1 — current manual batch (`vertexai-search-ingestion-from-examples/scripts/ingest_batch.py`)
- `documents.import` is fed a **manifest** in which `structData` is the JSON sent **inline** (from the in-memory dict), and `content.uri` points to the `.md`.
- The per-document GCS `.json` sidecar is **written but not read** by the import.
- In Phase 1 the sidecar's value is therefore purely a **durable replay / audit copy**.

### Phase 2 — production target (per [PIPELINE-ARCHITECTURE-WORKFLOW.md](PIPELINE-ARCHITECTURE-WORKFLOW.md) §4, §17)
- The Vertex AI Search data store runs in **sidecar mode** with source `gs://imm-postings-ingestion/*/reddit/*.json`: the `.json` *is* the metadata source and the `.md` is the document body.
- The `.json` landing in GCS is the **Eventarc trigger** (`.json` finalize → `search-importer` → `documents.import`), making the document searchable in minutes.
- The `.json` supplies **search facets** and the **chatbot's grounding citations**; the `.md` supplies the readable passage.

So in the real architecture the sidecar `.json` is load-bearing — it is both the canonical metadata artifact and the per-object event trigger. The Phase-1 inline-`structData` is the simplification (a convenience for a one-off batch), not the long-term contract.

---

## 4. Why it is worth generating — three concrete payoffs

1. **Replay / rebuild without re-running the LLM.** Tagging is the expensive, rate-limited, non-deterministic step. `.md` + `.json` is a frozen, deterministic re-import source: the entire data store (or the BigQuery table) can be rebuilt from GCS with **zero model calls**. This is the strongest single argument.
2. **It is the production sink's native contract.** Vertex AI Search sidecar mode + the per-object event trigger are designed around exactly this pair. Removing it means re-architecting Phase 2.
3. **Audit / lineage + gold training data.** An immutable, per-document record of what was generated at ingestion time, independent of BigQuery schema/retention. The same artifact feeds the eval harness and the Example Store (self-learning loop).

---

## 5. The real cost — three-way consistency

The metadata physically exists in three places:

| Copy | Role |
|---|---|
| GCS `.json` sidecar | Canonical artifact + replay source + event trigger (Phase 2) |
| BigQuery `postings.postings_metadata` row | Dedup + watermark + analytics + training-data store |
| Vertex AI Search data-store `structData` | Serving copy for search facets + grounding |

A correction therefore risks a three-way write. This was felt directly during the batch-2 invalid-date repair (`2026-02-29` → `2026-02-28`), which had to be applied to the local JSON, the GCS sidecar, **and** the BigQuery row.

This is a **consistency** problem, not a reason to delete the file.

---

## 6. The source-of-truth model (the governance fix)

**The GCS sidecar pair (`.md` + `.json`) is the single source of truth. BigQuery and the Vertex AI Search data store are derived projections.**

Consequences:
- Corrections are made to the GCS sidecar (or re-emitted by the pipeline), then **flow outward**: GCS → re-import (data store) and GCS → re-load (BigQuery). Operators do not hand-edit the data store or BigQuery independently of GCS.
- Both downstream stores must be **rebuildable from GCS** at any time with no model calls. This is already the direction of travel: D-028 (Storage Write API → staging → scheduled MERGE) and the Phase-2 event-driven import both treat GCS as the upstream truth.
- `index_state` in BigQuery is **derived bookkeeping**, not authoritative. The authoritative answer to "is this document indexed?" is the data store itself (`get_document` / `list_documents`), as the batch-2 81-vs-82 investigation demonstrated.

---

## 7. Alternatives considered and rejected

| Approach | Why it is weaker for this system |
|---|---|
| **Front-matter inside the `.md`** (single file; YAML/JSON header) | Discovery Engine indexes the `content.uri` body, so front-matter pollutes search unless stripped; breaks the native sidecar-mode contract and facet wiring; harder to load into BigQuery. |
| **BigQuery-only metadata; drop the GCS `.json`** | The event-driven importer would have to join to BigQuery on every GCS object event (coupling + latency); BigQuery (an analytics store) becomes a hard operational dependency for every re-import; loses cheap GCS replay. |
| **Manifest / NDJSON only; no per-document `.json`** | Manifests are transient batch artifacts, not durable per-document records; no per-object replay; does not fit the Phase-2 "one event per `.json`" trigger. |
| **One combined JSON with the body inline (no `.md`)** | Loses the human-readable / renderable body the website wants; bloats manifests; the `.md` is the natural Discovery Engine "document body." |

---

## 8. How the sidecar `.json` participates in semantic search

A common misconception is that the `.json` "does" the semantic search. It does not produce the embedding — but it makes semantic retrieval **precise, steerable, and groundable**. Understanding the division of labor is essential to configuring the data store correctly.

### 8.1 What actually gets embedded — content vs. structData

Our data store is **GENERIC / CONTENT_REQUIRED** in **sidecar mode**:

- The **dense semantic vectors are generated from the document *content*** — i.e. the `.md` body (title + post text) referenced by `content.uri`. Vertex AI Search parses it, chunks it, and embeds the chunks **internally** (this is why we run a single sink with no self-managed Vector Search — see [PIPELINE-ARCHITECTURE-WORKFLOW.md](PIPELINE-ARCHITECTURE-WORKFLOW.md) §15.1). "Find documents by meaning" is powered by the `.md`.
- The **`.json` structData is *not* folded into that content vector.** Its fields participate through the **hybrid (keyword + structured) index**, plus filtering, boosting, faceting, and grounding.

So: the `.md` decides *what is semantically relevant*; the `.json` decides *what is precise and most useful*, and supplies *what the answer cites*.

### 8.2 The five roles structData plays in retrieval

1. **Searchable structured text → bridges vocabulary gaps.** Fields marked `searchable` (`tags`, `concerns_or_questions_tags`, `background_summary`, `concerns_or_questions_summary`, `embedding_text`, `post_title`) join the hybrid index. Because the master-tag vocabulary is a **controlled-vocabulary semantic layer**, a post that never literally writes "adjustment of status" but is tagged `AOS` still becomes retrievable for that concept (the abbreviation's Full Name/alternate_tag columns are indexed as search synonyms — `search_client.py`'s `_facet_registry()`). Raw posts are terse/slangy; the tags + summaries give the retriever clean concept anchors it would otherwise miss.
2. **Filters → scope the candidate set.** Fields marked filterable/`indexable` (`current_visa_or_greencard_category`, `visa_applying_for`, `consulates`, `subreddit`, `severity`, `resolution_status`, `posting_date`) let a query constrain *which* documents are ranked. Example: query `"what happens at a 221g for H-1B at Hyderabad"` + `filter: current_visa_or_greencard_category: ANY("H-1B") AND consulates: ANY("HYDERABAD")` — semantics find the meaning, the filter guarantees the right visa+consulate slice. This is the single biggest precision lever.
3. **Boosting → re-rank by business signal.** `boostSpec` on structData fields re-orders semantically-retrieved hits: boost recent `posting_date`, boost `severity = high`, boost `resolution_status = resolved`, boost specific `tags`.
4. **Facets → the drill-down UI.** Fields marked `dynamicFacetable` (visa category, consulate, tags, severity) become the sidebar facet counts that let users narrow a semantic result set interactively.
5. **Grounding & citations.** The Search + Answer / grounded-Gemini app cites documents using structData (`full_url`, `post_title`, `case_id`, tags, dates) while extractive snippets come from the `.md`. Without structData the chatbot cannot cite cleanly.

### 8.3 The `embedding_text` caveat — it does **not** currently drive the dense vector

`embedding_text` is a denormalized, high-signal blob (title + summaries + tags + stages + dates) generated into the **structData**, not the content. Because the dense vector is computed from **content only**, `embedding_text` today contributes to keyword/term recall and grounding, **but not to the dense semantic vector**. Its name is therefore slightly aspirational for this sink: a clean canonical summary that would be ideal to embed is sitting in the one place that is *not* embedded.

To make `embedding_text` actually steer **dense semantic** matching, it must be fed as **content**, not structData. Options:

| Option | Mechanism | Trade-off |
|---|---|---|
| **A. Append `embedding_text` to the `.md` body** | The content file becomes `title + body + "\n\n" + embedding_text` | Simplest; the curated summary + tags now influence the dense vector. Risk: the appended block is also returned in extractive snippets unless delimited/trimmed; mild duplication of the body. |
| **B. Replace the content body with `embedding_text`** | content = `embedding_text` only; raw post kept only in the human-readable `.md`/GCS | Most control over the embedded representation; but loses the verbatim post as the embedded/snippet source — snippets become summary-flavored, not the poster's own words. |
| **C. Keep as-is (structData only)** | No change | Dense vector stays purely the poster's words (most faithful); `embedding_text` remains a recall/grounding aid only. |

This is a genuine retrieval-quality decision and should be measured, not guessed: prototype A vs C on the existing batch and compare retrieval (e.g. with the Gen AI Evaluation Service golden set, D-019) before committing. **Not yet decided.**

## 9. Open follow-ups (optional, not yet decided)

- **(a) Exercise the sidecar on the Phase-1 import path.** Phase-1 batch import uses inline `structData`, so the GCS sidecar is **not read** on the import path today. To rehearse the production path, switch the batch import to consume the GCS `.json` in **sidecar mode** (data store source `gs://.../*.json`) instead of inline `structData`. Behavioural change to `ingest_batch.py`.
- **(b) Decide whether `embedding_text` should drive the dense vector** (§8.3). If yes, feed it as content (Option A or B) rather than structData, and validate the retrieval-quality delta against the golden set before adopting.
