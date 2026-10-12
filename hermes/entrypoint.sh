#!/usr/bin/env bash
# Seeds /opt/data (the Railway volume) on every boot, then hands over to Hermes' own entrypoint.
#  - config.yaml: copied only if missing (so `hermes model` changes survive), or always when
#    HERMES_CONFIG_FORCE=1.
#  - renderbox/env: the secrets renderbox and upload-link need. Hermes strips secrets from
#    terminal and cron subprocesses, so they read this file (mode 600, owner hermes).
#  - the reaper cron job: created once.
set -euo pipefail
D="${HERMES_HOME:-/opt/data}"
U="hermes"
mkdir -p "$D/scripts" "$D/renderbox" "$D/cache/renderbox"

if [ ! -f "$D/config.yaml" ] || [ "${HERMES_CONFIG_FORCE:-0}" = "1" ]; then
  [ -f "$D/config.yaml" ] && cp "$D/config.yaml" "$D/config.yaml.bak.$(date +%s)"
  cp /opt/traced-edit/seed/config.yaml "$D/config.yaml"
  echo "seeded $D/config.yaml"
fi
cp /opt/traced-edit/seed/scripts/* "$D/scripts/"

umask 077
{
  for k in GH_TOKEN CODESPACE_REPO CODESPACE_MACHINE CODESPACE_DISPLAY_NAME RENDERBOX_IDLE_MIN UPLOAD_HMAC_SECRET WORKER_BASE_URL; do
    [ -n "${!k:-}" ] && printf '%s=%q\n' "$k" "${!k}"
  done
} > "$D/renderbox/env"
umask 022

# Antigravity CLI: API-key mode when GEMINI_API_KEY is set.
if [ -n "${GEMINI_API_KEY:-}" ] && [ ! -f "$D/.gemini/antigravity-cli/settings.json" ]; then
  mkdir -p "$D/.gemini/antigravity-cli"
  echo '{"modelProvider": "gemini"}' > "$D/.gemini/antigravity-cli/settings.json"
fi

# The volume mounts root-owned; the hermes user must own the whole tree (cron, sessions, memory).
# chown on the volume persists, so this heals old root-owned stragglers and is idempotent on boots.
chown -R "$U:$U" "$D" 2>/dev/null || true

# The reaper: every 30 min, stop the codespace when idle. Script-only (no LLM call); it prints
# (and so messages you) only when it stopped the box.
HERMES_BIN="$(command -v hermes || echo /opt/hermes/.venv/bin/hermes)"
as_hermes() { runuser -u "$U" -- env HOME="$D" HERMES_HOME="$D" "$@"; }
if [ -x "$HERMES_BIN" ] && ! as_hermes "$HERMES_BIN" cron list 2>/dev/null | grep -q renderbox-reap; then
  as_hermes "$HERMES_BIN" cron create "every 30m" --no-agent --script renderbox-reap.sh --deliver telegram --name renderbox-reap \
    || echo "WARNING: could not create the renderbox-reap cron job; create it from the chat"
fi

exec /opt/hermes/docker/entrypoint-dispatch.sh "$@"
