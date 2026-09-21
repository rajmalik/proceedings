# Find Candidates — how it works, what was broken, and whether it wants an Agent

**Status:** the four defects in §2 are FIXED (this branch). Everything in §4 onward is
evaluation and proposal — no code.

**Question asked:** *"Evaluate and plan the functionality and potential design when a user
clicks 'Find Candidates'. Evaluate the matching pattern to be used. Evaluate the
architecture option of maybe having another Agent."*

**Answer in one line:** an Agent is the wrong next step — the matcher was losing candidates
to four concrete defects, not to a lack of intelligence, and there are two cheaper,
higher-yield options (§4.1, §4.2) that are completely unexploited. Revisit the Agent when
profiles are rich enough to reason over.

---

## 1. What "Find candidates" does today

`POST /api/groups/{id}/find-candidates` → `matching.find_matches()`, ranking every user in
Firestore `users` against the group's **stored `criteria_tags`** (the criteria frozen at
creation — not the current members' profiles, and not the caller's).

Scoring (`matching._score()`) is a pure weighted set-intersection over five controlled-
vocabulary buckets:

| Facet | Comparison | Weight each |
|---|---|---|
| visa (`current_visa_or_greencard_category` ∪ `visa_applying_for`) | set ∩ | **3.0** |
| consulates (`consulates` ∪ `primary_consulate`) | set ∩ | **1.5** |
| `key_stages_or_info` | same key **and** identical value | **1.0** |
| `tags` (1.3 abbreviations + 1.10 topics) | set ∩ | **0.75** |
| `key_dates` | same key, then by proximity | 1.5 exact / 1.0 ≤30d / 0.6 ≤90d / 0.3 ≤180d / 0.1 floor |

A candidate surfaces iff `shared` is non-empty **and** `score >= MIN_SCORE (1.0)`. Sorted by
`(score, username)` descending, capped at `top_n=20`.

Notable: **no free text is used at all.** `background_text` is carried through
`_clean_criteria()` but `_score()` never reads it; `journey` is stripped entirely. There
are no embeddings, no semantic similarity, and no vector representation of a user anywhere
in the repo.

---

## 2. The four defects (fixed on this branch)

These were losing real candidates. None of them were about intelligence.

**2.1 — The top-N cap was applied before the caller's exclusions.**
`find_matches()` capped at 20, and only *then* did the route filter out existing members. A
group with 15 members could return 5 candidates while dozens of good ones existed; a group
with 20+ members could return **none**. Fixed by threading `exclude_ids` into the loop so
the cap applies to the eligible pool. Pending invitees are excluded too, so the UI stops
re-offering someone whose invitation is already outstanding.

**2.2 — A Timeline group's processing type scored exactly zero. (The worst one.)**
`_clean_criteria()` deliberately re-admits 1.6 vocabulary such as `stem-opt-extension` into
*group* criteria — it is the group's defining attribute. But candidate profiles are cleaned
by `posting.clean_misc_tags()`, which keeps only 1.3/1.10. So the tag could never intersect
a profile's `tags`, and contributed **0.0** to every candidate, silently. "Who else is doing
a STEM-OPT extension" could not find anyone *for that reason*.

Fixed by scoring the signal that profiles genuinely carry: when the criteria match a
`POST_JOIN_ATTRIBUTE_TEMPLATES` entry, candidates are scored on how many of that template's
`key_dates` keys (`ead_filed_date`, …) they have populated. Those are real 1.8 profile
vocabulary. No schema change, no new data.

**2.3 — Non-matches were displayed as matches.**
`_date_key_score()` returns a 0.1 floor for a shared date *key* whose values are far apart,
and `_date_label()` rendered that as a `key(≠)` chip inside `shared[]` — which the UI shows
under a heading meaning overlap. Fixed: the floor still contributes to score (tracking the
same milestone is weak evidence), but only genuinely-near dates appear in `shared`.

**2.4 — No explanation.** The card showed a bare float (`match 4.5`) and raw vocabulary
codes. `_score()` already computed a `shared_detail` breakdown and threw it away. Now a
`reason` string is derived from it — *"Both H-1B · at Mumbai · similar timing on EAD Filed
Date"* — reusing `search_client._humanize()` / `_consulate_label()`.

---

## 3. What remains weak (not fixed — design questions, not bugs)

- **No near-miss vocabulary.** EB-2 vs EB-3, H-1B vs H-4, DEL vs BOM all score 0.
- **`key_stages_or_info` demands exact string equality**, so `I-485: filed` vs
  `I-485: pending` scores 0 despite being the same boat.
- **Free text is unused.** `background_text` and `journey` are the richest human signal in
  the system and contribute nothing.
- **No recency or direction.** Someone who filed in 2019 and someone filing next month score
  identically on a shared tag.
- **No symmetry or intent.** Whether the *candidate* would want the match is not modelled.
- **O(N) full scan** of `users` per request, with `clean_profile()` re-run per user, uncached.
- **Ranks against frozen criteria**, not the group's actual current membership.

---

## 4. The option ladder

Ordered by yield-per-unit-effort. Each is independently shippable.

### 4.1 Deterministic enrichment — *do this next*
`search_client._tag_hierarchy()` and `_hierarchy_related(code)` already exist, are already
built from the `tags-cleaned/` CSVs, and are **entirely unused by `matching.py`**. Wiring
them in gives partial credit for parent/sibling vocabulary, which directly fixes the EB-2/EB-3
and neighbouring-consulate blind spots.

Also cheap here: relax `key_stages_or_info` to same-key partial credit; add a mild recency
weight; cache the cleaned candidate corpus per request.

Cost: hours. No new infrastructure, no latency, fully testable, fully deterministic.

### 4.2 Semantic retrieval over a surface that already exists — *highest untapped value*
Users' consented `journey` entries and "looking to connect" cards are **already indexed in
the Vertex AI Search datastore**, keyed on `author_handle`
(`posting.publish_experience()`, `publish_connect_card()`, `search_client.postings_by_handle()`).
That corpus is semantically searchable *today* and is completely disconnected from
`matching.py`.

Design: build a query from the group's criteria (the existing `extract_filters()` /
`search_with_strictness()` path), retrieve matching experience/connect-card documents, map
`author_handle` → user, and blend that semantic score with the deterministic score.

This is the only option that introduces genuine semantic understanding, and it needs **no
new infrastructure** — the index, the retrieval client, the strictness tiers, and the
author↔document link all exist. Its limit is coverage: only users who consented to publish
are represented, which is also arguably the correct privacy boundary.

Cost: days. One extra Discovery Engine call per Find-candidates click.

### 4.3 An LLM re-rank + explain pass
Take the top ~20 deterministic candidates and have Gemini re-order them and write the
"why". Fits the existing single-turn pattern exactly: `posting.genai_client()`,
`profile._gen_json()` for structured output, and `query.classify_intent()`'s
cheap-classifier-with-deterministic-fallback shape (which is the right template — never let
the LLM be load-bearing; fall back to the deterministic order on any failure).

Caveat: with 24 thin seeded profiles there is very little for it to reason over, and §2.4
already delivers most of the explainability benefit deterministically, for free and instantly.
Worth revisiting once 4.1/4.2 land and profiles are richer.

Cost: ~1–3s added latency, one Gemini call per click.

### 4.4 A standing Agent
**Recommendation: not yet.**

What exists: single-turn, stateless Gemini calls with JSON-by-prompt.
What does **not** exist, and would all have to be built: an agent loop, tool/function
calling (`response_schema` isn't used anywhere either), a scheduler or job runner, any
per-user embedding or vector store, and a notification surface to deliver proactive results
to (this branch's invitation record is the first actionable record in the codebase).

An agent is the right shape for a *proactive, continuous* matcher — "watch for people who
enter my boat and tell me" — which is a genuinely valuable product idea and a natural
follow-on to the invitation flow just built (an agent's output would be an invitation).
But as a way to make one Find-candidates click smarter, it would be strictly worse than
4.2 at higher cost, and it cannot outperform a corrected deterministic scorer on a corpus
of 24 profiles carrying one visa, one consulate and one date each.

**Revisit when:** (a) 4.1 and 4.2 are in and measured, (b) profiles carry real free text at
volume, and (c) there is a notification surface to deliver proactive matches into.

---

## 5. Recommended sequence

1. **Done (this branch)** — the four defects in §2.
2. **Next** — §4.1 deterministic enrichment. Hours, no new infrastructure, immediately measurable.
3. **Then** — §4.2 semantic retrieval over the existing datastore. The real unlock.
4. **Then** — §4.3 LLM re-rank, once there's enough signal to justify the latency.
5. **Later** — §4.4 an agent, reframed as *proactive* matching feeding the invitation flow,
   not as a better single click.

## 6. How to measure any of this

There is no evaluation harness today. Before 4.2, build a small labelled set: for ~10 real
groups, hand-mark which of the 24 users genuinely belong. Then track precision@5 and
recall across changes. Without it, "smarter matching" is unfalsifiable — and that, more
than model choice, is what would make an agent hard to justify or refute.
