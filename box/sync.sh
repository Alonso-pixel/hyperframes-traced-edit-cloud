#!/usr/bin/env bash
# Move files between this Codespace and R2. The Codespace is the only writer of projects/.
#   box/sync.sh assets            r2:assets -> videos/ASSETS (incremental; run on every start)
#   box/sync.sh pull <project>    r2:projects/<p> -> videos/<p>, only if it is not here yet
#   box/sync.sh push <project>    videos/<p> -> r2:projects/<p> (+ new music profiles -> r2:assets)
#   box/sync.sh fetch <r2-key> <dir>   copy one object (e.g. incoming/<p>/<file>) into <dir>
source "$(dirname "$0")/lib.sh"
need_r2
cmd="${1:-}"

case "$cmd" in
  assets)
    mkdir -p videos/ASSETS
    exec 9>/tmp/assets.lock
    flock 9
    rclone copy "$R2/assets" videos/ASSETS --fast-list --transfers 16 --checkers 32 --update -q
    date -Is > /workspaces/.assets-synced
    echo "assets in sync ($(du -sh videos/ASSETS | cut -f1))"
    ;;
  pull)
    check_project "$2"
    # wait for a start-up asset sync that is still running
    exec 9>/tmp/assets.lock; flock 9; exec 9>&-
    if [ -d "videos/$2" ]; then exit 0; fi
    if rclone lsf "$R2/projects/$2" --max-depth 1 -q | grep -q .; then
      echo "restoring videos/$2 from R2…"
      rclone copy "$R2/projects/$2" "videos/$2" --fast-list --transfers 16 -q
    fi
    ;;
  push)
    check_project "$2"
    [ -d "videos/$2" ] || exit 0
    rclone sync "videos/$2" "$R2/projects/$2" --fast-list --transfers 16 -q \
      --exclude ".previews.json" --exclude ".review.json" --exclude "review-server.log"
    rclone copy videos/ASSETS/music "$R2/assets/music" --include "*.profile.json" -q
    ;;
  fetch)
    [[ "$2" =~ ^incoming/[A-Za-z0-9._-]+/[^/]+$ ]] || { echo "box: fetch only takes incoming/<project>/<file>" >&2; exit 2; }
    mkdir -p "$3"
    rclone copy "$R2/$2" "$3" -q
    echo "$3/$(basename "$2")"
    ;;
  *)
    echo "usage: box/sync.sh assets | pull <p> | push <p> | fetch <incoming-key> <dir>" >&2
    exit 2
    ;;
esac
