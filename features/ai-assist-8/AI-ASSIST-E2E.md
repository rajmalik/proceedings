# AI Assist — live E2E verification runbook

Companion to [`ai-assist-specs-8.md`](./ai-assist-specs-8.md) (§5.9) and
[`ai-assist-implementation-plan-8.md`](./ai-assist-implementation-plan-8.md) (Phase 9).
The script under test is [`backend/tests/test_assist_e2e.py`](../../backend/tests/test_assist_e2e.py).

## What it is

A **live, read-only** integration check that exercises the AI-Assist backend
against **real GCP** (Vertex AI Search Answer API + Firestore, via ADC) and **real
Gemini**. It is the "prove it works against production data" pass that the
offline unit suites (`test_assist*.py`) deliberately cannot do — they stub every
external call.

It is **not** wired into the no-GCP CI gate: it needs credentials, makes a few
paid Gemini/Vertex calls, and Gemini's routing is non-deterministic. Run it **by
hand** at the moments below, not on every push.

## Why it exists — the §5.9 gates

Phase 1–8 shipped behind assumptions the offline tests could not confirm. This
script resolves them:

| § | Open question (spec §5.9) | Resolved by |
|---|---|---|
| B1 | Does the **Answer API** accept a `doc_kind` filter? (only the *Search* path had confirmed live usage) | **I1** |
| B1 | Does the filter actually *restrict* to gov/official docs? | **I1b** |
| Q9 | Do community postings carry a **resolvable source link** so every card links back? | **I2 / I2b** |
| — | Does the gov→community→ungrounded **cascade** work end to end? | **I3** |
| Q12 | Does the **public** timeline group search run against live Firestore? | **I4** |
| — | Does **`handle_turn`** work end to end with the real Gemini router? | **I5 / I5b** |

## Safety

- **Read-only.** It calls `answer_query` (search), `matching.search_groups`
  (Firestore reads), `get_document` (to inspect `doc_kind`), and `handle_turn`
  for *answer* questions. It never writes to the datastore, GCS, or Firestore,
  and never creates a group or a posting.
- **Cost.** A handful of Answer-API + Gemini calls per run (cents). Fine to run
  on demand; don't loop it.
- It queries the **production** datastore/project, so results reflect live data
  (grounded vs. fallback will vary as the corpus changes).

## Prerequisites

```bash
gcloud auth application-default login   # ADC, once
```

Environment (same identifiers the API uses; shown with the current prod values):

```bash
GCP_PROJECT_ID=proceedings-490601
GCP_VERTEX_SEARCH_APP_ID=imm-postings-search-app
GCP_VERTEX_DATASTORE_LOCATION=global
```

## How to run

```bash
cd backend
GCP_PROJECT_ID=proceedings-490601 \
GCP_VERTEX_SEARCH_APP_ID=imm-postings-search-app \
GCP_VERTEX_DATASTORE_LOCATION=global \
.venv/bin/python tests/test_assist_e2e.py integration
```

With `GCP_PROJECT_ID` unset the run **SKIPs** (prints a notice, exits 0) — so it
is safe to invoke from a script that may or may not have creds. Exit code is
non-zero only if a check that actually ran **failed**.

## The checks

| ID | Asserts | Notes / skip condition |
|----|---------|------------------------|
| **I1** | The gov `doc_kind` filter is **accepted** by the Answer API (no 400) and returns the normal `{answer, chunks, is_fallback}` shape. | The critical gate. Prints whether it grounded + chunk count. |
| **I1b** | Every grounded gov chunk's stored `doc_kind` is in `{gov_news, official_reference}`. | Fetches each doc via `DocumentServiceClient`. **Skipped** if the gov tier returned no chunks for the sample question. |
| **I2** | The community **negation** filter (`(NOT doc_kind: ANY("gov_news","official_reference"))`) is accepted. | |
| **I2b** | Every community card has a non-empty `url` (external permalink, else `/case/{case_id}`) — Q9. | **Skipped** if the community tier returned no chunks. |
| **I3** | `answer_cascade` returns a valid `source_tier` (`gov`/`community`/`ungrounded`) and a non-empty answer. | |
| **I4** | The **public** timeline `search_groups` runs and returns a list. | 0 matches is a pass (the sample cohort may not exist yet). |
| **I5 / I5b** | `handle_turn` (real Gemini router) returns a valid `intent` and always attaches a disclaimer. | Tolerant — asserts *validity*, not a specific intent, since the router is non-deterministic. |

Skips are expected and fine — they mean the sample question didn't ground on that
tier today, not that anything is broken. The one that **must always pass** before
enabling the feature is **I1** (and **I1b** when it grounds): if the Answer API
ever rejects the filter, the gov/community cascade is broken.

## When to run

- **Before flipping `NEXT_PUBLIC_AI_ASSIST_ENABLED=1`** — the go/no-go for enabling.
- **After a backend deploy** that touches `assist.py` / `search_client.py` / the
  grounding config.
- If the **grounding datastore or the router model** changes (e.g. bumping
  `GCP_GEMINI_ASSIST_MODEL`).

## Last recorded run

**2026-09-19 · `proceedings-490601` / `us-central1` · 8/8 PASS.**
- I1 gov filter accepted, grounded (4 chunks); I1b docs were `{gov_news, official_reference}`.
- I2 community filter accepted; I2b cards linked back (mostly `/case/{id}` pages).
- I3 cascade → `gov`; I4 timeline search ran (0 matches — no `EAD-stem-opt-extension-Aug-2026` cohort yet); I5 `handle_turn` → `answer-gov` with a disclaimer.
