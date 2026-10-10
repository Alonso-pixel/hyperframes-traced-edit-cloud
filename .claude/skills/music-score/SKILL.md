---
name: music-score
description: >
  Put background music under a FINISHED video that has speech (an mp4 with voice): several
  cropped stretches of the mood-music library in videos/ASSETS/music, one per section of the
  story, crossfaded, ducked under the voice, with real musical drops landing exactly on the key
  lines (a number, an accusation, the call to action). Script-driven: you write one small JSON
  file, the scripts do the audio work and verify it. Use for "put music in this video", "add a
  music bed / background music", "make the video more dynamic with music", "use the music
  library". Keeps an intro's own audio untouched when asked. Not for wiring music into a
  HyperFrames composition during a build (/beat-bed), and not for mixing audio that is already
  in a composition (/hyperframes-audio).
---

# music-score

You add music to a finished video. **You never write ffmpeg commands and never do arithmetic
on times.** You write one file, `score.json`, and run two scripts. The scripts analyze the
music, crop it, level it, mix it under the voice, and check the result by measurement.

Worked example (a 4:41 street interview with a 22.6 s intro that keeps its own audio):
`examples/lamparas-hechas.score.json`. **Open it now** and copy its pattern.

All commands run from the workspace root (`hyperframes-videos/`). `S` means
`.claude/skills/music-score`.

## Rules (do not break these)

1. Edit only `score.json`. Everything else in the work dir is regenerated.
2. **Every time in `score.json` is copied**: `from` and `hitAt` from `sentences.txt` (or
   `hitAt` from `words.tsv` for a word inside a line), and `drop` from `library.txt`. The first
   section's `from` is exactly `musicFrom`. Never estimate a time, never round it, never
   compute it. The build rejects times that are not in those files.
3. Never overwrite the source video. The output is a new file (the build refuses otherwise).
4. Only use track names listed in `library.txt`. Never use a track marked
   `NOT A MUSIC BED`.
5. Do not tell the user the job is done until the build prints `ALL CHECKS PASSED`.
6. `init.mjs` and `build.mjs` (without `--check`) take several minutes. Run them with the
   longest command timeout your shell tool allows (for example `timeout: 600000` ms), in the
   **foreground**, one at a time. Never run two builds at once or in the background. If a run
   is cut off, just run the same command again: finished work (transcript, library profiles)
   is reused.

## Step 1: Analyze

```
node S/scripts/init.mjs <path/to/video.mp4> [--music-from <seconds>] [--out <path/to/output.mp4>]
```
- `--music-from`: only if the user says the start of the video (an intro, a title, a clip with
  its own music) must keep its own audio. Use the number the user gives. Otherwise leave it out
  (music from the start).
- `--out`: the file name the user asked for. Default: `<video name>-music.mp4` next to the video.
- It transcribes the speech (a few minutes; let it finish) and writes a work dir, by default
  `<video folder>/music-score/`. It prints the paths of the files below.

## Step 2: Read the two files

1. `sentences.txt`: every line of speech with its start time. Read it top to bottom and
   understand the story: what is being complained about, where the numbers and accusations
   are, where the tone changes, how it ends.
2. `library.txt`: every track with its **mood**, where its bed starts, and its **MAIN drop**:
   the moment the music comes back at full power after a silence. A `hit` needs a MAIN drop.

## Step 3: Write the sections in `score.json`

`score.json` already has `video`, `musicFrom` and `output`. You fill in `sections`, a list in
time order. Each section plays one track until the next section starts; the last one plays to
the end of the video.

```json
{ "from": 57.45,  "track": "esperanza-barrio",  "role": "bed" }
{ "from": 159.59, "track": "tension-creciente", "role": "hit", "hitAt": 172.34, "drop": 91.5 }
{ "from": 263.86, "track": "llamado-accion",    "role": "ending" }
```

**How to cut the story into sections**

1. The first section's `from` is exactly `musicFrom` from `score.json` (0 when there is no
   intro).
2. Every other `from` is a start time copied from `sentences.txt`, at a place where the
   topic or the tone changes.
3. Aim for one section per 30–45 s of video. That is 4–8 sections for 3–5 minutes, and 3–4 for
   under 2 minutes. Each section must be at least 8 s; 20–70 s is best.
4. Two neighbouring sections never use the same track. The same track may come back later.

**How to pick the track for a section**

Match what is being SAID in that section to the `mood:` line in `library.txt`:

| The section is about… | good tracks |
|---|---|
| neutral talk, an interview, setting the scene | `calle-lofi`, `informativo-neutral` |
| something good, neighbours helping, a solution | `esperanza-barrio` |
| complaints, suspicion, "they don't tell you" | `denuncia-oscura` |
| sadness, neglect, victims, abandoned streets | `abandono-melancolia` |
| budgets, amounts, comparisons of numbers | `cifras-datos` |
| a question building to a reveal | `tension-creciente` |
| protest, fighting back, "levantar la voz" | `revuelta-cinematica` |
| outrage, a punchline | `indignacion-phonk` |
| danger, night, insecurity | `noche-inseguridad` |
| urgency, deadlines | `urgencia-ultimo-momento` |
| a politician contradicting themselves (irony) | `ironia-sarcasmo` |
| the closing call to action, hope at the end | `llamado-accion`, `esperanza-barrio` |

If `library.txt` lists a track that is not in this table, use its `mood:` line.

**Roles**

- `"bed"`: the default. The music plays from the track's normal start. Do not add
  `trackIn`; the example uses it for one special case, and you never need it.
- `"hit"`: the music goes silent for a moment and then comes back at full power **exactly on
  one word**. **Every score has 1–3 hits** (`--check` refuses a score without one), on the
  strongest lines only: the big number ("300 millones"), the accusation, the call to action
  ("Tienen que levantar la voz"). Only if the user asked for no hits, add `"noHits": true` at
  the top level of `score.json`.
- `"ending"`: only on the last section. The track's own ending lands on the last frame. Use a
  calm or hopeful track, and start this section 10–25 s before the end.

Do not add `"gain"` now. It is only for fixing a failed check (see "If a check fails").

**How to place a hit (do these in order)**

1. Pick the key line in `sentences.txt`. Its start time (the number at the left of that line)
   is `"hitAt"`. The hit lands on the **first word of the line**: "Tienen" in "Tienen que
   levantar la voz", not "que" or "levantar". Only when the key word is inside a longer line
   (a number in the middle of a sentence) take that word's start from `words.tsv` instead.
2. Pick a track that has a MAIN drop in `library.txt` and copy that number into `"drop"`.
3. The hit section's `"from"` is a sentence start **10–45 s before `hitAt`** (at least 4 s
   before). That stretch is the build-up; the music goes silent just before the word.
4. The NEXT section must start at least 3 s after `hitAt`. The simplest choice is to let the
   hit section run until the next change of topic.
5. If `--check` reports an error for this section, it tells you the allowed range. Choose
   another sentence start inside it.

## Step 4: Check

```
node S/scripts/build.mjs <work dir>/score.json --check
```
- `ERROR` lines: nothing is built. Each one says exactly what to change (and lists the nearest
  valid times). Fix `score.json` and run `--check` again until it prints `CHECK OK`.
- `WARNING` lines: read each one. Fix it unless you are sure it is what you want.
- Look at the printed table. The last column of each hit row shows the word the drop lands on.
  It must be the word you intended.

## Step 5: Build

```
node S/scripts/build.mjs <work dir>/score.json
```
This takes 1–3 minutes. It writes the output video and then prints a report of `PASS`/`FAIL`
lines (also saved as `report.txt`).

## If a check fails

| FAIL | what to change in score.json |
|---|---|
| music under the voice: too loud (< 12 dB) | add `"gain": -3` to every section (or to the loud ones), build again |
| music under the voice: too quiet (> 18 dB) | add `"gain": 3` to every section, build again (`"gain"` goes up to 6) |
| no silent holes: lists times | a track goes quiet there. Move the section boundary nearest to that time to another sentence start, or use a different track for that section |
| hit at X: weak jump | use the track's MAIN drop from `library.txt`, or choose another track that has one |
| loudness / true peak / duration / video untouched | not caused by score.json. Run the full build one more time without changing anything. If the same line fails again, stop and tell the user the exact line |

Any line that says **"This is a bug in the skill's scripts"**: stop at once. Do not change
`score.json` to work around it, and do not retry. Tell the user that exact line.

Build again after every fix. Repeat until `ALL CHECKS PASSED`. If the same check still fails
after two fixes, stop and tell the user the exact line.

## Step 6: Hand over

Tell the user:
- the output path;
- the section list: time range, track, and for each hit the word it lands on;
- that `listen/` in the work dir has short clips of every hit and every crossfade, so they
  can listen to the key moments first;
- that you cannot hear the audio, so they should listen before publishing. To change
  something, they (or you) edit `score.json` and run step 5 again.
