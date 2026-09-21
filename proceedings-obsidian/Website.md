# Website

**Location:** `/website/`
**Stack:** Next.js 14.1 (App Router), React 18, TypeScript 5, Tailwind CSS 3.4, Firebase (client Auth)
**Brand:** Meridian — `meridianjourney.ai`
**Deployed:** Cloud Run service `immiguide-web` (`us-central1`) — see [[Deployment]]. (Previously Vercel; migrated after loss of Vercel admin access.)
**Backend:** FastAPI on Cloud Run (`immiguide-api`) via [[api.py]], reached through Next.js proxy routes.

---

## Purpose

The public web app for Meridian: an AI immigration assistant plus a community/experience-sharing product. It is the browser sibling of the [[Mobile App]] and shares the same product surface and backend (see [[Proceedings — Project Overview]]). Users can search/ask (grounded AI answers), browse and publish tagged experience postings, find and connect with similar people, form groups, and complete AI onboarding. Every page that talks to the backend does so through a same-origin `/api/*` proxy route (never calling Cloud Run directly from the browser).

---

## Pages

App Router pages under `src/app/`. Client identity flows through the `X-User-Id` header (a Firebase uid in prod, or the dev demo-user picker).

| Route | File | Description |
|-------|------|-------------|
| `/` | `page.tsx` | Marketing home / landing (Meridian hero, entry points to search, community, find). |
| `/search` | `search/page.tsx` | **Unified search-first interface** (Search ⇄ AI Mode). Consolidates the old `/ask`; renders `UnifiedSearch` — facets, strictness, and grounded AI answers. |
| `/ask` | `ask/page.tsx` | Legacy Q&A entry; now folded into the unified search interface. |
| `/find` | `find/page.tsx` | People/experience match-making: expert-chat that builds match criteria, then ranked `MatchCard`s; can form a group from selections. |
| `/onboarding` | `onboarding/page.tsx` | Two-stage AI onboarding conversation that populates the user profile. |
| `/community` | `community/page.tsx` | Community discussion / Q&A listing. |
| `/news` | `news/page.tsx` | Immigration news feed (curated article cards). |
| `/post` | `post/page.tsx` | Posting composer — publish a tagged experience; AI tag-suggest + profile reconcile at submit. |
| `/profile` | `profile/page.tsx` | The active user's profile + activity (`ProfileActivity`). |
| `/pro` | `pro/page.tsx` | Directory to connect with immigration attorneys / consultants. |
| `/author/[uid]` | `author/[uid]/page.tsx` | Author view: full structured profile + all of their postings. |
| `/author-by-handle/[handle]` | `author-by-handle/[handle]/page.tsx` | Author lookup resolved by handle/username. |
| `/case/[id]` | `case/[id]/page.tsx` | Single posting/case detail with replies and votes. |
| `/groups/[id]` | `groups/[id]/page.tsx` | Group chat room (`GroupChat`). |
| `/login` | `login/page.tsx` | Firebase email/password + Google sign-in. |
| `/signup` | `signup/page.tsx` | Firebase account creation. |
| `/support` | `support/page.tsx` | Support & Help Center. |
| `/disclaimer` | `disclaimer/page.tsx` | Standalone legal disclaimer (not legal advice). |
| `/terms` | `terms/page.tsx` | Terms of Service (Termly export). |
| `/privacy` | `privacy/page.tsx` | Privacy Policy (Termly export). |
| — | `error.tsx`, `not-found.tsx` | Route error boundary and 404. |

---

## API Routes (Next.js proxy → FastAPI backend)

All routes live under `src/app/api/`, import `apiBase()` from `@/lib/apiBase`, and `fetch` `${apiBase()}/api/...` on the backend origin (`PYTHON_API_URL`). `apiBase()` defensively strips a trailing slash and a stray `/api` suffix to avoid `…/api/api/…` 404s. Identity is forwarded via the `X-User-Id` header.

| Route | Methods | Proxies to backend |
|-------|---------|--------------------|
| `/api/search` | GET | `/api/search` (grounded search + facets) |
| `/api/ask` | POST | `/api/ask` (grounded AI answer) |
| `/api/chat` | POST | `/api/chat` |
| `/api/expert` | POST | `/api/expert` |
| `/api/onboard` | POST | `/api/onboard` (one onboarding turn) |
| `/api/reconcile` | POST | `/api/reconcile` (profile ↔ in-progress message) |
| `/api/find/chat` | POST | `/api/find/chat` (build match criteria) |
| `/api/find/matches` | POST | `/api/find/matches` (rank similar users) |
| `/api/connect-card` | POST | `/api/connect-card` (publish a "looking to connect" card) |
| `/api/postings` | POST | `/api/postings` (publish a posting) |
| `/api/postings/[id]` | GET | `/api/postings/{id}` |
| `/api/postings/[id]/replies` | GET, POST | replies for a posting |
| `/api/postings/[id]/replies/[replyId]` | DELETE | delete a reply |
| `/api/votes` | POST | `/api/votes` (up/down/clear on posting or reply) |
| `/api/tag-suggest` | POST | `/api/tag-suggest` (AI tag suggestions for composer) |
| `/api/tag-vocab` | GET | `/api/tag-vocab` (controlled tag vocabulary) |
| `/api/profile` | GET, PUT | active user's profile |
| `/api/qa` | GET | recent Q&A log |
| `/api/qa/[id]/feedback` | POST | Q&A feedback |
| `/api/groups` | GET, POST | list / form groups |
| `/api/groups/all` | GET | all groups |
| `/api/groups/[id]` | GET | one group |
| `/api/groups/[id]/join` | POST | join a group |
| `/api/groups/[id]/messages` | GET, POST | group messages |
| `/api/groups/[id]/messages/[messageId]` | DELETE | delete a group message |
| `/api/users` | GET, POST | seed roster (dev persona picker) / create user |
| `/api/users/[uid]/postings` | GET | a user's postings |
| `/api/users/[uid]/replies` | GET | a user's replies |
| `/api/users/[uid]/public-profile` | GET | a user's public profile |
| `/api/authors/by-handle/[handle]/postings` | GET | postings by author handle |

---

## Components (`src/components/`)

| Component | Description |
|-----------|-------------|
| `TopAppBar.tsx` | Desktop top navigation bar (mounted in `layout.tsx`). |
| `MobileBottomNav.tsx` | Mobile bottom tab bar. |
| `Providers.tsx` | Client provider wrapper (mounts `AuthProvider`). |
| `BrandMark.tsx` | Meridian logo mark. |
| `UnifiedSearch.tsx` | The search-first surface (Search ⇄ AI Mode), facets, strictness, answers. |
| `ChatInterface.tsx` | Conversational chat UI (onboarding / expert / find turns). |
| `StrictnessSlider.tsx` | Grounding strictness control (`broad` / `balanced` / `strict`). |
| `SuggestedFilters.tsx` | Facet filter groups derived from search results. |
| `MatchCard.tsx` | A ranked similar-person result on `/find`. |
| `PostingCard.tsx` | Compact posting summary card. |
| `CategoryPill.tsx` | Tag/category pill with display-label mapping. |
| `VoteControl.tsx` | Up/down vote widget for postings and replies. |
| `Replies.tsx` / `ReplyItem.tsx` | Reply thread list and individual reply. |
| `AuthorSection.tsx` | Author identity block on posting/case views. |
| `ProfileActivity.tsx` | A user's activity feed on the profile page. |
| `GroupChat.tsx` | Group chat room UI. |
| `Markdown.tsx` | Sanitized Markdown renderer (`react-markdown` + `remark-gfm` + `rehype-sanitize`). |
| `AskForm.tsx` / `QAList.tsx` / `SourceCitation.tsx` | Legacy Q&A form, recent-Q&A list, and source citation pill. |
| `DisclaimerBanner.tsx` | Legal disclaimer banner. |

---

## Contexts & Lib

| File | Role |
|------|------|
| `contexts/AuthContext.tsx` | Firebase Auth provider — email/password + Google sign-in, ID-token refresh (`onIdTokenChanged`), sign-out; syncs the active uid. |
| `lib/firebase.ts` | Client Firebase init (browser-only) from `NEXT_PUBLIC_FIREBASE_*` env. |
| `lib/apiBase.ts` | Resolves the backend origin from `PYTHON_API_URL` (defensively normalized). |
| `lib/activeUser.ts` | Active-user identity for the `X-User-Id` header; Firebase session and the dev demo-user picker are mutually exclusive (`DEMO_PICKER_ENABLED` off in prod). |
| `lib/useRequireUser.ts` | Route guard — redirects to `/login` in prod when unauthenticated; no-op in dev/test. |

---

## Design System

Tailwind config (`tailwind.config.ts`) defines the **Meridian** token set: primary brand red `#AE0000`, a cool near-white `surface` ground, neutral-gray secondary, and a Material-style surface/on-surface token family. Fonts are Inter (sans, `--font-inter`) and Lora (serif, `--font-lora`); a tightened type scale (`display-lg`, `headline-lg`, `body-md`, `caption`, …) and 8px-based spacing. `globals.css` provides base element styles and component utilities (`.btn-primary`, `.btn-secondary`, `.pill`, `container-narrow/wide`). These tokens are shared with the mobile app — see [[Design System]].

---

## Commands

```bash
cd website/
npm install
npm run dev      # local dev server
npm run build    # production build
npm run lint     # ESLint (eslint-config-next)
npm run test     # Vitest unit tests
npm run smoke    # post-deploy smoke check (scripts/post-deploy-smoke.mjs)
```

---

## Dependencies

| Package | Version |
|---------|---------|
| `next` | 14.1.0 |
| `react` / `react-dom` | ^18.2.0 |
| `firebase` | ^12.14.0 |
| `react-markdown` | ^10.1.0 |
| `remark-gfm` | ^4.0.1 |
| `rehype-sanitize` | ^6.0.0 |
| `lucide-react` | ^0.312.0 |
| `tailwindcss` | ^3.4.1 |
| `typescript` | ^5.3.3 |
| `vitest` (dev) | ^2.1.9 |
| `@testing-library/react` (dev) | ^16.3.2 |

---

## Related

[[Proceedings — Project Overview]] · [[Mobile App]] · [[api.py]] · [[Design System]] · [[Deployment]] · [[Docs Map]]
