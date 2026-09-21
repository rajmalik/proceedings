# Nested Replies, Voting, Expand/Collapse & Reply Typography — UI Spec

**Status**: SPEC — for review. No code changes yet.
**Scope**: `website/` and `mobile/` (both clients), plus the backend changes
both depend on (`backend/interactions.py`, `backend/api.py`).

## Current state (confirmed by reading the actual code)

- **Replies are genuinely flat today, not just flat-looking.** The backend
  module docstring says it outright (`backend/interactions.py:14`):
  *"Replies are flat (v1): a reply links only to its parent posting via
  `parent_case_id`."* There is no `parent_reply_id`/`in_reply_to`/depth field
  anywhere in the backend — dormant or otherwise. A reply cannot reference
  another reply at all today, on either client or the server.
- **Voting is already fully built** — this spec is "add threading to an
  existing, working vote system," not a from-scratch build. `VoteControl`
  (`website/src/components/VoteControl.tsx`, `mobile/src/components/
  VoteControl.tsx`) already renders Reddit-style up/down arrows, does
  optimistic updates, and is already generic on a `contentId` — it's reused
  verbatim today for both postings and (flat) replies. Backend `vote_state`/
  `cast_vote` (`backend/interactions.py`) are likewise content-type-agnostic.
  **Nothing about voting needs to change for nesting to work** — the existing
  component/endpoint just needs to be rendered inside the new nested reply
  layout, same as it's rendered in the flat one today.
- **"Top" sort already implies real scoring** — `list_replies` sorts by
  `(score, created_at)` where `score = up - down` from the existing
  `content_meta` tally (`backend/interactions.py:231`). Sorting within a
  nested thread can reuse this unchanged.
- **The only existing visual distinction** between a posting and a reply is
  a lighter background color and a font-weight difference on the author
  name (`ReplyItem.tsx` on both clients) — not a distinct type scale. There
  is no existing expand/collapse pattern for reply threads on either client
  (the only precedent, website's `QAList.tsx` truncated-body toggle, is
  unrelated to threading).

## 1. Backend: minimal schema + API additions

**New field**: `parent_reply_id: str = ""` on the reply document (Firestore
`replies/{auto_id}`) and on `ReplyCreate`/`ReplyCard` (`backend/api.py`).
Empty string = top-level reply (replies directly to the posting) — same
empty-string-means-absent convention already used elsewhere in this schema.

**Keep `list_replies` flat.** Do **not** have the backend return a
pre-nested tree. Continue the existing single-equality Firestore query on
`parent_case_id` (fetches every reply for a posting in one call, exactly as
today) and let each client build the hierarchy client-side from
`parent_reply_id`. This is the smallest possible backend change — no new
composite indexes, no recursive queries, and both clients already fetch the
full reply list in one shot today.

**Server-side validation additions** (`add_reply` / `POST /api/postings/
{case_id}/replies`):
- If `parent_reply_id` is provided, verify that reply actually belongs to
  the same `case_id` (reject cross-posting attachment — a client bug or bad
  actor pointing a reply at an unrelated posting's reply id).
- Enforce the max-depth cap server-side too (see §4), not just in UI — a
  client should not be able to force arbitrarily deep nesting by calling the
  API directly.

**No changes needed** to `VoteRequest`/`VoteResponse`/`cast_vote`/
`vote_state` — already correctly generic on `content_id`.

## 2. Shared design decisions (both clients follow these identically)

- **Max nesting depth: 6 levels.** Beyond depth 6, new replies still attach
  logically (backend accepts them) but the UI stops increasing visual
  indentation and instead shows a **"Continue this thread →"** link that
  opens the remaining sub-thread as its own focused view — same pattern
  Reddit uses to avoid indentation collapsing the text column to
  unreadable width, which matters more here given mobile screen widths.
- **Collapse affordance**: every reply with at least one child gets a
  clickable twisty (chevron) next to its vote control. Collapsing hides the
  entire subtree and replaces it with an inline summary: **"[+] N replies"**
  (N = total descendant count, not just direct children). Collapsed state is
  local UI state only (not persisted) — reopening the screen/post starts
  expanded, same as Reddit's default.
- **Sort applies per-level, using the existing tally.** The current Top/New
  toggle continues to sort top-level replies; sibling replies at every
  nesting level sort by the same toggle and the same existing `score`/
  `created_at` fields — no new sorting concept needed.
- **Indentation + thread lines**: each depth level gets a fixed left
  indent plus a thin vertical line connecting a reply to its parent
  (Reddit's visual convention for "this belongs to that") — not indentation
  alone, since indentation-only nesting gets visually ambiguous past 2-3
  levels.

## 3. Typography (the 4th requirement)

- **Depth 0 (posting)**: unchanged — existing headline/body type scale.
- **Depth 0 replies (direct replies to the posting)**: unchanged from
  today's existing reply styling (already visually distinct from the
  posting via lighter background).
- **Depth 1+ (nested replies)**: **one step smaller** than depth-0 reply
  text, applied uniformly at all nested depths — not progressively shrinking
  per level. Reddit itself does not shrink font per depth indefinitely; it
  relies on indentation + thread-lines for depth cues once past the first
  nesting step, and this repo's own type scale doesn't have enough distinct
  small sizes to make a per-level shrink legible anyway. Concretely:
  - Website: depth-0 replies keep whatever Tailwind text class they use
    today (confirmed `text-body-md` scale); depth 1+ drops one step to the
    existing `text-caption`/`text-label-md` scale already used elsewhere in
    the codebase — no new CSS class needed.
  - Mobile: same one-step-down rule, expressed as an `AppText` variant
    change (see §5's typography-debt note) rather than a new font size
    invented for this feature.

## 4. Website changes (`website/src/components/`)

- **`Replies.tsx`**: currently does `replies.map(r => <ReplyItem .../>)`
  over a flat array with no nesting. Needs to: (a) build a tree from the
  flat `parent_reply_id`-linked list client-side after fetch, (b) render
  recursively (a `ReplyItem` that renders its own children `ReplyItem`s,
  each indented one step further), (c) track collapsed-state per reply id
  (`Set<string>` of collapsed ids is enough — no need for per-branch state
  objects).
- **`ReplyItem.tsx`**: needs a "Reply" action that opens an inline composer
  **scoped to that specific reply** (setting `parent_reply_id` on submit) —
  today the only composer is the posting-level one at the top of
  `Replies.tsx`. Needs the collapse twisty (only rendered when the reply has
  children) and the depth-based indent/typography from §2-3.
  `VoteControl.tsx` is reused completely unchanged.
- **New**: a small "Continue this thread" component for the depth-6 cutoff
  (§2) — links to a focused view of that subtree (could reuse the existing
  case-detail page pattern, scoped to a reply id instead of a case id).

## 5. Mobile changes (`mobile/src/`)

- **Architecture note specific to mobile**: `Replies.tsx` currently renders
  via `FlatList`, which does not naturally support recursive/nested
  rendering the way a web `.map` does. Recommended approach: flatten the
  built tree into a single display list where each item carries its own
  `depth` and `hidden` (collapsed-by-ancestor) metadata, and keep using
  `FlatList` over that flattened list — toggling a collapse just updates
  which items in the flat list have `hidden=true`, filtered out via
  `FlatList`'s `data` prop. This avoids replacing `FlatList` with nested
  `ScrollView`s (worse performance, loses `FlatList`'s virtualization for
  what could be long threads).
- **`ReplyItem.tsx`**: same additions as website (inline reply composer
  targeting `parent_reply_id`, collapse twisty, depth-based indent), plus:
  entrance animation for newly-expanded subtrees should reuse the existing
  `FadeInDown.springify()` list-entrance convention from `mobile/AGENTS.md`
  (staggered ≤60ms, capped at first 6 items — directly applicable here),
  and expand/collapse taps should use `light` haptics per the existing
  haptics policy (navigation-weight interaction, not a state-changing vote).
- **Existing typography debt worth fixing while these files are touched
  anyway**: `mobile/ReplyItem.tsx` and `mobile/VoteControl.tsx` currently
  use raw `<Text>` with inline `fontSize`/`fontWeight` literals and a
  hardcoded `fontFamily: 'NunitoSans_700Bold'` — this violates `mobile/
  AGENTS.md`'s own A1 rule (must use `AppText` variants, never inline
  fontSize, never pair fontWeight with fontFamily). Since this feature
  requires touching both files anyway to add depth-based typography, migrate
  them onto `AppText` variants in the same change rather than adding a third
  inline-style pattern on top of the existing debt.
- **Existing loading-state debt, same reasoning**: mobile `Replies.tsx` uses
  a raw `ActivityIndicator` (line 156) instead of the shared `Skeleton`
  component `mobile/AGENTS.md` mandates — worth fixing alongside since the
  component is being substantially rewritten for threading regardless.

## Non-goals

- Not changing anything about the vote UI/UX itself — it's reused as-is.
- Not adding reply notifications, mentions, or any "someone replied to you"
  feature — purely the display/composition/voting hierarchy.
- Not persisting collapse state across sessions.
- Not solving deep-linking directly to a specific nested reply (the
  "Continue this thread" focused view in §4 is the only navigation
  affordance this spec adds).

## Open questions for review

1. Is a max depth of 6 the right number, or should it be lower for mobile
   specifically given narrower screens (e.g. cap visual indent at depth 4
   on mobile, 6 on web)?
2. Should the reply-count shown on a collapsed thread ("[+] N replies")
   count only visible/non-deleted replies, or include soft-deleted ones
   (existing `deleted` flag) in the count?
3. Any objection to bundling the two pre-existing mobile typography/loading
   debt fixes (§5) into this change, versus doing them as a separate,
   unrelated cleanup PR first?
