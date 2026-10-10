#!/usr/bin/env bash
# Once per codespace: the whisper model, HyperFrames' browser, the asset library. Leaves
# /workspaces/.box-ready when everything worked (renderbox waits for it).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f /workspaces/.box-ready

MODEL=tools/models/ggml-large-v3-turbo.bin
if [ ! -s "$MODEL" ]; then
  mkdir -p tools/models
  echo "downloading the whisper model (1.6 GB)…"
  curl -fL --retry 5 -o "$MODEL.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
  mv "$MODEL.part" "$MODEL"
fi

HF="$(node -e 'import("./.claude/skills/traced-edit/scripts/lib/paths.mjs").then(m=>console.log(m.DEFAULT_HF))')"
echo "HyperFrames $HF: fetching its browser…"
npx --yes "hyperframes@$HF" browser ensure
npx --yes "hyperframes@$HF" doctor || echo "(doctor reported problems; see above)"

bash box/sync.sh assets

touch /workspaces/.box-ready
echo "render box ready."
