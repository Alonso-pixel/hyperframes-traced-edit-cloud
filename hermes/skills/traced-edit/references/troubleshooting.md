# Troubleshooting

Always start with `node S/status.mjs <project>`, then the failing state's `TRACE.md`.

| symptom | where to look | fix |
|---|---|---|
| state 1 `no notes or directions in brackets` / `no timings` / `no markdown…` / `no speaker labels` / `no directions in capitals` / `no links or emojis` | the check names the line and the text | rewrite that line of `script.txt` as words to be read aloud; never in the teleprompter copy |
| state 1 `written in Spanish` fails | the count of Spanish vs English function words | the script must be Spanish; rewrite it |
| state 1 `brief.json needs a "topic" or a "context"` | `brief.json` | fill it in from the user's words, add media to `context/`, or `"mode": "none"` for footage with no voice |
| state 1 stops at `context digested` | `out/context.md` | not an error: open every picture it lists, write `script.txt` (and `beats.json` in footage mode), run again |
| state 1 `beats.json exists` / `one beat per paragraph` / `beats are in order…` fails | the check's detail | one beat per paragraph, `p` = 1, 2, 3…, `from` < `to`, in order, inside the footage |
| state 1 warning `pN: X words for Y s of footage` | `out/beats.md` | shorten paragraph N, or give its beat a longer stretch (a voice that does not fit fails state 4 later) |
| a context transcript says "Gracias por ver el video" over music | the clip's contact sheet | whisper invents a line on music or noise; ignore it where nobody is talking |
| state 1 warning `enrich: could not start the fact-checker (…)` (fact-checker unreachable) | TRACE.md, the `fc` command it ran | the fact-checker is not where `enrich.factChecker` (or `FACTCHECKER_DIR`) says, or has no `.venv` and `uv` is not on PATH. Point it at the project, or `uv sync` there. The state still passes; write the script without sound bites or fix it and rerun |
| state 1 warning `the fact-checker's search backend failed … (fc exit 4)` | the errors it quotes, `out/enrich/ENRICH.md` | the search backend (agent or local index) is down: rerun state 1 later (a failed lookup is never cached). Until then ENRICH.md keeps the last good lookup's candidates, and clips already in `videos/ASSETS/clips/cabildo/` stay usable |
| state 1 note `no evidence … (fc exit 3)` | `enrich.queries` | nothing in the archive matches: shorter queries, in the words said in a session |
| state 1 warning `did not print the expected JSON` | the command's stdout in TRACE.md | the `fc` that ran is not the fact-checker. Never put bare `fc` in `enrich.command`: on Windows it is `C:/Windows/System32/fc.exe` (file compare). The skill calls `<factChecker>/.venv/Scripts/fc.exe` or `uv run --project <factChecker> fc` |
| state 1 enrich keeps old candidates after new queries didn't run | `out/enrich/candidates.json` `key` | a lookup is reused while corpus, k, maxClips, queries and the command are the same: change them or set `"refresh": true` |
| state 1 `sound bites: every caption was checked by ear by the user` fails | `soundbites.json` | the user listens to the clip from `from` to `to` (the deep link in ENRICH.md, or the mp4 in `videos/ASSETS/clips/cabildo/`) and confirms caption, speaker and role; then `"verified": true`. Never from the Chirp text alone |
| state 1 `sound bites: every clip is a cabildo clip …` fails | the path in the message | use the `clip` path ENRICH.md prints (`clips/cabildo/<passage>.mp4`, relative to `videos/ASSETS`) |
| state 1 warning `only N% of the caption's words were heard by Chirp` | ENRICH.md word times | the stretch or the caption is off (or Chirp misheard): check both with the user |
| state 2–7 `BLOCKED`: `no footage yet` | `raw-media/` is empty | the user records it (reading `out/teleprompter.txt`), then `init.mjs <p> --media <video>` |
| state 2 `BLOCKED`: `no voiceover yet` | footage mode | the user records the approved script, then `init.mjs <p> --voice <audio>` |
| state 2 `every paragraph found` fails: `pN not found` / `only X% said` | `out/alignment.md`, `out/sentences.txt` around the expected time | the take is missing or cut short: record it again (`--voice` again in footage mode), or change the script to what was said and re-approve 1 |
| state 2 kept the wrong take | `alignment.md` "other takes" | the last take covering `minCoverage` wins; raise or lower `minCoverage` in `params.json`, or fix the seeded pieces by hand in `edit.json` |
| state 4 `the voiceover does not fit the cut`: `pN runs X s over the start of pM` | `timeline.json` `voice[]`, the voice lane in `trace.html` | shorten paragraph N and re-record, give beat N a longer stretch (re-approve 1), or slow its piece |
| state 4 `pN's beat starts at source …, which no piece keeps` | `edit.json` pieces vs `beats.json` | extend a piece over the beat's `from`, or move the beat |
| state 4 check `the footage's sound is ducked under the voice` fails | the dB per paragraph in the detail | report it: the ducking curve did not apply (the failing command is in TRACE.md) |
| state 4 `event n=… is verified:false` | `states/3…/out/candidates/` strip for it | confirm on the strip, set `"verified": true`, or delete the event |
| state 4 `srcT … is outside piece X; it falls in piece Y` | the piece table in `review/REVIEW.md` | change the event's `piece`, or the piece bounds |
| state 4 `pieces … overlap` | `edit.json` | make each source second belong to one piece (pieces of different files never overlap each other) |
| state 4 `sound bite sbN … has no piece` / `plays sound bite … not in soundbites.json` | `edit.json` pieces vs state 1 `soundbites.json` | one piece per bite: `{ "id": "S1", "file": <its clip>, "from", "to", "speed": 1, "audio": true, "soundbite": "sbN" }`; in planned mode, keep `_scaffold` and rerun state 2 to reseed |
| state 4 `pN … speaks over sound bite sbN` | `timeline.json` voice[] and pieces | footage mode: move the bite's piece between two paragraphs' stretches, shorten the paragraph, or give its beat a stretch that ends before the bite |
| state 4 check `cut frame count` fails by a frame or two (planned mode) | the warning `lasts N.01 output frames` | a hand-typed `from`/`to` that is not a frame time (state 2 seeds frame times floored to 6 decimals since 2026-10-06; older seeds were rounded to 3 and can be a frame long); set both to whole frames, e.g. multiples of 0.1 s at 30 fps |
| state 4 warning `not a whole number` of frames | `edit.json` | adjust `to` so `(to - from) * fps / speed` is whole (pintas B: 134.4 s × 30 / 4 = 1008) |
| state 4 / 5 `… is outside videos/ASSETS/…` | the path in the message | states 4 and 5 compose only from the shared library: the user copies the file into the ASSETS folder it names, then refer to it from there |
| state 4 insert `file not found: videos/ASSETS/…` | `ls videos/ASSETS/<folder>` | copy the exact name (the path is relative to `videos/ASSETS`, e.g. `clips/x.mp4`) |
| state 4 insert `has only X s from Y s on, but "dur" is Z s` | `inspect.mjs <p> sheet 0 <len> 1 --asset <file>` | shorten `dur`, or start earlier in the clip with `from` |
| state 4 insert `the anchor … fires N times` | `edit.json` `inserts[].at` | an insert starts once: give `"n"` for an event anchor |
| state 4 insert `is outside the cut` | `timeline.json` duration | move `at` earlier or shorten `dur` |
| an insert covers the counter or what is counted | the Studio preview of state 4 | another `box`, or `inserts[].css` (`"top: 300px; height: 500px;"`) |
| check `cut duration matches the timeline` fails | `log.txt` of state 4, the transcode command | usually a `to` beyond the source end; rerun after fixing |
| the counter ticks a frame early/late | `review/event-NN.jpg` (6th tile = the event) | `inspect.mjs <p> strip <srcT-0.6> 1.2` on the source, copy the exact stamp into `srcT` |
| an event is missing from the count | `trace.html` timeline: is the source dot inside a coloured piece? | add the event, or extend the piece |
| state 5 `sound "x": file not found` | `states/5…/out/sounds.txt` | paste the exact path from it into `sounds` (relative to `videos/ASSETS/sound-effects`) |
| state 5 `"library" is …, but sound effects come only from videos/ASSETS/sound-effects` | `sfx.json` | `"library": "videos/ASSETS/sound-effects"` (or drop it) |
| state 5 `not a readable audio file` | its command + stderr in TRACE.md | the path points at something that is not audio |
| a sound is in the wrong place | `out/cues.json` (rule + anchor) or hover it in `trace.html` | change that rule's `on` / `where` / `offset` / `align` |
| `events with no sound` warning | the list it prints | add a rule, or ignore if intended |
| state 5 `true peak` check fails | `out/cues.json`: many loud cues stacked? | lower the `gain` of the stacked rules |
| state 2 / 5 / 6 / 7 `BLOCKED` | status line names the gate | review that state with the user and approve |
| `NEEDS REVIEW: outputs changed after the approval` | TRACE.md "Changed since the previous run" | review again; approve again |
| state 7 `hyperframes check` fails | `deliverables/check.txt` (full output) | a template error shows as `composition script error`; a timing error usually means the timeline changed. Rerun 4 → 5 → 6 → 7 |
| snapshots show the wrong number | `trace.html` → state 7 → params, `injected.events` in `deliverables/state.json` | they come from `timeline.json`; fix the edit, not the overlay |
| render duration check fails | state 7 log | rerun `7 --render` once; if it repeats, report the exact line |
| the Studio preview did not open | the state's `log.txt` (`[preview]` lines) and the server log path in `state.json` → `preview.serverLog` | `preview.mjs <p> <id>` again; another app on port 3017? set `previewPort` in deliver.json |
| `STUDIO EDIT` | `studio-diff.mjs <p> <id>` | port the change (SKILL.md table), then `run.mjs <p> <id> --ported "…"` |
| `STUDIO EDIT` but the diff says "identical once Studio's own re-serialization is ignored" | — | nothing real changed: `run.mjs <p> <id> --ported "no real edit"` |
| `cannot replace … a preview server may be holding it` | — | `preview.mjs <p> --stop`, run again |
| the phone cannot open the review URL | `review.mjs <p> --status` (is it running? which address?) | same Wi-Fi as the PC (not a guest network, which isolates devices; no VPN on the phone). Windows Firewall must let Node.js in on **private** networks: accept the prompt, or as admin `netsh advfirewall firewall add rule name="traced-edit review" dir=in action=allow protocol=TCP localport=3019 profile=private`, and set the Wi-Fi to Private in Windows settings |
| the phone says "This review link needs its key" | — | open the full URL with `?k=…` (scan the QR again: `http://127.0.0.1:3019/qr` on the PC) |
| the phone page has no video for a state | its tab's status line | the state has not been built without `--dry` since phone review existed: run it again |
| `review.mjs` did not start | `<project>/review-server.log` | `cannot listen on port 3019`: another app uses it; set `reviewPort` in deliver.json |
| `cannot replace …preview.mp4 (EBUSY)` | — | `review.mjs <p> --stop`, run again, start it again |
| the phone plays no sound | — | the silent switch on iPhone mutes web video; turn it off, or use headphones |
| state 6 `track … is not in the library` | `states/6…/out/library.txt` | use a name from it, without .mp3 |
| state 6 `the drop … comes too early` | the message gives the earliest `from` | start the section later (a smaller negative `offset` on `from`) |
| state 6 `goes quiet at track …` | the section table | move the boundary (another anchor) or pick another track |
| state 6 check `hit at …` fails | `listen/NN-hit-….mp4` | use the track's MAIN drop, or another track |
| state 6 check `no silent holes` fails | the times it lists | move a boundary or pick another track |
| music drowns the effects (user says so) | `trace.html` music lane | `deliver.json` `volumes.music` lower, or `music.json` `level` −3 |
| `--render` is BLOCKED | status of state 7 | the user reviews state 7 in Studio and approves first |
| `INTERRUPTED` | — | rerun the state |
| an error with `Script stack (this is a bug in the skill)` | — | stop and report that exact message |

## Running remotely (GitHub Codespace, a server)

Inside a Codespace the review server and Studio print their **forwarded** URLs
(`https://<codespace>-3019.app.github.dev/?k=…`, `https://<codespace>-3017.app.github.dev/#project/…`),
taken from `CODESPACE_NAME` and `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`. On any other server set
`TRACED_EDIT_PUBLIC_URL` to a template such as `https://box-{port}.example.com`. Wi-Fi addresses are
still listed after it.

| symptom | look at | fix |
|---|---|---|
| the phone gets a GitHub 404 or login page on the review URL | port 3019's visibility | `gh codespace ports visibility 3019:public -c <codespace>`; the `?k=` key still protects it |
| Studio asks for a GitHub login | — | expected: port 3017 stays **private** (Studio has no key). Sign in on the phone's browser with the account that owns the Codespace |
| a forwarded URL stopped working | `gh codespace list` | the Codespace stopped (idle timeout): start it, then `preview.mjs <p> <id> --no-open` and `review.mjs <p> --no-open` |
| state 2 `whisper-cli` not found | `WHISPER_CLI` | outside Windows the default is `whisper-cli` on PATH; `WHISPER_THREADS` sets the threads |
