# Gov-News on Mobile — Implementation Plan (not yet built)

**Status:** PLANNING — implementation plan only, per explicit request. No mobile code changed.
**Depends on:** `docs/ingestion/GOV-NEWS-INGESTION-PLAN.md` (backend, implemented and deployed) and the equivalent website News tab (implemented) — this doc is the mobile-specific follow-on, deliberately scoped to a plan rather than code this round.

> **Why this doc exists.** Backend gov-news ingestion and the website News tab
> are implemented and live. Mobile needs the same feature, but per explicit
> instruction this pass produces a plan, not code — mobile release cadence
> (App Store/Play Store review, not an instant deploy) means shipping code
> without a considered plan first is exactly the kind of mismatch already
> flagged in `PATH-B-PROVENANCE-PLAN.md`'s mobile rollout section.

---

## 1. What already exists (checked directly, not assumed)

Mobile already has almost the exact same starting point as the website did:

- **`src/screens/NewsScreen.tsx`** (177 lines) — a fully-built but disconnected
  mockup, structurally identical to the website's old `/news/page.tsx`: hardcoded
  `newsArticles` from `src/data/mockData.ts`, a fabricated "Smart Feed Active"
  card, and a "Show official policy changes only" toggle with no backing logic.
- **Not wired into navigation.** `NewsScreen` is not imported in
  `src/navigation/MainNavigator.tsx`'s screen list at all — same "removed for
  now" state the website's nav had before this work.
- **Predates the A1 design-system unification.** `NewsScreen.tsx` renders
  via raw `<Text>` + local `StyleSheet` objects, not `AppText`/`theme.colors`
  — violates `mobile/AGENTS.md`'s current conventions (no inline styles, no
  raw `Text`, must use the shared `Skeleton`/`EmptyState`/`ErrorState`
  components). **This means completing the feature is a rewrite of this
  screen against current conventions, not a small wire-up patch** — flagging
  this now so it isn't underestimated later.
- **The API plumbing already exists and needs zero changes**, confirmed in
  `src/services/apiService.ts`:
  - `searchPostings(q, {facets, pageToken, pageSize})` → already supports
    passing `facet: ['doc_kind:gov_news']` exactly like the website's
    `/api/search?facet=doc_kind:gov_news` call — same backend route, same
    facet allowlist change already deployed. (Filters on `doc_kind`, not
    `channel` — `channel` isn't registered as an indexable/filterable field
    in the datastore schema; confirmed live while building the website tab.)
  - `getPosting(caseId)` → same detail-fetch the website's case page uses;
    returns `author_handle` now that the backend model was extended (§3.6
    provenance), so the mobile detail screen can render the "Source: USCIS"
    / link-out behavior the same way the website does.
  - `getReplies(postingId, sort)` / `postReply(postingId, body)` /
    `deleteReply(...)` → the exact same reply/vote endpoints, already
    integrated into `CaseDetailsScreen.tsx` for regular postings. Gov-news
    replies need **zero new backend or API-client code** — confirmed
    end-to-end (backend routes are keyed by generic `case_id`, with no
    `doc_kind`/`channel` coupling anywhere in that path).

## 2. Scope: reuse, don't rebuild

Given §1, this is much closer to "finish a disconnected screen" than "build a
new feature":

1. **Rewrite `NewsScreen.tsx`** against current conventions:
   - Replace `mockData.newsArticles` with a real `searchPostings('', {facets: ['doc_kind:gov_news'], pageSize: 20})` call.
   - Remove the fabricated "Smart Feed Active" card and "policy changes only"
     toggle — same reasoning as the website: these claim personalization/
     classification that isn't implemented, and shipping fabricated stats
     ("92% relevant", etc. — website's version had this; mobile's doesn't
     show a fake percentage but does claim profile-based prioritization
     that isn't real either) would misrepresent the feature to users.
   - Use `AppText`, `theme.colors`, and the shared `Skeleton`/`EmptyState`/
     `ErrorState` components for loading/empty/error states, per
     `mobile/AGENTS.md` — `NewsScreen.tsx` today does none of this.
   - List entrance: `FadeInDown.springify()` staggered ≤60ms, capped at the
     first 6 items, matching the existing list-screen convention (e.g.
     `SearchScreen`/`FindScreen`) — check those for the exact pattern to
     copy rather than reinventing it.
   - Reuse the existing `NewsCard` component (`src/components`) if its shape
     is compatible with real `PostingCard`-style API data — likely needs its
     prop types updated from the mock shape to the real search-result shape
     (`case_id`, `title`, `description`, `date`/`timestamp`, `author_handle`,
     `tags`, etc.), same field set the website's `PostingCardData` already
     uses. If `NewsCard`'s visual design doesn't map cleanly, evaluate
     reusing whatever card component `SearchScreen` already uses for
     postings instead, for consistency — decide during implementation, not
     here.
2. **Wire into `MainNavigator.tsx`**:
   - Add `NewsScreen` to the screens import list and register a `Tab.Screen`
     (the tab bar currently has 4 `Tab.Screen` entries — check
     `FloatingTabBar`'s capacity/design before assuming a 5th tab fits
     visually; may need a design call on iconography/labeling, same
     consideration flagged for the website's mobile-web bottom nav).
3. **Detail view**: confirm `CaseDetailsScreen.tsx` renders gov-news content
   correctly without changes (it should, since it already handles any
   `case_id` generically via `getPosting()` + `getReplies()`), but explicitly
   verify:
   - The author/source section shows `author_handle` ("USCIS") and links
     out to the source URL rather than an in-app author profile — check
     whatever the mobile equivalent of the website's §3.6 fix is; if
     `CaseDetailsScreen.tsx` has the same "link author_handle to an in-app
     profile" assumption the website had (pre-fix), it needs the same
     `channel === 'gov_news'` branch added.
   - Reply/vote UI needs no changes (§1 already confirms the API layer is
     generic), but should be manually verified once real gov-news content
     exists in the datastore (it does now — see the backend PR).

## 3. Explicitly NOT in scope for this plan

- No mobile code is being written this round — this is the plan only, per
  the explicit instruction that mobile gets a plan while backend + website
  get real implementation.
- No App Store/Play Store submission planning — that's a distinct, later
  step once the screen is actually built and tested, following this
  project's existing mobile release process.
- No new backend/API work — §1 confirms none is needed.

## 4. Recommended order, once this is picked up for real implementation

1. Rewrite `NewsScreen.tsx` (§2.1) in isolation first, verified against a
   local/dev backend pointed at the now-real `channel=gov_news` content.
2. Wire into `MainNavigator.tsx` (§2.2) and verify the tab fits the existing
   `FloatingTabBar` design.
3. Verify `CaseDetailsScreen.tsx` for gov-news content specifically (§2.3) —
   likely a small, targeted fix if the same author-link assumption exists
   there that the website had before its fix.
4. Manual on-device verification (simulator, per this project's established
   "always verify UI changes in a real preview/simulator" discipline) before
   considering this done — not just a type-check.
5. Ship in the next mobile release cycle — per
   `PATH-B-PROVENANCE-PLAN.md`'s mobile-rollout-timeline section, this won't
   reach real devices until that release is actually cut and approved, a
   separate and later step from writing the code.
