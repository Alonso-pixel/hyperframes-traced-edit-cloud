#!/usr/bin/env bash
# The Studio and phone-review links of a project, as the skill recorded them (forwarded URLs).
#   box/urls.sh <project>
source "$(dirname "$0")/lib.sh"
p="${1:?project}"
check_project "$p"
node - "videos/$p" <<'EOF'
const fs = require("fs"), path = require("path"), dir = process.argv[2];
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const e of read(".previews.json") || []) console.log(`STUDIO (state ${e.id}; opens after the GitHub login): ${e.url}`);
const rv = read(".review.json");
if (rv?.pid && alive(rv.pid) && rv.urls?.[0]) console.log(`PHONE REVIEW: ${rv.urls[0].url}/?k=${rv.token}`);
else console.log(`no phone review server running: renderbox exec "node S/review.mjs videos/${path.basename(dir)}"`);
EOF
