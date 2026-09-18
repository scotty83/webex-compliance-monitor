#!/usr/bin/env bash
# Build the NAS deployment zip from the committed tree. `git archive HEAD`
# includes ONLY tracked files -> no node_modules, no .git, no dist, and never
# backend/.env (untracked). Secrets travel via a separate user-run scp.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git diff-index --quiet HEAD --; then
  echo "WARNING: uncommitted changes — the zip is built from HEAD, not the working tree." >&2
fi

SHA="$(git rev-parse --short HEAD)"
mkdir -p dist-deploy
OUT="dist-deploy/webex-compliance-monitor-src-${SHA}.zip"
git archive --format=zip --output "$OUT" HEAD
echo "wrote $OUT"

LIST="$(unzip -l "$OUT")"

# Deploy-critical files must be present.
for f in Dockerfile .dockerignore docker-compose.example.yml \
         docker/entrypoint.sh backend/package-lock.json frontend/package-lock.json \
         backend/.env.example; do
  if ! echo "$LIST" | grep -q " ${f}\$"; then
    echo "FAIL: ${f} missing from zip" >&2; exit 1
  fi
done

# Deploy-critical source trees must be present.
for d in docker backend/src frontend/src; do
  if ! echo "$LIST" | grep -q " ${d}/"; then
    echo "FAIL: ${d}/ missing from zip" >&2; exit 1
  fi
done

# Secrets and junk must be absent.
for bad in "node_modules" " backend/\.env\$" "\.git/" " data/"; do
  if echo "$LIST" | grep -Eq "$bad"; then
    echo "FAIL: forbidden path matching '${bad}' found in zip" >&2; exit 1
  fi
done

# No .env* entries at all — the sole allowed exception is the tracked
# *.env.example reference file(s).
if echo "$LIST" | grep -E "[ /]\.env" | grep -Ev "\.env(\..+)?\.example$" | grep -q .; then
  echo "FAIL: unexpected .env* entry found in zip" >&2; exit 1
fi

echo "zip contents OK (source only — no secrets, no node_modules, no .git)"
