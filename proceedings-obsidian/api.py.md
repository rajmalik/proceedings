# api.py

**Type:** FastAPI HTTP server
**Location:** `backend/api.py`
**Grounding sink:** managed Vertex AI Search (Discovery Engine) datastore `imm-postings-datastore` via engine `imm-postings-search-app`
**Deployed:** Cloud Run — `gcloud run deploy immiguide-api --source backend --region us-central1`

---

## Purpose

The live HTTP API (title `meridianjourney.ai API`) for the website + mobile app. Exposes grounded Q&A, conversational chat, ranked posting search, posting/experience/connect-card publishing, user profiles + two-stage AI onboarding, replies/voting, groups + group chat, UGC moderation, email verification, and account deletion. Grounding is served by the managed Discovery Engine Search/Answer API (see [[search_client.py]]) — not the retired self-managed Vector Search index. Firestore + Vertex AI are initialized once at startup via the `lifespan` context manager.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ask` | Grounded RAG answer; saves the Q&A pair to Firestore |
| POST | `/api/expert` | Non-grounded "AI mode" answer from Gemini general knowledge (supports follow-up history) |
| POST | `/api/chat` | Conversational turn — routes to answer or search by classified intent + `strictness`/`facets` |
| GET | `/api/search` | Ranked posting cards; explicit `visa`/`consulate`/`outcome` + `facet` chips + `strictness` |
| POST | `/api/tag-suggest` | Auto-derive controlled-vocab tags from a composer draft (pure read) |
| GET | `/api/tag-vocab` | Controlled vocabularies for the composer autocomplete |
| POST | `/api/postings` | Publish a posting → GCS sidecar → `documents.import` → BigQuery; records author link |
| GET | `/api/postings/{case_id}` | Full posting detail (card + Markdown body + author link) |
| GET | `/api/postings/{case_id}/replies` | Flat replies + vote tallies (anonymous-safe) |
| POST | `/api/postings/{case_id}/replies` | Post a reply (active user) |
| DELETE | `/api/postings/{case_id}/replies/{reply_id}` | Soft-delete own reply |
| POST | `/api/votes` | Up/down/clear a vote on a posting or reply |
| GET | `/api/users` | Baked seed roster (dev user-picker) |
| POST | `/api/users` | Mint a dev `new-…` id, or register a Firebase uid (idempotent) |
| GET / PUT | `/api/profile` | Get / validate + save the active user's profile |
| DELETE | `/api/users/me` | Delete account + all associated data (profile, links, replies, groups, votes, Firebase Auth) |
| GET | `/api/users/{uid}/public-profile` | A posting author's PII-free profile |
| GET | `/api/users/{uid}/postings` | An author's app postings (from Firestore link) |
| GET | `/api/users/{uid}/replies` | An author's replies |
| GET | `/api/authors/by-handle/{handle}/postings` | Postings by synthetic author handle |
| POST | `/api/onboard` | One AI-onboarding turn (`stage` = basics / experiences) |
| POST | `/api/reconcile` | Merge saved profile with an in-progress message → merged/conflicts/explainer |
| POST | `/api/connect-card` | Publish a "looking to connect" card from the profile |
| POST | `/api/auth/send-code` | Email a 6-digit verification code (Resend; 10-min TTL) |
| POST | `/api/auth/verify-code` | Verify the code (max 5 attempts) |
| GET | `/api/auth/check-verified/{email}` | Whether an email is verified |
| GET | `/api/qa` | Recent Q&A pairs (optional category filter) |
| POST | `/api/qa/{doc_id}/feedback` | Helpful / not-helpful feedback |
| GET | `/api/qa/stats` | Q&A quality stats (fallback rate, top categories, knowledge gaps) |
| POST | `/api/reports` | Report objectionable content (auto-hide at threshold) |
| POST / DELETE / GET | `/api/blocks` | Block / unblock / list blocked users |
| POST | `/api/admin/takedown` | Admin takedown + optional author eject (`X-Admin-Token` gated) |
| POST | `/api/find/chat` | Expert-chat turn capturing match criteria |
| POST | `/api/find/matches` | Rank other users by criteria similarity |
| POST / GET | `/api/groups`, `/api/groups/all` | Create-or-join / list my / browse all groups |
| POST | `/api/groups/{group_id}/join` | Join a group directly |
| GET | `/api/groups/{group_id}` | One group (name, members, is_member) |
| GET / POST / DELETE | `/api/groups/{group_id}/messages[/{id}]` | Polled group chat (members-only) |
| GET | `/api/health` | Health; `chunks_loaded` = 1 when a grounding engine is configured |

---

## Key Details

- **Startup singletons (`lifespan`):** reads `GCP_PROJECT_ID`/`GCP_PROJECT`, `GCP_REGION`, `GCP_VERTEX_SEARCH_APP_ID` (engine), `GCP_VERTEX_DATASTORE_ID`, `GCP_VERTEX_DATASTORE_LOCATION`, optional `GCP_VERTEX_PUBLIC_ENGINE_ID` (DS-2 tier-3 public fallback, off by default). Inits `vertexai` + a Firestore client.
- **Grounding path:** `_grounded_answer()` calls `answer_query` on the primary engine; on fallback, retries the public engine if configured; drops to direct Gemini only when no engine is set. `_guard()` converts persistent `GoogleAPICallError` into a clean 503.
- **Identity resolution (`_resolve_uid`):** prefers a VERIFIED Firebase ID token (`Authorization: Bearer …`, verified via `firebase-admin`/ADC, `_ensure_registered` creates a minimal `users/{uid}`); falls back to the unverified `X-User-Id` header ONLY when `ALLOW_USER_IMPERSONATION=1` (dev/test, fail-closed). `_active_user` (required) vs `_optional_user` (anonymous-safe).
- **Rate limiting:** in-memory per-IP, 10 req / 60 s on most write/query routes; separate 3 codes / hour per email for verification.
- **CORS:** `localhost:3000`, `meridianjourney.ai` (+ www), and anchored `*.vercel.app` preview regex.
- **Firestore collections:** `users`, `qa_pairs`, `posting_authors`, `interactions` (replies/votes), `groups` (+ `messages` subcollection), `votes`, `verification_codes`, `verified_emails`, plus moderation `reports`/`blocks`/`content_meta`.
- **Feed filtering (`_filter_feed`):** stamps each first-party card with its `author_id` (batched `get_all`), then drops moderation-hidden cards and those authored by blocked users (App Store Guideline 1.2). Postings themselves stay anonymous in the datastore — the author link lives only in Firestore.
- **Facet filters:** `_facets_filter` / `_build_filter` build Discovery Engine `field: ANY("…")` expressions from an allowlisted set of facet fields (injection-safe).
- Delegates business logic to [[query.py]], [[search_client.py]], [[posting.py]], [[profile.py]], [[reconcile.py]], [[interactions.py]], [[matching.py]], [[group_messages.py]], [[moderation.py]] (mostly imported lazily inside handlers).

---

## Dependencies

- `fastapi`, `uvicorn` — HTTP framework + server
- `google-cloud-firestore` — app state / Q&A log
- `google-cloud-discoveryengine` — grounding + search (via [[search_client.py]])
- `firebase-admin` — server-side ID-token verification, account deletion/eject
- `resend` — email verification codes
- `vertexai` / `google-genai` — direct-Gemini fallback + tagging/onboarding

---

## Related

- Grounded retrieval + ranked search: [[search_client.py]]
- Direct-Gemini fallback, intent classification, Q&A log: [[query.py]]
- Posting/experience/connect-card publishing: [[posting.py]]
- Profiles + AI onboarding: [[profile.py]]
- Profile↔message reconciliation: [[reconcile.py]]
- Replies/votes: [[interactions.py]]; matches/groups: [[matching.py]]; group chat: [[group_messages.py]]; UGC safety: [[moderation.py]]
- Consumers: [[Website]], [[Mobile App]]
- [[Proceedings — Project Overview]], [[Deployment]]
