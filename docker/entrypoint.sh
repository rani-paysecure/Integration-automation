#!/bin/sh
# First start: seed the data volume from the image (the repo's committed cases, bank profiles,
# 3DS flow files). Later starts keep what the team changed on the server – existing files are
# never overwritten.
set -e
mkdir -p /data/uploaded-cases /data/psp-flows

for f in /app/tests/test-data/uploaded-cases/*.json; do
  [ -e "$f" ] || continue
  [ -e "/data/uploaded-cases/$(basename "$f")" ] || cp "$f" /data/uploaded-cases/
done
[ -e /data/bank-profiles.json ] || { [ -e /app/config/bank-profiles.json ] && cp /app/config/bank-profiles.json /data/bank-profiles.json; } || true
if [ -d /app/psp-flows ]; then
  cp -rn /app/psp-flows/. /data/psp-flows/ 2>/dev/null || true
fi

# Tokens saved in the UI (AI gateway, Jira) go to .env – keep it in the volume, never in the image.
[ -e /data/.env ] || { touch /data/.env && chmod 600 /data/.env; }
ln -sf /data/.env /app/.env

exec node tools/launcher/server.js --no-open
