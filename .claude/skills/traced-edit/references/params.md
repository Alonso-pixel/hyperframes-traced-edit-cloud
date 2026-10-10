# params.json (states 2 and 3)

## State 2 · audio-analysis

When state 1 has an approved script, this state transcribes the speech (the footage in planned
mode, `raw-media/voice.*` in footage mode) and aligns it to the script: `out/alignment.json` /
`alignment.md`. Editing the script makes this state STALE.

| field | default | meaning |
|---|---|---|
| `transcribe` | `false` | with no script: run whisper (`tools/transcribe.mjs`) anyway; adds `transcript.json`, `words.tsv`, `sentences.txt`. Timing only: whisper text is never copied to screen. |
| `language` | `"es"` | whisper language |
| `silenceDb` | `-45` | a 50 ms frame below this is "quiet" |
| `silenceMin` | `0.5` | shortest quiet run reported (s) |
| `onsetJumpDb` | `12` | a frame this much louder than the previous 0.15 s is a "sudden sound" |
| `onsetMinGap` | `0.5` | sudden sounds closer than this merge (s) |
| `maxPause` | `0.7` | alignment: a pause longer than this inside a take is cut out (s) |
| `minCoverage` | `0.8` | alignment: share of a paragraph's words a take must contain to count as complete. The last complete take wins |
| `pad` | `0.12` | planned mode: seconds kept before and after each seeded piece |

## State 3 · video-analysis

| field | default | meaning |
|---|---|---|
| `sheetStep` | `1` | one contact-sheet tile per this many seconds |
| `sceneThreshold` | `0.35` | scene score above which a frame is a hard cut |
| `motion` | `true` | write `motion.csv` (5 fps change score) |
| `detectors` | `[]` | colour detectors, below |

### A detector

It scores every frame by the share of pixels whose colour falls in an HSV box, then takes
the peaks. It only **proposes**; every candidate is checked by eye.

```json
{ "name": "green", "hue": [100, 140], "sat": [0.5, 1], "val": [0.45, 1],
  "region": [0.2, 0.8], "ranges": [[0, 62], [328, 346]],
  "fps": 10, "smooth": 3, "floor": 0.01, "minGap": 2.5 }
```

| field | meaning |
|---|---|
| `hue` | degrees, `[lo, hi]`; wraps when lo > hi (`[330, 20]` = reds). Green ≈ 100–140, magenta ≈ 290–340, yellow ≈ 45–65 |
| `sat`, `val` | 0–1 ranges. Raise `sat` to ignore washed-out tints |
| `region` | horizontal fraction of the frame to look at (default the whole width) |
| `ranges` | source seconds to scan (default the whole video) |
| `floor` | minimum smoothed score for a peak. Read `series-<name>.csv` to set it: a little above the baseline between targets |
| `minGap` | two peaks closer than this (s) are one |

The pintas paintings' neon-green highlight was found with the `green` box above (floor 0.01):
all three highlights in the test excerpt, each within 0.35 s of the verified onset. The
sun-washed middle wall was not found by colour at all. Those were counted from the contact
sheets, which is why the sheets are always made.
