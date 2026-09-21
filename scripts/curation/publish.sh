#!/usr/bin/env bash
set -euo pipefail

# Publish ONE post via /api/postings, reading "<name>.txt" + the reviewed
# "<name>.tags.json" that tag-suggest.sh produced. Run tag-suggest.sh first —
# this fails loudly (set -e) if the tags file doesn't exist yet, instead of
# silently publishing with missing/garbage tags. See
# docs/ingestion/MANUAL-CURATION-PLAYBOOK.md for the full workflow.
#
# Usage: ./publish.sh <path-to-post.txt>
#   e.g. ./publish.sh ~/curated/072226/h1b-cos-timeline.txt
#
# Points at production — running this script publishes for real into the
# live datastore. Swap BASE_URL to "http://localhost:8000" for local testing.
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
| jq '.'
