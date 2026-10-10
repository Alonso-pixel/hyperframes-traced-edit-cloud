#!/usr/bin/env bash
# After `run.mjs <p> 7 --render`: upload the render to r2:renders/<p>/ and make a copy small
# enough for Telegram (bots can send at most 50 MB).
#   box/deliver.sh <project>   -> prints  R2KEY=…  PREVIEW=/workspaces/.deliver/<p>-telegram.mp4
source "$(dirname "$0")/lib.sh"
need_r2
p="${1:?project}"
check_project "$p"

out="$(node -e 'try{console.log(require(process.argv[1]).output||"video.mp4")}catch{console.log("video.mp4")}' "$REPO_DIR/videos/$p/deliverables/deliver.json")"
src="videos/$p/deliverables/$out"
[ -f "$src" ] || { echo "box: no render at $src. Run state 7 with --render first (after the user approved state 7)." >&2; exit 2; }

stamp="$(date +%Y%m%d-%H%M)"
key="renders/$p/$p-$stamp.mp4"
rclone copyto "$src" "$R2/$key" -q

mkdir -p /workspaces/.deliver
small="/workspaces/.deliver/$p-telegram.mp4"
dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")"
# 45 MB budget, 128 kb/s audio, the rest video; never above the source's quality need (6 Mb/s).
vk="$(awk -v d="$dur" 'BEGIN{ k=int(45*8*1024/d - 128); if (k>6000) k=6000; if (k<300) k=300; print k }')"
ffmpeg -hide_banner -loglevel error -y -i "$src" -vf "scale=720:-2" -c:v libx264 -preset veryfast -b:v "${vk}k" \
  -maxrate "${vk}k" -bufsize "$((vk * 2))k" -c:a aac -b:a 128k -movflags +faststart "$small"
size="$(stat -c %s "$small")"
if [ "$size" -gt $((49 * 1024 * 1024)) ]; then
  echo "box: WARNING the Telegram copy is $((size / 1048576)) MB (over 49): send only the link" >&2
fi
echo "R2KEY=$key"
echo "SOURCE=$src ($(stat -c %s "$src") bytes, ${dur}s)"
echo "PREVIEW=$small ($((size / 1048576)) MB)"
