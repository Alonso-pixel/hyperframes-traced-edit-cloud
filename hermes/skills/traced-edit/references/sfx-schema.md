# sfx.json (state 5)

```json
{
  "library": "videos/ASSETS/sound-effects",
  "sounds": { "pop": "Extra/27 SFX PACK (1)-…/pop sound (1).MP3", "punch": "punch (1).mp3" },
  "rules": [
    { "sound": "pop", "on": "event", "where": { "piece": "B", "exceptLast": true }, "gain": 0.9 },
    { "sound": "punch", "on": "lastEvent", "gain": 0.8 }
  ]
}
```

- `library`: optional, and always `videos/ASSETS/sound-effects` (or a folder inside it). Sound
  effects come **only** from the shared library: a `library` elsewhere, or a sound that resolves
  outside it (`..`, an absolute path), is an error. To use a new sound, the user copies it into
  `videos/ASSETS/sound-effects` first. `sounds` paths are relative to `library`. Files are read
  in place, never copied.
- `out/sounds.txt` (written by every run, `--dry` included) lists every sound in the library as
  the exact path to paste into `sounds`.
- `sounds`: short name → file. Rules refer to the short name.

The anchor vocabulary (`on`, `piece`, `where`, `offset`) is shared with `music.json`
(`scripts/lib/anchors.mjs`), where a section's `from` and `hitAt` use the same words.

## A rule

| field | meaning |
|---|---|
| `sound` | a name from `sounds` |
| `on` | `event` (every event that passes `where`), `firstEvent`, `lastEvent`, `pieceStart`, `pieceEnd` (need `piece`), `soundbiteStart`, `soundbiteEnd` (need `id`, a sound bite of `timeline.json`), `at` (needs `t`, cut seconds) |
| `piece` | for `pieceStart` / `pieceEnd` |
| `where` | for `event`: `piece` / `notPiece` (an id or a list), `every: 10` (only n divisible by 10), `exceptLast: true`, `n: [1, 5]` |
| `offset` | seconds added to the anchor (negative = earlier) |
| `gain` | linear: 1 = as recorded, 0.5 = half |
| `align` | which part of the sound lands on the anchor: `onset` (default: where the sound starts), `peak` (its loudest point; for risers), `center` (its middle; for swooshes over a cut), `start` (the file's first sample) |
| `loop`, `dur` | repeat the file for `dur` seconds (`"piece"` = the piece's length) |
| `fadeIn`, `fadeOut` | seconds |

Rules stack: two rules can fire on the same event (pintas: a pop on every 4× tick plus a
chaching on #10 and #20). Every cue in `out/cues.json` records `rule` (1-based index) and
`anchor` ("event #12", "start of piece B"), so any sound in the mix traces back to the line
that made it.

The mix: every cue is trimmed to the cut, faded, gained, delayed to its `start`, summed
without normalization, padded to exactly the cut's length, and limited at 0.89 (≈ −1 dBFS).

## pintas, as rules

`examples/pintas.sfx.json` reproduces `pintas-presupuesto/scripts/build-sfx.mjs` exactly
(41 cues, every start within 1 ms). The counter's entrance is at first event − 0.55 s, so its
woosh is `offset −0.65` and its digits `offset −0.5`.
