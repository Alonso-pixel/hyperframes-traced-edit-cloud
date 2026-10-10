#!/usr/bin/env bash
# Bring a file the user uploaded (r2:incoming/<p>/<file>, via the upload page) into a project.
#   box/ingest.sh <project> <incoming-key> --none      footage with no voice: a new project (mode none)
#   box/ingest.sh <project> <incoming-key> --media     footage-first new project, or the planned on-camera take
#   box/ingest.sh <project> <incoming-key> --voice     the voiceover (footage mode)
#   box/ingest.sh <project> <incoming-key> --context   a reference image/clip for state 1
source "$(dirname "$0")/lib.sh"
p="${1:?project}"; key="${2:?incoming key}"; how="${3:?--none|--media|--voice|--context}"
check_project "$p"
bash box/sync.sh pull "$p"
tmp="/workspaces/.ingest/$p"
file="$(bash box/sync.sh fetch "$key" "$tmp")"
[ -f "$file" ] || { echo "box: $key is not in R2" >&2; exit 2; }

set +e
case "$how" in
  --none)    node "$S/init.mjs" "$file" "videos/$p" ;;
  --media)   node "$S/init.mjs" "videos/$p" --media "$file" ;;
  --voice)   node "$S/init.mjs" "videos/$p" --voice "$file" ;;
  --context)
    d="$(ls -d "videos/$p/states/1script"* 2>/dev/null | head -1)"
    [ -n "$d" ] || { echo "box: videos/$p has no state 1 folder yet: create the project first" >&2; exit 2; }
    mkdir -p "$d/context" && cp "$file" "$d/context/" && echo "added $d/context/$(basename "$file")" ;;
  *) echo "box: unknown $how" >&2; exit 2 ;;
esac
rc=$?
set -e
rm -rf "$tmp"
bash box/sync.sh push "$p"
exit $rc
