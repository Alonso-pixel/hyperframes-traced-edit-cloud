// Media helpers. Every one takes the state's Ctx so each ffmpeg call lands in the trace.
// Envelope/loudness/runs come from music-score/scripts/lib.mjs; sceneCuts/frameScores/gridFilter
// from icon-hero-enrich/scripts/lib.mjs; analyzeSound from pintas-presupuesto/scripts/build-sfx.mjs.
// They are copied, not imported, because those libs hard-code their own paths and exit the process.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSCRIBE, UserError, ensureDir, readJsonIf, writeJson } from "./paths.mjs";
import { fingerprint } from "./trace.mjs";

export const FRAME = 0.05; // envelope step, seconds

export function probe(ctx, file) {
  const r = ctx.exec("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels", "-of", "json", file], { why: "probe" });
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  const [n, d] = String(v?.r_frame_rate || "30/1").split("/").map(Number);
  return {
    duration: +(+j.format.duration).toFixed(3),
    width: v?.width,
    height: v?.height,
    fps: d ? +(n / d).toFixed(3) : 30,
    frames: v?.nb_frames ? +v.nb_frames : null,
    vcodec: v?.codec_name,
    hasVideo: !!v,
    hasAudio: !!a,
    acodec: a?.codec_name,
    sampleRate: a ? +a.sample_rate : null,
  };
}

/** Untraced probe for status/trace views (they must not write a trace). */
export function quickProbe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return r.status === 0 ? +(+r.stdout.trim()).toFixed(3) : null;
}

/** RMS level (dBFS) of every 50 ms frame of the file's audio. */
export function envelope(ctx, file) {
  const e = ctx.ffmpeg(["-i", file, "-vn", "-af",
    "aresample=44100,aformat=channel_layouts=mono,asetnsamples=n=2205:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-"], { why: "50 ms RMS envelope" }).stderr;
  const out = [];
  for (const m of e.matchAll(/RMS_level=(-?[\d.]+|-inf|inf|nan)/g)) {
    const v = Number(m[1]);
    out.push(Number.isFinite(v) ? Math.max(v, -120) : -120);
  }
  return Float64Array.from(out);
}

/** Integrated loudness, loudness range and true peak (ebur128). */
export function loudness(ctx, inputArgs, why = "loudness") {
  const e = ctx.ffmpeg([...inputArgs, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], { why }).stderr;
  const s = e.slice(e.lastIndexOf("Summary:"));
  const num = (re, dflt) => {
    const v = Number((s.match(re) || [])[1]);
    return Number.isFinite(v) ? v : dflt;
  };
  return { I: num(/I:\s+(-?[\d.]+)/, -70), LRA: num(/LRA:\s+(-?[\d.]+)/, 0), truePeak: num(/Peak:\s+(-?[\d.]+)/, -120) };
}

/** loudnorm pass 1 over an input (after `filter`): the JSON report (input_i, input_tp, …). */
export function measure(ctx, inputArgs, filter = "anull", why = "measure loudness") {
  const e = ctx.ffmpeg([...inputArgs, "-vn", "-af", `${filter},loudnorm=print_format=json`, "-f", "null", "-"], { why }).stderr;
  return JSON.parse(e.slice(e.lastIndexOf("{"), e.lastIndexOf("}") + 1));
}

/** Power mean (dB) of a 50 ms envelope over [a, b) seconds (music-score's meanDb). */
export function meanDb(env, a, b) {
  const i0 = Math.max(0, Math.round(a / FRAME));
  const i1 = Math.min(env.length, Math.round(b / FRAME));
  if (i1 <= i0) return -120;
  let s = 0;
  for (let i = i0; i < i1; i++) s += Math.pow(10, env[i] / 10);
  const p = s / (i1 - i0);
  return p > 0 ? 10 * Math.log10(p) : -120;
}

/** 0.4 s power-smoothed envelope (music-score's smooth). */
export function smooth(env, win = 8) {
  const out = new Float64Array(env.length);
  let acc = 0;
  const q = [];
  for (let i = 0; i < env.length; i++) {
    const p = Math.pow(10, env[i] / 10);
    q.push(p);
    acc += p;
    if (q.length > win) acc -= q.shift();
    out[Math.max(0, i - (win >> 1))] = acc / q.length > 0 ? 10 * Math.log10(acc / q.length) : -120;
  }
  for (let i = env.length - (win >> 1); i < env.length; i++) if (i >= 0) out[i] = env[i];
  return out;
}

/** Runs of consecutive envelope frames where pred(i) holds, as [{start, end}] seconds. */
export function runs(n, pred, minDur) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && pred(i);
    if (on && s < 0) s = i;
    if (!on && s >= 0) {
      if ((i - s) * FRAME >= minDur) out.push({ start: +(s * FRAME).toFixed(2), end: +(i * FRAME).toFixed(2) });
      s = -1;
    }
  }
  return out;
}

/** Scene-change times above a threshold (hard cuts). */
export function sceneCuts(ctx, video, threshold) {
  const e = ctx.ffmpeg(["-i", video, "-an", "-vf", `scale=180:320,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { why: "scene cuts" }).stderr;
  return [...e.matchAll(/pts_time:([0-9.]+)/g)].map((m) => +(+m[1]).toFixed(2));
}

/** Per-frame change scores at 5 fps: [[t, score]]. Near 0 means nothing moves. */
export function frameScores(ctx, video) {
  const e = ctx.ffmpeg(["-i", video, "-an", "-vf", "fps=5,scale=90:160,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"], { why: "motion per frame" }).stderr;
  const out = [];
  let t = null;
  for (const line of e.split("\n")) {
    const m = line.match(/pts_time:([0-9.]+)/);
    if (m) t = +m[1];
    const s = line.match(/scene_score=([0-9.]+)/);
    if (s && t !== null) out.push([+t.toFixed(2), +(+s[1]).toFixed(4)]);
  }
  return out;
}

const stamp = (offset, size) => `drawtext=text='%{pts\\:flt\\:${offset}}':x=4:y=4:fontsize=${size}:fontcolor=yellow:box=1:boxcolor=black`;

/** Timestamped contact sheet of [from, to), one tile per `step` seconds. */
export function sheet(ctx, video, from, to, step, out, why = "contact sheet", scale = "180:320") {
  const count = Math.max(1, Math.ceil((to - from) / step));
  const cols = Math.min(10, count);
  const rows = Math.ceil(count / cols);
  ctx.ffmpeg(["-ss", String(from), "-t", String(to - from), "-i", video, "-vf",
    `fps=1/${step},scale=${scale},${stamp(from, 18)},tile=${cols}x${rows}`, "-frames:v", "1", out], { why });
  return out;
}

/** One row of tiles around a time: `fps` tiles per second, each stamped with its own time. */
export function strip(ctx, video, from, dur, fps, out, why = "strip") {
  const n = Math.max(1, Math.round(dur * fps));
  const s = Math.max(0, from);
  ctx.ffmpeg(["-ss", String(s), "-t", String(dur), "-i", video, "-vf",
    `fps=${fps},scale=108:192,${stamp(s, 13)},tile=${n}x1`, "-frames:v", "1", out], { why });
  return out;
}

/** 540x960 frame with a grid every 100 video px and labels every 200 px. */
export function gridFilter() {
  const labels = [];
  for (let x = 200; x < 1080; x += 200) labels.push(`drawtext=text='${x}':x=${x / 2 + 2}:y=4:fontsize=16:fontcolor=yellow:box=1:boxcolor=black`);
  for (let y = 200; y < 1920; y += 200) labels.push(`drawtext=text='${y}':x=4:y=${y / 2 + 2}:fontsize=16:fontcolor=yellow:box=1:boxcolor=black`);
  return `scale=540:960,drawgrid=w=50:h=50:t=1:c=white@0.35,${labels.join(",")}`;
}

/**
 * Where a sound effect actually starts (onset: first 10 ms window within 30 dB of the loudest)
 * and where it is loudest (peak). Cues align one of those to their anchor time.
 */
const soundCache = {};
export function analyzeSound(ctx, file) {
  if (soundCache[file]) return soundCache[file];
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const rec = { n: ctx.commands.length + 1, why: "decode sfx for onset/peak", cmd: `ffmpeg -v error -i '${file}' -ac 1 -ar 8000 -f f32le -`, ms: 0, exit: r.status };
  ctx.commands.push(rec);
  if (r.status !== 0) {
    rec.stderrTail = String(r.stderr).trim().split("\n").slice(-6).join("\n");
    const e = new UserError(`not a readable audio file: ${file}\nCheck its entry in "sounds" (sfx.json).`);
    e.command = rec;
    throw e;
  }
  const pcm = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
  const W = 80, rms = [];
  for (let i = 0; i + W <= pcm.length; i += W) {
    let s = 0;
    for (let j = i; j < i + W; j++) s += pcm[j] * pcm[j];
    rms.push(Math.sqrt(s / W));
  }
  const max = Math.max(...rms);
  const peakIdx = rms.indexOf(max);
  const onsetIdx = rms.findIndex((v) => v >= max * 0.0316);
  return (soundCache[file] = { onset: (onsetIdx * W) / 8000, peak: (peakIdx * W) / 8000, len: pcm.length / 8000 });
}

/**
 * Whisper (tools/transcribe.mjs) on a file's audio: [{ text, start, end }] seconds, or null when
 * it hears no speech. TIMING and CONTENT only: whisper text is never copied to screen.
 */
export function transcribe(ctx, file, outDir, { language = "es", name = "speech" } = {}) {
  if (!existsSync(TRANSCRIBE)) throw new Error(`workspace transcriber not found at ${TRANSCRIBE}`);
  const wav = join(ensureDir(outDir), `${name}.wav`);
  ctx.ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", "16000", wav], { why: `16 kHz mono for whisper (${name})` });
  const tj = join(outDir, name === "speech" ? "transcript.json" : `${name}.transcript.json`);
  const r = ctx.exec(process.execPath, [TRANSCRIBE, wav, "--language", language, "--out", tj], { why: `whisper transcription (${name})`, allowFail: true });
  if (r.status !== 0 || !existsSync(tj)) {
    if (/0 words/.test(r.stdout + r.stderr)) return null;
    const e = new Error(`whisper failed on ${file} (exit ${r.status})`);
    e.command = ctx.commands.at(-1);
    throw e;
  }
  return JSON.parse(readFileSync(tj, "utf8"));
}

/**
 * Pictures and words of a video, for reading it without playing it: probe, one timestamped
 * contact sheet per minute (sheet-MM.jpg, one tile per `step` s), scene cuts and (optionally) a
 * transcript. Cached in dir/digest.json against the file's fingerprint and the options.
 */
export function digestVideo(ctx, file, dir, { step = 1, sceneThreshold = 0.35, words = true, language = "es" } = {}) {
  ensureDir(dir);
  const key = { fp: fingerprint(file), step, sceneThreshold, words, language };
  const cacheFile = join(dir, "digest.json");
  const cached = readJsonIf(cacheFile);
  if (cached && JSON.stringify(cached.key) === JSON.stringify(key) && cached.sheets.every((s) => existsSync(s))) {
    ctx.log(`digest of ${file}: unchanged, reusing ${cacheFile}`);
    return { ...cached, cached: true };
  }
  const info = probe(ctx, file);
  const sheets = [];
  if (info.hasVideo)
    for (let m = 0; m < info.duration; m += 60)
      sheets.push(sheet(ctx, file, m, Math.min(info.duration, m + 60), step, join(dir, `sheet-${String(m / 60).padStart(2, "0")}.jpg`), `contact sheet minute ${m / 60}`));
  const scenes = info.hasVideo ? sceneCuts(ctx, file, sceneThreshold) : [];
  const said = words && info.hasAudio ? transcribe(ctx, file, dir, { language }) : null;
  const d = { key, probe: info, step, sheets, scenes, words: said };
  writeJson(cacheFile, d);
  return { ...d, cached: false };
}

/** A viewable copy of an image (jpg, at most 720 px wide). */
export function previewImage(ctx, file, out) {
  ctx.ffmpeg(["-i", file, "-vf", "scale='min(720,iw)':-2", "-frames:v", "1", out], { why: "image preview" });
  return out;
}
