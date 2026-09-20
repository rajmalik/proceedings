# AI Assist (v8) — Implementation Plan

Companion to [`ai-assist-specs-8.md`](./ai-assist-specs-8.md). **§5 of the spec is the frozen
build contract**; this document maps it onto real files, functions, and a phased build order. All
file:line anchors below were verified against the current tree (`feature/ai-assist`).

> No code has been written yet. This is the plan of record for the build.

---

## 0. Architecture in one line

One new backend module **`backend/assist.py`** + one new route **`POST /api/assist`**, using the
codebase's existing **JSON-structured-output Gemini idiom** (the `posting.py:784-814` `_extract`
template — `genai_client()`, `response_mime_type="application/json"`, `_retry`, `json.loads`), **not**
the SDK's native tool objects. The router returns one typed decision; `assist.py` then calls the *real*
functions in-process (`search_client.answer_query`, `posting.suggest_tags`, `matching.search_groups`,
`profile.scrub_pii`, `query.generate_direct_answer`) — never via a self-referential HTTP call. Lowest
risk, no new infra, matches every existing module's shape (§3 "Best" verdict).

### Key design choices (confirmed against the code)
- **Single router call does double duty.** The JSON schema always returns best-effort
  `post_title`/`post_summary` and `timeline_*` fields regardless of which intent wins — so the A5
  override ("Post this instead" / "Find your group") is *free* (re-interpret fields already returned,
  no re-classification) and we save a second Gemini round-trip.
- **One unified fallback.** Router hard-failure **and** post-3-clarify exhaustion both resolve to the
  *labelled ungrounded answer* (`query.generate_direct_answer`, captioned "general information — not
  from our sources, not legal advice"). Unifies §5.4/Q17 with the A4 gap into one code path.
- **Clarify count derives from `history`, not server state** (§5.6/G1). Each `ai` turn the client
  echoes back carries the `intent` we returned; `assist.py` counts the trailing run of `"clarify"`
  intents to know it's round 1/2/3.
- **No new backend auth gating.** `/api/postings` uses only `_optional_user` (`api.py:1041`); the real
  "must log in to post" rule lives in the frontend guard `useRequireUser()` (`/post/page.tsx:54`,
  `/find/page.tsx:194`, `/groups/[id]/page.tsx:173`). The `post`/`timeline-find` branches just hand off
  to pages that already gate themselves.

---

## 1. `POST /api/assist` — contract

**Request**
```
AssistTurn   { role: "user"|"ai"; content: str; intent: str = "" }
AssistRequest{ message: str (1..2000); history: AssistTurn[] = []  # capped to last 8 server-side
               session_id: str = "";  force_intent: "" | "post" | "timeline-find" = "" }
```

**Response**
```
AssistResponse{
  intent: str                 # answer-gov|answer-community|post|timeline-find|clarify  (plain str = extensible, Q6)
  confidence: float
  answer: str
  source_tier: "gov"|"community"|"ungrounded"|""
  citations: Citation[]       # {source, title, as_of}
  community_cards: CommunityCard[]   # {case_id, title, snippet, url, channel} — url = external permalink or /case/{id}
  clarify_questions: str[]    # ≤3
  post_draft: PostDraft|null  # {title, description, groups: TagGroups, key_stages_or_info, key_dates}
  timeline: TimelineHandoff|null  # {status: found|not_found|unresolved, group_id, group_name, criteria: Criteria}
  disclaimer: str
  can_post: bool;  can_find_timeline: bool
  qa_id: str;  turns_used: int;  rationale: str  # one-sentence "why I routed you here" (A5)
}
```
Reuse existing models: **`TagGroups`** (`api.py:165-171`) and **`Criteria`** (`api.py:490-499`).
`intent` is a `str`, not an `Enum`, so `ask-attorney` is a later prompt+branch change, no schema break.

**Router JSON schema** (what Gemini returns):
`intent, confidence, rationale, rewritten_question (PII-free), clarify_questions[], post_title,
post_summary, timeline_processing_type, timeline_eligibility, timeline_filing_month,
timeline_filing_year`.

---

## 2. Tool-wiring (router intent → existing function)

| Intent | Calls | New param |
|---|---|---|
| `answer-gov` | `search_client.answer_query(q, …, filter_expr='doc_kind: ANY("gov_news","official_reference")')` | **+`filter_expr`** on `answer_query` (`search_client.py:169`) |
| ↳ miss → `answer-community` | `answer_query(q, …, filter_expr='(NOT doc_kind: ANY("gov_news","official_reference"))')` | same (negation syntax per `api.py:1705`) |
| ↳ miss → ungrounded | `query.generate_direct_answer(q)` + label | reword label wrapper only |
| `post` | `profile.scrub_pii` (pre-Gemini, C3) → `posting.suggest_tags(title, summary)` → `scrub_pii` again (pre-draft, C3) | none |
| `timeline-find` | `assist.resolve_timeline_criteria` (uses `posting.timeline_scope_rows`) → `matching.search_groups(db, criteria,"timeline","balanced",0)` → if empty `matching.preview_timeline_group` | none (in-process) |
| `clarify` | router's own `clarify_questions` | none |
| profile reconcile | **not called from assist** — stays on `/post` via `reconcile.reconcile_profile_message` (§5.5) | none |
| analytics | `query.save_qa_pair(q, result, db, route=…, source_tier=…)` | **+`route`, `source_tier`** kwargs (`query.py:132`) |
| anon rate limit | new `check_assist_anon_limit(key)` (sibling to `check_rate_limit` `api.py:131-139`) | new fn + dict/consts |

---

## 3. File-by-file change list

### Backend
- **`backend/search_client.py`** (modify)
  - `answer_query(…)` `:169` → add `filter_expr: str = ""`; after `:182` set `if filter_expr: search_params.filter = filter_expr`.
  - `_reference_to_chunk` `:123-166` → add `"as_of": str(meta.get("posting_date") or "")` to all three return branches (B3).
  - `FALLBACK_MESSAGE` `:55` → reword off "contact the firm directly" (B2). *(This is the live copy.)*
- **`backend/query.py`** (modify)
  - `FALLBACK_MESSAGE` `:25` → reword identically (currently a dead duplicate — fix in the **same commit**).
  - `save_qa_pair(…, route="", source_tier="")` `:132` → write both into the Firestore doc (`:136-144`); defaults keep `/api/ask`'s call byte-compatible.
- **`backend/api.py`** (modify)
  - `SourceInfo` `:292-298` → add `as_of: str = ""`.
  - Add the new Pydantic models (§1) after `ChatResponse` (`:730`).
  - Add `_assist_anon_rate` dict + `ASSIST_ANON_MAX` (env `AI_ASSIST_ANON_LIMIT`, default 5) / `ASSIST_ANON_WINDOW` (env `AI_ASSIST_ANON_WINDOW_SECONDS`, default 3600) + `check_assist_anon_limit(key)` mirroring `:131-139`.
  - Add `_save_assist(question, result, route, source_tier)` sibling to `_save` (`:751-758`).
  - Add route `POST /api/assist` near `/api/chat` (`:1513`): `uid=_optional_user(request)`; **anon rate-limit key = `session_id` (primary) + client IP (secondary)** — anonymous→`check_assist_anon_limit`, authenticated→`check_rate_limit` (per Q7: IP alone is unreliable behind the BFF); `import assist` locally → `assist.handle_turn(...)`; `_guard(...)` wrap; `_save_assist(...)`; map dict→`AssistResponse`.
- **`backend/assist.py`** (new) — reads its model from a **new dedicated env var `GCP_GEMINI_ASSIST_MODEL`** (default = the current-generation Flash; exact GA id probe-verified in `us-central1` in Phase 2 — see §7/Q11), so this feature isn't on the sunsetting `gemini-2.5-flash` and doesn't disturb tagging/moderation/profile. `ASSIST_SYSTEM_PROMPT` (5-way taxonomy verbatim from §5.1 + timeline-pre-empts-post + ≤3-clarify targeting current/intended status or process + the legal-advice guardrail sentence reused from `query.py:46-47`); `INTENTS` tuple; `route_turn(message, history)->dict`; `_trailing_clarify_streak(history)->int`; `handle_turn(message, history, *, force_intent, project_id, ds_location, engine_id, db)->dict` (returns a plain dict — zero FastAPI import, same layering as `reconcile.py`); `_gov_answer`/`_community_answer`/`_ungrounded_answer`; `_post_draft`; `resolve_timeline_criteria`; `_timeline_handoff`; `DISCLAIMER_TEXT`/`disclaimer_for(source_tier)`.
- **`posting.py` / `matching.py` / `profile.py` / `reconcile.py`** — **no signature changes** (reused as-is).

### Frontend
- **`website/src/app/api/assist/route.ts`** (new) — JSON forward to `${apiBase()}/api/assist`, forwarding `X-User-Id`/`Authorization` (template: `app/api/profile/route.ts:6-9`) so the rate-limit tier is chosen correctly.
- **`website/src/lib/assistSession.ts`** (new) — `getAssistSessionId()` = `crypto.randomUUID()` in `localStorage` (soft key only).
- **`website/src/components/AiAssist.tsx`** (new) — the unified conversational surface (F1): chat turns, `AssistResponse` rendering (answer/citations/community cards/clarify), the two override buttons (`force_intent:"post"` / `force_intent:"timeline-find"`, latter only when `can_find_timeline`), inline `<DisclaimerBanner text={disclaimer}/>` under every AI turn. On `post` → write sessionStorage draft + `router.push('/post')`. On `timeline-find` `found` → `Link` to `/groups/{group_id}`; `not_found`/`unresolved` → `Link` to `/find`.
- **New flag** `AI_ASSIST_ENABLED = process.env.NEXT_PUBLIC_AI_ASSIST_ENABLED === '1'` — a **different** constant from `UnifiedSearch.tsx:35` `AI_MODE_ENABLED` (which stays `false`, Q5). Add matching `ENV NEXT_PUBLIC_AI_ASSIST_ENABLED` to the website Dockerfile build stage (NEXT_PUBLIC_* is inlined at **build** time — the exact class of bug `build-config.test.ts` already guards).
- **`website/src/components/UnifiedSearch.tsx`** (modify) — mount `<AiAssist/>` in the right column as a sibling to the untouched `{AI_MODE_ENABLED && …}` block (`:458-508`); extend the grid-cols ternary at `:353` to open the 3rd column when `AI_ASSIST_ENABLED`.
- **`website/src/app/post/page.tsx`** (modify) — sessionStorage draft contract:
  - key `"aiAssist.postDraft.v1"`, shape `{title, description, groups: Groups, key_stages_or_info, key_dates, source:"ai-assist", createdAt}`.
  - Extract the reconcile-and-apply half of `preview()` (`:127-153`) into `applyTagResult(...)`; add a **mount `useEffect`** that reads the key once, applies it through the **same `/api/reconcile` conflict check** (D1/D3), then `sessionStorage.removeItem(key)`; falls back to empty form when absent.
  - Add a small "Not sure how to phrase this? Ask AI" link near the compose header (`:270-273`) → `/` (where `AiAssist` lives) — the §1 "Post a Message" integration touchpoint.
- **`DisclaimerBanner.tsx`** (modify) — add `text?: string` + `className?: string` props (defaulting to current copy/classes); `AiAssist` passes the per-turn server disclaimer + a compact inline style.
- **`app/find/page.tsx`, `app/groups/[id]/page.tsx`** — **no changes** (deep-links + `?next=` login round-trip already work; `/find` query-param pre-fill is deferred, Q12).

---

## 4. Phased build sequence

1. **Backend primitives** — `answer_query(filter_expr)`, `_reference_to_chunk` `as_of`, `FALLBACK_MESSAGE` reword (both files), `save_qa_pair(route, source_tier)`, `SourceInfo.as_of`. `/api/ask`/`/api/chat` keep working unchanged (defaults).
2. **Router core** — `assist.py` prompt + `route_turn` + `_trailing_clarify_streak` (offline-testable with monkeypatched `genai_client()`). **First: probe Vertex in `us-central1` for the current-gen Flash GA model id and set the `GCP_GEMINI_ASSIST_MODEL` default (Q11).**
3. **Answer path** — cascade + citations + community-card link resolution.
4. **Post handoff** — `_post_draft`, sessionStorage contract, `/post` mount-effect + `applyTagResult` refactor.
5. **Timeline/find handoff** — `resolve_timeline_criteria`, `_timeline_handoff`, deep-links in `AiAssist`.
6. **`POST /api/assist` wiring** — models, route, `_save_assist`, anon limiter, Next proxy.
7. **Frontend surface** — `AiAssist.tsx`, flag (+ Dockerfile ENV), `UnifiedSearch` mount, `/post` entry link, `DisclaimerBanner` props.
8. **Guardrails/analytics hardening** — sign-in nudge after anon cap, `route`/`source_tier` verified in Firestore, A5 overrides exercised on every branch.
9. **Tests + §5.9 verification pass.**

---

## 5. Test plan

**Offline unit — `backend/tests/test_assist.py`** (style of `test_reconcile.py`, run `.venv/bin/python tests/test_assist.py`)
- `_trailing_clarify_streak` on 0/1/2/3 consecutive clarify histories.
- `handle_turn` with **monkeypatched `route_turn`** (no live Gemini) for all 5 intents + forced-fallback-after-3 + router-exception → both land on labelled ungrounded answer.
- `resolve_timeline_criteria` vs fixed `timeline_scope_rows` fixtures (EAD `stem-opt-extension` → correct `key`/`field`).
- community card link logic: external `source` URL → that URL; bare `case_id` → `/case/{id}`.
- `save_qa_pair(route, source_tier)` writes both keys (in-memory Firestore double).
- `check_assist_anon_limit` — 5 allowed then blocked, window rollover.

**Live/integration — `backend/tests/test_assist_e2e.py`** (style of `test_grounding_e2e.py`, live ADC + cleanup)
- **§5.9**: `answer_query(filter_expr=…)` on the live **Answer** API returns only gov docs for the gov branch and excludes them for community (the unverified assumption).
- **§5.9**: ≥1 live community doc has a resolvable `source`.
- `matching.search_groups("timeline")` exact-match round-trip against a synthetic timeline group (create+clean up).
- `POST /api/assist` via `TestClient` per intent with stubbed Gemini responses (deterministic, cheap).

**Frontend — `website/src/__tests__/`** (vitest)
- build-config-style test asserting `NEXT_PUBLIC_AI_ASSIST_ENABLED` is in the Dockerfile build stage (can't silently drop from prod).
- sessionStorage draft contract test: write shape → mount `/post` → fields populated + key cleared.

---

## 6. Risks & open verification items (§5.9 + architect findings)

- **[GATE, Phase 3]** `answer_query` + `doc_kind` filter on the **Answer** API is unverified — only the **Search** API path has confirmed live `doc_kind` usage. Smoke-test against live Discovery Engine before shipping the cascade.
- **[Phase 3]** Community source-link resolvability is confirmed *in code* (`_reference_to_chunk` source fallback) but spot-check the **live** corpus (a doc with no external URL and no working `/case/{id}` would break "must link back").
- **[Phase 4]** `/post` mount-time read is genuinely new; the `applyTagResult` refactor must not regress `preview()` — needs its own new frontend test (the suite is currently thin).
- **`FALLBACK_MESSAGE` is duplicated** (`query.py:25` + `search_client.py:55`) with no shared import — reword **both** in one commit or the stale one reintroduces the bug.
- **IP attribution behind the Next BFF is unreliable** — `request.client.host` sees the frontend's IP if web/backend are separate Cloud Run services (a pre-existing `check_rate_limit` limitation). **Key the anon limiter primarily on `session_id`**, IP as secondary defense-in-depth. Decide/confirm in Phase 6.
- **E2 guardrail on `rationale`** — the shown "why I routed you here" sentence is a *new* surface `query.py`'s prompt doesn't cover; it must never read as an eligibility/case assessment. Add an explicit `ASSIST_SYSTEM_PROMPT` line + a keyword unit check (mirroring `moderation.check_text`).
- **Cost (G2)** — speculatively filling `post_title`/`timeline_*` on every turn is cheap but nonzero; keep as a tuning knob if `flash-lite` latency/cost shows up in analytics.
- **Anonymous-posting invariant** — the only thing between an anon "Post this" click and a publish is `/post`'s `useRequireUser()` (since `/api/postings` isn't server-gated). Add a one-line regression test pinning that intent, or decide to server-gate `/api/postings` during this build.

---

## 7. Engineering decisions (plan grilling, 2026-09-19)

The plan-level grilling settled every implementation fork below. Where these refine the earlier
sections, **§7 wins**.

| # | Decision | Choice |
|---|---|---|
| Q1 | Router mechanism | Repo's **JSON structured-output** idiom (`posting._extract` template) — not native function-calling. |
| Q2/Q11 | Router model | **New dedicated `GCP_GEMINI_ASSIST_MODEL`**. **Probe result (2026-09-19, `proceedings-490601`/`us-central1`): only `gemini-2.5-flash` and `gemini-2.5-flash-lite` are available — all Gemini-3 Flash ids and `-latest` aliases 404.** So the default ships as **`gemini-2.5-flash`** (best current-gen Flash available here); the dedicated var makes the eventual bump to `gemini-3-flash` a **one-line env flip, zero code**, once it's GA in the region. **Plus** a tracked **follow-up**: repo-wide `gemini-2.5-flash → newer` migration (the shared `GCP_GEMINI_MODEL` default, the `query.py:60` stray literal, `.env.example`) with its own regression pass on tagging/moderation/profile — this feature does **not** change those subsystems' model. |
| Q3 | Tier-miss signal | Reuse `answer_query`'s **`is_fallback` + empty grounded citations**; router picks the starting tier, cascade fires only on a real miss. |
| Q4 | Community tier | **`answer_query` filtered to community `doc_kind`s** — answer = summary, reference chunks = the linked cards. Labelled "community experiences." |
| Q5 | Surface placement | **Home (`/`) `UnifiedSearch` right-column panel** (`AiAssist.tsx`) + an "Ask AI" link from `/post`. (Spec §1's literal "on /post" was considered and declined for v1.) |
| Q6 | PII scrub scope | **`profile.scrub_pii` as-is** (email/phone/A-number) before Gemini + before the draft. Broader PII detection (names/employers/addresses) is a separate hardening task, noted not done. |
| Q7 | Anon rate-limit key | **`session_id` primary + client IP secondary** (IP alone unreliable behind the BFF). Soft cost-nudge, not a security control. |
| Q8 | Streaming | **Non-streaming** for v1 (whole `AssistResponse`), matching `/api/expert`. |
| Q9 | Chat persistence | **Ephemeral** — chat state is client-only, lost on navigation/reload; only the sessionStorage draft carries forward. |
| Q10 | Flag rollout | `NEXT_PUBLIC_AI_ASSIST_ENABLED` **off in prod**, verify on a tagged/canary revision, flip via `WEBSITE-DEPLOYMENT.md` after smoke. |
| Q12 | Community-card render | **Reuse the existing search-result card** component, styled for the narrower chat column. |
| Q13 | Gov citation UX | Compact **"Sources" block** under the answer — title + link + **"as of" date** per source. |
| Q14 | Clarify UX | **Plain-text** questions answered in the normal chat input (no chips/mini-form in v1). |
| Q15 | Anon-cap nudge | **Inline chat message** with a login link using the existing `?next=` round-trip (no modal/redirect). |

**Two tracked follow-ups spun out of this grilling** (out of scope for the v8 build): the repo-wide
model migration (Q2/Q11) and broader PII detection for the assist path (Q6).
