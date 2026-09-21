# Enable AI Assist feature

**Status:** The feature for "AI Assist" which acts as a chat to Gemini model which acts as conversational AI related to immigration question is currently disabled. This requirement is to enable it in user-friendly fasion in website


## 1. Integration
- The feature to integrate "AI Assist" has to be integrated with "Post a Message" screen where user has the ability to post a new message in the forum.
- The interface whether user wants to post a message or ask AI or ask an attorney (in future release) will remain same determine by an AI Agent to route appropriately


The message the user enters in a conversation AI should be interpreter in a smart way so that the Agent in backend of that COnversational AI can route as one of following:
1) If the conversation is quite generic and user is asking for generic information related to US Visa or Immigration related question then the Agent can treat as LLM agent and answer from the grounded government authentic sources 
2) If the conversation / question is not generic and/or user intends to post a message and ask the community of this platform then the backend agent should 
- validate the payload / background / intent of user 
- validate the there is no ambiguity in user's payload / background / intent / question
- Ask back and clear if any ambiguity found
- Direct the user to existing `/post` page which the conversation summarized and pre-filled on the left panel and tage evalued on right panel based upon the information entered
3) Determine if the conversation / question is regarding general information or not. If it can be answered from govt  authoritative websites then answer from there. If it can be searched from community grounded posts (ingested already in Vertex AI datstore) then answer from there.  If it a user's case specific then it should be routed to /post. Also, if the post is related to timeline of EAD or H-1B processing then it should be routed to https://www.meridianjourney.ai/find page and user should be asked to find relevant group related to that timeline and post a message there for that group or create a group, if that group does not exist
5) For any message that the user intends to post to community forum validate that the user's profile is up-to-date with latest updates in his immigration  journey and ask user to review, validate and allow to update (if required). There should already be a rule at the time of post a message that if there is a dicrepancy found in the question and the profile then user is asked if the profile can be updated. Verify  that this is in place and incorporated when user is posting a message
6) For any AI assitance by Gemini show a legal disclaimer that this is not a legal advise


---

## 2. Gaps, open questions & edge-case scenarios (review 2026-09-19)

> Reviewer notes for build-readiness. The spec above is a good north star but underspecified.
> **Code baseline:** the AI chat is already built and only disabled by two client flags
> (`website/src/components/UnifiedSearch.tsx:35` `AI_MODE_ENABLED=false`,
> `mobile/src/navigation/MainNavigator.tsx:183` `AI_CHAT_ENABLED=false`). Backend is live:
> `/api/ask` (grounded RAG), `/api/expert` (ungrounded Gemini + follow-ups), `/api/chat`
> (`query.py classify_intent` → search **or** answer). Guardrails exist (`query.py` legal-advice
> prompt + `FALLBACK_MESSAGE`; web disclaimer; mobile AI-consent gate).

### A. Routing taxonomy & the "backend agent"
- **A1 — Taxonomy mismatch.** Today's router (`classify_intent`) only decides **search vs ask**. The
  spec needs a **3–4-way** decision: *answer-with-AI* / *post-to-forum* / *(future) ask-attorney* /
  *clarify*. This is new routing logic, not the current classifier.
- **A2 — "Ambiguity" is undefined.** What makes a payload ambiguous (missing visa type? dates?
  country? consulate?) and how many clarify rounds before we give up / default?
- **A3 — Mixed / shifting intent.** A chat can start generic then become "post this," or an answer may
  itself suggest posting. Is routing per-message or per-conversation? Define re-evaluation + the
  answer→post handoff.
- **A4 — Low-confidence default.** If the router can't classify, what happens (answer? ask the user to
  pick?). `classify_intent` has a heuristic fallback — define the equivalent here.
- **A5 — Explicit override.** The single input is "AI-routed," so the user can't pre-pick a mode.
  Define how the decision is shown and how the user overrides ("Post this instead" / "Just answer").

### B. Grounded-answer path (spec item 1)
- **B1 — "Government authentic sources" ≠ current grounding.** `/api/ask` grounds on the *whole* DS-1
  datastore — which includes **Reddit/community + app postings**, not just gov. To honor the spec, the
  AI-Assist answer path must **filter to `doc_kind ∈ {gov_news, official_reference}`** (and/or the DS-2
  public-reference tier) — a new filtered answer mode.
- **B2 — No-grounding fallback.** If a generic question isn't grounded, do we fall back to ungrounded
  Gemini (`/api/expert`) or refuse? Also: the current `FALLBACK_MESSAGE` ("contact the firm directly")
  is **wrong for this self-service product** — reword.
- **B3 — Citation/freshness.** Answers should cite the gov/official source + "as of" date (esp. now
  that `official_reference` docs carry as-of dates). Define citation UX.

### C. Post-intent → /post handoff (spec item 2)
- **C1 — Chat→posting-fields transform undefined.** How does free-form chat map to the `/post`
  composer's structured fields (title, description, the 5 tag buckets)? Reuse `posting.suggest_tags`
  for tags + a summarizer for title/description; specify the mapping.
- **C2 — Handoff mechanism.** How is the summarized draft carried into `/post` (query param? a draft
  store? a new draft API)? `/post` starts empty today — define the pre-fill contract.
- **C3 — PII in transcript.** The chat goes to Gemini and may contain PII; posting scrubs at publish
  (`scrub_pii`), but define whether the transcript/summary is scrubbed *before* Gemini and *before*
  pre-filling `/post`.

### D. Profile freshness & reconciliation (spec item 3)
- **D1 — The rule EXISTS; verify the wiring.** `reconcile.py reconcile_profile_message()` already
  returns `conflicts` (profile↔message disagreements, each "with an offer to update the profile") +
  `prefilled`, via `/api/reconcile`. The *logic* is there — **confirm it's actually surfaced in the
  `/post` flow UI** (the offer-to-update step), which is what "verify this is in place" means.
- **D2 — "Up-to-date" undefined.** How do we decide a profile is stale (last-updated age? a diff vs the
  new message via `reconcile`)? Define the trigger.
- **D3 — Where it runs.** Does AI-Assist reconcile *during the chat* or only on `/post`? Avoid asking
  twice.

### E. Disclaimer & legal boundary (spec item 4)
- **E1 — Timing/placement.** Per-message, per-session, or one-time ack? Web already has an inline
  disclaimer (`UnifiedSearch.tsx:504`) + `/disclaimer`; mobile has an AI-consent gate. Pin the web rule.
- **E2 — Legal-advice line.** The router's own nudges ("you should post / update your profile") edge
  toward procedural guidance. Confirm the clarifying questions + routing rationale never assess
  eligibility or give case-specific advice (the `query.py` prompt already forbids this).

### F. UX, placement & platform
- **F1 — Placement conflict (biggest decision).** The spec says integrate into the **"Post a Message"
  screen**, but the existing AI panel lives in `UnifiedSearch` on **Home (`/`)** and `/post` is a
  separate composer. Decide: is AI-Assist the Home panel (flip `AI_MODE_ENABLED`), a new conversational
  surface *on* `/post`, or a unified entry that can end in either? This changes the whole build.
- **F2 — Scope: web only?** Spec says "in website"; mobile has its own flag. Confirm mobile is out of
  scope for v8 (or note the parallel flip).
- **F3 — Auth gating.** Does asking AI require login? Posting does (token-only prod). Define whether
  anonymous users can use AI-Assist.

### G. Non-functional
- **G1 — Session/state.** A clarify-looping agent needs conversation state; today's endpoints are
  stateless (history passed in the request). Define where multi-turn state lives.
- **G2 — Cost & rate limits.** Multi-turn Gemini + routing multiplies calls; define per-user quotas
  (only a basic IP limiter exists today).
- **G3 — Analytics.** How are routing decisions + answer quality logged for evaluation?

---

## 3. GCP routing-agent evaluation

**What the "routing agent" actually is:** a per-turn intent router + light orchestrator that (a)
classifies intent (answer-AI / post / clarify / future-attorney), (b) for answers calls grounded
retrieval, (c) for posts runs the ambiguity/clarify loop + tag/summarize + profile reconcile, (d)
always attaches the disclaimer. I.e. **classification + tool-calling over a short multi-turn state**,
in a domain with hard legal guardrails.

**Fit vs. the existing stack** (FastAPI on Cloud Run · Gemini via `genai_client()` · grounding on
Vertex AI Search · `suggest_tags`/`reconcile_profile_message` already Python functions):

| Option | What it is | Fit here | Verdict |
|---|---|---|---|
| **Gemini function-calling / controlled (structured) output — inside the existing FastAPI service** | One Gemini call returns a typed decision (intent + tool + args) via function-calling or a JSON schema; your code runs the tool. Extends today's `classify_intent`. | **Best** — reuses every existing Python capability as a tool, **no new infra**, cheapest, keeps the legal guardrails in your own prompt/code, ships on the current Cloud Run service. | ✅ **Recommended for v8** |
| **Vertex AI Agent Engine (managed agent runtime) + ADK (Agent Development Kit)** | Google's managed runtime for a stateful, multi-tool agent (ADK/LangGraph) — sessions, tracing, orchestration. | **Upgrade path** — worth it only if the clarify-loop/orchestration/memory outgrows a simple router. Adds a new deployable + infra + cost; grounding still via Vertex AI Search. | ⏭️ **Later, if it grows** |
| **Dialogflow CX** | Enterprise conversational agent built on scripted flows/pages/intents (+ an LLM add-on). | **Mismatch** — built for guided scripted flows; this router is LLM-reasoning-first over your own tools/guardrails. Rigid, duplicates logic, harder legal control. | ❌ **Not recommended** |
| **Vertex AI Search (Discovery Engine)** | The grounding/answer engine you already run. | Not the router — it's the **tool** the router calls for the grounded-answer branch (filtered to gov/official per B1). | ✅ keep as the answer tool |

**Recommendation:** build the router as **Gemini function-calling / structured-output inside the
existing FastAPI/Cloud Run backend**, exposing current capabilities (grounded search, `suggest_tags`,
`reconcile_profile_message`, a draft-summarizer) as callable tools, with the disclaimer/guardrails
enforced in your own prompt + code. Reserve **Vertex AI Agent Engine + ADK** as the migration target
if/when the agent needs durable sessions, many tools, or multi-step planning. Avoid **Dialogflow CX**
for this LLM-reasoning-first, guardrail-heavy router.


---

## 4. Resolved requirements (decisions 2026-09-19)

Answers to the §2 gaps, from product review — settled for the v8 build.

### Placement & UX
- **[F1] Surface:** a **single unified conversational entry** — the same input routes to an AI answer
  **or** into a pre-filled `/post` (per §1). Not just the Home side-panel.
- **[A5] Routing control:** the agent **routes automatically but shows what it's doing and offers a
  one-tap override** ("Post this instead" / "Just answer").
- **[F2] Scope:** **web only** for v8; mobile (`AI_CHAT_ENABLED`) is a follow-up.
- **[F3] Auth:** **anonymous users can use the AI answer path**; **login is required only to post**
  (and to reconcile/update the profile).

### Answer path (generic questions)
- **[B1] Sources:** ground on **gov/official first** — `doc_kind ∈ {gov_news, official_reference}`
  (+ the DS-2 public-reference tier); if nothing grounds there, fall back to **community postings,
  clearly labeled as user experiences** (not authoritative).
- **[B2] No grounding at all:** answer with **ungrounded Gemini** (the `/api/expert` path) **clearly
  labeled "general information — not from our sources, not legal advice."** Reword `FALLBACK_MESSAGE`
  (the current "contact the firm directly" text is wrong for this self-service product).
- **[B3] Citation:** grounded answers cite the gov/official source + its "as of" date.

### Post path (post-intent)
- **[A2] Clarify loop:** ask **up to 3 targeted clarifying questions**; the essentials to establish are
  the user's **current immigration status, intended status, or process/stage** — if those aren't
  clear, the questions target them. Then proceed with a **best-effort draft** (composer + reconcile
  cover the rest).
- **[C1/C2] Handoff:** on post-intent, open **`/post` pre-filled** — conversation **summary → left
  panel** (title/description), **tags → right panel** (reuse `posting.suggest_tags`). User
  reviews/edits/submits.
- **[C3] PII:** **scrub PII (reuse `scrub_pii`) before sending the transcript to Gemini AND before
  pre-filling `/post`** (in addition to the existing scrub at publish time).

### Profile step
- **[D1/D3] When:** the profile↔message reconcile (**conflicts → "update your profile?"**) stays on
  **`/post`** via the existing `reconcile.py` step — not duplicated in chat. (Confirm it's surfaced in
  the `/post` UI, then done.) AI-Assist just enforces login before reaching this.

### Legal & non-functional
- **[E1] Disclaimer:** show the **"not legal advice" disclaimer on every AI answer, inline** (the built
  panel already does this).
- **[E2] Advice boundary:** the router/clarifier must **never assess eligibility or give case-specific
  advice** (the `query.py` prompt already forbids this — keep it).
- **[G2] Rate/cost:** **cap anonymous AI at N questions per session/IP, then nudge sign-in** (N TBD,
  ~5); authenticated users get the standard limit.
- **[G1] State:** the clarify loop needs short multi-turn state — carry conversation `history` per
  request (as `/api/expert` already supports); a durable session store is only needed if we later move
  to Agent Engine (§3).

### Architecture
Per §3: build the router as **Gemini function-calling / structured-output in the existing
FastAPI/Cloud Run backend**, with tools = gov-filtered grounded search · `suggest_tags` · `reconcile`
· summarize-draft; guardrails enforced in prompt + code.

**Still to pin during design (minor):** exact anonymous cap `N`; the draft-carry mechanism into `/post`
(session/localStorage vs a draft API); citation rendering.

> The items above marked "TBD" / "still to pin" are all resolved in **§5** below, which is the
> definitive, build-ready contract (grilling outcome). Where §5 and §4 differ, **§5 wins**.


---

## 5. Build contract — grilling outcome (2026-09-19)

The frontier-exhausting requirements interview (three rounds) settled every branch below. This is the
authoritative spec for the v8 build; §2 is the gap audit, §3 the architecture rationale, §4 the earlier
product-review answers that §5 refines.

### 5.1 Router endpoint & taxonomy
- **[Q1] Dedicated endpoint `POST /api/assist`.** New route — do **not** overload `/api/ask` (grounded
  RAG) or `/api/chat` (`classify_intent`). It owns the routing + orchestration; it *calls* the existing
  capabilities as tools.
- **[Q2/A1] Five-way per-turn decision** (Gemini function-calling / structured output, §3):
  1. **`answer-gov`** — generic/general-information question → grounded answer over
     `doc_kind ∈ {gov_news, official_reference}` (+ DS-2 public-reference tier).
  2. **`answer-community`** — answerable from community experience → community-grounded response
     (see §5.2).
  3. **`post`** — user's *case-specific* message intended for the forum → `/post` handoff (§5.4).
  4. **`timeline-find`** — question about **EAD or H-1B *processing timeline*** → `/find` timeline-group
     flow (§5.3). This pre-empts `post` for timeline/processing-time questions on EAD/H-1B.
  5. **`clarify`** — insufficient signal → ask ≤3 targeted questions (§5.4), then re-route.
- **[Q6] Intent enum is extensible; no attorney stub.** Model the intents as an open enum so
  `ask-attorney` can be added later, but ship **no** attorney code path in v8.

### 5.2 Answer path
- **[Q10] Resolution cascade (gov-first):** `answer-gov` grounded → if not grounded, `answer-community`
  → if still nothing, **ungrounded Gemini** labelled **"general information — not from our sources, not
  legal advice."** (`/api/expert` path; reword `FALLBACK_MESSAGE`.)
- **[B1] Gov filter:** set `search_params.filter = 'doc_kind: ANY("gov_news","official_reference")'` on
  the `answer_query` call (~1-line add; no filter set today). **Never filter on `channel`** (400s).
- **[Q9] Community tier = short grounded summary + linked post cards.** A brief summary explicitly
  framed *"here's what community members have shared"* **plus the source postings as cards**, and
  **every card must link back to the original posting** (Reddit permalink / app-posting URL). Never
  phrased as authoritative guidance. *(Build check: confirm community docs carry a resolvable source
  link.)*
- **[B3] Citations:** grounded gov/official answers cite the source + its "as of" date.

### 5.3 Timeline → groups flow (`timeline-find`) — NEW
Facts (verified): `group_type="timeline"` groups already exist, keyed by **processing-type
(EAD/H-1B) + eligibility/application category + filing month/year** (`backend/config/
timeline_attributes.default.json`, `matching._timeline_group_name`); `POST /api/groups/search` and
`/api/groups/preview` are **public**; `/groups/{id}` deep-links work; `/find` has **no** criteria
query-params.
- **[Q13] Collect keying criteria first.** Use the ≤3 clarify budget to obtain **processing-type +
  eligibility/application category + filing month/year** (the exact-match keys). If unresolved after 3,
  fall back to routing the user to `/find` generically.
- **[Q12] Hand-off mechanism (v1, no new frontend):**
  1. Assistant calls the **public `POST /api/groups/search`** with `group_type:"timeline"` + inferred
     criteria.
  2. **Cohort exists →** hand a direct **`/groups/{group_id}`** link ("join & post here").
  3. **None exists →** send to **`/find` → Find/create tab** to create it (login required at that
     point; find-or-create dedups by generated timeline name).
  - Deferred nicety: query-param plumbing to pre-fill the `/find` panel (new frontend work — not v1).

### 5.4 Post handoff (`post`) & clarify loop
- **[A2/Q17] Clarify:** ask **≤3** targeted questions; essentials are **current status / intended
  status / process-stage**. **[Q17] If still unclassifiable after 3 → default to the labelled
  general-info answer** (least-harmful), with the override affordances visible — do **not** dead-end or
  force a post.
- **[C1] Transform:** conversation **summary → `/post` left panel** (title/description); **tags → right
  panel** via `posting.suggest_tags`.
- **[Q11/C2] Carry mechanism = client-side `sessionStorage` draft.** `/post` reads it on mount, then
  clears it; falls back to empty. (Not URL params, not a server draft doc.) *(New injection path —
  `/post` has no pre-fill today.)*
- **[C3] PII:** scrub via `scrub_pii` **before Gemini AND before writing the `/post` draft** (plus the
  existing publish-time scrub).

### 5.5 Profile reconcile
- **[Q3/D1/D3] Fires at the `/post` handoff only**, via the existing `reconcile.py` "update your
  profile?" step (already wired + rendered in `/post`, fires on Preview). Not duplicated in chat.
  AI-Assist enforces login before this point.

### 5.6 Routing granularity, overrides & state
- **[Q16/A3] Per-message routing**, re-evaluated each turn using the **[Q8] capped recent conversation
  thread** as context. Not per-conversation lock-in.
- **[A5] Override always available**, and **[Q16] every AI answer surfaces explicit affordances**:
  *"Post this to the community"* (→ builds the §5.4 `sessionStorage` draft, opens `/post`) and, when the
  turn is timeline-relevant, *"Find your EAD/H-1B group"* (→ §5.3).
- **[G1] State:** carry `history` per request (as `/api/expert` already does); durable session store
  only if we later migrate to Agent Engine (§3).

### 5.7 Auth, rate limits, disclaimer, analytics
- **[F3] Auth:** anonymous can use the **answer** path; **login required to post, to create/join a
  group, and to reconcile the profile**.
- **[Q18/G2] Rate limit:** **server-side IP limiter** (reuse the `/api/groups` message limiter pattern)
  at **~5 AI questions per rolling window** for anonymous users, then a sign-in nudge. Tune `N` from the
  §5.7 analytics.
- **[Q14/E1] Disclaimer:** reuse the existing (currently unused) **`DisclaimerBanner.tsx`** with
  AI-answer-specific copy, rendered **inline on every AI answer**. **[E2]** never assess eligibility /
  give case-specific advice (keep the `query.py` guardrail prompt).
- **[Q15/G3] Analytics:** add a **`route`/`intent`** field to `query.save_qa_pair` (Firestore
  `qa_pairs`) — one of `answer-gov | answer-community | post | timeline-find | clarify` — plus which
  source tier answered. `is_fallback` already captures grounded outcome.
- **[Q5] Enablement:** ship behind a **new enable flag** (do not simply flip the old
  `AI_MODE_ENABLED`/`AI_CHAT_ENABLED`; those stay for the legacy panel). **[F2]** web only for v8;
  mobile is a follow-up.

### 5.8 Architecture (unchanged from §3)
Router = **Gemini function-calling / structured output inside the existing FastAPI/Cloud Run backend**,
tools = gov-filtered grounded search · community grounded search · `posting.suggest_tags` ·
`reconcile_profile_message` · draft-summarizer · **`groups/search` (timeline)**. Guardrails enforced in
prompt + code. Vertex AI Agent Engine + ADK is the later migration target only if orchestration/memory
outgrows this.

### 5.9 Build-time verification items (facts to confirm, not decisions)
- Community post docs expose a resolvable **source link** for the Q9 cards.
- `/post` mount-time read of the `sessionStorage` draft (new).
- `answer_query` accepts the `doc_kind` filter with the Answer API (search path already supports it).
