// Shared helpers for the music-score skill: ffmpeg/ffprobe wrappers, loudness measurement,
// a 50 ms RMS envelope, and the library-track profiler.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = resolve(SKILL_DIR, "../../.."); // hyperframes-videos/
export const LIBRARY = join(ROOT, "videos", "ASSETS", "music");

export const FRAME = 0.05; // envelope step, seconds
const PROFILE_VERSION = 6;

export function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

export function run(argv, { quiet = false } = {}) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...argv], { encoding: "utf8", maxBuffer: 1 << 30, timeout: 30 * 60 * 1000 });
  if (r.status !== 0) {
    if (!quiet) console.error(r.stderr.slice(-3000));
    fail(`ffmpeg failed: ffmpeg ${argv.join(" ").slice(0, 300)}`);
  }
  return r.stderr;
}

export function probe(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,nb_frames", "-of", "json", file],
    { encoding: "utf8" },
  );
  if (r.status !== 0) fail(`cannot read ${file}`);
  const j = JSON.parse(r.stdout);
  return { duration: Number(j.format.duration), streams: j.streams };
}

// loudnorm pass 1 over an input spec; returns the JSON report (input_i, input_tp, ...)
export function measure(inputArgs, filter = "anull", target = "") {
  const e = run([...inputArgs, "-vn", "-af", `${filter},loudnorm=${target}print_format=json`, "-f", "null", "-"]);
  return JSON.parse(e.slice(e.lastIndexOf("{"), e.lastIndexOf("}") + 1));
}

// integrated loudness + true peak (ebur128)
export function loudness(inputArgs) {
  const e = run([...inputArgs, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const s = e.slice(e.lastIndexOf("Summary:"));
  const I = Number((s.match(/I:\s+(-?[\d.]+|-inf)/) || [])[1]);
  const tp = Number((s.match(/Peak:\s+(-?[\d.]+|-inf)/) || [])[1]);
  return { I: Number.isFinite(I) ? I : -70, tp: Number.isFinite(tp) ? tp : -120 };
}

// RMS level (dBFS) of every 50 ms frame: returns Float64Array, index i = time i*0.05
export function envelope(file, { ss, t } = {}) {
  const pre = [];
  if (ss != null) pre.push("-ss", String(ss));
  if (t != null) pre.push("-t", String(t));
  const e = run([
    ...pre, "-i", file, "-vn", "-af",
    "aresample=44100,aformat=channel_layouts=mono,asetnsamples=n=2205:p=0,astats=metadata=1:reset=1," +
      "ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-",
  ]);
  const out = [];
  for (const m of e.matchAll(/RMS_level=(-?[\d.]+|-inf|inf|nan)/g)) {
    const v = Number(m[1]);
    out.push(Number.isFinite(v) ? Math.max(v, -120) : -120);
  }
  return Float64Array.from(out);
}

const toPow = (db) => Math.pow(10, db / 10);
const toDb = (p) => (p > 0 ? 10 * Math.log10(p) : -120);

// power-mean of env over [a, b) seconds
export function meanDb(env, a, b) {
  const i0 = Math.max(0, Math.round(a / FRAME));
  const i1 = Math.min(env.length, Math.round(b / FRAME));
  if (i1 <= i0) return -120;
  let s = 0;
  for (let i = i0; i < i1; i++) s += toPow(env[i]);
  return toDb(s / (i1 - i0));
}

// 0.4 s power-smoothed envelope
export function smooth(env, win = 8) {
  const out = new Float64Array(env.length);
  let acc = 0;
  const q = [];
  for (let i = 0; i < env.length; i++) {
    const p = toPow(env[i]);
    q.push(p);
    acc += p;
    if (q.length > win) acc -= q.shift();
    out[Math.max(0, i - (win >> 1))] = toDb(acc / q.length);
  }
  for (let i = env.length - (win >> 1); i < env.length; i++) if (i >= 0) out[i] = env[i];
  return out;
}

function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : -120;
}

// runs of consecutive frames where pred(i) is true, as [{start, end}] in seconds
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

// the onset near t: the frame with the biggest jump over the previous 0.15 s, in [t-back, t+fwd]
function refineOnset(env, t, back = 0.6, fwd = 0.9) {
  let best = -1, bestJump = -Infinity;
  const i0 = Math.max(3, Math.round((t - back) / FRAME));
  const i1 = Math.min(env.length - 1, Math.round((t + fwd) / FRAME));
  for (let i = i0; i <= i1; i++) {
    const prev = Math.min(env[i - 1], env[i - 2], env[i - 3]);
    const jump = env[i] - prev;
    if (jump > bestJump) (bestJump = jump), (best = i);
  }
  return best < 0 ? t : +(best * FRAME).toFixed(2);
}

// mood lines from TIMING-DESCRIPTIONS.md: "## 3 · indignacion-phonk: viral denunciation, ..."
export function moods() {
  const f = join(LIBRARY, "TIMING-DESCRIPTIONS.md");
  const out = {};
  if (!existsSync(f)) return out;
  for (const m of readFileSync(f, "utf8").matchAll(/^##\s*\d+\s*·\s*([\w-]+):\s*(.+)$/gm)) out[m[1]] = m[2].trim();
  return out;
}

export function libraryTracks() {
  if (!existsSync(LIBRARY)) fail(`music library not found: ${LIBRARY}`);
  return readdirSync(LIBRARY)
    .filter((f) => f.toLowerCase().endsWith(".mp3"))
    .map((f) => f.replace(/\.mp3$/i, ""))
    .sort();
}

export function trackFile(name) {
  return join(LIBRARY, `${name}.mp3`);
}

// Profile one library track (cached next to it as <name>.profile.json)
export function profile(name, { force = false } = {}) {
  const file = trackFile(name);
  if (!existsSync(file)) fail(`track "${name}" not found in ${LIBRARY}`);
  const cache = join(LIBRARY, `${name}.profile.json`);
  if (!force && existsSync(cache) && statSync(cache).mtimeMs >= statSync(file).mtimeMs) {
    const p = JSON.parse(readFileSync(cache, "utf8"));
    if (p.version === PROFILE_VERSION) return p;
  }

  const env = envelope(file);
  const dur = +(env.length * FRAME).toFixed(2);
  const sm = smooth(env);
  const inner = sm.slice(Math.round(2 / FRAME), Math.max(Math.round(2 / FRAME) + 1, sm.length - Math.round(2 / FRAME)));
  const med = median(inner);
  const lufs = Number(measure(["-i", file]).input_i);

  // where the final decay begins: last frame still near the track's normal level
  let tail = sm.length - 1;
  while (tail > 0 && sm[tail] < med - 6) tail--;
  const tailStart = +(tail * FRAME).toFixed(2);

  // stops: >= 0.45 s at least 15 dB under the median (includes quiet intros)
  const stops = runs(sm.length, (i) => sm[i] < med - 15 && i * FRAME < tailStart, 0.45);

  // drops: the onset after every stop, plus beat-bed map drops when a map exists
  const cands = [];
  for (const s of stops) {
    if (s.end >= tailStart) continue;
    cands.push({ t: refineOnset(env, s.end, 0.3, 1.2), afterStop: true });
  }
  const mapFile = join(LIBRARY, `${name}.map.json`);
  if (existsSync(mapFile)) {
    for (const d of JSON.parse(readFileSync(mapFile, "utf8")).drops || []) cands.push({ t: refineOnset(env, d.t), afterStop: false });
  }
  const drops = [];
  for (const c of cands.sort((a, b) => a.t - b.t)) {
    c.afterStop = c.afterStop || stops.some((s) => c.t - s.end >= -0.3 && c.t - s.end <= 1.5);
    c.rise = +(meanDb(env, c.t + 0.05, c.t + 1.0) - meanDb(env, c.t - 1.0, c.t - 0.15)).toFixed(1);
    // how loud the 4 s after the onset stay, relative to the track's normal level
    c.sustain = +(meanDb(env, c.t, c.t + 4) - med).toFixed(1);
    const near = drops.find((d) => Math.abs(d.t - c.t) < 1.0);
    if (near) {
      if (c.afterStop && !near.afterStop) Object.assign(near, c);
      continue;
    }
    if (c.rise >= 4) drops.push(c);
  }

  // MAIN drop = the one to land on a key line: after a stop, past the intro, not in the
  // outro, stays loud for 4 s, biggest rise
  const main = drops
    .filter((d) => d.afterStop && d.t > 30 && d.t < dur - 15 && d.sustain >= -4 && d.rise >= 10)
    .sort((a, b) => b.rise - a.rise)[0];
  if (main) main.main = true;

  // bedStart: the first big entrance (rise >= 10) between 5 and 30 s; otherwise the first point
  // after 5 s where the next 8 s stay loud (90% of frames >= med-8), snapped to a drop within 2 s
  let bedStart = null;
  const entrance = drops.find((d) => d.t >= 5 && d.t <= 30 && d.rise >= 10 && d.sustain >= -4);
  const need = Math.round(8 / FRAME);
  for (let i = Math.round(5 / FRAME); !entrance && i + need < sm.length; i++) {
    let ok = 0;
    for (let k = i; k < i + need; k++) if (sm[k] >= med - 8) ok++;
    if (ok >= need * 0.9 && sm[i] >= med - 8) {
      bedStart = +(i * FRAME).toFixed(2);
      break;
    }
  }
  if (entrance) bedStart = entrance.t;
  if (bedStart == null) bedStart = 15;
  const snap = drops.filter((d) => Math.abs(d.t - bedStart) <= 2).sort((a, b) => Math.abs(a.t - bedStart) - Math.abs(b.t - bedStart))[0];
  if (snap) bedStart = snap.t;

  // coarse 2 s loudness map for humans
  const map = [];
  for (let t = 0; t < dur; t += 2) map.push(Math.round(meanDb(env, t, Math.min(dur, t + 2))));

  const p = { version: PROFILE_VERSION, name, duration: dur, lufs, median: +med.toFixed(1), bedStart, tailStart, stops, drops, map2s: map };
  writeFileSync(cache, JSON.stringify(p, null, 1));
  return p;
}

export function fmt(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
}

export function readJson(f) {
  if (!existsSync(f)) fail(`missing file: ${f}`);
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    fail(`${f} is not valid JSON: ${e.message}. Fix the syntax (commas, quotes, brackets) and run again.`);
  }
}

export { basename, join, resolve, dirname, existsSync, readFileSync, writeFileSync };
