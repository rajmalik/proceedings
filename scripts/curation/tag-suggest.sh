#!/usr/bin/env bash
set -euo pipefail

# Draft tags for ONE post via /api/tag-suggest, writing the (pretty-printed)
# response to "<name>.tags.json" next to "<name>.txt" for hand-review/editing
# before publish.sh runs. See docs/ingestion/MANUAL-CURATION-PLAYBOOK.md for
# the full workflow this implements.
#
# Usage: ./tag-suggest.sh <path-to-post.txt>
#   e.g. ./tag-suggest.sh ~/curated/072226/h1b-cos-timeline.txt
#
# Points at production — every call this script makes reaches the live
# backend. Swap BASE_URL to "http://localhost:8000" for local testing.
BASE_URL="https://immiguide-api-971592620882.us-central1.run.app"

POST_FILE="${1:-}"
if [ -z "$POST_FILE" ]; then
  echo "Usage: $0 <path-to-post.txt>" >&2
  exit 1
fi
if [ ! -f "$POST_FILE" ]; then
  echo "Error: '$POST_FILE' not found" >&2
  exit 1
fi

TAGS_FILE="${POST_FILE%.txt}.tags.json"

TITLE=$(head -n1 "$POST_FILE")
DESCRIPTION=$(tail -n +3 "$POST_FILE")

# jq builds the request body with correct escaping (quotes, em dashes,
# embedded newlines) and pipes it directly into curl's stdin (-d @-) — never
# route JSON through a bash variable + echo first; under zsh, echo
# interprets \n inside the variable as a real newline and corrupts it.
jq -n --arg title "$TITLE" --arg description "$DESCRIPTION" \
  '{title: $title, description: $description}' \
| curl -sS -X POST "$BASE_URL/api/tag-suggest" \
    -H "Content-Type: application/json" \
    -d @- \
| jq '.' | tee "$TAGS_FILE"
