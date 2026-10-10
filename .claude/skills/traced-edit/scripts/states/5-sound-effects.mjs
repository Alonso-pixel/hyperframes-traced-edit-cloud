// State 5 · sound-effects (human review). sfx.json holds rules; each rule anchors a sound to the
// cut's events or piece boundaries (out of state 4's timeline.json). The rules expand into a cue
// sheet, and the cues are pre-mixed into one stem.
// Every sound comes from the shared library, videos/ASSETS/sound-effects: a path outside it is an error.
//   out/sounds.txt     every sound in the library, as the path to paste into sfx.json "sounds"
//   out/cues.json      every cue: time, sound, gain, AND the rule + anchor that produced it
//   out/sfx-mix.wav    48 kHz stereo stem, exactly the cut's length, limited at -1 dBFS
//   out/preview.mp4    phone proxy: the cut + its own sound + the sfx at deliver.json volumes
//   listen/*.mp4       3 s clips around each piece boundary and the first/last event
//   preview/<project>-sfx/   HyperFrames project (cut + sfx + overlay) that run.mjs opens in Studio
//   --dry   sounds.txt + cues.json + the printed cue sheet only (no mix). Allowed before state 4 is approved.
// The cue math and mix are pintas-presupuesto/scripts/build-sfx.mjs, made rule-driven.
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { analyzeSound, loudness, probe } from "../lib/media.mjs";
import { ONS, anchors } from "../lib/anchors.mjs";
import { buildProject } from "../lib/hfproject.mjs";
import { phoneProxy } from "../lib/review.mjs";
import { ASSETS, ID, UserError, WORKSPACE, assetFile, ensureDir, hfSettings, previewDir, readJson, writeJson } from "../lib/paths.mjs";

const RATE = 48000;
export const SFX_LIBRARY = join(ASSETS, "sound-effects");
const AUDIO = /\.(mp3|wav|aiff?|flac|ogg|m4a|aac)$/i;

/** Every sound file in the library, as paths relative to it (what sfx.json "sounds" takes). */
export function librarySounds(dir = SFX_LIBRARY, pre = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) => (d.isDirectory() ? librarySounds(join(dir, d.name), `${pre}${d.name}/`) : AUDIO.test(d.name) ? [`${pre}${d.name}`] : []));
}

/**
 * sfx.json "library" is optional and must be videos/ASSETS/sound-effects or a folder inside it;
 * "sounds" are relative to it. Returns the ASSETS sub-folder the sounds resolve in.
 */
function librarySub(sfx) {
  if (sfx.library == null) return "sound-effects";
  const lib = resolve(isAbsolute(sfx.library) ? sfx.library : join(WORKSPACE, sfx.library));
  const r = relative(SFX_LIBRARY, lib);
  if (r.startsWith("..") || isAbsolute(r))
    throw new UserError(`sfx.json "library" is ${sfx.library}, but sound effects come only from videos/ASSETS/sound-effects. Set "library": "videos/ASSETS/sound-effects" (or drop it) and copy any new sound into that folder.`);
  return ["sound-effects", ...(r ? [r.split("\\").join("/")] : [])].join("/");
}

export function cueSheet(ctx, sfx, tl) {
  const errors = [];
  const sub = librarySub(sfx);
  const files = {};
  for (const [name, rel] of Object.entries(sfx.sounds || {})) {
    try {
      files[name] = assetFile(rel, sub, `sound "${name}"`).file;
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      errors.push(`${e.message}${/not found/.test(e.message) ? " Every sound is listed in out/sounds.txt." : ""}`);
      files[name] = null;
    }
  }
  (sfx.rules || []).forEach((r, i) => {
    if (!(r.sound in files)) errors.push(`rule ${i + 1}: sound "${r.sound}" is not in "sounds" (${Object.keys(files).join(", ") || "none"})`);
    if (!ONS.includes(r.on)) errors.push(`rule ${i + 1}: "on" must be one of ${ONS.join(", ")} (got ${JSON.stringify(r.on)})`);
    if ((r.on === "pieceStart" || r.on === "pieceEnd") && !r.piece) errors.push(`rule ${i + 1}: "${r.on}" needs "piece"`);
    if (r.on === "at" && typeof r.t !== "number") errors.push(`rule ${i + 1}: "at" needs a number "t" (cut seconds)`);
    if (typeof r.gain !== "number") errors.push(`rule ${i + 1}: "gain" must be a number (0.5 = half, 1 = as recorded)`);
  });
  if (errors.length) throw new UserError(`sfx.json has ${errors.length} error(s); nothing was built:\n- ${errors.join("\n- ")}`);

  const cues = [];
  (sfx.rules || []).forEach((r, i) => {
    for (const a of anchors(r, tl, `rule ${i + 1}`)) {
      const s = analyzeSound(ctx, files[r.sound]);
      const at = a.t + (r.offset || 0);
      const off = r.align === "peak" ? s.peak : r.align === "center" ? s.len / 2 : s.onset;
      const dur = r.loop ? (r.dur === "piece" ? a.piece?.duration : r.dur) : null;
      if (r.loop && !(dur > 0)) throw new UserError(`rule ${i + 1}: "loop" needs "dur" (seconds, or "piece" on a piece rule)`);
      cues.push({
        at, start: r.align === "start" ? at : at - off, sound: r.sound, file: files[r.sound], gain: r.gain,
        align: r.align || "onset", rule: i + 1, anchor: a.anchor, n: a.n,
        loop: r.loop || undefined, dur: dur ?? undefined, fadeIn: r.fadeIn, fadeOut: r.fadeOut,
      });
    }
  });
  cues.sort((x, y) => x.at - y.at);
  for (const c of cues) {
    c.start = +Math.max(0, c.start).toFixed(4);
    c.at = +c.at.toFixed(4);
  }
  return cues;
}

export async function run(ctx) {
  const { P, S, opts } = ctx;
  const T = P.st[ID.edit];
  const tlFile = join(T.out, "timeline.json");
  if (!existsSync(tlFile)) throw new UserError("no timeline.json from state 4. Run state 4 first.");
  const tl = readJson(tlFile);
  const sfx = readJson(S.config);
  ctx.params = sfx;
  ctx.input(S.config, "sfx rules (human)");
  ctx.input(tlFile, "timeline from state 4");
  const cut = join(T.out, "cut.mp4");
  if (!opts.dry) ctx.input(cut, "cut from state 4");

  // The library, written before the cue sheet so a "file not found" can point at it.
  const out = ensureDir(S.out);
  const all = librarySounds();
  if (!all.length) throw new UserError(`no sounds in ${SFX_LIBRARY}: the sound-effects library is missing or empty`);
  writeFileSync(join(out, "sounds.txt"), [
    "# Sound-effects library: videos/ASSETS/sound-effects. Paste a line, as is, into sfx.json \"sounds\".",
    "# To use a new sound, copy it into videos/ASSETS/sound-effects first.", "", ...all, ""].join("\n"));
  ctx.output(join(out, "sounds.txt"), `${all.length} sounds in videos/ASSETS/sound-effects`);

  const cues = cueSheet(ctx, sfx, tl);
  for (const f of new Set(cues.map((c) => c.file))) ctx.input(f, "sound file (videos/ASSETS/sound-effects)");
  writeJson(join(out, "cues.json"), { duration: tl.duration, cues });
  ctx.output(join(out, "cues.json"), `${cues.length} cues from ${(sfx.rules || []).length} rules`);
  console.log(cues.map((c) => `${c.at.toFixed(3).padStart(8)}  start ${c.start.toFixed(3).padStart(8)}  ${c.gain.toFixed(2)}  ${c.sound.padEnd(12)} rule ${c.rule}: ${c.anchor}`).join("\n"));
  ctx.log(`${cues.length} cues over ${tl.duration}s`);

  const hit = new Set(cues.filter((c) => c.n != null).map((c) => c.n));
  const silent = tl.events.filter((e) => !hit.has(e.n)).map((e) => `#${e.n}`);
  if (silent.length) ctx.warn(`events with no sound: ${silent.join(", ")}`);
  const late = cues.filter((c) => c.start >= tl.duration);
  if (late.length) ctx.warn(`${late.length} cue(s) start after the end of the cut and are dropped: ${late.map((c) => `${c.sound}@${c.at}`).join(", ")}`);
  ctx.extra.summary = { cues: cues.length, rules: (sfx.rules || []).length };

  if (opts.dry) {
    ctx.note("--dry: cue sheet only. sfx-mix.wav, preview.mp4 and listen/ were NOT rebuilt.");
    return;
  }
  if (!existsSync(cut)) throw new UserError("state 4 was only run with --dry: there is no cut.mp4. Run state 4 without --dry.");

  const TOTAL = tl.duration;
  const mix = join(out, "sfx-mix.wav");
  const live = cues.filter((c) => c.start < TOTAL);
  if (!live.length) {
    ctx.ffmpeg(["-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`, "-t", String(TOTAL), "-c:a", "pcm_s16le", mix], { why: "silent stem (no cues)" });
  } else {
    const inputs = [], f = [];
    live.forEach((c, i) => {
      if (c.loop) inputs.push("-stream_loop", "-1");
      inputs.push("-i", c.file);
      const chain = [`aresample=${RATE}`, "aformat=channel_layouts=stereo"];
      let len = c.loop ? c.dur : analyzeSound(ctx, c.file).len;
      len = Math.min(len, TOTAL - c.start);
      chain.push(`atrim=0:${len.toFixed(3)}`, "asetpts=PTS-STARTPTS");
      if (c.fadeIn) chain.push(`afade=t=in:d=${c.fadeIn}`);
      if (c.fadeOut) chain.push(`afade=t=out:st=${(len - c.fadeOut).toFixed(3)}:d=${c.fadeOut}`);
      chain.push(`volume=${c.gain}`, `adelay=${Math.round(c.start * 1000)}:all=1`);
      f.push(`[${i}:a]${chain.join(",")}[s${i}]`);
    });
    f.push(live.map((_, i) => `[s${i}]`).join("") +
      `amix=inputs=${live.length}:normalize=0:dropout_transition=0,apad=whole_dur=${TOTAL},atrim=0:${TOTAL},alimiter=limit=0.89:attack=1:release=50:level=disabled[out]`);
    ctx.ffmpeg([...inputs, "-filter_complex", f.join(";"), "-map", "[out]", "-ar", String(RATE), "-c:a", "pcm_s16le", mix], { why: "mix all cues into one stem" });
  }
  const mi = probe(ctx, mix);
  ctx.output(mix, `${mi.duration}s stem`);
  ctx.check("stem length equals the cut", Math.abs(mi.duration - TOTAL) <= 0.05, `${mi.duration}s vs ${TOTAL}s`);
  const L = loudness(ctx, ["-i", mix], "stem peak");
  ctx.check("stem true peak under -0.5 dBTP", L.truePeak <= -0.5, `${L.truePeak} dBTP`);

  const preview = phoneProxy(ctx, P, { sfx: mix });

  const ldir = join(S.dir, "listen");
  if (existsSync(ldir)) rmSync(ldir, { recursive: true, force: true });
  ensureDir(ldir);
  const spots = [];
  for (let i = 1; i < tl.pieces.length; i++) spots.push({ t: tl.pieces[i].start, name: `boundary-${tl.pieces[i - 1].id}${tl.pieces[i].id}` });
  if (tl.events.length) spots.push({ t: tl.events[0].t, name: `first-event-${tl.events[0].n}` }, { t: tl.events.at(-1).t, name: `last-event-${tl.events.at(-1).n}` });
  for (const s of spots) {
    const f = join(ldir, `${s.name}-${s.t.toFixed(2)}.mp4`);
    ctx.ffmpeg(["-ss", String(Math.max(0, s.t - 1.5)), "-t", "3", "-i", preview, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", f], { why: `listen clip ${s.name}` });
    ctx.output(f, `3 s around ${s.name} (cut ${s.t}s)`);
  }
  // The Studio preview: the cut with its sound effects, and the overlay when deliver.json has one,
  // so each sound can be judged against the tick it belongs to. run.mjs opens it after this state.
  const hs = hfSettings(P);
  buildProject(ctx, P, previewDir(P, ID.sfx), { sfx: mix, overlay: hs.overlay, volumes: hs.volumes });
  ctx.note("You cannot hear the result: the user listens in the Studio preview or on the phone (preview.mp4, review.mjs), and listen/ and gives feedback before approving.");
}
