#!/usr/bin/env bash
# Long commands (state 4 transcode, whisper, 7 --render) run detached, so an ssh drop or the
# agent's terminal timeout does not kill them.
#   box/job.sh start <project|-> <base64 command>   -> prints the job id
#   box/job.sh status <id>                           -> running / exit N, plus the log tail
#   box/job.sh running                               -> ids of running jobs (exit 1 if none)
#   box/job.sh list
source "$(dirname "$0")/lib.sh"
mkdir -p "$JOBS"

alive() { [ -f "$JOBS/$1/pid" ] && kill -0 "$(cat "$JOBS/$1/pid")" 2>/dev/null; }

case "${1:-}" in
  start)
    id="$(date +%Y%m%d-%H%M%S)-$RANDOM"
    d="$JOBS/$id"
    mkdir -p "$d"
    printf '%s' "$3" | base64 -d > "$d/cmd"
    echo "$2" > "$d/project"
    setsid nohup bash -c "bash '$REPO_DIR/box/run.sh' '$2' '$3' > '$d/log' 2>&1; echo \$? > '$d/exit'" > /dev/null 2>&1 &
    echo $! > "$d/pid"
    echo "$id"
    ;;
  status)
    d="$JOBS/${2:?job id}"
    [ -d "$d" ] || { echo "no job $2"; exit 2; }
    echo "job $2: $(cat "$d/cmd")"
    if alive "$2"; then echo "RUNNING since $(stat -c %y "$d/cmd" | cut -d. -f1)"; elif [ -f "$d/exit" ]; then echo "FINISHED exit $(cat "$d/exit")"; else echo "DIED (no exit code: the codespace may have stopped mid-run; rerun it)"; fi
    echo "--- last lines of the log ---"
    tail -n "${3:-40}" "$d/log" 2>/dev/null || true
    ;;
  running)
    found=1
    for d in "$JOBS"/*/; do
      [ -d "$d" ] || continue
      id="$(basename "$d")"
      if alive "$id"; then echo "$id"; found=0; fi
    done
    exit $found
    ;;
  list)
    for d in "$JOBS"/*/; do
      [ -d "$d" ] || continue
      id="$(basename "$d")"
      st="$(alive "$id" && echo running || { [ -f "$d/exit" ] && echo "exit $(cat "$d/exit")" || echo died; })"
      echo "$id  $st  $(cat "$d/cmd")"
    done
    ;;
  *)
    echo "usage: box/job.sh start <p|-> <b64> | status <id> [lines] | running | list" >&2
    exit 2
    ;;
esac
