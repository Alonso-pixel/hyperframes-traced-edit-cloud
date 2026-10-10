# traced-edit, remote: you are on Hermes, the work happens on the render box

You run on a small always-on server and talk to the user on **Telegram**. Their PC is off. Every
traced-edit script, ffmpeg, whisper, HyperFrames Studio, the phone review page and the render run
on a **GitHub Codespace (the render box)**. You reach it ONLY through `renderbox`. Projects live in
R2 between runs; `renderbox` restores and saves them for you.

## How to run the original skill's commands

The original skill below says "All commands run from the workspace root" and writes them as
`node S/run.mjs videos/<project> 4`. Here, wrap every one of them:

```
renderbox exec "node S/run.mjs videos/<project> 4 --dry"     # quick: waits for the output
renderbox exec --detach "node S/run.mjs videos/<project> 4"  # long: returns a job id at once
renderbox job <id>                                            # RUNNING / FINISHED exit N + log tail
```

- **Use `--detach` for:**
  - state 4 without `--dry` (the transcode);
  - states 1 and 2 when there is footage or a voice to transcribe (whisper);
  - state 3;
  - `7` and `7 --render`.

  Poll with `renderbox job <id>` every minute or two; do not start a second heavy job while one
  runs. Everything else (`--dry`, `status.mjs`, `approve.mjs`, `feedback.mjs`, `inspect.mjs`,
  `studio-diff.mjs`) runs without `--detach`.
- `--no-open` is added for you. Nothing on the box can open a browser, and nobody is sitting at
  it.
- **Configs:**
  - Write them on the box with a heredoc:
    `renderbox exec "cat > 'videos/<p>/states/5sound-effects(human-review)/sfx.json' <<'EOF' … EOF"`
  - Read them with `renderbox exec "cat …"`.
  - Quote state folders: they contain parentheses.
- **The asset library:**
  - It lives on the box at `videos/ASSETS/`: `renderbox exec "node tools/find-asset.mjs <words> --kind clip"`.
  - Read the index with `renderbox exec "sed -n '1,200p' videos/ASSETS/INDEX.md"`.
- **Looking at pictures (Rule 3).**
  - `renderbox pull videos/<p>/states/3video-analysis/out/sheets` copies them here and prints
    local paths.
  - Open each one with your vision tool.
  - Never confirm an event, a beat or an insert from a file name or a log line.
  - Send the user the sheets that matter as Telegram images when asking them to check something.

## Footage, voiceovers and reference media come through an upload link

Telegram bots cannot download files over 20 MB, so never ask the user to send footage in the chat.

1. `upload-link up <project> --what none|media|voice|context`
   - `none`: footage with no voice, a new project.
   - `media`: footage-first, or the planned on-camera take.
   - `voice`: the voiceover.
   - `context`: reference images and clips for state 1.

   Send the user the link. It is a phone page that uploads big files.
2. When they say it is uploaded (or the bot's "📥 Subido" message appears): `upload-link list <project>`.
3. `renderbox ingest <project> <incoming/…key> --none|--media|--voice|--context`. This is the
   `init.mjs` step from "Step 0" and Step 1.6, done for you.

Small images the user sends in the chat (state 1 context) can go up directly:
`renderbox push <local image> "videos/<p>/states/1script(human-review)/context"`.

## Reviews (states 4–7) happen on the user's phone

After a build of 4, 5, 6 or 7:
1. Run `renderbox urls <project>`.
2. Send both links:
   - **PHONE REVIEW**: plays the cut with its sound, takes notes and approvals; no login.
   - **STUDIO**: the exact preview. It asks for the GitHub login of the account that owns the
     box.

In this setup "Studio pops up" means "send the Studio link". The review loop and Rules 4, 5 and
8 are unchanged: approvals are the user's, in their words, and only from them.

To be woken by a phone note, run this in the background:
`renderbox exec "node S/review.mjs videos/<p> --wait --timeout 25"`. It returns when the user
sends a note or approves from the phone. If it times out, nothing happened: the user may answer
in Telegram instead.

## Delivering (after Step 7's render)

`renderbox deliver <project>`:
- uploads the render to R2;
- copies a ≤50 MB version here;
- prints a 14-day download link.

Reply with `MEDIA:<the TELEGRAM_COPY path>` on its own line plus the full-quality link, then the
hand-over list from Step 7.5.

## Spend the box carefully

The box costs GitHub core-hours whenever it is on.
- `renderbox status` shows whether it is on.
- `renderbox stop` it when the user approves the last state of a session, says they are done,
  or goes quiet.
- A cron job (`renderbox reap`) stops it after 30 idle minutes anyway; the review links die
  with it.
- **The very first time** (`renderbox status` says "no codespace"), creating the box takes 20–40
  minutes. Run `renderbox up` as a **background** terminal process with notify on, tell the user,
  and wait for the notification. Never run it in the foreground: the 10-minute limit kills it.
- When the user comes back, `renderbox up` (or any `exec`) starts it again in about a minute.
  Then rerun `node S/preview.mjs videos/<p> <id>` and `node S/review.mjs videos/<p>` and send
  fresh links.

When the user says they updated the skill (on their PC, then pushed), run `renderbox update`. The box
then has the new scripts. Your own copy of these instructions updates when Railway redeploys.

## What does not exist here

- **`enrich`** (the fact-checker's cabildo sound bites) is not installed on the box. Never add
  `"enrich"` to `brief.json`. If the user asks for council clips, say they need the PC for that.
- **There is no Wi-Fi and no QR page on the user's PC.** Ignore those parts of "Review from the
  phone"; the links come from `renderbox urls`.
- **Do not edit the scripts or templates on the box.** They are a copy of the user's workspace.
  Report a "Script stack (this is a bug in the skill)" message verbatim, as Rule 7 says.
