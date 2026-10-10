// State 4 · video-edition (human review). edit.json says which stretches of the source to keep,
// at what speed, and which source moments are events (what the overlay counts and the SFX hit).
// This state maps every event onto the cut's timeline and transcodes the cut.
//   out/timeline.json   pieces in cut time + every event with srcT (source) and t (cut)
//   out/cut.mp4         H.264, edit.fps, the pieces in order (+ freezeEnd on the last frame)
//   review/event-NN.jpg       the cut around each event, ±0.5 s at 10 fps, stamped in CUT time
//   review/boundary-XY.jpg    the cut across each piece boundary
//   review/REVIEW.md          the checklist to go through with the user before approving
//   --dry   timeline.json only (no transcode, no review pictures)
// Footage mode (the voiceover was recorded after the footage) also places the voice:
//   timeline.json voice[]   each paragraph's kept take, starting at its beat (beats.json, source
//                           time) mapped onto the cut; its segments back to back, edit.voice.gap apart
//   out/voice-mix.wav       the voiceover on the cut's timeline, exactly the cut's length
//   out/ambience.wav        the cut's own sound, ducked by edit.voice.duckDb while the voice speaks
// Inserts (edit.inserts) lay clips, images, icons and animations from videos/ASSETS over the cut,
// timed by anchors. They never change the cut: timeline.json inserts[] carries them to every
// HyperFrames project (this state's Studio preview, 5, 6 and 7).
//   review/insert-<id>.jpg    a clip's frames over the stretch it plays (an image: the image)
//   preview/<project>-edit/   HyperFrames project (cut + inserts + overlay) that run.mjs opens in Studio
//   out/phone-video.mp4       the cut at 720 px, no audio: the picture of every phone proxy (4-7)
//   out/preview.mp4           phone proxy: the cut + its own sound (footage mode: voice + ambience)
// A piece with a "file" comes from videos/ASSETS instead of the footage (a sound bite: a stretch of
// a cabildo clip, with its own audio). It is fitted to the frame (a blurred, scaled-up copy behind
// it when its shape differs) and cut in like any other piece. Sound bites (state 1 soundbites.json)
// each match one such piece ("soundbite": "sb1"):
//   timeline.json soundbites[]   cut time, speaker, session, the verified caption, the Chirp word
//                                times rebased to the cut (timing only)
//   out/soundbites-key.wav       the cut's sound only where a sound bite plays: state 6 ducks the music with it
//   review/soundbite-<id>.jpg    the cut while the bite plays
// The math and the filtergraph are pintas-presupuesto/scripts/build-cut.mjs, generalized.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { envelope, meanDb, previewImage, probe, sheet, strip } from "../lib/media.mjs";
import { resolveTime } from "../lib/anchors.mjs";
import { readSidecar, readSoundbites, sidecarFile, soundbitesFile } from "../lib/enrich.mjs";
import { BOXES, buildProject } from "../lib/hfproject.mjs";
import { phoneProxy } from "../lib/review.mjs";
import { ID, UserError, assetFile, ensureDir, fmtT, hfSettings, previewDir, projectMode, readJson, sourceVideo, sourceVoice, writeJson } from "../lib/paths.mjs";

export const DEFAULT_VOICE = { duckDb: -12, gap: 0.25, minClearance: 0.3 };

/**
 * Source time -> cut time through the footage's pieces, or null when that moment is cut out.
 * { start: true }: a time on a boundary belongs to the piece that starts there (a beat's start),
 * not the one that ends there; they differ when a sound bite sits between the two.
 */
export function srcToCut(tl, srcT, { start = false } = {}) {
  const inside = (x) => !x.file && srcT >= x.from - 0.001 && srcT <= x.to + 0.001;
  const p = (start && tl.pieces.find((x) => inside(x) && srcT < x.to - 0.001)) || tl.pieces.find(inside);
  return p ? +(p.start + (Math.min(Math.max(srcT, p.from), p.to) - p.from) / p.speed).toFixed(3) : null;
}

/**
 * Footage mode: where each paragraph's voice goes on the cut. beats: [{ p, from, to }] source s;
 * alignment: state 2's paragraphs. Returns { voice, errors, warnings }.
 */
export function placeVoice(tl, beats, alignment, cfg) {
  const errors = [], warnings = [], voice = [];
  for (const a of alignment) {
    const b = beats.find((x) => x.p === a.p);
    if (!b) {
      errors.push(`p${a.p} has no beat in beats.json`);
      continue;
    }
    if (!a.found) {
      errors.push(`p${a.p} was not found in the voiceover (state 2): record it, or remove it from the script`);
      continue;
    }
    const at = srcToCut(tl, b.from, { start: true });
    if (at === null) {
      errors.push(`p${a.p}'s beat starts at source ${b.from}s, which no piece keeps: move the beat, or extend a piece over it`);
      continue;
    }
    let off = 0;
    const segments = a.segments.map((s) => {
      const seg = { from: s.start, to: s.end, at: +(at + off).toFixed(3) };
      off += s.end - s.start + cfg.gap;
      return seg;
    });
    const dur = +(off - cfg.gap).toFixed(3);
    const beatEnd = srcToCut(tl, b.to) ?? at;
    if (at + dur > beatEnd + 0.05) warnings.push(`p${a.p}: the voice runs ${(at + dur - beatEnd).toFixed(1)} s past its beat (into the footage after it)`);
    voice.push({ p: a.p, at, dur, beat: { from: b.from, to: b.to, cutEnd: beatEnd }, segments });
  }
  voice.sort((x, y) => x.at - y.at);
  voice.forEach((v, i) => {
    const next = voice[i + 1];
    const limit = next ? next.at - cfg.minClearance : tl.duration;
    if (v.at + v.dur > limit + 0.001)
      errors.push(`p${v.p} runs ${(v.at + v.dur - limit).toFixed(1)} s over ${next ? `the start of p${next.p} (they must be ${cfg.minClearance} s apart)` : "the end of the cut"}: shorten the paragraph and record it again, give beat ${v.p} a longer stretch, or slow down its piece`);
  });
  // A sound bite is the session's own voice: the narration pauses for it.
  for (const s of tl.pieces.filter((x) => x.soundbite))
    for (const v of voice)
      if (v.at < s.start + s.duration - 0.001 && v.at + v.dur > s.start + 0.001)
        errors.push(`p${v.p} (cut ${v.at}–${(v.at + v.dur).toFixed(2)}s) speaks over sound bite ${s.soundbite} (piece ${s.id}, cut ${s.start}–${(s.start + s.duration).toFixed(2)}s): move the bite's piece between two paragraphs' stretches, or shorten the paragraph`);
  return { voice, errors, warnings };
}

/**
 * fileDurations: { <piece "file">: seconds } for pieces that come from videos/ASSETS (a missing or
 * unreadable file is reported by the caller and skipped here).
 */
export function validate(edit, srcDuration, fileDurations = {}) {
  const errors = [], warnings = [];
  const fps = edit.fps ?? 30;
  if (!Array.isArray(edit.pieces) || !edit.pieces.length) errors.push(`"pieces" must list at least one piece`);
  const ids = new Set();
  for (const [i, p] of (edit.pieces || []).entries()) {
    const at = `piece ${p.id ?? `#${i + 1}`}`;
    if (!p.id) errors.push(`piece #${i + 1} has no "id"`);
    if (ids.has(p.id)) errors.push(`${at}: the id is used twice`);
    ids.add(p.id);
    if (!(p.to > p.from)) errors.push(`${at}: "to" (${p.to}) must be greater than "from" (${p.from})`);
    if (p.file) {
      const D = fileDurations[p.file];
      if (D != null && (p.from < 0 || p.to > D + 0.001)) errors.push(`${at}: ${p.from}–${p.to}s is outside videos/ASSETS/${p.file} (0–${D}s)`);
    } else if (p.from < 0 || p.to > srcDuration + 0.001) errors.push(`${at}: ${p.from}–${p.to}s is outside the source (0–${srcDuration}s)`);
    if (!(p.speed > 0)) errors.push(`${at}: "speed" must be a positive number (1 = normal, 4 = four times faster)`);
    if (p.soundbite != null && (p.speed !== 1 || p.audio === false)) errors.push(`${at}: sound bite ${p.soundbite} must play at "speed": 1 with its audio (someone is speaking)`);
    if (p.soundbite != null && !p.file) errors.push(`${at}: sound bite ${p.soundbite} needs the "file" of its clip (clips/cabildo/…)`);
    const outFrames = ((p.to - p.from) * fps) / (p.speed || 1);
    if (Math.abs(outFrames - Math.round(outFrames)) > 0.01)
      warnings.push(`${at}: lasts ${outFrames.toFixed(2)} output frames, not a whole number; the cut will drift by a fraction of a frame. Make (to - from) * ${fps} / speed whole.`);
  }
  // Overlap only matters within one source: the footage, or one file of videos/ASSETS.
  const sources = new Map();
  for (const p of edit.pieces || []) sources.set(p.file || "", [...(sources.get(p.file || "") || []), p]);
  for (const [file, list] of sources) {
    const sorted = [...list].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i].from < sorted[i - 1].to - 0.001) errors.push(`pieces ${sorted[i - 1].id} and ${sorted[i].id} overlap in ${file ? `videos/ASSETS/${file}` : "the source"} (${sorted[i].from} < ${sorted[i - 1].to})`);
  }

  const seen = new Set();
  for (const [i, e] of (edit.events || []).entries()) {
    const at = `event n=${e.n ?? `#${i + 1}`}`;
    if (e.n == null) errors.push(`event #${i + 1} has no "n"`);
    if (seen.has(e.n)) errors.push(`${at}: n is used twice`);
    seen.add(e.n);
    if (e.verified !== true) errors.push(`${at} (${e.srcT}s) is verified:${e.verified}. Confirm it on its strip/contact sheet and set "verified": true, or delete it.`);
    const p = (edit.pieces || []).find((x) => x.id === e.piece);
    if (!p) errors.push(`${at}: piece "${e.piece}" does not exist (pieces: ${[...ids].join(", ")})`);
    else if (p.file) errors.push(`${at}: piece ${p.id} is videos/ASSETS/${p.file}, not the footage; events count things in the footage`);
    else if (e.srcT < p.from || e.srcT > p.to) {
      const fit = edit.pieces.find((x) => !x.file && e.srcT >= x.from && e.srcT <= x.to);
      errors.push(`${at}: srcT ${e.srcT}s is outside piece ${p.id} (${p.from}–${p.to}s)${fit ? `; it falls in piece ${fit.id}` : "; no piece contains it, so it would be cut out"}`);
    }
  }
  if (!(edit.events || []).length) warnings.push("no events: nothing will be counted and no event SFX can fire (fine for a talking video)");
  return { errors, warnings };
}

// What an insert is, from its extension. Every insert file lives in videos/ASSETS.
const KINDS = { ".mp4": "clip", ".mov": "clip", ".webm": "clip", ".m4v": "clip", ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image", ".gif": "image", ".svg": "icon", ".html": "animation" };

/**
 * edit.inserts -> timeline inserts: file checked inside videos/ASSETS, "at" resolved through the
 * anchors of the cut (frame-snapped), "dur" checked against the cut and the clip. Returns
 * { inserts, errors, warnings }; nothing is thrown, so every problem is reported at once.
 */
export function resolveInserts(ctx, edit, tl) {
  const errors = [], warnings = [], inserts = [], ids = new Set(), comps = new Map();
  const frame = (t) => +(Math.round(t * tl.fps) / tl.fps).toFixed(3);
  const caught = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      errors.push(e.message);
      return null;
    }
  };
  for (const [i, x] of (edit.inserts || []).entries()) {
    const who = `insert ${x.id ?? `#${i + 1}`}`;
    const E = (m) => errors.push(`${who}: ${m}`);
    if (!/^[A-Za-z0-9_-]+$/.test(x.id || "")) {
      E(`"id" must be a short name of letters, digits, - or _ (got ${JSON.stringify(x.id)})`);
      continue;
    }
    if (ids.has(x.id)) {
      E("the id is used twice");
      continue;
    }
    ids.add(x.id);
    const a = caught(() => assetFile(x.file, "", who));
    if (!a) continue;
    const kind = KINDS[extname(a.file).toLowerCase()];
    if (!kind) {
      E(`${a.rel}: cannot place a ${extname(a.file) || "file without an extension"} (use ${Object.keys(KINDS).join(" ")})`);
      continue;
    }
    const at = caught(() => resolveTime(x.at, tl, `${who} "at"`));
    if (!at) continue;
    const r = { id: x.id, kind, file: a.rel, t: frame(at.t), anchor: at.anchor, box: x.box, css: x.css || undefined, fadeIn: x.fadeIn || undefined, fadeOut: x.fadeOut || undefined };
    let own = null; // the length the asset brings: a clip from "from" on, an animation's data-duration
    if (kind === "clip") {
      const info = probe(ctx, a.file);
      r.from = x.from ?? 0;
      if (!(r.from >= 0)) E(`"from" must be seconds inside the clip (got ${JSON.stringify(x.from)})`);
      own = +(info.duration - r.from).toFixed(3);
    } else if (x.from != null) E(`"from" is for clips only`);
    if (kind === "animation") {
      const m = /<[^>]*\bdata-composition-id="([^"]+)"[^>]*>/.exec(readFileSync(a.file, "utf8"));
      if (!m) {
        E(`${a.rel} has no data-composition-id: it is not a HyperFrames sub-composition`);
        continue;
      }
      r.compId = m[1];
      r.width = +(/data-width="(\d+)"/.exec(m[0])?.[1] || 1080);
      r.height = +(/data-height="(\d+)"/.exec(m[0])?.[1] || 1920);
      const d = /data-duration="([\d.]+)"/.exec(m[0]);
      if (d) own = +d[1];
      if (comps.has(r.compId)) E(`${a.rel} is already placed by insert ${comps.get(r.compId)}: an animation can be mounted once per video`);
      comps.set(r.compId, x.id);
    }
    r.dur = x.dur ?? own;
    if (!(typeof r.dur === "number" && r.dur > 0)) {
      E(`"dur" must be seconds on screen${kind === "image" || kind === "icon" ? " (an image or icon has no length of its own)" : ""}`);
      continue;
    }
    r.dur = +r.dur.toFixed(3);
    if (kind === "clip" && r.dur > own + 0.05) E(`${a.rel} has only ${own}s from ${r.from}s on, but "dur" is ${r.dur}s: shorten "dur" or start earlier with "from"`);
    if (kind === "animation" && own && r.dur > own + 0.05) warnings.push(`${who}: ${a.rel} is a ${own}s animation shown for ${r.dur}s; it holds its last frame for the rest`);
    if (r.t < 0 || r.t + r.dur > tl.duration + 0.001) E(`cut ${r.t}–${(r.t + r.dur).toFixed(3)}s is outside the cut (0–${tl.duration}s)`);
    r.box ??= kind === "icon" ? "center" : kind === "animation" && r.height < 1920 ? "lower" : "full";
    if (!BOXES[r.box]) E(`"box" must be one of ${Object.keys(BOXES).join(", ")} (got ${JSON.stringify(x.box)}); fine-tune it with "css"`);
    if ((r.fadeIn || 0) + (r.fadeOut || 0) > r.dur) E(`fadeIn + fadeOut (${(r.fadeIn || 0) + (r.fadeOut || 0)}s) is longer than "dur" (${r.dur}s)`);
    inserts.push(r);
  }
  inserts.sort((p, q) => p.t - q.t);
  inserts.forEach((x, i) => {
    for (const p of inserts.slice(0, i))
      if (p.box === x.box && x.t < p.t + p.dur - 0.001) warnings.push(`inserts ${p.id} and ${x.id} overlap in the same box (${p.box}); the later one covers the earlier`);
  });
  return { inserts, errors, warnings };
}

/** build-cut.mjs: pieces back to back, events mapped through (srcT - from) / speed, frame-snapped. */
export function timeline(edit) {
  const fps = edit.fps ?? 30;
  const freeze = edit.freezeEnd ?? 0;
  let cursor = 0;
  const pieces = edit.pieces.map((p) => {
    const len = (p.to - p.from) / p.speed;
    const r = { id: p.id, start: cursor, duration: len, speed: p.speed, from: p.from, to: p.to, audio: p.audio !== false };
    if (p.file) r.file = p.file; // from videos/ASSETS, not the footage ("from"/"to" are its seconds)
    if (p.soundbite != null) r.soundbite = p.soundbite;
    cursor += len;
    return r;
  });
  const frame = (t) => Math.round(t * fps) / fps;
  const events = (edit.events || []).map(({ n, srcT, piece, anchor, label }) => {
    const p = pieces.find((x) => x.id === piece);
    return { n, srcT, t: +frame(p.start + (srcT - p.from) / p.speed).toFixed(3), piece, anchor, label };
  });
  events.sort((a, b) => a.t - b.t);
  return {
    fps,
    freezeEnd: freeze,
    duration: +(cursor + freeze).toFixed(3),
    pieces: pieces.map((p) => ({ ...p, start: +p.start.toFixed(3), duration: +p.duration.toFixed(3) })),
    events,
  };
}

/**
 * The cut's ffmpeg inputs and filtergraph (build-cut.mjs): trim each piece, retime it, concat;
 * muted pieces keep a silent audio track so concat stays aligned. src: { file, probe } of the
 * footage. clips: { <piece "file">: { file (absolute), probe } } for pieces from videos/ASSETS: one
 * extra input each, fitted to the footage's frame (a clip of another shape sits centred on a
 * blurred, scaled-up copy of itself), fps normalized, audio 48 kHz stereo (silence when it has none).
 */
export function cutGraph(tl, src, clips = {}) {
  const fps = tl.fps, last = tl.pieces.length - 1;
  const f = [];
  const inputs = ["-i", src.file];
  if (!src.probe.hasAudio) inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  const A = src.probe.hasAudio ? "0:a" : "1:a";
  const idx = {};
  let n = src.probe.hasAudio ? 1 : 2;
  for (const p of tl.pieces)
    if (p.file && idx[p.file] == null) {
      if (!clips[p.file]) throw new Error(`cutGraph: no probe for ${p.file}`);
      idx[p.file] = n++;
      inputs.push("-i", clips[p.file].file);
    }
  // Square pixels on every segment, so concat accepts the mix (only when there is a mix).
  const sar = n > (src.probe.hasAudio ? 1 : 2) ? ",setsar=1" : "";
  const W = src.probe.width, H = src.probe.height;
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  tl.pieces.forEach((p, i) => {
    const isLast = i === last;
    const hold = isLast && tl.freezeEnd ? `,tpad=stop_mode=clone:stop_duration=${tl.freezeEnd}` : "";
    const fade = `afade=t=in:d=0.03,afade=t=out:st=${(p.duration - 0.03).toFixed(3)}:d=0.03`;
    const pad = isLast && tl.freezeEnd ? `,apad=pad_dur=${tl.freezeEnd}` : "";
    if (!p.file) {
      f.push(`[0:v]trim=${p.from}:${p.to},setpts=(PTS-STARTPTS)/${p.speed},fps=${fps}${sar}` + hold + `[v${i}]`);
      f.push(p.audio && src.probe.hasAudio
        ? `[${A}]atrim=${p.from}:${p.to},asetpts=PTS-STARTPTS,${fade}${pad}[a${i}]`
        : `[${A}]atrim=0:${(p.duration).toFixed(3)},asetpts=PTS-STARTPTS,volume=0${pad}[a${i}]`);
      return;
    }
    const c = clips[p.file], k = idx[p.file];
    const trim = `[${k}:v]trim=${p.from}:${p.to},setpts=(PTS-STARTPTS)/${p.speed},fps=${fps}`;
    if (c.probe.width * H === c.probe.height * W) f.push(`${trim},scale=${W}:${H},setsar=1${hold}[v${i}]`);
    else
      f.push(`${trim},split[vb${i}][vf${i}]`,
        // Behind: the clip filling the frame, blurred (at a quarter size: same look, much faster).
        `[vb${i}]scale=${even(W / 4)}:${even(H / 4)}:force_original_aspect_ratio=increase,crop=${even(W / 4)}:${even(H / 4)},boxblur=10:2,scale=${W}:${H},eq=brightness=-0.06[bg${i}]`,
        `[vf${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg${i}]`,
        `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1${hold}[v${i}]`);
    const mute = p.audio ? "" : ",volume=0";
    f.push(c.probe.hasAudio
      ? `[${k}:a]atrim=${p.from}:${p.to},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${fade}${mute}${pad}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${(p.duration).toFixed(3)},asetpts=PTS-STARTPTS${pad}[a${i}]`);
  });
  f.push(tl.pieces.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${tl.pieces.length}:v=1:a=1[v][a]`);
  return { inputs, graph: f.join(";") };
}

/** An ffmpeg expression (commas escaped for a filter chain): 1 while a sound bite plays, else 0. */
const biteGate = (tl) => tl.soundbites.map((s) => `between(t\\,${s.t}\\,${(s.t + s.dur).toFixed(3)})`).reduce((a, b) => `max(${a}\\,${b})`);

/** The files of pieces from videos/ASSETS: { clips: { <file>: { file, rel, probe } }, errors }. */
function pieceFiles(ctx, edit) {
  const clips = {}, errors = [];
  for (const p of edit.pieces || []) {
    if (!p.file || clips[p.file]) continue;
    try {
      const a = assetFile(p.file, "", `piece ${p.id}`);
      clips[p.file] = { ...a, probe: probe(ctx, a.file) };
      if (!clips[p.file].probe.hasVideo) errors.push(`piece ${p.id}: videos/ASSETS/${a.rel} has no video stream`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      errors.push(e.message);
    }
  }
  return { clips, errors };
}

/**
 * State 1's soundbites.json against the pieces: every sound bite is played by exactly one piece
 * ("soundbite": its id) and every such piece names a sound bite. Returns { soundbites, errors,
 * warnings, files } (files: what was read, for the trace).
 */
export function resolveSoundbites(P, tl) {
  const errors = [], warnings = [], files = [];
  const bites = readSoundbites(P);
  const used = tl.pieces.filter((p) => p.soundbite != null);
  if (!bites) {
    if (used.length) errors.push(`piece(s) ${used.map((p) => `${p.id} (${p.soundbite})`).join(", ")} play sound bites, but state 1 has no soundbites.json`);
    return { soundbites: [], errors, warnings, files };
  }
  files.push([soundbitesFile(P), "sound bites (state 1): verified captions"]);
  const out = [];
  for (const b of bites) {
    const ps = used.filter((p) => p.soundbite === b.id);
    if (ps.length !== 1) {
      errors.push(ps.length ? `sound bite ${b.id} is played by ${ps.length} pieces (${ps.map((p) => p.id).join(", ")}); one only` : `sound bite ${b.id} (soundbites.json) has no piece: add { "id": "S1", "file": "${b.clip}", "from": ${b.from}, "to": ${b.to}, "speed": 1, "audio": true, "soundbite": "${b.id}" } to "pieces" where it plays`);
      continue;
    }
    const p = ps[0];
    if (b.verified !== true) errors.push(`sound bite ${b.id} is not verified (state 1): its caption must be checked by ear before it goes on screen`);
    let a = null;
    try {
      a = assetFile(b.clip, "", `sound bite ${b.id}`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      errors.push(e.message);
      continue;
    }
    const pf = (() => {
      try {
        return assetFile(p.file, "", `piece ${p.id}`).rel;
      } catch {
        return p.file;
      }
    })();
    if (pf !== a.rel) errors.push(`piece ${p.id} plays videos/ASSETS/${pf}, but sound bite ${b.id} is videos/ASSETS/${a.rel}`);
    if (Math.abs(p.from - b.from) > 0.1 || Math.abs(p.to - b.to) > 0.1)
      warnings.push(`piece ${p.id} plays ${p.from}–${p.to}s of the clip, but sound bite ${b.id} is ${b.from}–${b.to}s: the caption was verified for the bite's stretch`);
    const side = readSidecar(a.file) || {};
    if (existsSync(sidecarFile(a.file))) files.push([sidecarFile(a.file), `sound bite ${b.id}: fact-checker sidecar`]);
    // Chirp's word times, moved onto the cut: they time the caption's reveal, never its text.
    const words = (side.words || [])
      .filter((w) => w.end > p.from && w.start < p.to)
      .map((w) => ({ text: w.text, start: +(p.start + Math.max(0, w.start - p.from)).toFixed(3), end: +(p.start + Math.min(p.to, w.end) - p.from).toFixed(3) }));
    out.push({
      id: b.id, t: p.start, dur: p.duration, piece: p.id, clip: a.rel, from: p.from, to: p.to,
      speaker: b.speaker || side.speaker || "", role: b.role || "", session: side.session ?? null, date: side.date ?? null,
      caption: String(b.caption || "").trim(), words,
    });
  }
  for (const p of used) if (!bites.some((b) => b.id === p.soundbite)) errors.push(`piece ${p.id} plays sound bite "${p.soundbite}", which is not in soundbites.json`);
  return { soundbites: out.sort((x, y) => x.t - y.t), errors, warnings, files };
}

export async function run(ctx) {
  const { P, S, opts } = ctx;
  const src = sourceVideo(P);
  const edit = readJson(S.config);
  ctx.params = edit;
  ctx.input(S.config, "edit (human)");
  if (!opts.dry) ctx.input(src.file, "source video");
  const srcDur = src.probe.duration;

  if (edit._scaffold) ctx.warn(`edit.json is still a scaffold written by the scripts (${edit._seededBy || "init.mjs: one piece = the whole video"}). Check it, delete "_scaffold", then approve.`);
  // Pieces may come from videos/ASSETS ("file"): their length bounds them.
  const { clips, errors: fileErrors } = pieceFiles(ctx, edit);
  const durations = Object.fromEntries(Object.entries(clips).map(([k, c]) => [k, c.probe.duration]));
  const { errors, warnings } = validate(edit, srcDur, durations);
  errors.unshift(...fileErrors);
  warnings.forEach((w) => ctx.warn(w));
  if (errors.length) throw new UserError(`edit.json has ${errors.length} error(s); nothing was built:\n- ${errors.join("\n- ")}`);
  for (const c of Object.values(clips)) ctx.input(c.file, `piece source (videos/ASSETS/${c.rel})`);

  const tl = timeline(edit);
  const out = ensureDir(S.out);

  // Sound bites: the council session's own voice, captioned with the words the user verified.
  const sb = resolveSoundbites(P, tl);
  sb.warnings.forEach((w) => ctx.warn(w));
  if (sb.errors.length) throw new UserError(`the sound bites do not match the pieces (${sb.errors.length} problem(s)); nothing was built:\n- ${sb.errors.join("\n- ")}`);
  for (const [f, role] of sb.files) ctx.input(f, role);
  if (sb.soundbites.length) tl.soundbites = sb.soundbites;
  for (const s of sb.soundbites) ctx.log(`sound bite ${s.id}: piece ${s.piece}, cut ${s.t}+${s.dur}s, ${s.speaker || "?"}${s.session ? ` (${s.session}${s.date ? `, ${s.date}` : ""})` : ""}`);

  // Inserts: overlays from videos/ASSETS, placed by anchors on the cut. They do not change the cut.
  const inserted = resolveInserts(ctx, edit, tl);
  inserted.warnings.forEach((w) => ctx.warn(w));
  if (inserted.errors.length) throw new UserError(`edit.json "inserts" has ${inserted.errors.length} error(s); nothing was built:\n- ${inserted.errors.join("\n- ")}`);
  if (inserted.inserts.length) tl.inserts = inserted.inserts;
  for (const x of inserted.inserts) {
    ctx.input(assetFile(x.file, "", `insert ${x.id}`).file, `insert ${x.id} (videos/ASSETS)`);
    ctx.log(`insert ${x.id}: ${x.kind} videos/ASSETS/${x.file} at cut ${x.t}+${x.dur}s (${x.anchor}), box ${x.box}`);
  }

  // Footage mode: the voiceover goes over the footage, each paragraph at its beat.
  const footageMode = projectMode(P) === "footage";
  const vcfg = { ...DEFAULT_VOICE, ...(edit.voice || {}) };
  let voiceSrc = null;
  if (footageMode) {
    const alFile = join(P.st[ID.audio].out, "alignment.json"), beatsFile = join(P.st[ID.script].dir, "beats.json");
    if (!existsSync(alFile)) throw new UserError("footage mode: no alignment.json from state 2. Run state 2 on the voiceover first.");
    ctx.input(alFile, "alignment of the voiceover (state 2)");
    ctx.input(beatsFile, "beats (state 1)");
    const beatsJ = readJson(beatsFile);
    // { "soundbite": "sb1", "afterBeat": 2 } entries of beats.json are not paragraphs.
    const beatList = (Array.isArray(beatsJ) ? beatsJ : beatsJ.beats).filter((x) => x?.soundbite == null);
    const placed = placeVoice(tl, beatList, readJson(alFile).paragraphs, vcfg);
    placed.warnings.forEach((w) => ctx.warn(w));
    if (placed.errors.length) throw new UserError(`the voiceover does not fit the cut (${placed.errors.length} problem(s)):\n- ${placed.errors.join("\n- ")}`);
    tl.voice = placed.voice;
    tl.voiceDuckDb = vcfg.duckDb;
    for (const v of tl.voice) ctx.log(`voice p${v.p}: cut ${v.at}+${v.dur}s (beat at source ${fmtT(v.beat.from)}), ${v.segments.length} segment(s)`);
    if (!opts.dry) {
      voiceSrc = sourceVoice(P);
      ctx.input(voiceSrc.file, "voiceover");
    }
  }
  writeJson(join(out, "timeline.json"), tl);
  ctx.output(join(out, "timeline.json"), `${tl.events.length} events, duration ${tl.duration}s`);
  for (const p of tl.pieces) ctx.log(`piece ${p.id}: ${p.file ? `videos/ASSETS/${p.file} ` : "source "}${fmtT(p.from)}–${fmtT(p.to)} at ${p.speed}x -> cut ${p.start}+${p.duration}s${p.audio ? "" : " (muted)"}${p.soundbite ? ` (sound bite ${p.soundbite})` : ""}`);
  const ordered = tl.events.map((e) => e.n);
  if (ordered.some((n, i) => i && n < ordered[i - 1])) ctx.warn(`events are not in n order on the cut timeline: ${ordered.join(",")}`);
  ctx.extra.summary = { duration: tl.duration, pieces: tl.pieces.length, events: tl.events.length, voice: tl.voice?.length ?? 0, inserts: inserted.inserts.length, soundbites: sb.soundbites.length };
  if (sb.soundbites.length) ctx.extra.soundbites = sb.soundbites.map(({ words, ...s }) => ({ ...s, words: words.length }));
  if (opts.dry) {
    ctx.note("--dry: timeline only. cut.mp4 and the review pictures were NOT rebuilt.");
    return;
  }

  const fps = tl.fps;
  const { inputs, graph } = cutGraph(tl, src, clips);
  const cut = join(out, "cut.mp4");
  ctx.ffmpeg([...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p", "-r", String(fps), "-g", String(Math.round(fps)), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", cut], { why: "transcode the cut" });

  const info = probe(ctx, cut);
  ctx.output(cut, `${info.duration}s, ${info.frames ?? "?"} frames at ${fps} fps`);
  ctx.check("cut duration matches the timeline", Math.abs(info.duration - tl.duration) <= 1.5 / fps + 0.03, `cut ${info.duration}s vs timeline ${tl.duration}s`);
  if (info.frames) ctx.check("cut frame count", Math.abs(info.frames - Math.round(tl.duration * fps)) <= 1, `${info.frames} frames, expected ${Math.round(tl.duration * fps)}`);
  // Times are stored to the millisecond, so a frame-exact 75.667 s is 0.010 frames off at 30 fps.
  ctx.check("every event lands on a whole frame", tl.events.every((e) => Math.abs(e.t * fps - Math.round(e.t * fps)) <= 0.0005 * fps + 1e-6));
  ctx.check("every event is inside the cut", tl.events.every((e) => e.t >= 0 && e.t <= tl.duration));

  // soundbites-key.wav: the cut's sound only while a sound bite plays (silence elsewhere). State 6
  // ducks the music with it, so the music dips under the official's voice.
  const sbKey = join(out, "soundbites-key.wav");
  if (tl.soundbites?.length) {
    ctx.ffmpeg(["-i", cut, "-vn", "-af", `aresample=48000,aformat=channel_layouts=stereo,volume=${biteGate(tl)}:eval=frame`, "-ar", "48000", "-c:a", "pcm_s16le", sbKey], { why: "sound-bite ducking key (the cut's sound only during the bites)" });
    ctx.output(sbKey, `the cut's sound during ${tl.soundbites.length} sound bite(s), silence elsewhere: state 6's ducking key`);
  } else rmSync(sbKey, { force: true });

  if (voiceSrc) {
    // voice-mix.wav: every kept segment of the voiceover, delayed to its place on the cut.
    const segs = tl.voice.flatMap((v) => v.segments);
    const D = tl.duration;
    const vm = join(out, "voice-mix.wav"), amb = join(out, "ambience.wav");
    // The voice is mono: its first channel goes to both sides at full level (an upmix would lose 3 dB).
    const fc =[`[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,asplit=${segs.length}${segs.map((_, i) => `[s${i}]`).join("")}`];
    segs.forEach((g, i) => {
      const len = +(g.to - g.from).toFixed(3);
      fc.push(`[s${i}]atrim=${g.from}:${g.to},asetpts=PTS-STARTPTS,afade=t=in:d=0.015,afade=t=out:st=${Math.max(0, len - 0.015).toFixed(3)}:d=0.015,adelay=${Math.round(g.at * 1000)}:all=1[d${i}]`);
    });
    fc.push(`${segs.map((_, i) => `[d${i}]`).join("")}amix=inputs=${segs.length}:normalize=0,apad=whole_dur=${D},atrim=0:${D}[v]`);
    ctx.ffmpeg(["-i", voiceSrc.file, "-filter_complex", fc.join(";"), "-map", "[v]", "-ar", "48000", "-c:a", "pcm_s16le", vm], { why: "place the voiceover on the cut" });
    const vi = probe(ctx, vm);
    ctx.output(vm, `${tl.voice.length} paragraphs, ${segs.length} segments, ${vi.duration}s`);
    ctx.check("voice-mix is exactly the cut's length", Math.abs(vi.duration - D) <= 0.05, `${vi.duration}s vs ${D}s`);

    // ambience.wav: the cut's own sound, down by duckDb under each paragraph (0.25 s ramp in, 0.4 s out).
    const G = Math.pow(10, vcfg.duckDb / 20);
    // Commas inside the expression are escaped (\\,) so the filter chain does not split on them.
    let W = tl.voice.map((v) => `clip((t-(${(v.at - 0.25).toFixed(3)}))/0.25\\,0\\,1)*clip((${(v.at + v.dur + 0.4).toFixed(3)}-t)/0.4\\,0\\,1)`).reduce((a, b) => `max(${a}\\,${b})`);
    // A sound bite is never ducked: the ramps of the paragraphs around it stop at its edges.
    if (tl.soundbites?.length) W = `${W}*(1-${biteGate(tl)})`;
    ctx.ffmpeg(["-i", cut, "-vn", "-af", `aresample=48000,volume=1-${(1 - G).toFixed(4)}*${W}:eval=frame`, "-ar", "48000", "-c:a", "pcm_s16le", amb], { why: `duck the footage's sound ${vcfg.duckDb} dB under the voice` });
    ctx.output(amb, `the cut's own sound, ${vcfg.duckDb} dB under the voice`);
    const eCut = envelope(ctx, cut), eAmb = envelope(ctx, amb);
    const short = [];
    for (const v of tl.voice) {
      const a = v.at + 0.3, b = v.at + v.dur - 0.1;
      if (b - a < 0.2 || meanDb(eCut, a, b) < -60) continue; // too short to measure, or nothing to duck
      const drop = meanDb(eCut, a, b) - meanDb(eAmb, a, b);
      if (drop < Math.abs(vcfg.duckDb) - 1.5) short.push(`p${v.p}: ${drop.toFixed(1)} dB`);
    }
    ctx.check("the footage's sound is ducked under the voice", !short.length, short.join("; ") || `${vcfg.duckDb} dB under every paragraph`);
  }

  // Review pictures: they show the CUT, so they prove the mapping, not just the source.
  const rdir = join(S.dir, "review");
  if (existsSync(rdir)) rmSync(rdir, { recursive: true, force: true });
  ensureDir(rdir);
  const lines = [];
  for (const e of tl.events) {
    const file = strip(ctx, cut, e.t - 0.5, 1.0, 10, join(rdir, `event-${String(e.n).padStart(2, "0")}.jpg`), `review strip event ${e.n}`);
    ctx.image(file, `event #${e.n}: cut ${e.t}s (source ${e.srcT}s, piece ${e.piece}); the 6th tile is the event frame`);
    lines.push(`- [ ] #${e.n} at cut ${e.t}s (source ${fmtT(e.srcT)}, piece ${e.piece}) — \`review/event-${String(e.n).padStart(2, "0")}.jpg\`: the 6th tile shows the thing being counted`);
  }
  const bLines = [];
  for (let i = 1; i < tl.pieces.length; i++) {
    const a = tl.pieces[i - 1], b = tl.pieces[i];
    const file = strip(ctx, cut, b.start - 0.4, 0.8, 10, join(rdir, `boundary-${a.id}${b.id}.jpg`), `review boundary ${a.id}->${b.id}`);
    ctx.image(file, `cut ${a.id}→${b.id} at ${b.start}s (source ${fmtT(a.to)} → ${fmtT(b.from)})`);
    bLines.push(`- [ ] ${a.id}→${b.id} at cut ${b.start}s — \`review/boundary-${a.id}${b.id}.jpg\`: the jump looks intentional (no half-frame, no repeated shot)`);
  }
  const iLines = [];
  for (const x of inserted.inserts) {
    const pic = join(rdir, `insert-${x.id}.jpg`);
    const file = assetFile(x.file, "", `insert ${x.id}`).file;
    if (x.kind === "clip") {
      const n = 8, d = Math.min(x.dur, 30);
      ctx.ffmpeg(["-ss", String(x.from), "-t", String(d), "-i", file, "-vf", `fps=${(n / d).toFixed(4)},scale=-2:240,tile=${n}x1`, "-frames:v", "1", pic], { why: `review insert ${x.id}` });
    } else if (x.kind === "image") previewImage(ctx, file, pic);
    if (existsSync(pic)) ctx.image(pic, `insert ${x.id}: videos/ASSETS/${x.file}${x.kind === "clip" ? `, ${x.from}–${(x.from + x.dur).toFixed(2)}s of the clip` : ""}`);
    iLines.push(`| ${x.id} | ${x.kind} | \`videos/ASSETS/${x.file}\` | ${x.t}–${(x.t + x.dur).toFixed(3)}s (${x.anchor}) | ${x.box} | ${existsSync(pic) ? `\`review/insert-${x.id}.jpg\`` : "Studio only"} |`);
  }
  const sLines = [];
  for (const s of tl.soundbites || []) {
    const pic = sheet(ctx, cut, s.t, s.t + s.dur, Math.max(0.5, +(s.dur / 8).toFixed(2)), join(rdir, `soundbite-${s.id}.jpg`), `review sound bite ${s.id}`);
    ctx.image(pic, `sound bite ${s.id}: cut ${s.t}–${(s.t + s.dur).toFixed(3)}s, ${s.speaker || "?"} (videos/ASSETS/${s.clip} ${s.from}–${s.to}s)`);
    sLines.push(`- [ ] **${s.id}** at cut ${s.t}–${(s.t + s.dur).toFixed(3)}s (piece ${s.piece}) — ${s.speaker || "?"}${s.role ? `, ${s.role}` : ""}${s.session ? ` · ${s.session}` : ""}${s.date ? ` · ${s.date}` : ""} — \`review/soundbite-${s.id}.jpg\``, `  «${s.caption}»`);
  }
  writeFileSync(join(rdir, "REVIEW.md"), [
    "# Review: video edition", "",
    `Cut: \`out/cut.mp4\`, ${tl.duration}s, ${tl.pieces.length} pieces, ${tl.events.length} events${tl.soundbites?.length ? `, ${tl.soundbites.length} sound bite(s)` : ""}.`, "",
    "| piece | source | speed | cut |", "|---|---|---|---|",
    ...tl.pieces.map((p) => `| ${p.id} | ${p.file ? `\`${p.file}\` ` : ""}${fmtT(p.from)}–${fmtT(p.to)} | ${p.speed}x${p.audio ? "" : ", muted"} | ${p.start}–${(p.start + p.duration).toFixed(3)}s |`), "",
    "## Events", "", ...lines, "", "## Boundaries", "", ...(bLines.length ? bLines : ["- (single piece)"]), "",
    ...(sLines.length ? ["## Sound bites (the session's own audio, captioned)", "", "Play each one in the Studio preview: the right words on screen, the name and role right, the narration silent while the official speaks.", "", ...sLines, ""] : []),
    ...(iLines.length ? ["## Inserts (from videos/ASSETS)", "", "Play them in the Studio preview: each sits where it should, at the right moment, without covering what is counted.", "",
      "| id | kind | file | cut | box | picture |", "|---|---|---|---|---|---|", ...iLines, ""] : []),
    "Show this to the user. Only when they say it is right:", "",
    "```", `node .claude/skills/traced-edit/scripts/approve.mjs ${JSON.stringify(P.root)} ${ID.edit} --note "<what they said>"`, "```", "",
  ].join("\n"));
  ctx.output(join(rdir, "REVIEW.md"), "checklist for the user");

  // The Studio preview: the cut with its inserts (and the overlay when deliver.json has one).
  const hs = hfSettings(P);
  buildProject(ctx, P, previewDir(P, ID.edit), { overlay: hs.overlay, volumes: hs.volumes });
  // What the phone plays (review.mjs): the picture is encoded once here and reused by 5, 6 and 7.
  phoneProxy(ctx, P);
}
