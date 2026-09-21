# Manual Curation Playbook — Reddit Content

**Status**: MOSTLY READY TO RUN. The human-in-the-loop draft step
(`suggest_tags()`) is live and reusable as-is. The publish step
(`publish_posting()`/`POST /api/postings`) is also live, but **hardcodes
`channel="app"`** — it cannot preserve Reddit provenance (`subreddit`,
`reddit_post_id`, real permalink) out of the box. See the callout in Step 5
for the two ways to handle this: accept the trade-off short-term, or use a
small new script for full Reddit provenance.
**Scope**: the same 2-3 named subreddits as the rest of the current
evaluation; cap each curated post at its top 3 comments by upvote count if
comments are included at all.
**Legal posture**: cleanest of all the options under evaluation — a human
reading public content and typing it in is not automated collection, and
carries none of the ToS/scraping-enforcement risk discussed in
[`APIFY-SCRAPER-LEGAL-AND-INTEGRATION.md`](APIFY-SCRAPER-LEGAL-AND-INTEGRATION.md).
Use this as the immediate, zero-risk way to seed quality content while any
Apify/API-access decision is still pending.

## Why most of this works today already

This exact path was proven once already: **D-026** (see `MEMORY.md`) used it
to build the current 82-doc seed corpus. The batch *script* that ran it
(`ingest_batch.py`) no longer exists in this repo — only its output survives,
as reference examples in
[`docs/tagging/tagging-examples/postings-batch-1-tagged/`](../tagging/tagging-examples/postings-batch-1-tagged/).
But the two API endpoints that script relied on are still live today, and
are exactly what a human curator needs:

- **`POST /api/tag-suggest`** → `posting.suggest_tags(title, description)` —
  runs the same Gemini tagging used for user-submitted postings, returns a
  **draft**: controlled-vocab tags grouped by section, relevant sections,
  posting type, detected stages/outcomes, key dates.
- **`POST /api/postings`** → `posting.publish_posting(title, description,
  tags, key_stages_or_info, key_dates)` — takes the (possibly hand-edited)
  tags as an explicit argument, then does PII scrub + moderation + build
  canonical sidecar + GCS write + `documents.import` + BigQuery row. **Caveat**:
  its request/response schema and `posting.build_canonical()` both hardcode
  `channel = "app"` and a random `case_id` — there is no parameter to pass
  `subreddit`/`reddit_post_id`/a real `full_url` through this endpoint. See
  Step 5.

So the curator loop is: **draft (AI) → review/edit (human) → publish**,
mostly wired end-to-end already — the one gap is provenance fields on
publish, not the draft/review loop itself. See Step 5 for both the
zero-new-code path and the small-script path that closes that gap.

## Step-by-step

### 1. Select a thread
- Only from the 2-3 approved subreddits for this pilot.
- Pick posts that are substantive (a real account of someone's
  visa/greencard/USCIS experience — background, timeline, outcome), not
  low-effort or off-topic content.
- If including comments, take **at most the top 3 by upvote count** — sort
  the thread by "top" and read down; skip low-value or off-topic replies
  even if they rank in the top 3 (curator judgment, not a hard rule).

### 2. Capture the raw content into a local file — first, before anything else

Paste the post title + body (and up to 3 selected comments, clearly
attributed as comments if included) into a local file. **Always do this
step before calling any endpoint** — Steps 4 and 5 read from this file
rather than having you re-type or paste the content into a curl command
by hand, which is both tedious and error-prone for long text (quoting,
special characters, accidental truncation).

**Format required**: line 1 = title, line 2 = blank, everything from line 3
onward = the body/description. This mirrors the shape in
`postings-batch-1-tagged/*.md` and is what the extraction commands in Steps
4/5 assume.

**File extension (`.md` vs `.txt` vs anything else): does not matter.**
Nothing in the backend ever reads this file directly — its content only
ever becomes the `title`/`description` strings sent in a request body. The
"real" `.md` that eventually lands in GCS is auto-*regenerated* from those
strings by `posting._markdown_body()`, not a copy of your local file. `.md`
is used in this doc's examples purely for consistency with that eventual
GCS artifact and with the existing `postings-batch-1-tagged/*.md` reference
examples — `.txt` (or no extension at all) works identically.

```bash
mkdir -p curated
cat > curated/h1b-rfe-approved-2026-06.md << 'EOF'
H-1B RFE on specialty occupation — approved after response

Filed H-1B extension through my employer in March. Got an RFE in May
questioning whether my role (data analyst) qualifies as a specialty
occupation. Employer's immigration attorney put together a detailed
response with an expert opinion letter and updated job duties. Responded
within the 87-day deadline. Approval notice came about 5 weeks after RFE
response. Total case time from filing to approval was just under 4 months.
EOF
```

- This is a **near-verbatim copy of already-public content**, which is
  explicitly the posture D-017 sanctions (raw content mirrors public Reddit
  content; only the derived `.json` summary fields need to be paraphrases —
  see Step 4).
- **Do not capture the Reddit author's username or handle anywhere** — per
  the original pipeline spec's explicit privacy requirement. If a comment
  you're including references the original poster by name, redact it.
- **Where you save this file doesn't matter functionally either** — pick one
  consistent local folder (`curated/` in these examples) purely so you can
  track capture-vs-published progress (Step 6) and so Steps 4/5's commands
  have a stable path to read from. **Don't commit this folder to git** —
  it's near-verbatim public Reddit content with no reason to sit permanently
  in repo history; add `curated/` to `.gitignore` instead.
- **Prerequisite for Steps 4/5**: [`jq`](https://jqlang.org) — used to safely
  build the JSON request body from file content (handles quotes, em dashes,
  embedded newlines correctly, which manual string-pasting doesn't).
  `brew install jq` (macOS) or `apt install jq` (Linux); already present in
  most dev environments.

### 3. Set identity/provenance fields
Unlike the original D-026 batch (which had no source URLs and used
synthesized identity fields), a manual curator working from a live Reddit
thread *does* have the real values — use them **when using Path B** (§5).

| Field | Value |
|---|---|
| `channel` | `"reddit"` |
| `subreddit` | the actual subreddit, e.g. `"h1b"` |
| `reddit_post_id` | the real Reddit post ID (from the URL, e.g. `1abc2de`) |
| `full_url` | the real permalink |
| `ingestion_method` | `"manual_curation"` (distinguish from `"manual_upload"`, D-026's synthesized-ID batch, and `"app"` for user-submitted content) |
| `posting_date` | the post's actual creation date |
| `case_id` | `reddit-<posting_date>-<subreddit>-<reddit_post_id>` (deterministic, matches the dedup key scheme from the original pipeline spec — doubles as your own duplicate-check: if you've already curated this post, the ID will collide) |

> **⚠️ Another Path-A limitation, same shape as the `channel` one in §5.**
> `posting.build_canonical()` (`backend/posting.py:727`) unconditionally sets
> `posting_date`/`ingestion_timestamp`/`last_updated_timestamp` to
> `datetime.now(timezone.utc)` — **the moment you publish, not the original
> Reddit post's date.** There is no parameter anywhere in
> `publish_posting()`/`build_canonical()` to pass a different date. Via Path
> A, a post from two months ago curated today will be stamped with today's
> date — no way around this without Path B, which can set `posting_date` to
> the real value before calling the lower-level write functions directly.

### 4. Draft tags via the existing endpoint — reading straight from the file

Call `POST /api/tag-suggest` with the title + body **extracted from the file
you saved in Step 2** — never re-typed. Request/response shapes are defined
by `TagSuggestRequest`/`TagSuggestResponse` in `backend/api.py` (lines
160–180) — no auth required, just IP rate-limiting.

`BASE_URL` is `http://localhost:8000` against a local `uvicorn` run (see
`CLAUDE.md`), or the deployed Cloud Run URL
(`https://immiguide-api-971592620882.us-central1.run.app`) against prod.

```bash
BASE_URL="http://localhost:8000"
POST_FILE="curated/h1b-rfe-approved-2026-06.md"

TITLE=$(head -n1 "$POST_FILE")
DESCRIPTION=$(tail -n +3 "$POST_FILE")

jq -n --arg title "$TITLE" --arg description "$DESCRIPTION" \
  '{title: $title, description: $description}' \
| curl -sS -X POST "$BASE_URL/api/tag-suggest" \
    -H "Content-Type: application/json" \
    -d @- \
| jq '.' | tee curated/h1b-rfe-approved-2026-06.tags.json
```

Notes on this pattern (reused in Step 5, worth understanding once):
- `head -n1` / `tail -n +3` implement the "line 1 = title, line 3+ = body"
  format from Step 2.
- `jq -n --arg ... '{...}'` builds the JSON body with **correct escaping**
  of quotes, em dashes, and embedded newlines — manually pasting long text
  into a `-d '{"...": "..."}'` string is exactly the fragile, error-prone
  approach this avoids.
- `jq ... | curl ... -d @-` pipes the JSON **directly** into curl's stdin
  (`@-` = read body from stdin). **Don't** route it through a bash variable
  and `echo` first (e.g. `BODY=$(jq ...); echo "$BODY" | curl ...`) — under
  **zsh** (the default macOS shell), `echo` interprets `\n` inside the
  variable as a real newline instead of the literal two characters `\`+`n`,
  silently corrupting the JSON. The direct pipe sidesteps this entirely and
  works identically in bash and zsh.
- **`| jq '.' | tee curated/....tags.json`** — the API's raw response is
  compact (single-line) JSON; piping it through `jq '.'` first pretty-prints
  it (2-space indented), *then* `tee` writes that pretty version to the file
  **and** echoes it to the terminal. Doing it in this order (pretty-print
  before tee, not after) matters — writing the raw response and only
  pretty-printing the terminal copy would leave the saved file
  hard to hand-edit. This file becomes Step 5's tags input after you edit it
  (see below), and doubles as a record of what the tagger originally
  drafted before your edits — worth keeping readable for both reasons.

Illustrative response shape (values are what the tagger *might* draft —
always review against the real output, not this example):

```json
{
  "groups": {
    "visa_applying_for": ["H-1B"],
    "current_visa_or_greencard_category": [],
    "primary_consulate": "",
    "consulates": [],
    "tags": ["h1b-rfe", "specialty-occupation", "experience-posting"],
    "concerns_or_questions_tags": []
  },
  "relevant_sections": ["visa_applying_for", "tags", "key_stages_or_info", "key_dates"],
  "posting_type": "experience",
  "key_stages_or_info": {"petition_stage": "RFE_response"},
  "key_dates": {"rfe_response_date": "2026-06-01"}
}
```

**Review — and hand-edit `curated/h1b-rfe-approved-2026-06.tags.json`
directly — before moving on.** This is the actual point of doing this
manually: catch anything off-vocabulary, wrong, or too aggressive before
it's published. Reddit phrasing is more likely to produce an odd tag choice
than the app's structured composer flow. Cross-check any tag you're unsure
about against the vocab files in `backend/tags-cleaned/` (e.g.
`1.6-visa-form-actions.csv` has `h1b-rfe`; `1.9-outcomes.csv` has `RFE`/`approved`).
Step 5 reads this file as-is, edits included.

The `background_summary`/`concerns_or_questions_summary` fields aren't
returned by this endpoint (they come from the same underlying `_extract()`
call inside `publish_posting()` in Step 5) — the paraphrase requirement from
D-017 applies to those, not to anything drafted here.

### 5. Publish

> **⚠️ Read this before publishing.** `POST /api/postings` →
> `posting.publish_posting()` → `posting.build_canonical()` **hardcodes**
> `channel = "app"`, `ingestion_method = "user_post"`, `subreddit = ""`,
> `reddit_post_id = ""`, and a random `case_id` (`app-<date>-<8 hex chars>`)
> — confirmed by reading `backend/posting.py` lines 721–801. There is
> currently **no way to pass Reddit provenance through this endpoint.**
> Publishing this way works, but the result is indistinguishable from a
> first-party app posting: it loses the `channel:"reddit"` search boost
> already wired (unused) in `search_client.py`, and readers/curators lose
> the "this came from Reddit" transparency the D-055 provenance design is
> built around. Pick one:

**Path A — Quick, curl-only, accepts the trade-off.** Fine for validating
the pipeline end-to-end or for a first few test postings; not recommended
for the ongoing curation cadence, since it silently mislabels every curated
post as first-party content.

This reads **both** files from Steps 2 and 4 — the raw post content and your
hand-edited tags draft — and merges them into the request, again without
retyping anything:

```bash
POST_FILE="curated/h1b-rfe-approved-2026-06.md"
TAGS_FILE="curated/h1b-rfe-approved-2026-06.tags.json"

TITLE=$(head -n1 "$POST_FILE")
DESCRIPTION=$(tail -n +3 "$POST_FILE")

jq -n \
  --arg title "$TITLE" \
  --arg description "$DESCRIPTION" \
  --slurpfile draft "$TAGS_FILE" \
  '{title: $title, description: $description,
    tags: $draft[0].groups,
    key_stages_or_info: $draft[0].key_stages_or_info,
    key_dates: $draft[0].key_dates}' \
| curl -sS -X POST "$BASE_URL/api/postings" \
    -H "Content-Type: application/json" \
    -d @- \
| python3 -m json.tool
```

`--slurpfile draft "$TAGS_FILE"` loads Step 4's (edited) response file and
`.groups`/`.key_stages_or_info`/`.key_dates` pull out exactly the fields
`PostingCreateRequest` expects — same "pipe straight into curl, no
variable/`echo` round-trip" pattern as Step 4, for the same zsh-safety
reason.

Response (`PostingCreateResponse`):

```json
{
  "case_id": "app-2026-07-22-9f3a1c02",
  "gcs_path": "gs://imm-postings-ingestion/2026-07-22/app/app-2026-07-22-9f3a1c02.md",
  "indexed": true,
  "author_handle": "..."
}
```

Note `case_id` starts with `app-`, not `reddit-` — this is the trade-off
described above.

**Path B — Recommended, preserves Reddit provenance.** Requires a small new
script (not built yet — ~40 lines, happy to write it on request) that calls
`posting._extract()` directly for the tagging draft (same call
`suggest_tags()` makes), then constructs the canonical dict itself —
mirroring `build_canonical()`'s exact field shape but setting
`channel="reddit"`, the real `subreddit`/`reddit_post_id`/`full_url`, and
`case_id = f"reddit-{posting_date}-{subreddit}-{reddit_post_id}"` (the
scheme from Step 3) — then calls `posting.validate()`,
`posting._write_gcs()`, `posting._import_to_datastore()`, and
`posting._write_bigquery()` in the same order `publish_posting()` does, just
outside the HTTP layer so the hardcoded `CHANNEL`/`case_id` never come into
play. This is real, moderate-effort work, not a config flag — flagging it
honestly rather than implying it's already possible through curl alone.

### 6. Track what's been curated
- Keep a simple running log (a checklist file, spreadsheet, or just the
  `case_id`s themselves) of which threads have been curated, to avoid
  re-curating the same post and to have a record of source threads if ever
  asked.

## Where content gets saved

Every publish (Path A or B) writes to the same three places
`posting.py`'s `publish_posting()` always writes to — nothing curation-specific
about the destinations, only about which field values land in them:

| Store | Location | What's there |
|---|---|---|
| **GCS (Cloud Storage)** | `gs://<bucket>/<posting_date>/<channel>/<case_id>.md` and `.json` (both written by `posting._write_gcs()`) | The raw Markdown body (`.md`) and the full canonical sidecar JSON (`.json`) — the source-of-truth pair per `SIDECAR-METADATA-DESIGN.md`. Bucket defaults to `imm-postings-ingestion` (env `GCP_BUCKET_NAME` overrides) |
| **Vertex AI Search (Discovery Engine)** | Datastore `imm-postings-datastore` (env `GCP_VERTEX_DATASTORE_ID`), location `global` (env `GCP_VERTEX_DATASTORE_LOCATION`), document ID = `case_id` | The same canonical JSON as `struct_data`, inline-imported via `documents.import` (`posting._import_to_datastore()`) — this is what search/retrieval actually reads |
| **BigQuery** | `<project>.postings.postings_metadata` (table auto-provisioned by `posting._ensure_bq_table()` on first write) | One row per posting, same fields as the canonical JSON, appended via `insert_rows_json` |

Concretely, for this repo's GCP project (`proceedings-490601`, per
`docs/DEPLOYMENT.md`), Path A's example response above resolves to:
- `gs://imm-postings-ingestion/2026-07-22/app/app-2026-07-22-9f3a1c02.md`
- `gs://imm-postings-ingestion/2026-07-22/app/app-2026-07-22-9f3a1c02.json`
- BigQuery row in `proceedings-490601.postings.postings_metadata` where `case_id = 'app-2026-07-22-9f3a1c02'`
- Discovery Engine document `.../dataStores/imm-postings-datastore/branches/default_branch/documents/app-2026-07-22-9f3a1c02`

(With Path B, the same three locations, just under a `reddit/` channel
prefix and a `reddit-...` `case_id` instead of `app/`/`app-...`.)

## Verification after publish

Four independent ways to confirm a curated posting actually landed —
useful because `indexed: true` in the publish response only confirms the
Discovery Engine import call *succeeded*, not that the other two writes did.

**1. In the app** — simplest check, confirms the full read path works:
```bash
curl -sS "$BASE_URL/api/postings/app-2026-07-22-9f3a1c02" | python3 -m json.tool
```
or open `<APP_BASE_URL>/case/<case_id>` in a browser (e.g.
`https://meridianjourney.ai/case/app-2026-07-22-9f3a1c02`, or the local
website dev server against the same `case_id`).

**2. GCS console** — confirm both sidecar files exist:
```
https://console.cloud.google.com/storage/browser/imm-postings-ingestion/2026-07-22/app?project=proceedings-490601
```
or via `gcloud`:
```bash
gcloud storage ls gs://imm-postings-ingestion/2026-07-22/app/ --project=proceedings-490601
```

**3. BigQuery console** — confirm the metadata row:
```
https://console.cloud.google.com/bigquery?project=proceedings-490601
```
then run:
```sql
SELECT case_id, channel, subreddit, post_title, ingestion_timestamp
FROM `proceedings-490601.postings.postings_metadata`
WHERE case_id = 'app-2026-07-22-9f3a1c02';
```

**4. Vertex AI Search / Discovery Engine** — confirm it's actually indexed
and retrievable, not just that the import call didn't error:
- Console: Google Cloud Console → **Agent Builder → Data Stores** →
  `imm-postings-datastore` → Documents tab → search by document ID.
- Or directly via the same API `posting.py` uses:
  ```bash
  PROJECT=proceedings-490601
  TOKEN=$(gcloud auth print-access-token)
  curl -sS \
    "https://discoveryengine.googleapis.com/v1/projects/$PROJECT/locations/global/collections/default_collection/dataStores/imm-postings-datastore/branches/default_branch/documents/app-2026-07-22-9f3a1c02" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Goog-User-Project: $PROJECT" | python3 -m json.tool
  ```
- Or simplest of all: search for a distinctive phrase from the posting
  through the app's own search UI/`/api/search` — if it comes back, it's
  live end-to-end (Search API indexing is typically visible within a couple
  of minutes of the inline `documents.import` call, given DS-1's ~2–12 min
  window noted in `PIPELINE-ARCHITECTURE-WORKFLOW.md`).

## Worked example

Putting Steps 1–5 together end-to-end, using the same illustrative H-1B RFE
post as above (**fictional content, written for this doc — not copied from a
real Reddit thread**; a real curation pass would start from an actual public
post):

1. **Select**: a substantive `r/h1b` post describing a full RFE-to-approval
   experience — real timeline, real outcome, not a one-line question.
2. **Capture** into `curated/h1b-rfe-approved-2026-06.md` using the
   `cat > ... << 'EOF'` command in Step 2 — a plain-text file, `.md` chosen
   here for consistency with the eventual GCS artifact, but `.txt` would
   behave identically since nothing reads the extension.
3. **Identity fields** (Step 3, Path B only — see the §3/§5 warnings):
   `channel="reddit"`, `subreddit="h1b"`, `reddit_post_id="1abc2de"` (from the
   real post URL), `full_url="https://www.reddit.com/r/h1b/comments/1abc2de/..."`,
   `ingestion_method="manual_curation"`, `posting_date="2026-06-15"` (the
   post's real creation date, two months before this curation session) →
   `case_id = "reddit-2026-06-15-h1b-1abc2de"`. Via Path A, none of this is
   achievable — `posting_date` would land as today's date and provenance
   fields as `channel="app"`, regardless of what you intend.
4. **Draft tags**: run Step 4's `jq | curl -d @- | tee ...tags.json` command,
   reading `curated/h1b-rfe-approved-2026-06.md` and writing
   `curated/h1b-rfe-approved-2026-06.tags.json`; open that file and review/edit
   it against `backend/tags-cleaned/` before proceeding.
5. **Publish**: run Step 5's command, which reads *both* the `.md` and the
   (now hand-edited) `.tags.json` file — Path A (curl-only) lands as
   `app-2026-07-22-...`, dated today rather than the post's real 2026-06-15
   date; Path B (once built) would land it correctly as
   `reddit-2026-06-15-h1b-1abc2de`, dated `2026-06-15`, with full provenance.
6. **Verify** using any of the four checks above, substituting the real
   `case_id` from the publish response.
7. **Log** `reddit-2026-06-15-h1b-1abc2de` (or the `app-...` ID if Path A was
   used) in the curation tracking log (Step 6) so this exact post isn't
   re-curated later.

## Suggested cadence

This doesn't scale (per `REDDIT-INGESTION-ALTERNATIVES.md`'s own assessment
of option 1-C), and isn't meant to — treat it as a **quality-seeding**
activity, not a volume strategy. A sustainable solo-curator pace is a
handful of well-chosen postings per week across the 2-3 subreddits, which is
also roughly in line with this pilot's intentionally narrow scope.

## Relationship to the other options under evaluation

Run this **in parallel**, not instead of, the Apify/API-access track — they
serve different purposes. Manual curation gets a small amount of
high-quality, zero-legal-risk content in immediately; Apify (pending legal
sign-off) or the official API (pending approval) are what would eventually
give ongoing, automated coverage at a sustainable cadence. See
[`REDDIT-INGESTION-ALTERNATIVES.md §7.4`](REDDIT-INGESTION-ALTERNATIVES.md#74-updated-recommendation)
for how all the options fit together.
