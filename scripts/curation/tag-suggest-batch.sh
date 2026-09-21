#!/usr/bin/env bash
set -uo pipefail
# Deliberately NOT `set -e` — one file's failure (e.g. a transient Gemini 429
# / RESOURCE_EXHAUSTED) shouldn't abort the whole batch; each file is handled
# independently and failures are summarized at the end.

# Batch version of tag-suggest.sh: draft tags for every .txt post in a
# folder, writing "<name>.tags.json" next to each "<name>.txt" — same naming
# publish-batch.sh already expects, so no renaming needed before publishing.
# See docs/ingestion/MANUAL-CURATION-PLAYBOOK.md for the full workflow.
#
# Usage: ./tag-suggest-batch.sh <path-to-folder>
#   e.g. ./tag-suggest-batch.sh ~/curated/072226
#
# NOTE: resolves the folder argument relative to your CURRENT working
# directory, not this script's location — since the working content folder
# is expected to live outside this repo (see MANUAL-CURATION-PLAYBOOK.md on
# why it's git-ignored), run this with an absolute path, or a relative one
# from wherever your content folder actually is.

# Points at production — every call this script makes reaches the live
# backend (read-only/no side effects per /api/tag-suggest's own docstring,
# but still real Gemini calls against real quota). Swap to
# "http://localhost:8000" for local testing.
BASE_URL="https://immiguide-api-971592620882.us-central1.run.app"

# Seconds to wait between calls — a small buffer against the per-minute
# Gemini quota exhaustion (429 RESOURCE_EXHAUSTED). Increase if a batch
# still hits 429s.
SLEEP_BETWEEN=2

DATE_DIR="${1:-}"
if [ -z "$DATE_DIR" ]; then
  echo "Usage: $0 <path-to-folder>   e.g. $0 ~/curated/072226" >&2
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
echo

FAILED=()
i=0
for POST_FILE in "${TXT_FILES[@]}"; do
  i=$((i + 1))
  BASENAME=$(basename "$POST_FILE" .txt)
  TAGS_FILE="${DATE_DIR}/${BASENAME}.tags.json"
  TMP_FILE="${TAGS_FILE}.tmp"

  echo "[$i/${#TXT_FILES[@]}] $POST_FILE"

  TITLE=$(head -n1 "$POST_FILE")
  DESCRIPTION=$(tail -n +3 "$POST_FILE")

  # Pipeline (with pipefail) fails if curl can't connect OR the response
  # isn't parseable JSON. The `has("groups")` check additionally catches
  # well-formed-but-wrong JSON — e.g. a {"detail": "..."} validation/error
  # body, which parses fine but isn't a real TagSuggestResponse.
  if jq -n --arg title "$TITLE" --arg description "$DESCRIPTION" \
       '{title: $title, description: $description}' \
     | curl -sS -X POST "$BASE_URL/api/tag-suggest" \
         -H "Content-Type: application/json" \
         -d @- \
     | jq '.' > "$TMP_FILE" 2>/dev/null \
     && jq -e 'has("groups")' "$TMP_FILE" > /dev/null 2>&1
  then
    mv "$TMP_FILE" "$TAGS_FILE"
    echo "    -> $TAGS_FILE"
  else
    rm -f "$TMP_FILE"
    echo "    FAILED (see response above, or re-run this file alone via tag-suggest.sh to debug)" >&2
    FAILED+=("$POST_FILE")
  fi

  if [ "$i" -lt "${#TXT_FILES[@]}" ]; then
    sleep "$SLEEP_BETWEEN"
  fi
done

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "Done with ${#FAILED[@]} failure(s) out of ${#TXT_FILES[@]}:"
  printf '  %s\n' "${FAILED[@]}"
  exit 1
fi
echo "Done — all ${#TXT_FILES[@]} file(s) processed successfully."
