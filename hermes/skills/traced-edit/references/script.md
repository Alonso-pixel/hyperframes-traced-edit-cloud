# The script (state 1)

What you write in `states/1script(human-review)/`:

| file | what |
|---|---|
| `brief.json` | the mode, and what the script is about in the user's words |
| `script.txt` | the script |
| `beats.json` | footage mode only: the stretch of footage under each paragraph |
| `soundbites.json` | optional: moments of the council archive spliced into the video with their own audio (below) |

The user's images and video clips go in `context/`.

`run.mjs … 1` digests the context into `out/context.md`, checks the script, and writes
`out/teleprompter.txt`, the copy the user pastes into the teleprompter. The teleprompter prints
every character of that file, so the file holds only the words to be read aloud.

## brief.json

```json
{
  "mode": "planned",
  "topic": "Las pintas de #EsRoberto pagadas con el presupuesto municipal",
  "context": "Recorrido por la avenida: 32 pintas de #EsRoberto en un solo paseo. Los vecinos dicen que se pagaron con dinero público.",
  "audience": "vecinos del municipio",
  "tone": "indignado pero claro",
  "sheetStep": 1
}
```

| field | meaning |
|---|---|
| `mode` | `planned`: script first, then the user records themselves on camera. `footage`: the footage exists; the script follows it and a voiceover is recorded after. `none`: footage with no voice (pintas). The state is skipped and passes as OK. Briefs from before modes existed (`"narration": false`) read as `none` |
| `topic` | what the video is about |
| `context` | the facts, the notes, the article text the user gave you. **The script says nothing that is not here, in `context/`, or in the footage** |
| `audience`, `tone` | optional; how it should sound |
| `sheetStep` | footage mode: seconds between contact-sheet tiles of the footage (default 1) |
| `enrich` | optional: ask the fact-checker's archive of council sessions for moments to quote (below) |

A topic or context is required, unless `context/` has media or the mode is `footage`.

## enrich: the council archive (fact-checker)

```json
"enrich": { "corpus": "cabildo", "k": 10, "queries": [], "maxClips": 6, "factChecker": "C:/Users/Admin/Desktop/Proyectos/fact-checker" }
```

When `enrich` has a `corpus` and there is a `topic` (or `queries`), every run of state 1 asks the
fact-checker for the moments of its Facebook-Live council sessions ("cabildo") that match, right
after digesting the context:

| field | meaning |
|---|---|
| `corpus` | the fact-checker corpus (`cabildo`) |
| `queries` | what to search for; `[]` = the `topic`. Short, in the words a regidor would say |
| `k` | hits per query |
| `maxClips` | the best hits (merged across queries by passage, best score kept) that are cut into clips |
| `factChecker` | the fact-checker project; `FACTCHECKER_DIR` overrides it. Default: `../fact-checker` next to the workspace |
| `refresh` | `true` asks again even when the queries did not change (a rerun reuses the last lookup otherwise) |
| `command` | tests only: the command that stands in for `fc` (e.g. `["node", "fake-fc.mjs"]`, run from the project folder) |

`fc` is run as `<factChecker>/.venv/Scripts/fc.exe`, or `uv run --project <factChecker> fc` when there
is no venv, never as bare `fc` (on Windows that is `fc.exe`, the file comparer). Every call is in
the trace. `fc search` exit 3 (no evidence) is a note; exit 4 (backend failure), any other failure
or output that is not the expected JSON is a **warning, and state 1 goes on** (the last good
lookup's candidates are kept).

Each kept hit is cut by `fc clip` and copied to `videos/ASSETS/clips/cabildo/<passage>.mp4`, with a
`<passage>.json` sidecar: passage, session (`event_title`), date, speaker, agenda item, kind, the
Chirp text and word times, deep link, timestamp, duration. That folder is written by the skill,
not by hand. Then:

- `out/enrich/ENRICH.md`: each candidate (`c1`, `c2` …): speaker, session, date, agenda item,
  where it is in the session (timestamp, deep link), kind, length, its contact sheet, the Chirp
  text **marked as a draft that is never copied to screen unchecked**, and the words with their
  times in the clip, for choosing `from`/`to`.
- `out/enrich/candidates.json`: the same for the scripts; `out/enrich/<passage>/sheet.jpg`.
- `out/context.md` gets an "Archivo de cabildo" section listing them. Open every sheet.

## soundbites.json: quoting the session

A sound bite is a stretch of one of those clips placed between two paragraphs: its **original
audio** plays (the narration pauses), the picture is fitted to 9:16 over a blurred copy of
itself, and a caption shows who speaks and the words they say.

```json
[
  { "id": "sb1", "clip": "clips/cabildo/<passage>.mp4", "from": 3.2, "to": 14.8, "after": 2,
    "caption": "the exact words said", "speaker": "Ana López", "role": "Regidora", "verified": false }
]
```

| field | meaning |
|---|---|
| `id` | short name (`sb1`); state 4's piece and the anchors refer to it |
| `clip` | path relative to `videos/ASSETS`: a clip of this run's candidates, or one with a fact-checker sidecar |
| `from`, `to` | seconds **of the clip** (the word times in ENRICH.md) |
| `after` | the paragraph it plays after; `0` = before the first |
| `caption` | the exact words said between `from` and `to`. Shown on screen, so it must be right |
| `speaker`, `role` | the lower third (name, office). The session and date come from the sidecar |
| `verified` | `true` only after **the user** listened to the clip from `from` to `to` and confirmed the caption, speaker and role. You cannot hear; never set it on the Chirp text alone |

Write the script around the bites: the paragraph before introduces who speaks, the one after
reacts. The script (and the teleprompter copy) stays plain text with no marker for a bite;
`out/soundbites.md` shows the script with each bite where it plays, for the user's review.

In planned mode state 2 seeds each bite into `edit.json` as a piece after its paragraph's last
take (`S1`, `S2` …). In footage mode you add that piece yourself (`references/edit-schema.md`),
between two paragraphs' stretches, and `beats.json` may carry `{ "soundbite": "sb1", "afterBeat": 2 }`
entries as a note; they are not paragraphs and are not counted.

## context/: images and video clips

Drop images (`jpg png webp`) and video clips (`mp4 mov m4v webm mkv`) here. Screenshots, photos,
reference videos and the user's own clips all go here. Other files are not read (a warning says so):
put what matters from them in `brief.json` `context`.

`out/context.md` lists, for each file:
- **image**: a preview (`out/context/<name>.preview.jpg`);
- **clip**: one timestamped contact sheet per minute, its scene cuts, and what is said in it
  (whisper);
- **footage mode**: the footage itself, digested the same way, into `out/context/footage/`.

Open every picture before writing. Digests are cached: a rerun only redoes a file that changed.

A file added to or removed from `context/` makes the state STALE.

Transcripts are for knowing what was said, and they are never copied to screen. On music or
street noise, whisper can invent a line ("Gracias por ver el video"), so trust a transcript only
where the pictures show someone talking.

## Writing script.txt

- **Spanish**, in the register the user speaks. They read it aloud, so write it to be said, not read.
- **Only the words to be read.** No title, headings, scene numbers, notes, stage directions
  (`[pausa]`, `(énfasis)`, `CORTE`), speaker labels (`NARRADOR:`), emojis, links or markdown.
- **No timings.** No seconds, timecodes or target length. The recording sets the timing, and
  state 2 aligns and trims it.
- **One idea per paragraph**, with a blank line between paragraphs. Short sentences: one breath
  each (a sentence over 40 words gets a warning).
- **Write everything the way it is said**: amounts and symbols in words (`un millón y medio de
  pesos`, not `$1.5 mdp`; `por ciento`, not `%`), abbreviations spelled out, hashtags written
  the way the user says them.
- **Shape**: a hook in the first line, the facts, then a close (a question or a call to action).
- **Facts come from the context only.** These stories name real officials. Never invent a
  number, a name or an accusation, and attribute claims (`según los vecinos`, `de acuerdo con…`).
  Any number that will appear on screen later must trace back to a source.

## Footage mode: beats.json

The footage sets the order and the pacing, so the script follows it: one paragraph per stretch,
in order.

```json
[
  { "p": 1, "from": 0, "to": 7.5 },
  { "p": 2, "from": 7.5, "to": 21 },
  { "p": 3, "from": 34, "to": 41 }
]
```

- `from`/`to` are **source seconds read off the footage contact sheets** (never estimated), the
  stretch the paragraph speaks over.
- Stretches are in order and don't overlap. They may leave gaps: footage with no voice.
- **Word budget**: a paragraph fits its stretch at 2.5 words per second (150 per minute). Over
  budget is a warning ("p3: 31 words for 6.0 s of footage"). Shorten the paragraph, or give it a
  longer stretch. Keep each paragraph a little under budget, because the recorded voice is often
  slower than the estimate.
- `out/beats.md` shows each paragraph next to the frames of its stretch, for the user's review.

After recording, state 4 starts each paragraph's voice where its stretch starts on the cut. A
voice that runs into the next paragraph fails the build there.

## Checks (a failed check fails the state, and no teleprompter copy is written)

| check | catches |
|---|---|
| `script is not empty` | an empty file |
| `no notes or directions in brackets` | any `[ ] ( ) { } < >` |
| `no timings` | `0:05`, `5 s`, `2 seg`, `300 ms`, `3 min` |
| `no markdown or list markup` | `#` headings, `-`/`*`/`•` bullets, `1.` lists, `>` quotes, `**bold**`, `` ` ``, `---` |
| `no speaker labels` | a line starting `NARRADOR:`, `VOZ EN OFF:`, `Locutora:` … (`Pero ojo: …` is prose and passes) |
| `no directions in capitals` | `PAUSA`, `CORTE`, `TOMA`, `PLANO`, `NOTA`, `SFX`, `MÚSICA`, `B-ROLL`, `INTRO`, `CTA`, `GANCHO`, `HOOK` … |
| `no links or emojis` | `http…`, `www.`, any emoji |
| `written in Spanish` | too few Spanish function words, or more than half as many English ones |
| footage mode: `beats.json exists`, `one beat per paragraph`, `beats are in order and inside the footage` | a missing, miscounted, misnumbered, overlapping or out-of-range beat |
| `sound bites: ids are unique short names` | a missing, malformed or repeated `id` |
| `sound bites: every clip is a cabildo clip in videos/ASSETS` | a clip outside `videos/ASSETS`, missing, with no audio, or neither a candidate of this run nor with a fact-checker sidecar |
| `sound bites: "after" is a paragraph number` | `after` outside 0..paragraphs |
| `sound bites: 0 <= from < to <= the clip's length` | a stretch outside the clip |
| `sound bites: every one has a caption` | an empty `caption` |
| `sound bites: every caption was checked by ear by the user` | any `"verified"` that is not `true` |

Warnings:
- a `#hashtag` or `@mention` (read aloud exactly as written);
- a sentence over 40 words;
- an over-budget beat;
- a sound bite over 20 s, more than 3 sound bites, or a caption whose words Chirp mostly did not
  hear in `from`..`to` (under ~60%): check the stretch and the caption with the user;
- enrichment problems (fact-checker missing, exit 4, bad output).

The teleprompter copy has its whitespace normalized: no BOM, LF line endings, single spaces, at
most one blank line between paragraphs. The trace notes the word count and a read-aloud estimate
at 150 words per minute. That estimate stays in the trace, never in the script.
