#!/usr/bin/env bash
# Local Android release helper: preflight checks + EAS build (+ optional submit).
#
# Usage:
#   ./scripts/release-android.sh <preview|production> [--submit]
#
# See docs/MOBILE-PLAY-STORE-DEPLOYMENT.md for the full release flow and the
# one-time EAS/Google credential setup this script assumes is already done.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-}"
SUBMIT=false
for arg in "$@"; do
  if [ "$arg" = "--submit" ]; then
    SUBMIT=true
  fi
done

if [[ "$PROFILE" != "preview" && "$PROFILE" != "production" ]]; then
  echo "Usage: $0 <preview|production> [--submit]" >&2
  exit 1
fi

echo "==> Preflight: eas-cli auth"
if ! npx --yes eas-cli whoami >/dev/null 2>&1; then
  echo "Not logged in to EAS. Run: npx eas-cli login" >&2
  exit 1
fi
npx eas-cli whoami

echo "==> Preflight: git status (must be clean)"
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes — commit or stash before an EAS release build." >&2
  git status --short
  exit 1
fi

echo "==> Preflight: unit tests"
npm test -- --ci

echo "==> Preflight: current version"
npx expo config --json 2>/dev/null | node -e "
  let d = '';
  process.stdin.on('data', (c) => (d += c));
  process.stdin.on('end', () => {
    const cfg = JSON.parse(d);
    console.log('  version=' + cfg.version + '  android.versionCode=' + (cfg.android && cfg.android.versionCode) + '  package=' + (cfg.android && cfg.android.package));
  });
"
read -r -p "Confirm this is the version you intend to ship (see docs/RELEASE-TAGGING.md). Continue? [y/N] " ans
if [[ ! "$ans" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

BUILD_ARGS=(build --platform android --profile "$PROFILE" --non-interactive)
if $SUBMIT; then
  BUILD_ARGS+=(--auto-submit)
  echo "==> npx eas-cli ${BUILD_ARGS[*]}  (will build, then submit to Google Play on success)"
else
  echo "==> npx eas-cli ${BUILD_ARGS[*]}"
fi
npx eas-cli "${BUILD_ARGS[@]}"

echo "==> Done. See the EAS dashboard link above for build/submit status."
if $SUBMIT; then
  echo "==> Next: Play Console → confirm the release landed on the configured track (internal, unless changed) → promote through testing tracks per docs/MOBILE-PLAY-STORE-DEPLOYMENT.md §4."
fi
