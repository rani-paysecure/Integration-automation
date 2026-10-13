#!/usr/bin/env bash
# Deploys the Test Launcher to the team server with Docker.
#   deploy/deploy.sh                       → gautam@23.29.114.29, folder /opt/app
#   deploy/deploy.sh user@host some/folder
# Needs: your SSH access to the server; Docker + "docker compose" on the server;
#        .env.server created ON THE SERVER once (see .env.server.example).
# Uploads the code only – never .env, testers, settings, reports or videos.
set -euo pipefail
TARGET="${1:-gautam@23.29.114.29}"
DIR="${2:-/opt/app}"
cd "$(dirname "$0")/.."

echo "→ Uploading code to $TARGET:$DIR"
# /opt/app must exist and belong to the SSH user (once: sudo mkdir -p /opt/app && sudo chown \$USER /opt/app).
ssh "$TARGET" "test -d '$DIR' && test -w '$DIR' || { echo '  $DIR is missing or not writable – run once on the server: sudo mkdir -p $DIR && sudo chown \$USER $DIR'; exit 1; }"
rsync -az --delete \
  --exclude='.git' --exclude='node_modules' \
  --exclude='.env' --exclude='.env.server' --exclude='.env.local' \
  --exclude='profiles.local.json' --exclude='settings.local.json*' \
  --exclude='reports/' --exclude='test-results/' --exclude='playwright-report/' --exclude='blob-report/' \
  --exclude='playwright/.auth/' --exclude='playwright/.cache/' \
  --exclude='Claude outputs/' --exclude='*.mp4' --exclude='*.mov' --exclude='*.webm' --exclude='*.part' \
  --exclude='.DS_Store' --exclude='.idea/' --exclude='.vscode/' \
  ./ "$TARGET:$DIR/"

echo "→ Building and starting on the server"
ssh "$TARGET" "cd '$DIR' && \
  if [ ! -f .env.server ]; then echo '  .env.server is missing on the server – create it from .env.server.example (login user + password hash), then run this again.'; exit 1; fi && \
  docker compose up -d --build && docker compose ps"

echo "→ Waiting for the launcher to be healthy"
ssh "$TARGET" "for i in \$(seq 1 30); do \
    s=\$(docker inspect -f '{{.State.Health.Status}}' qa-launcher 2>/dev/null || echo missing); \
    [ \"\$s\" = healthy ] && { echo '  healthy'; exit 0; }; sleep 5; \
  done; echo '  not healthy after 150 s – last log lines:'; docker logs --tail 40 qa-launcher; exit 1"

echo "✓ Open http://${TARGET#*@}:4173 and sign in with the team login."
