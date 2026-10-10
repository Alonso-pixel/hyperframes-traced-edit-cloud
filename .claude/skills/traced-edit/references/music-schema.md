# music.json (state 6)

```json
{
  "level": 0,
  "duckUnderSfx": true,
  "sections": [
    { "from": 0, "track": "calle-lofi", "role": "bed" },
    { "from": { "on": "pieceStart", "piece": "B", "offset": -20 }, "track": "cifras-datos",
      "role": "hit", "hitAt": { "on": "pieceStart", "piece": "B" }, "drop": 93.05 },
    { "from": { "on": "pieceStart", "piece": "C" }, "track": "llamado-accion", "role": "ending" }
  ]
}
```

| field | meaning |
|---|---|
| `level` | dB added to every section's target loudness (bed −24, hit −21, ending −22 LUFS) |
| `duckUnderSfx` | compress the music under `sfx-mix.wav` (sidechain), so effects stay clear |
| `sections[]` | in time order; each plays until the next one's `from`, the last to the end |
| `.from` | cut seconds (copied from `timeline.json`) or an anchor (below). The first may be > 0: music starts there |
| `.track` | a name from `out/library.txt` (without `.mp3`); never a `NOT A MUSIC BED` file |
| `.role` | `bed` (plays from the track's bed start), `hit` (its drop lands on `hitAt`), `ending` (last section only; the track's ending lands on the last frame) |
| `.hitAt` | for `hit`: the moment of the drop, an anchor or cut seconds |
| `.drop` | for `hit`: a drop time INSIDE the track, copied from library.txt (use the MAIN drop) |
| `.gain` | dB, −8…6, only to fix a level the user flagged |
| `.trackIn` | `bed` only: start the track elsewhere (rarely needed) |

## Anchors (shared with sfx.json)

`{ "on": "pieceStart" | "pieceEnd", "piece": "B" }`, `{ "on": "event", "n": 12 }`,
`{ "on": "firstEvent" }`, `{ "on": "lastEvent" }`, `{ "on": "at", "t": 30.5 }`,
`{ "on": "soundbiteStart" | "soundbiteEnd", "id": "sb1" }` (a sound bite of `timeline.json`), each
with an optional `"offset"` (seconds). A music anchor must fire exactly once (`event` needs `n`).

The music also ducks under every sound bite (state 4's `out/soundbites-key.wav`, the cut's sound
only while an official speaks), on top of the sound effects and, in footage mode, the voiceover.
`out/sections.json` and the trace show which anchor set each time.

## What the build checks

- **Errors** (nothing is built), each with the fix:
  - an unknown or stinger track;
  - the same track twice in a row;
  - a section < 6 s;
  - `ending` not last;
  - a hit with a `drop` that is not one of the track's drops;
  - `hitAt − from` < 4 s (no build-up), or a hit < 2 s before its section ends;
  - a drop too early for the build-up (the message gives the allowed `from`);
  - the track running out before the section ends;
  - the track going quiet inside the played part.
- **Warnings**: a drop that is not the MAIN drop, or one with no silence before it (weak hit).
- **Checks on the result**:
  - the stem is exactly the cut's length;
  - true peak ≤ −1 dBTP;
  - no silent holes ≥ 1.5 s (except before the music starts, a hit's breakdown, and the ending's tail);
  - every hit jumps ≥ 8 dB on its moment (measured from a −70 dB floor).

## Where it comes from

Track analysis (bed start, stops, drops, MAIN drop) is music-score's: `profile()` from
`.claude/skills/music-score/scripts/lib.mjs`, cached as `<track>.profile.json` next to each track
in `videos/ASSETS/music/`. The validation, crossfades and levelling are music-score's
`build.mjs`, anchored to the edit instead of to spoken words.
