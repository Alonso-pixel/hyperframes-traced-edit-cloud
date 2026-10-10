#!/usr/bin/env bash
# Hermes cron (script-only): stop the render codespace after RENDERBOX_IDLE_MIN idle minutes.
# Prints only when it stopped it; empty output sends no Telegram message.
out="$(/usr/local/bin/renderbox reap 2>/dev/null || true)"
case "$out" in
  stopped*) echo "🛑 Apagué la caja de render: $out. Se vuelve a encender sola cuando me pidas algo." ;;
esac
