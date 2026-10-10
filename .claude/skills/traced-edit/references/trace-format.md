# Reading a trace

Every state folder holds, after a run:

| file | what |
|---|---|
| `state.json` | the record below; `status.mjs` and `trace.html` read it |
| `TRACE.md` | the same, for people: what went wrong, what changed since the last run, inputs, numbered commands, outputs, checks, pictures |
| `log.txt` | timestamped log; each command with its exit code, time and (on failure) stderr tail |
| `state.prev.json`, `log.prev.txt` | the previous run, for comparison |
| `feedback.jsonl` | what the user said about this state: `feedback`, `approved`, `revoked`, `studio-edit` entries, and Claude's `reply` to a note. Entries made on the phone page carry `"source": "phone"`, the cut time `t` and `near` (what was on the timeline there: piece, event, cue, music section) |
| `out/preview.mp4` | (states 4–7) the phone proxy: the cut at 720 px with the state's audio at `deliver.json` volumes. State 4 also writes `out/phone-video.mp4` (the picture, encoded once) |
| `studio-edits/*.diff` | (states 4–7) every hand edit made in Studio, archived when it was ported |

The project root also holds `traced-edit.json` (the marker `init.mjs` writes) and `raw-media/`:
the footage plus `manifest.json`, written once and never again, and, in footage mode, the
voiceover `voice.<ext>` plus `voice.json`. A new voiceover take moves the old one to
`voice-takes/` and lists it in `voice.json` `replaced`.

Phone review (`review.mjs`) adds `.review.json` to the project root: `{ pid, port, token, urls,
startedAt }`. The token survives restarts, so the phone's bookmark keeps working; delete the file
to issue a new one. The server's own log is `review-server.log`.

## state.json

```jsonc
{
  "id": "4", "name": "video-edition",
  "status": "ok",                    // ok | failed | running
  "startedAt": "…", "ms": 36900,
  "args": {}, "dry": false,
  "inputs":   [{ "path": "states/4…/edit.json", "role": "edit (human)", "fp": "c46d860ce630702d" }],
  "params":   { … },                 // snapshot of the config used
  "commands": [{ "n": 1, "why": "transcode the cut", "cmd": "ffmpeg …", "cwd": ".", "ms": 34900, "exit": 0 }],
  "outputs":  [{ "path": "…/cut.mp4", "note": "20.5s, 615 frames", "bytes": 25202106, "fp": "…" }],
  "checks":   [{ "name": "cut frame count", "pass": true, "detail": "615 frames, expected 615" }],
  "warnings": [], "notes": [], "images": [{ "path": "…/event-01.jpg", "caption": "…" }],
  "error":    null,                  // { message, user, command: {…, stderrTail}, stack? }
  "review":   { "approved": true, "note": "…", "at": "…", "key": "…", "source": "phone" },  // states 1, 4-7; source only when approved on the phone
  "generated": { "dir": "…/preview/<project>-sfx", "pristine": "…/.pristine-<project>-sfx",
                 "files": { "index.html": "…", "compositions/overlay.html": "…" } },  // states 4-7
  "preview":  { "ok": true, "url": "http://127.0.0.1:3017/#project/<project>-sfx", "at": "…",
                "stoppedAt": "…", "cmd": "npx … preview … --background", "serverLog": "…" },
  "portedEdits": [{ "at": "…", "note": "volumes.sfx 1 -> 0.6", "diff": "…/studio-edits/….diff" }]
}
```

- **Paths** inside the project are relative to it; files outside (the sound library,
  templates) are absolute and shown as `{workspace}/…`.
- **Fingerprints** (`fp`): sha1 of files up to 8 MB; size + sha1 of the first and last MB for
  bigger media. A rerun that writes identical bytes keeps the same fingerprint, so downstream
  states stay OK.
- **Commands** are quoted for Git Bash. Paste one from the project root (or its `cwd`) to
  rerun just that step by hand.
- **error.user = true**: a config problem; the message says what to change. An error with a
  `stack` and no command is a bug in the skill's scripts.
- A failed **check** turns an otherwise clean run into `failed`.

## Derived status (status.mjs, trace.html)

Computed fresh each time from the records plus the current files:

1. no record → `NOT RUN` (or `BLOCKED` if its gate is not OK, or if it reads the footage and
   `raw-media/` has none yet: "no footage yet"; in footage mode state 2 also waits for the
   voiceover: "no voiceover yet")
2. `running` with a live pid → `RUNNING`; dead pid → `INTERRUPTED`
3. its generated Studio project differs from what the build wrote → `STUDIO EDIT`. The
   comparison ignores Studio's own re-serialization (`data-hf-id` stamps, doctype case, `/>`, `attr=""`)
4. `failed` → `FAILED`
5. any input fingerprint differs, or a watched folder gained or lost a file (state 1's
   `context/`) → `STALE` (names the files)
6. an upstream state (`1` for 2; `4` for 5; `4`, `5` for 6; `4`–`6` for 7) is not OK/NEEDS REVIEW → `STALE`
7. its gate (the state before it) is not OK → `BLOCKED`
8. last run was `--dry` → `NEEDS REVIEW` (human states) / `STALE`
9. a human state whose run recorded `skipped` (state 1 in mode `none`) → `OK`.
   Otherwise: human state not approved, or its decision files (config + `timeline.json` / `cues.json` /
   `sections.json` / the generated deliver project; for state 1, `brief.json` + `script.txt` +
   `beats.json`) changed since approval → `NEEDS REVIEW`
10. otherwise `OK` (state 7 adds "not rendered yet" until `--render` ran)

The approval survives a rerun that produces the same decision files, and resets on any change.
