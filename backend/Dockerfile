FROM python:3.13-slim

# Unbuffered stdout/stderr — without this, print() output is block-buffered
# (not a TTY) and never flushes before a killed/timed-out request, which is
# exactly what made a real production hang in /internal/gov-news/poll
# undiagnosable from Cloud Run logs alone (2026-07-27).
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# An explicit allowlist, so nothing unexpected ships. The cost is that a NEW
# module is invisible until something imports it at runtime — attribute_config
# was missed here and would have ImportError'd on the first /api/tag-vocab
# call in prod. tests/test_packaging.py now fails if this line falls behind.
COPY api.py assist.py query.py search_client.py posting.py profile.py reconcile.py interactions.py matching.py group_messages.py moderation.py news_sources.py gov_news_poll.py official_reference_poll.py attribute_config.py seed_users.json ./
COPY tags-cleaned/ ./tags-cleaned/
# The Timeline attribute base config. Firestore overrides it at runtime; this
# is what serves until something is published, and what --from-default seeds.
COPY config/ ./config/

EXPOSE 8080

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8080"]
