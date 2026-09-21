# Timestamps & Analytics Queries — Data Model Reference

**Status:** Reference doc (verification findings, not a proposal)
**Last updated:** 2026-07-26
**Scope:** Postings (`backend/posting.py`) + replies/votes (`backend/interactions.py`)

> **Why this doc exists.** A verification pass confirmed which timestamps the
> backend actually captures and where they're stored, then used that to write
> example analytical queries against the real schema. This is a description
> of what exists today, not a design proposal.

---

## 1. Findings — which timestamps are captured

| Concept | Field name in code | Applies to | Captured? |
|---|---|---|---|
| When **we** ingested/processed the content | `ingestion_timestamp` | Postings | ✅ Always set, never overridable — `datetime.now(timezone.utc)` at publish time ([`posting.py:806,813`](backend/posting.py)) |
| When a **reply** was created | `created_at` | Replies | ✅ Always set at write time — `_now_iso()` ([`interactions.py:36-37,207`](backend/interactions.py)) |
| The **original/source event date** (e.g. real Reddit post date) | `posting_date` | Postings only | ✅ Captured, but scoped to postings — see §1.1 |

### 1.1 `posting_date` — the "actual event timestamp from source"

- Defaults to **today** for app-authored content ([`posting.py:812`](backend/posting.py:812)) — correct by design, since for a live user submission the posting *is* the event; there's no separate "source" to diverge from.
- Carries the **real original Reddit post date** for backend-ingested content, passed explicitly through `publish_reddit_posting()` (Path B — [`posting.py:796`](backend/posting.py:796), see [`docs/ingestion/PATH-B-PROVENANCE-PLAN.md`](ingestion/PATH-B-PROVENANCE-PLAN.md)).
- It is a genuinely separate field from `ingestion_timestamp`, not derived from it — both are written independently into the canonical dict ([`posting.py:888-889`](backend/posting.py:888)).

### 1.2 Gap: no source-event timestamp for replies

This concept does **not** extend to replies. There is no "original Reddit comment timestamp" field anywhere, because Path B ingests a Reddit post as a single paraphrased document (per the D-017 paraphrase posture) — it never creates individual reply/comment documents. So for replies, "actual event timestamp from source" is currently N/A by construction, not an oversight. Only relevant if a future ingestion path starts pulling individual Reddit comments as first-class replies.

---

## 2. Where each timestamp is stored

Postings and replies/votes live in **entirely separate storage systems** — this matters for what a single query can and can't join.

| Data | Store | Collection / table | Timestamp field(s) |
|---|---|---|---|
| **Postings** (title, tags, category, provenance) | GCS (sidecar JSON) | `gs://<bucket>/<date>/<channel>/<case_id>.json` | `posting_date`, `ingestion_timestamp` (full canonical dict) |
| | Vertex AI Search (Discovery Engine) | `imm-postings-datastore`, doc id = `case_id` | Same — `struct_data` is the unfiltered canonical dict ([`posting.py:992`](backend/posting.py:992)) |
| | **BigQuery** | `postings.postings_metadata` | `posting_date` (`DATE`), `ingestion_timestamp` (`TIMESTAMP`), `last_updated_timestamp` (`TIMESTAMP`) — [`posting.py:1012`](backend/posting.py:1012) |
| **Replies** (body, author) | **Firestore** | `replies/{auto_id}` | `created_at` (ISO string) |
| **Votes** (per-user) | Firestore | `votes/{contentId}__{uid}` | `updated_at` |
| **Vote/score tallies** (aggregate) | Firestore | `content_meta/{contentId}` | `updated_at` |

**Key implication:** postings have **no row in Firestore at all**, and replies/votes/scores have **no row in BigQuery at all** — by deliberate design ([`interactions.py:4-6`](backend/interactions.py:4): "kept OUT of the GCS→datastore→BigQuery posting pipeline so they never pollute search/grounding"). A query that needs *both* a posting's metadata (title, category) *and* its vote score has to hit both stores and join in application code — there's no single database with both.

The full BigQuery schema (`postings.postings_metadata`, partitioned on `posting_date`) is defined at [`posting.py:1007-1024`](backend/posting.py:1007) — includes `case_id`, `channel`, `post_title`, `current_visa_or_greencard_category` (repeated), `visa_applying_for` (repeated), `tags` (repeated), `subreddit`, `reddit_post_id`, and both timestamp fields above.

---

## 3. Example analytical queries

### 3.1 "Show me postings from today" — BigQuery

Two different questions depending on which "today" is meant:

**(a) Postings that entered our system today** (ingestion time):
```sql
SELECT case_id, post_title, channel, ingestion_timestamp
FROM `proceedings-490601.postings.postings_metadata`
WHERE DATE(ingestion_timestamp) = CURRENT_DATE()
ORDER BY ingestion_timestamp DESC;
```

**(b) Postings whose original/event date is today** (mostly meaningful for
`channel="reddit"` content, where `posting_date` can differ from ingestion
day — for `channel="app"` content the two are the same by design):
```sql
SELECT case_id, post_title, channel, posting_date
FROM `proceedings-490601.postings.postings_metadata`
WHERE posting_date = CURRENT_DATE()
ORDER BY case_id;
```

### 3.2 "Which category has the most postings" — BigQuery

`current_visa_or_greencard_category` and `tags` are both `REPEATED STRING` —
requires `UNNEST`:

**By visa/green-card category:**
```sql
SELECT category, COUNT(*) AS posting_count
FROM `proceedings-490601.postings.postings_metadata`,
UNNEST(current_visa_or_greencard_category) AS category
GROUP BY category
ORDER BY posting_count DESC;
```

**By tag** (finer-grained — `tags` carries the controlled-vocab topic tags):
```sql
SELECT tag, COUNT(*) AS posting_count
FROM `proceedings-490601.postings.postings_metadata`,
UNNEST(tags) AS tag
GROUP BY tag
ORDER BY posting_count DESC
LIMIT 20;
```

### 3.3 "Which postings have the most upvotes" — Firestore

`content_meta.score` is a real, incrementally-maintained field (updated
transactionally on every vote — [`interactions.py:161`](backend/interactions.py:161)), so a native
ordered query works directly, no full scan needed:

```python
from google.cloud import firestore

db = firestore.Client(project="proceedings-490601")

top = (
    db.collection("content_meta")
    .order_by("score", direction=firestore.Query.DESCENDING)
    .limit(20)
    .stream()
)
for doc in top:
    print(doc.id, doc.to_dict())  # {'up': .., 'down': .., 'score': .., 'updated_at': ..}
```

**Caveat:** `content_meta` has **no field distinguishing a posting's tally
from a reply's tally** — `contentId` is either a posting `case_id` or a
reply's Firestore auto-ID (see the collection-shape note in
[`interactions.py:8-11`](backend/interactions.py:8)). To filter to postings only, use the
`case_id` prefix convention client-side (postings start with `app-`,
`app-exp-`, `app-connect-`, or `reddit-`; replies are opaque Firestore
auto-IDs and won't match). To show the post title/category alongside the
score, cross-reference the resulting `case_id`s against BigQuery — there's
no single-query join across the two stores.

### 3.4 "Which postings have the most replies" — Firestore

There is **no denormalized reply-count field anywhere** (unlike
`content_meta.score`, reply counts are never incrementally maintained), so
finding the globally most-replied posting requires a full collection scan
and grouping client-side:

```python
from collections import Counter
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

db = firestore.Client(project="proceedings-490601")
replies = db.collection("replies").where(filter=FieldFilter("deleted", "==", False)).stream()
counts = Counter(r.to_dict()["parent_case_id"] for r in replies)
top_20 = counts.most_common(20)
```

For **one specific posting's** reply count (not "which posting has the
most"), Firestore's native `count()` aggregation avoids the full scan:
```python
from google.cloud.firestore_v1.base_query import FieldFilter
q = (db.collection("replies")
       .where(filter=FieldFilter("parent_case_id", "==", "reddit-2026-06-15-h1b-1abc2de"))
       .where(filter=FieldFilter("deleted", "==", False)))
count = q.count().get()[0][0].value
```
This doesn't help the "which posting has the most" question, though — `count()`
only aggregates a single filtered query, not a GROUP BY across all
`parent_case_id` values in one call.

---

## 4. Notes for future work (not decisions, just observations)

- **§3.3/§3.4 don't compose into one query.** "Top postings by score, with
  their titles and categories" requires: Firestore query → collect
  `case_id`s → BigQuery `WHERE case_id IN (...)` → merge in application code.
  This is fine at current scale; would be worth a denormalized read model if
  this becomes a frequent product surface (e.g. a "trending" page).
- **No `kind` discriminator on `content_meta`.** Filtering postings vs.
  replies by `case_id` prefix works but is implicit/fragile — an explicit
  field would make §3.3's query self-contained.
- **No `reply_count` counter.** Every "most replied" query today is an
  O(all replies) scan. A denormalized counter (maintained the same way
  `content_meta.score` already is, transactionally on write/delete) would
  make this a native ordered query like §3.3, if this becomes a real
  product surface rather than an ad-hoc analytics question.
