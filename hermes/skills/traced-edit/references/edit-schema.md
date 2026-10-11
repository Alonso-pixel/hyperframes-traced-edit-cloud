# edit.json (state 4)

```json
{
  "fps": 30,
  "freezeEnd": 2,
  "pieces": [
    { "id": "A", "from": 0,  "to": 62,    "speed": 1, "audio": true },
    { "id": "B", "from": 62, "to": 196.4, "speed": 4, "audio": false }
  ],
  "events": [
    { "n": 1, "srcT": 28.2, "piece": "A", "anchor": "green",  "verified": true },
    { "n": 6, "srcT": 65.6, "piece": "B", "anchor": "center", "verified": true }
  ],
  "inserts": [
    { "id": "broll", "file": "clips/avenida-inundada-coatepec.mp4", "from": 1.5, "dur": 4,
      "at": { "on": "pieceStart", "piece": "B", "offset": 0.5 }, "box": "top", "fadeIn": 0.2, "fadeOut": 0.2 },
    { "id": "coins", "file": "svg-icons/coins.svg", "at": { "on": "event", "n": 10 }, "dur": 1.5 },
    { "id": "bus", "file": "animations/bus-boarding.html", "at": 12 }
  ]
}
```

| field | meaning |
|---|---|
| `fps` | output frame rate. Event times snap to its frames |
| `freezeEnd` | seconds the last frame is held (audio padded with silence) |
| `pieces[]` | kept stretches, **in output order** |
| `.id` | short unique name; events, SFX rules and the overlay refer to it |
| `.from`, `.to` | source seconds |
| `.speed` | 1 = normal, 4 = four times faster. Output length = (to − from) / speed |
| `.audio` | `false` mutes the piece (a silent track keeps the concat aligned) |
| `.file` | optional: the piece comes from this file of `videos/ASSETS` (`clips/cabildo/x.mp4`) instead of the footage; `from`/`to` are then seconds of that file (below) |
| `.soundbite` | optional: the id of the state-1 sound bite this piece plays (`"sb1"`); needs `file`, `speed` 1 and its audio |
| `events[]` | the things to count. Any order; the timeline sorts them by cut time |
| `.n` | the number the counter shows when this event fires |
| `.srcT` | source second it fires on. Copy it from a strip/contact sheet stamp |
| `.piece` | the piece that contains `srcT` |
| `.anchor` | free text: what the time marks (`green` = highlight onset, `center` = centred). Shown in the trace |
| `.label` | optional free text, carried into timeline.json |
| `.verified` | must be `true`: you confirmed it by eye |
| `voice` | footage mode only, optional: `{ "duckDb": -12, "gap": 0.25, "minClearance": 0.3 }`. `duckDb`: how far the footage's own sound dips while the voice speaks. `gap`: silence between the kept segments of one paragraph. `minClearance`: the least time between one paragraph's end and the next one's start |
| `inserts[]` | optional: things from `videos/ASSETS` laid **over** the cut (below). They never change the cut |
| `_scaffold` | present only while the scripts wrote the file: `init.mjs` (one piece = the whole video), or state 2 in planned mode (one piece per kept take, `_seededBy` says so). State 2 reseeds pieces and state 3 seeds events while it is there. Delete it once you have checked or edited it |

**The mapping** (from pintas `build-cut.mjs`): piece k starts in the cut at the sum of the
earlier pieces' lengths; an event lands at `start_k + (srcT − from_k) / speed_k`, rounded to
the nearest frame. `timeline.json` keeps both `srcT` and `t` for every event.

**Errors** (nothing is built): an unverified event, an event outside its piece (the message
names the piece it does fall in), overlapping pieces (of the same source), unknown piece ids,
duplicated `id`/`n`, a piece outside the source (or outside its `file`), an event in a `file`
piece.

## Pieces from videos/ASSETS: sound bites

A piece with a `file` is cut in from the shared library instead of the footage; the only use so
far is a **sound bite**, a stretch of a council-session clip (`clips/cabildo/`, written by state 1)
whose own voice plays while the narration pauses:

```json
{ "id": "S1", "file": "clips/cabildo/cab-001.mp4", "from": 0.8, "to": 13.1, "speed": 1, "audio": true, "soundbite": "sb1" }
```

- Planned mode: state 2 seeds it after the last take of the bite's paragraph. Footage mode: add
  it yourself between two paragraphs' stretches (a paragraph whose voice would run over a bite
  fails the build, and the footage's sound is not ducked during it).
- A clip of another shape (the cabildo clips are 640×360) is fitted to the footage's frame: the
  clip whole and centred over a blurred, scaled-up copy of itself. Frame rate and audio (48 kHz
  stereo; silence if it has none) are normalized. Pieces of the footage are cut exactly as before.
- Every sound bite of `soundbites.json` must be played by exactly one piece, every `soundbite`
  piece must name one, and each must be `"verified": true`; else nothing is built. A piece whose
  `from`/`to` differ from the bite's by more than 0.1 s is a warning (the caption was verified for
  the bite's stretch).
- Events are never in a `file` piece; `srcT` and beats map through the footage's pieces only.

`timeline.json` keeps `file` and `soundbite` on those pieces, and adds `soundbites[]`:
`{ id, t, dur, piece, clip, from, to, speaker, role, session, date, caption, words }`: cut time and
length, who and where from, the **verified caption** (the only text shown) and the Chirp word times
moved onto the cut (`words`, timing only: they pace the caption's reveal). The anchors
`{ "on": "soundbiteStart" | "soundbiteEnd", "id": "sb1" }` use them (sfx.json, music.json, inserts).

State 4 also writes `out/soundbites-key.wav` (the cut's sound only during the bites: state 6 ducks
the music with it) and `review/soundbite-<id>.jpg`. Every HyperFrames project gets one caption per
bite: `compositions/soundbite-<id>.html` from `templates/soundbite.html` (lower third with name,
role, session and date; the caption revealed word by word, in pages of two lines).
**Warnings**: a piece that is not a whole number of output frames, events not in `n` order on
the cut, no events.

## Inserts: overlays from `videos/ASSETS`

Every insert file lives in the shared library. **A path outside `videos/ASSETS/` is an error**:
the user copies a new file into the right folder (`clips/`, `images/`, `animations/`,
`motion-graphics/`, `svg-icons/`) first. Inserts lie on top of the footage and under the
overlay (the counter). The cut, the events, the SFX and the music do not move.

| field | meaning |
|---|---|
| `id` | short unique name (letters, digits, `-`, `_`). The element is `#ins-<id>` in the HyperFrames project |
| `file` | path relative to `videos/ASSETS` (`clips/x.mp4`). The kind comes from the extension: `.mp4 .mov .webm .m4v` clip (muted), `.jpg .jpeg .png .webp .gif` image, `.svg` icon, `.html` animation (a HyperFrames sub-composition with a `data-composition-id`) |
| `at` | when it appears: an anchor that fires once (`{"on": "event", "n": 10}`, `{"on": "pieceStart", "piece": "B", "offset": 0.5}`) or cut seconds copied from `timeline.json`. Snapped to a frame |
| `dur` | seconds on screen. Optional for a clip (the rest of it from `from`) and for an animation with its own `data-duration`; required for an image or icon |
| `from` | clips only: the second of the clip it starts at (find it with `inspect.mjs <p> sheet 0 <len> 1 --asset <file>`) |
| `box` | where on the 1080×1920 frame: `full` (whole frame), `top` (960×640 window near the top), `center` (500×500), `lower` (1080×340 band at y 1380, the size of `bus-boarding`), `pip` (360×640, top right). Default: `center` for icons, `lower` for an animation shorter than 1920, otherwise `full` |
| `css` | CSS declarations added to `#ins-<id>` to fine-tune the box (`"top: 300px; border-radius: 0;"`). An icon drawn in `currentColor` is inlined, so `"color: #39e43a;"` tints it |
| `fadeIn`, `fadeOut` | seconds (GSAP opacity tweens on the main timeline) |

**Errors** (nothing is built): a file outside `videos/ASSETS` or missing, an unknown
extension, a duplicated or malformed `id`, an anchor that fires 0 or 2+ times, a clip shorter
than `from + dur`, an insert that extends past the end of the cut, an unknown `box`, fades longer than
`dur`, an `.html` with no `data-composition-id`, the same animation mounted twice.
**Warnings**: two inserts overlapping in the same box, an animation shown longer than its own
`data-duration`. A ProRes/HEVC clip (the `.mov` loops in `animations/`) is fine: Studio swaps in
a preview proxy, and the render decodes the original.

**Data charts** (`motion-graphics/manim/`, made by `node tools/manim-chart.mjs` from
`videos/ASSETS/data/<place>/facts.json`) are clips sized for one box. The file name ends in it
(`-top` is 960×640), so set that `box`: in another box `object-fit: cover` crops the chart.
Leave `dur` out (6 s). The `.mp4` is an opaque dark card. A `.webm` is VP9 with alpha.
Checked with hyperframes 0.8.105: `snapshot` and `render` keep the transparency, but
its grey bars are faint over busy footage. The number the chart shows must be the number the
narration says (Two truths).

`timeline.json` `inserts[]` keeps each one resolved (`t`, `dur`, `anchor`, `kind`, `file`), and
every HyperFrames project (the Studio previews of states 4–6 and the deliverable) carries them.
In the project, clips, images and SVGs that are not inlined go to `assets/inserts/` (hard links),
and animations are copied to `compositions/insert-<id>.html`. Do not port a Studio edit made
inside that copy. Change the ASSETS file itself, if the user wants that, and rerun state 4.
