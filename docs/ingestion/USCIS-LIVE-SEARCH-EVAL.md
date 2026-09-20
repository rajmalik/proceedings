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
