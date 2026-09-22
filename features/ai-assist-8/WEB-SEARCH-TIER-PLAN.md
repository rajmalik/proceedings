# Web-search fallback tier (Option B) — implementation plan

Productionize the [Option-B spike](../../docs/ingestion/USCIS-LIVE-SEARCH-EVAL.md):
Gemini "Grounding with Google Search" as a **new answer tier** so the long tail of
uscis.gov (and other official) questions returns a **live, cited** answer instead
of falling through to uncited model knowledge. Flag-gated (grounding-with-search
is priced) and behind the existing disclaimer.

## Where it fits (the cascade)

Today: `answer_cascade` = **gov (DS-1) → community → ungrounded**.
New: **gov (DS-1) → community → `web_search` → ungrounded**.

Rationale for the position: keep curated DS-1 and community first (community stays
the right answer for *experiential* questions); use live web search as the broad
fallback **before** giving up to model knowledge. In practice web search rarely
fully misses, so it largely **replaces** the uncited `ungrounded` answer with a
cited `web` one — the whole point.

- `source_tier` gains **`"web"`** (`gov | community | web | ungrounded`).
- Flag-gated: when the flag is off, the cascade is unchanged.

## Backend — `assist.py`

`_web_search_answer(question) -> dict` (from `scripts/spike_web_search_grounding.py`):
- One Gemini call with `Tool(google_search=GoogleSearch())` (fallback to
  `GoogleSearchRetrieval` for older SDKs), `_assist_model()`, temp 0.1, and a
  prompt that restricts to **official U.S. government sources** (prefer uscis.gov /
  travel.state.gov / dhs.gov) and says "say you don't have it" otherwise.
- **Clean the answer:** strip leaked inline `[cite:N]` / `[cite: 1, 3]` markers
  (regex) before returning.
- **Citations:** from `grounding_metadata.grounding_chunks[].web` →
  `{source: web.uri (Google redirect — required), title: web.title (the real
  domain), as_of: ""}`. Optionally **filter/label**: keep gov-domain titles
  prominent; a config toggle can drop non-gov citations entirely.
- **Search-Suggestion chips (compliance):** capture
  `grounding_metadata.search_entry_point.rendered_content` (HTML) and return it as
  `search_suggestions_html` — Google's terms require the UI to render it.
- Return `_answer_shape(cleaned, "web", citations=…, is_fallback=False)` plus the
  `search_suggestions_html`. If the model declines / no grounding chunks → return
  `None` (miss) so the cascade falls through to `ungrounded`.
- Robust: any exception → `None` (never break the turn); grounding-with-search is
  best-effort.

`answer_cascade` change: after the community miss, `if _WEB_SEARCH_ENABLED: web =
_web_search_answer(q); if web: return web`. Then `_ungrounded_answer`.

Flag + config:
- `_WEB_SEARCH_ENABLED = os.getenv("AI_ASSIST_WEB_SEARCH", "0") == "1"` (default off).
- Reuse `GCP_GEMINI_ASSIST_MODEL`. Grounding-with-Search is supported on 2.5-flash.
- Cost guard: only fires on the fallback path; the anonymous rate limiter already
  caps volume.

## Backend — `api.py`

- `AssistResponse`: `source_tier` now includes `"web"`; add
  `search_suggestions_html: str = ""`. Map it from the handle_turn result.
- `handle_turn`/`_answer_shape`: thread `search_suggestions_html` through the
  answer branch result.
- `_save_assist`: already logs `route` + `source_tier`; a `"web"` tier is logged
  for analytics (how often the long-tail tier fires).

## Frontend — `AiAssist.tsx`

- `AssistResponse` type: add `search_suggestions_html: string`.
- `renderAi`, for `source_tier === "web"`:
  - a small label: **"From a live search of official sources"**;
  - the citations block already renders (title = domain, link = the Google
    redirect URI — clickable, required);
  - **render the Search-Suggestion chips**: `search_suggestions_html` via
    `dangerouslySetInnerHTML` inside a contained, styled box (Google-provided
    HTML; scope styles, no user input — compliance requirement).
- The inline disclaimer footer already applies. The "search further" buttons stay
  gated on `ungrounded`, so a `web` answer (cited) doesn't show them; optionally
  still offer "Search community forum".

## Tests

Offline (backend, monkeypatched genai):
- `_web_search_answer`: canned Gemini response with `grounding_metadata`
  (grounding_chunks + search_entry_point) → asserts `[cite:N]` stripped, citations
  mapped (redirect uri + domain title), `search_suggestions_html` captured,
  `source_tier == "web"`; a no-grounding response → `None` (miss).
- `answer_cascade` with the flag ON: gov miss + community miss → `web` tier;
  flag OFF → `ungrounded` (unchanged). Web tier position (after community).
- `handle_turn` / `AssistResponse` carry `search_suggestions_html`.

Frontend (Vitest): AiAssist with a `web`-tier response renders the label, the
citations, and the Search-Suggestion chips (assert the container is present).

Live (manual, not in the gate): `scripts/spike_web_search_grounding.py` already
exercises the live call; add a light check to `test_assist_e2e.py`.

## Compliance & risks

- **Google display terms (required):** render the Search-Suggestion chips and use
  the provided redirect citation URIs — do not rewrite them to raw uscis.gov.
- **Soft site restriction:** the prompt prefers but can't enforce gov sources; the
  citation title shows the real domain, so non-gov sources are visible/labellable.
  A config toggle can hard-drop non-gov citations.
- **XSS:** `rendered_content` is Google-authored HTML; render it in a scoped
  container, never mix with user input.
- **Cost:** priced per grounded request → keep the flag + the fallback-only
  position + the existing rate limits.
- **Legal:** sanctioned API + public-domain gov content; not scraping.

## Phased build sequence

1. `_web_search_answer` + `[cite]` cleaning + citation/chip mapping (offline-tested
   with a canned response).
2. Wire into `answer_cascade` behind `AI_ASSIST_WEB_SEARCH` (default off); cascade
   tests.
3. `AssistResponse.search_suggestions_html` + `source_tier="web"`; `_save_assist`.
4. `AiAssist.tsx`: web-tier label + citations + the Search-Suggestion chips;
   frontend test.
5. Live smoke via the spike script + a `test_assist_e2e` check.
6. Enable in dev/preview (`AI_ASSIST_WEB_SEARCH=1`), validate quality + cost, then
   flip in prod via the runbook.

## Follow-ups / not now

- **Option A** (Custom Search restricted to `site:uscis.gov`) remains the upgrade
  for *strict* source fidelity + raw citations (see the eval doc).
- Consider a per-answer "source strictness" that hard-filters to gov domains.
