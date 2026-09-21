# Handoff: Nested Replies, Voting, Expand/Collapse & Reply Typography

**This doc is written for a developer (or a fresh Claude Code session) with
zero prior context on this work.** It exists because this feature is being
delegated to someone who wasn't in the conversation where it was scoped —
everything you need to start should be here or one link away.

## Start here

1. Read [`NESTED-REPLIES-UI-SPEC.md`](NESTED-REPLIES-UI-SPEC.md) — the
   **what**: requirements, current-state findings, and every design
   decision already made (depth cap, indentation, typography rule, the
   mobile `FlatList`-flattening approach).
2. Read [`NESTED-REPLIES-IMPLEMENTATION-PLAN.md`](NESTED-REPLIES-IMPLEMENTATION-PLAN.md)
   — the **how**: sequenced as 3 PRs (backend → website/mobile in
   parallel), with the exact files each touches.
3. Read this doc fully before writing any code — it has environment
   gotchas that cost real debugging time to discover the first time.

## What this repo is

A RAG immigration-intake assistant. Backend is FastAPI (`backend/`),
grounded on managed Vertex AI Search; website is Next.js (`website/`);
mobile is Expo/React Native (`mobile/`). **Read `/CLAUDE.md` at the repo
root first** — it's the canonical source of truth for architecture,
commands, and conventions, kept up to date independently of this doc.
`mobile/AGENTS.md` has mobile-specific design-system rules (typography via
`AppText` only, color via `theme.colors` only, motion/haptics policy) that
this feature must follow, not invent around.

## Environment gotchas learned the hard way this session

**These are not in the spec/plan doc — they're operational traps.**

### Backend `.venv` may be stale
The project's `.venv` (repo root) sometimes lags `backend/requirements.txt`.
If a test import fails with `ModuleNotFoundError` for something listed in
`requirements.txt`, it's a stale venv, not a real problem —
`.venv/bin/pip install <package>` and move on.

### Two *separate* GCP credential stores — this one is easy to lose an hour on
`gcloud config set account ...` (what the `gcloud` CLI uses) and
`gcloud auth application-default login` (ADC — what Python client libraries
like `google-genai`/`google-cloud-bigquery`/`discoveryengine_v1` actually
use) are **completely independent**. You can have the CLI authenticated as
one identity and ADC authenticated as a totally different one with zero
permissions on the project — this repo hit exactly that: `gcloud` CLI was
fine, but ADC was silently on an identity with **zero IAM roles** on
`proceedings-490601`, causing every local Gemini-calling test to fail with a
403 that looked unrelated to auth at first.

If you hit `403 PERMISSION_DENIED` on `aiplatform.endpoints.predict` or
similar while running tests locally: check ADC specifically, not just
`gcloud config get-value account`:
```bash
TOKEN=$(gcloud auth application-default print-access-token)
curl -s "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=$TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('email'))"
```
If that's not an identity with `roles/owner` (or equivalent) on
`proceedings-490601`, run `gcloud auth application-default login`
interactively (it opens a browser — you have to do this yourself, an agent
can't drive an OAuth consent screen) and sign in as an account that has
access.

### Test commands
```bash
cd backend
../.venv/bin/python tests/test_posting_tagging.py unit   # deterministic, no network — always safe
../.venv/bin/python tests/test_posting_tagging.py all     # includes live Gemini + a real publish+cleanup — needs the ADC fix above
```
`tests/test_interactions.py` is the file most relevant to this feature
(replies/votes) — check its existing structure before adding new tests; it
may not use the exact same `check()` pattern as `test_posting_tagging.py`.

### Deploy
```bash
gcloud run deploy immiguide-api --source backend --region us-central1 --project proceedings-490601 --quiet
```
Only run this after a backend PR is **merged**, not before — and only when
explicitly asked to deploy, not automatically after merging (this repo's
convention: merge and deploy are separate, deliberate steps).

## This repo's workflow conventions (follow these, don't improvise)

- **One isolated branch + PR per logical change.** Every recent change in
  this repo's history is a small, focused branch off `main`, its own PR,
  its own tests, reviewed before merge — not one giant branch for
  "everything." PR 1/2/3 in the implementation plan should genuinely be
  three separate PRs (or at minimum, backend fully separate from the
  client work).
- **Never commit/PR/deploy without being asked.** If you're an AI agent
  picking this up: don't create branches, open PRs, or deploy on your own
  initiative — propose the change, wait for a human "yes, go ahead," same
  as how every change in this repo's history has happened.
- **Frontend UI changes need real manual verification** — run the actual
  dev server / simulator and exercise the feature, don't report a UI PR
  done based on a type-check or a read-through alone.
- **Tagging/releasing is separately gated** — see
  `docs/RELEASE-TAGGING.md` if a version tag ever comes up for this work;
  it's explicit and human-triggered only, never automatic on merge.

## Open questions — ask the product owner, don't guess

These are listed in both the spec and the plan; repeating here because
they're the single most likely thing to get silently assumed wrong:
1. Max nesting depth — 6 for both platforms, or lower specifically on
   mobile given narrower screens?
2. Does the collapsed "[+] N replies" count include soft-deleted replies?
3. Bundle the pre-existing mobile typography/loading-state debt fixes
   (`ReplyItem.tsx`/`VoteControl.tsx` inline-style violations,
   `ActivityIndicator` instead of `Skeleton`) into the mobile PR, or ship
   them separately first?

None of these are blocking to *start* the backend PR (which doesn't depend
on the answers), but all three should be resolved before starting the
website/mobile PRs.
