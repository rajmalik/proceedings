#!/usr/bin/env bash
set -uo pipefail
# Deliberately NOT `set -e` — one file's failure shouldn't abort the whole
# batch; each file is handled independently and results are summarized at
# the end (same reasoning as tag-suggest-batch.sh).

# Batch version of publish.sh: publish every .txt post in a folder that
# already has a reviewed "<name>.tags.json" (from tag-suggest.sh /
# tag-suggest-batch.sh), writing "<name>.published.json" with the API
# response (case_id, gcs_path, indexed, author_handle) next to each pair.
# See docs/ingestion/MANUAL-CURATION-PLAYBOOK.md for the full workflow.
#
# Publishing is NOT idempotent — re-running creates a DUPLICATE posting for
# the same content, unlike tag-suggest which is a pure read. To guard
# against accidentally re-publishing on a second run, any file that already
# has a "<name>.published.json" is SKIPPED by default; pass --force to
# republish anyway.
#
# Usage: ./publish-batch.sh <path-to-folder> [--force]
#   e.g. ./publish-batch.sh ~/curated/072226
#        ./publish-batch.sh ~/curated/072226 --force
#
# NOTE: resolves the folder argument relative to your CURRENT working
# directory, not this script's location — since the working content folder
# is expected to live outside this repo (see MANUAL-CURATION-PLAYBOOK.md on
# why it's git-ignored), run this with an absolute path, or a relative one
# from wherever your content folder actually is.

# Points at production — running this script publishes for real into the
# live datastore. Swap to "http://localhost:8000" for local testing.
BASE_URL="https://immiguide-api-971592620882.us-central1.run.app"

# Seconds to wait between calls — publish_posting() also calls Gemini
# internally (for the context/summary extraction), so it's subject to the
# same per-minute quota as tag-suggest. Increase if a batch hits 429s.
SLEEP_BETWEEN=2

DATE_DIR="${1:-}"
FORCE=0
if [ "${2:-}" = "--force" ]; then
  FORCE=1
fi

if [ -z "$DATE_DIR" ]; then
  echo "Usage: $0 <path-to-folder> [--force]   e.g. $0 ~/curated/072226" >&2
  exit 1
fi

if [ ! -d "$DATE_DIR" ]; then
  echo "Error: directory '$DATE_DIR' not found (looked relative to $(pwd))" >&2
  exit 1
fi

shopt -s nullglob
TXT_FILES=("$DATE_DIR"/*.txt)
shopt -u nullglob

if [ ${#TXT_FILES[@]} -eq 0 ]; then
  echo "No .txt files found in $DATE_DIR" >&2
  exit 1
fi

echo "Found ${#TXT_FILES[@]} .txt file(s) in $DATE_DIR"
[ "$FORCE" -eq 1 ] && echo "(--force: republishing even if already published)"
echo

PUBLISHED=()
SKIPPED=()
FAILED=()
i=0
for POST_FILE in "${TXT_FILES[@]}"; do
  i=$((i + 1))
  BASENAME=$(basename "$POST_FILE" .txt)
  TAGS_FILE="${DATE_DIR}/${BASENAME}.tags.json"
  RESULT_FILE="${DATE_DIR}/${BASENAME}.published.json"
  TMP_FILE="${RESULT_FILE}.tmp"

  echo "[$i/${#TXT_FILES[@]}] $POST_FILE"

  if [ ! -f "$TAGS_FILE" ]; then
    echo "    SKIPPED — no $TAGS_FILE yet (run tag-suggest-batch.sh first)"
    SKIPPED+=("$POST_FILE (no tags file)")
    continue
  fi

  if [ -f "$RESULT_FILE" ] && [ "$FORCE" -ne 1 ]; then
    EXISTING_CASE_ID=$(jq -r '.case_id // "unknown"' "$RESULT_FILE" 2>/dev/null)
    echo "    SKIPPED — already published as $EXISTING_CASE_ID (pass --force to republish)"
    SKIPPED+=("$POST_FILE (already published as $EXISTING_CASE_ID)")
    continue
  fi

  TITLE=$(head -n1 "$POST_FILE")
  DESCRIPTION=$(tail -n +3 "$POST_FILE")

  # Pipeline (with pipefail) fails if curl can't connect OR the response
  # isn't parseable JSON. The `has("case_id")` check additionally catches
  # well-formed-but-wrong JSON — e.g. a {"detail": "..."} validation/error
  # body (422/500), which parses fine but isn't a real PostingCreateResponse.
  if jq -n \
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
     | jq '.' > "$TMP_FILE" 2>/dev/null \
     && jq -e 'has("case_id")' "$TMP_FILE" > /dev/null 2>&1
  then
    mv "$TMP_FILE" "$RESULT_FILE"
    CASE_ID=$(jq -r '.case_id' "$RESULT_FILE")
    echo "    -> published as $CASE_ID ($RESULT_FILE)"
    PUBLISHED+=("$POST_FILE -> $CASE_ID")
  else
    rm -f "$TMP_FILE"
    echo "    FAILED (see response above, or re-run this file alone via publish.sh to debug)" >&2
    FAILED+=("$POST_FILE")
  fi

  if [ "$i" -lt "${#TXT_FILES[@]}" ]; then
    sleep "$SLEEP_BETWEEN"
  fi
done

echo
echo "Published: ${#PUBLISHED[@]}   Skipped: ${#SKIPPED[@]}   Failed: ${#FAILED[@]}"
if [ ${#PUBLISHED[@]} -gt 0 ]; then
  printf '  + %s\n' "${PUBLISHED[@]}"
fi
if [ ${#SKIPPED[@]} -gt 0 ]; then
  printf '  - %s\n' "${SKIPPED[@]}"
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  echo
  echo "FAILED:"
  printf '  %s\n' "${FAILED[@]}"
  exit 1
fi
