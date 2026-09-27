# Live search for the uscis.gov long tail — evaluation

**Problem.** Curated DS-1 grounding (forms + a few area pages) covers only a slice
of uscis.gov. For the long tail (naturalization, cap-gap, asylum, travel docs, …)
we want a **live** answer — like a browser `site:uscis.gov` search — returned in
the platform with a citation, instead of falling through to unlabelled model
knowledge.

**Do NOT** scrape Google's results page — it violates Google's ToS, gets blocked,
and is unreliable. Use a sanctioned API. Two ways evaluated below.

---

## Option A — Custom Search JSON API restricted to `site:uscis.gov` (documented for future)

A **Programmable Search Engine** (PSE/CSE) restricted to `uscis.gov`, queried via
the **Custom Search JSON API**. Returns top links + snippets; we synthesize an
answer with Gemini over the snippets (or fetch the top page) and cite the **raw
uscis.gov URLs**.

**Setup (when we do it):**
1. Create a Programmable Search Engine at programmablesearchengine.google.com,
   set "Sites to search" = `uscis.gov` (or `*.uscis.gov`). Note the **cx** id.
2. Enable the **Custom Search API** in the GCP project; create an **API key**.
3. Backend: `GET https://www.googleapis.com/customsearch/v1?key=…&cx=…&q=<question> site:uscis.gov`
   → take the top N `items[].link/title/snippet` → synthesize a concise answer,
   cite the links.

**Pros:** **true `site:uscis.gov`** restriction (exactly the ask); **raw uscis.gov
citations**; we control synthesis and can hard-filter to gov domains.
**Cons:** new setup (CSE + API key + a secret to manage); more plumbing (search →
synthesize/fetch → cite); cost (100 queries/day free, then ~$5 / 1,000, ≤10k/day);
snippet-only answers can be thin unless we also fetch the page.

**When to pick A:** if we need **guaranteed** source fidelity (only uscis.gov /
official domains) and raw citations. This is the stricter, more controllable path.

---

## Option B — Gemini "Grounding with Google Search" (SPIKED 2026-09-20)

`Tool(google_search=GoogleSearch())` on the Gemini call → Gemini runs a live
Google search, grounds the answer, returns citations in `grounding_metadata`.
Already in our genai SDK — **no new API key / CSE**. Spike tool:
`scripts/spike_web_search_grounding.py`.

**Spike results (gemini-2.5-flash, prompt: "answer only from official US-gov
sources, prefer uscis.gov/travel.state.gov/dhs.gov"):**

| Question | Answer quality | Citations |
|---|---|---|
| Naturalization eligibility | ✅ accurate, concise | 5 (3 uscis.gov, + ilrc.org, a law firm) |
| H-1B cap-gap | ✅ accurate | 11 (uscis.gov ×3, dhs.gov ×2, + a law firm) |
| Re-entry permit | ✅ accurate | 0 in metadata, but inline `[cite:N]` markers leaked into the text |

**Verdict: viable and low-effort, with caveats to handle before production:**
- **Soft site restriction** — the prompt *prefers* but doesn't *enforce* uscis.gov;
  non-authoritative sources (law firms, ilrc.org) show up. Mitigate by
  hard-filtering citations to gov domains and/or labelling clearly.
- **Citation URLs are Google *redirect* links** (`vertexaisearch.cloud.google.com/
  grounding-api-redirect/…`), not raw uscis.gov — the real domain is in the
  chunk's `title`. This is a Google requirement, not a bug.
- **Inline `[cite:N]` markers** can leak into `resp.text` — must be stripped.
- **Compliance (required):** grounding-with-Search returns a **Search Entry Point**
  (the "Search Suggestions" chips); Google's terms require the UI to **render those
  chips** and use the provided redirect citation URIs. We'd need to surface them in
  the chat.
- **Cost:** priced per grounded request (bounded — only on the fallback path).
- **Freshness:** always live; no ingestion/refresh needed (the whole point).

**If productionised (Option B):** add a `web_search` fallback tier to the assist
cascade — `gov (DS-1) → community → web_search → ungrounded` — that: strips
`[cite:N]`, keeps only gov-domain citations (or labels non-gov), renders the
Search-Suggestion chips, and marks `source_tier="web"`. It effectively upgrades the
existing manual "Search on USCIS.gov" button into an inline, cited answer.

---

## Recommendation

- **Ship B** as the long-tail fallback tier (fastest, native grounding, no setup) —
  with the answer-cleaning + gov-citation filtering + the required Search-Suggestion
  chips in the UI.
- **Keep A on the shelf** (this doc) for when strict `site:uscis.gov`-only fidelity
  and raw citations are required; it's a ~1-page CSE + API-key setup away.

---

## Re-evaluation — 2026-09-27 (goals changed; recommendation flips)

Revisited against the now-explicit product goals: **authenticated, government-first, latest, and a
one-stop shop that keeps users in-app**, for a **privacy-sensitive** immigration audience. Three facts
(verified from current Google docs) change the calculus since the 2026-09-20 spike:

1. **Search-Suggestion chips are MANDATORY for Grounding-with-Google-Search (Option B).** Google's
   terms require displaying them **exactly as provided** (no restyling), **same width** as the answer,
   **whenever** the grounded response shows. Those chips push users **to Google Search** — the opposite
   of a one-stop shop.
2. **Option B citations are Google *redirect* links** (`vertexaisearch.cloud.google.com/…`), not raw
   `uscis.gov` — weakens the "authenticated source" UX/trust.
3. **Option B stores prompts + outputs for 30 days with no opt-out** (Google terms) — a real
   **data-privacy** problem for immigration queries.
4. **"Advanced" website indexing requires domain verification** even for third-party sites — we don't
   own `uscis.gov`, so advanced features (extractive answers, follow-ups) are **not available**; only
   **basic** website crawl is (which is exactly what our provisioned **DS-2** already does).

### New option not in the original eval
**Option C — Web Grounding for Enterprise (Vertex).** Grounds on a **subset of the Google index**,
built for **highly-regulated industries**: **no logging of customer data**, ML processing in US/EU
multi-regions, **VPC-SC support**. Materially better privacy posture than Option B for this product;
confirm (a) whether it still requires the Search-Suggestion chips and (b) pricing.

**Option D — DS-2 basic website data store restricted to `.gov` (already provisioned, currently OFF).**
Google crawls the specified `.gov` sites; our own Answer API synthesizes + cites → **in-app answer, raw
`.gov` citations, no mandatory chips, no per-request grounding fee** (it's a data store, not live
search). Limitation: **basic crawl only** (freshness/coverage is Google's; no advanced extractive
features without domain verification we can't get).

### Re-ranked options vs. the goals
| Option | In-app (no off-app chips) | Citations | Privacy (no data logging) | Freshness | Effort | Fit |
|---|---|---|---|---|---|---|
| **D — DS-2 `.gov` basic crawl** (provisioned) | ✅ | ✅ raw `.gov` | ✅ (datastore) | crawl-cadence (Google) | **low** (restrict domains + enable) | **best immediate** |
| **C — Web Grounding for Enterprise** | ❔ confirm chips | redirect | ✅ no logging, VPC-SC | ✅ live | med (new integration) | **best for live+privacy** |
| **A — Custom Search `site:uscis.gov` + synth** | ✅ | ✅ raw uscis.gov | ✅ (our synth) | live | med (CSE + key + synth) | strict single-site alt |
| **B — Grounding w/ Google Search** | ❌ mandatory chips | ❌ redirect | ❌ 30-day logging | ✅ live | low | **last resort only** |

### Revised recommendation
- **Demote Option B** from "ship it" to **last-resort** — mandatory off-app chips + redirect citations
  + 30-day data logging conflict with in-app, authenticated, and privacy goals.
- **Recommended: enable DS-2 restricted to `.gov` (Option D)** as the long-tail tier-3 — it's already
  provisioned, in-app, gives raw `.gov` citations, no chips, no per-request fee. Immediate, low-effort,
  goal-aligned.
- **Investigate Option C (Web Grounding for Enterprise)** in parallel as the *live/fresh* privacy-safe
  upgrade (confirm chip requirement + cost) — the right long-term answer if we want always-live coverage.
- **Keep Option A** as the strict single-site alternative if raw-uscis.gov-only fidelity is required.

## Plan — recommended option (D: DS-2 `.gov`-restricted, enable the provisioned tier)
1. **Restrict domains to `.gov`:** in `backend/scripts/provision_ds2_website.py`, set `PUBLIC_DOMAINS` to
   only authoritative gov sites (`uscis.gov`, `travel.state.gov`, `dhs.gov`, `dol.gov`, `ice.gov`,
   `studyinthestates.dhs.gov`, `ecfr.gov`, `federalregister.gov`); **drop** `boundless.com`,
   `immigrationdirect.com`. Re-provision (idempotent) so target sites re-crawl.
2. **Confirm crawl health:** wait for target sites to read `SUCCEEDED` (`report_indexing`), verify a
   `site:uscis.gov`-style query returns results.
3. **Enable the tier:** set `GCP_VERTEX_PUBLIC_ENGINE_ID` = the DS-2 engine id in the backend env
   (Cloud Run) so `api.py:_grounded_answer` wires the **tier-3 fallback** (`gov DS-1 → community → DS-2
   .gov crawl`). Keep it clearly labelled as a public-web tier below curated DS-1.
4. **Guardrails/UX:** label the tier-3 source, link raw `.gov` citations, keep the "not legal advice"
   guardrail; monitor answer quality vs curated DS-1.
5. **Tests/acceptance:** a long-tail question not covered by curated DS-1 (e.g. naturalization/cap-gap)
   returns an in-app answer citing a `.gov` page, with **no** off-app chips and **no** 30-day logging.
6. **Then:** spike **Option C (Web Grounding for Enterprise)** to compare freshness/quality/cost/chips
   before deciding whether it supersedes D as the live tier.

**Registry impact (per the maintenance rule):** when D is enabled, move the DS-2 crawl row in
`GROUNDING-SOURCES.md` from "wired but OFF" to section A (restricted to the `.gov` set).
