# Nested Replies — Implementation Plan

**Status**: PLAN — for review. No code changes yet.
**Depends on**: [`NESTED-REPLIES-UI-SPEC.md`](NESTED-REPLIES-UI-SPEC.md) —
read that first; this doc sequences *how* to build it, not *what* to build.

## Sequencing rationale

Backend first, as its own PR — both clients depend on the new
`parent_reply_id` field and the validation it needs, and the backend change
is small, isolated, and independently testable (matches how every backend
change in this repo's recent history has shipped: one focused PR, unit
tests, then integration-tested before merge). Website and mobile can then
proceed **in parallel** (different codebases, no shared files) once the
backend PR is merged and deployed — if this is split across two developers,
that's the natural split point.

## PR 1 — Backend: `parent_reply_id` + validation

**Files**: `backend/interactions.py`, `backend/api.py`,
`backend/tests/test_interactions.py` (existing test file — extend it, don't
create a new one).

1. Add `parent_reply_id: str = ""` to the Firestore reply document shape in
   `add_reply()` and to `ReplyCreate`/`ReplyCard` in `api.py`.
2. In `add_reply()`, when `parent_reply_id` is non-empty:
   - Fetch that reply, confirm its `parent_case_id` matches the posting
     being replied to — reject (raise, mapped to 4xx) if not.
   - Walk up the parent chain to compute depth; reject if it would exceed
     the max depth from the spec (§2 — confirm the exact number with the
     product owner first, see Open Questions below before hardcoding it).
3. `list_replies()` stays a flat return — no tree-building server-side (per
   spec §1). Just make sure `parent_reply_id` round-trips through
   `ReplyCard`.
4. Tests to add (mirror the existing style in `test_interactions.py` —
   check `backend/tests/test_posting_tagging.py` for the `check()`-based
   pattern this repo's test files use if `test_interactions.py` looks
   different): a reply-to-reply succeeds and returns the right
   `parent_reply_id`; a `parent_reply_id` from a different posting is
   rejected; depth-cap rejection at the boundary and one-past-it; existing
   flat-reply behavior (`parent_reply_id=""`) is unchanged.
5. Deploy following this repo's existing process — `gcloud run deploy
   immiguide-api --source backend --region us-central1 --project
   proceedings-490601`, then a live smoke test against the deployed URL
   before either client PR starts building against it.

## PR 2 — Website

**Files**: `website/src/components/Replies.tsx`, `ReplyItem.tsx`, new
"Continue this thread" component, `website/src/app/case/[id]/page.tsx` if a
new route is needed for the thread-continuation view.

1. Tree-building: write a pure function (`buildReplyTree(flatReplies):
   ReplyNode[]`) that takes the flat API response and nests it by
   `parent_reply_id` — keep this as a standalone, unit-testable function
   rather than inline in the component.
2. Recursive `ReplyItem` rendering with depth-based indent/typography per
   spec §2-3, collapse state as a `Set<string>` of collapsed reply ids in
   `Replies.tsx`, passed down.
3. Per-reply inline composer (reuse the existing composer's styling/logic
   from the posting-level one, parameterized by `parent_reply_id`).
4. Depth-6 cutoff → "Continue this thread" link/view.
5. Manual verification: this is frontend UI, so per this repo's own
   guidance, actually run it in a browser (`npm run dev`) and exercise
   nesting several levels deep, collapse/expand, voting at depth, and the
   depth-6 cutoff — don't just rely on typechecking.

## PR 3 — Mobile

**Files**: `mobile/src/components/Replies.tsx`, `ReplyItem.tsx`,
`VoteControl.tsx` (typography-debt fix only, no logic change),
`mobile/src/screens/CaseDetailsScreen.tsx` if needed.

1. Same `buildReplyTree` logic as website (can be near-identical TS, just
   ported — consider whether it's worth sharing as a common package later,
   but don't block this PR on that; duplicate it for now).
2. **Flatten the tree for `FlatList`** per spec §5 — each item carries
   `depth` and `hidden` (collapsed-by-ancestor) — do not switch to nested
   `ScrollView`s.
3. Migrate `ReplyItem.tsx` and `VoteControl.tsx` off inline
   fontSize/fontWeight literals onto `AppText` variants while adding the
   depth-based typography (spec §5's bundled-debt note) — confirm with the
   product owner first whether to bundle this or split it into its own PR
   (see Open Questions).
4. `FadeInDown.springify()` entrance for newly-expanded subtrees, `light`
   haptics on expand/collapse — both per existing `mobile/AGENTS.md`
   conventions, not new patterns.
5. Verify in the iOS Simulator (or Android) — build, run, exercise the same
   scenarios as the website manual pass. Screenshot the nested/collapsed
   states for the PR description.

## Testing summary across all three PRs

- Backend: unit tests (deterministic, no network) following this repo's
  existing `check()`-based pattern; run the full relevant test file
  (`unit` scope at minimum, `all` scope if GCP/Gemini credentials are
  available locally — see the Handoff doc for the credentials gotcha).
- Website/mobile: manual verification in a real browser/simulator is
  required for UI work in this repo — do not report either PR done on the
  strength of a type-check alone.

## Open questions to resolve with the product owner before/while implementing

These were raised in the spec and are **not yet answered** — surface them
early rather than guessing:
1. Max depth: 6 for both platforms, or lower on mobile specifically?
2. Does the collapsed "[+] N replies" count include soft-deleted replies?
3. Bundle the mobile typography/loading-state debt fixes into PR 3, or ship
   them as a separate cleanup PR first?
