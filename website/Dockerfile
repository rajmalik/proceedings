# Next.js (standalone) image for Cloud Run — frontend `immiguide-web`.
# Built by `gcloud run deploy immiguide-web --source website`.

# ---- deps ----
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
# Bake the backend origin so build-time prerender of ISR routes (e.g. /api/users)
# fetches the real backend and caches the correct response. Runtime --set-env-vars
# also provides it. Bare origin, NO trailing /api (apiBase() also normalizes it).
ENV PYTHON_API_URL=https://immiguide-api-971592620882.us-central1.run.app
# Firebase web config — PUBLIC by design (Next.js inlines NEXT_PUBLIC_* into the
# client bundle, so these MUST exist at BUILD time). The Firebase web apiKey is
# not a secret: it ships in every client and is gated by Auth rules + Authorized
# domains, not secrecy. ARG defaults keep `--source` deploys working; override
# per-env with --build-arg if ever needed.
ARG NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyDP54OKGTYch6BtKOLRCPDZJzooP1XOPnU
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=proceedings-490601.firebaseapp.com
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID=proceedings-490601
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=proceedings-490601.firebasestorage.app
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=971592620882
ARG NEXT_PUBLIC_FIREBASE_APP_ID=1:971592620882:web:47b14e2e710fd940def88b
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID
# AI Assist feature flag — inlined at build time (Q5/Q10). Ships OFF; a deploy
# passes --build-arg NEXT_PUBLIC_AI_ASSIST_ENABLED=1 to turn it on.
ARG NEXT_PUBLIC_AI_ASSIST_ENABLED=0
ENV NEXT_PUBLIC_AI_ASSIST_ENABLED=$NEXT_PUBLIC_AI_ASSIST_ENABLED
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- run ----
FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV PYTHON_API_URL=https://immiguide-api-971592620882.us-central1.run.app
# Standalone server bundle + static assets + public/ (favicon, og-image, logo).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
