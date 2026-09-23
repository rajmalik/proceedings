# STEM OPT unified timeline — pending items & future considerations

Companion to [`stem-opt-timeline-plan-9.md`](stem-opt-timeline-plan-9.md). Records
what is **shipped**, what is **pending to release**, and what was **deliberately
deferred**, so a future pass can pick any of it up without re-deriving context.

Scope reminder: **STEM OPT only** (`EAD → stem-opt-extension`). Generalizing the
card to other processing types is a separate, later effort (plan §10).

---

## Shipped & tested (Phases 1–6, PR #66 → `build-release-1.4`)

The full posting ⇄ cohort loop with one unified capture UI, on backend +
website + mobile. No `it.todo` remain.

| Phase | What | Where |
| --- | --- | --- |
| 1 | `posting.filing_period()` + locked canonical schema / vocab / cleaner pipeline | `backend/posting.py`, `backend/tests/test_stem_opt_timeline.py` (groups A–D, F) |
| 2 | Shared `StemOptTimelineCard` in `/post` | `website/src/components/StemOptTimelineCard.tsx`, `app/post/page.tsx` |
| 3 / 3b | Cross-link both directions (posting→cohort deep-link; cohort→posting draft) | `lib/stemOptTimeline.ts`, `lib/assistDraft.ts`, `app/groups/[id]/page.tsx` |
| 4 / 4b | Mobile parity: card + posting-side + both cross-link directions | `mobile/src/**` (lib, `StemOptTimelineCard`, `PostScreen`, `GroupChatScreen`) |
| 5 | Offline golden over curated fixtures + partial-parse "N of M captured" | `test_stem_opt_timeline.py` group G; both cards |
| 6 / 6b | Timeline-form reuse: the card IS the join/attribute form + paste-to-extract | `StemOptAttributeForm` (web + mobile), group forms |

Coverage after the gap pass: `stemOptTimeline` 100%, `StemOptTimelineCard` 100%,
`assistDraft` 100%, `StemOptAttributeForm` 100% stmt / 93.5% branch (remainder is
the unreachable disabled-button guard). Website vitest 575, mobile jest 318,
backend golden 45/45.

---

## Pending to release

1. **Promote `build-release-1.4` → `main` + prod deploy.** Same release-branch
   flow used for `build-release-1.3` → main (#63). Deploy is backend
   (`filing_period`) + website + a mobile build. **Requires explicit
   confirmation** (prod-facing).
2. **iOS-simulator verification.** All mobile work (Phases 4–6) is
   **Jest-verified only** — the Xcode 27 / Expo SDK 56 incompatibility blocked a
   device/sim run (devicectl detection, then an ExpoModulesJSI Swift-compiler
   crash). Re-verify on a compatible Xcode before relying on the RN UI.
3. **Live extraction-recall run (backend group E).** Integration-only (needs
   GCP/Gemini); it did **not** run in the no-GCP CI gate. Run once to confirm the
   live extractor reproduces the golden targets group G documents.

---

## Deliberately deferred (plan §6 / §10 / §11)

4. **Curated `publish.sh` structured emit.** Seeded `curated/stem/*.txt`
   postings still publish as free text. Teaching curation to emit the structured
   stem-opt keys (so seeded STEM postings populate cohorts) is a named "later"
   item (plan §10, §11). Highest-impact of the deferred set.
5. **`suggest_tags()` prompt tightening (§7).** Only if live group-E recall
   proves weak. Phase 1 found extraction adequate and changed no prompt; revisit
   if drift shows up. The golden (group G) is the recall bar to tighten toward.
6. **Auto-attach on a high-confidence parse (§11).** Shipped "confirm-first"
   (the always-editable card + manual cohort-bridge click); auto-attaching a
   clean parse without a click is a later revisit.
7. **A discrete "looks right? confirm" affordance (§6).** Currently satisfied by
   design — the card is editable and the bridge/join is a manual action — but
   there is no separate confirm CTA if we later want that literal step.
8. **`/find` create-form paste on-ramp.** Paste-to-extract lives on the
   per-member join/attribute form (`StemOptAttributeForm`), which is the
   meaningful surface. The cohort-*creation* form on `/find` (which defines
   `filing_month`/`filing_year` criteria, not per-member milestones) did not get
   it. Minor.

---

## Unrelated operational backlog (surfaced during this work, not part of this feature)

- **Rotate `GOV_NEWS_POLL_SECRET`** — it was inadvertently printed once via a
  `gcloud run services describe` env dump.
- **Deploy the curated-publish auth fix to prod** — merged to the release branch
  via #65, not yet on prod (needs a backend redeploy + confirmation).

---

_Generated alongside PR #66. Update this doc as items land or new ones surface._
