#!/usr/bin/env bash
# Run one command from the workspace root, with the project restored before and saved after.
#   box/run.sh <project|-> <base64 command>
# The command arrives base64-encoded so no quoting survives two shells and an ssh hop.
source "$(dirname "$0")/lib.sh"
proj="$1"
cmdline="$(printf '%s' "$2" | base64 -d)"

if [ "$proj" != "-" ]; then
  check_project "$proj"
  bash box/sync.sh pull "$proj"
fi

set +e
bash -lc "export S='$S'; $cmdline"
rc=$?
set -e

if [ "$proj" != "-" ]; then
  bash box/sync.sh push "$proj" || echo "box: WARNING the project was not saved to R2 (rerun: box/sync.sh push $proj)" >&2
fi
exit $rc
