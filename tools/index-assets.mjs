#!/usr/bin/env node
// Index the shared asset library (videos/ASSETS) so an agent can find things without listing
// folders and opening every file.
//
//   node tools/index-assets.mjs           measure every asset, make contact sheets, write
//                                         videos/ASSETS/index.json + INDEX.md
//   node tools/index-assets.mjs --check   exit 1 (and list why) if the index is stale
//
// Two halves, merged into one catalog:
//   measured  duration, size, fps, audio, hash, duplicates, ...: this script (cached by size+mtime)
//   meaning   description, tags, place, origin, realPerson, legibleText, ...: hand-written in
//             videos/ASSETS/_index/notes.json, never overwritten here. A key ending in "/*" sets
//             defaults for every file in that folder; an exact path overrides it.
// Contact sheets go to videos/ASSETS/_index/sheets/ (one per clip, a thumbnail per image, one
// overview per pack folder). The sheet code is traced-edit's (scripts/lib/media.mjs).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sheet as mediaSheet } from "../.claude/skills/traced-edit/scripts/lib/media.mjs";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(WORKSPACE, "videos", "ASSETS");
const IDX = join(ASSETS, "_index");
const SHEETS = join(IDX, "sheets");
const NOTES = join(IDX, "notes.json");
const OUT_JSON = join(ASSETS, "index.json");
const OUT_MD = join(ASSETS, "INDEX.md");
const VERSION = 5; // bump to re-measure everything (sheets are cached by hash and survive)

const VIDEO = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const PACK_ROOT = "animations/unroll paper animations";
const FLAG = { ai: "⚠AI", realPerson: "⚠real-person", legibleText: "⚠text", duplicate: "⚠dup", noNotes: "⚠no-notes", verify: "⚠verify", bgSquare: "⚠bg-square" };

const rel = (abs) => relative(ASSETS, abs).split("\\").join("/");
const fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const readJsonIf = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

// ---------- walk ----------
function walk(dir, files = [], dirs = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p === IDX) continue;
      dirs.push(p);
      walk(p, files, dirs);
    } else files.push(p);
  }
  return { files, dirs };
}

/** What a file is to the library: an asset kind, a companion of another file, or a stray. */
function classify(r, siblings) {
  const ext = extname(r).toLowerCase();
  const top = r.split("/")[0];
  const stem = r.slice(0, -ext.length);
  if (r === "index.json" || r === "INDEX.md" || r === "CLAUDE.md") return { role: "self" };
  if (/\.(profile|map)\.json$/.test(r)) return { role: "companion", of: r.replace(/\.(profile|map)\.json$/, ".mp3"), what: "music-score analysis" };
  // traced-edit state 1 writes each cabildo sound-bite clip with a sidecar (speaker, session, words).
  if (ext === ".json" && r.startsWith("clips/cabildo/") && siblings.has(`${stem}.mp4`)) return { role: "companion", of: `${stem}.mp4`, what: "fact-checker sidecar" };
  if (ext === ".md") {
    const html = `${stem}.html`;
    if (siblings.has(html)) return { role: "companion", of: html, what: "usage notes" };
    return { role: "companion", of: dirname(r), what: "folder notes" };
  }
  if (top === "sound-effects" && (AUDIO.has(ext) || VIDEO.has(ext))) return { role: "asset", kind: "sfx" };
  if (top === "music" && AUDIO.has(ext)) return { role: "asset", kind: "music" };
  if (VIDEO.has(ext)) return { role: "asset", kind: "clip" };
  if (IMAGE.has(ext)) return { role: "asset", kind: "image" };
  if (ext === ".svg") return { role: "asset", kind: "icon" };
  if (ext === ".html") return { role: "asset", kind: "animation" };
  if (AUDIO.has(ext)) return { role: "asset", kind: "sfx" };
  return { role: "stray", why: ext === ".zip" ? "archive (unpack it or delete it)" : ext === ".py" ? "script, not an asset" : `unknown type ${ext || "(none)"}` };
}

// ---------- measure ----------
function quickHash(file, size) {
  const h = createHash("sha1").update(String(size));
  const fd = openSync(file, "r");
  try {
    const n = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    h.update(buf);
    if (size > n) {
      readSync(fd, buf, 0, n, size - n);
      h.update(buf);
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex").slice(0, 16);
}

function ffprobe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate:stream_side_data=rotation:stream_tags=rotate", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) return { error: (r.stderr || "ffprobe failed").trim().split("\n").pop() };
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === "video" && s.width);
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  const [n, d] = String(v?.r_frame_rate || "0/1").split("/").map(Number);
  // Phone footage is often stored landscape with a ±90° rotation flag: report the displayed size.
  const rot = Number(v?.side_data_list?.find((s) => s.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0);
  const turned = Math.abs(rot) % 180 === 90;
  return {
    duration: r2(+j.format?.duration || 0),
    width: (turned ? v?.height : v?.width) ?? null,
    height: (turned ? v?.width : v?.height) ?? null,
    fps: v && d ? r2(n / d) : null,
    hasAudio: !!a,
    alpha: !!v && /^(yuva|rgba|argb|bgra|gbrap|ya)/.test(v.pix_fmt || ""),
  };
}

function shape(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  if (Math.abs(r - 9 / 16) < 0.03) return "9:16";
  if (Math.abs(r - 16 / 9) < 0.03) return "16:9";
  if (Math.abs(r - 1) < 0.03) return "1:1";
  return r < 1 ? "portrait" : "landscape";
}

/** Max and mean volume (dB) of an audio file, and when the sound starts (onset, s). */
function volume(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "silencedetect=n=-45dB:d=0.02,volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const e = r.stderr || "";
  const num = (re) => {
    const m = e.match(re);
    return m ? +m[1] : null;
  };
  // A leading silence starts at 0; the sound starts where it ends. Line the onset up with the event.
  const start = num(/silence_start:\s*(-?[\d.]+)/);
  const end = num(/silence_end:\s*(-?[\d.]+)/);
  const onset = start != null && start <= 0.01 && end != null ? r2(end) : 0;
  return { peakDb: num(/max_volume:\s*(-?[\d.]+)/), meanDb: num(/mean_volume:\s*(-?[\d.]+)/), onset };
}

const sfxClass = (d) => (d == null ? null : d < 1.5 ? "short" : d <= 5 ? "medium" : "long");

function svgInfo(file) {
  const s = readFileSync(file, "utf8");
  const vb = s.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
  const shapes = (s.match(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/gi) || []).length;
  const stroke = /stroke\s*[=:]\s*["']?(?!none)[#a-z]/i.test(s);
  const fill = /fill\s*[=:]\s*["']?(?!none)[#a-z]/i.test(s);
  // Traced illustrations (big viewBox) often open with a full-canvas background path from 0,0:
  // over footage that is a solid square, so remove or hide the first path before using it.
  const first = s.match(/<(path|rect)\b[^>]*>/i)?.[0] || "";
  const bgSquare = /\bd\s*=\s*["']\s*M\s*0(\.\d+)?[\s,]+0(\.\d+)?[\sCLHVclhv]/.test(first) || (/^<rect/i.test(first) && !/\b[xy]\s*=\s*["']?[1-9]/.test(first) && /width\s*=\s*["']?100%/.test(first));
  const vbW = +(vb || "").split(/[\s,]+/)[2] || 0;
  return { viewBox: vb, shapes, style: stroke && fill ? "mixed" : stroke ? "stroke" : fill ? "fill" : "default-fill", traced: vbW > 100, bgSquare, bytes: s.length };
}

function htmlInfo(file) {
  const s = readFileSync(file, "utf8");
  const attr = (a) => s.match(new RegExp(`${a}\\s*=\\s*["']([^"']+)["']`))?.[1] ?? null;
  const w = +attr("data-width") || null;
  const h = +attr("data-height") || null;
  // Some animations keep their length in a script constant instead of data-duration.
  const dur = +attr("data-duration") || +(s.match(/\b(?:var|let|const)\s+DUR(?:ATION)?\s*=\s*([\d.]+)/)?.[1]) || null;
  return { compositionId: attr("data-composition-id"), duration: dur, width: w, height: h };
}

function imageInfo(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" });
  const [width, height] = (r.stdout || "").trim().split(",").map(Number);
  return { width: width || null, height: height || null };
}

/** Moods from music/TIMING-DESCRIPTIONS.md headings: "## 1 · denuncia-oscura: investigation, ..." */
function musicMoods() {
  const f = join(ASSETS, "music", "TIMING-DESCRIPTIONS.md");
  if (!existsSync(f)) return {};
  const out = {};
  for (const m of readFileSync(f, "utf8").matchAll(/^##\s+\d+\s*·\s*([a-z0-9-]+):\s*(.+)$/gim)) out[m[1]] = m[2].trim();
  return out;
}

// ---------- contact sheets ----------
// media.mjs functions take a traced-edit Ctx; this shim runs ffmpeg directly.
const ctx = {
  ffmpeg(args, { why } = {}) {
    const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-v", "error", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg (${why}): ${(r.stderr || "").trim().split("\n").pop()}`);
    return r;
  },
};

function clipSheet(file, dur, out) {
  const step = dur / 6 + 1e-3;
  mediaSheet(ctx, file, 0, Math.max(dur - 0.05, 0.1), step, out, "clip sheet", "-2:200");
}

function imageThumb(file, out) {
  ctx.ffmpeg(["-i", file, "-vf", "scale=-2:360", "-frames:v", "1", out], { why: "image thumb" });
}

/** One mid-frame per pack item, labelled with its number, tiled 10 across. */
function packSheet(items, out) {
  const tmp = join(tmpdir(), `asset-pack-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    items.forEach((it, i) => {
      const label = it.label.replace(/[\\':%]/g, "");
      ctx.ffmpeg(["-ss", String(Math.max(0, (it.duration || 0) / 2)), "-i", it.file, "-frames:v", "1", "-vf",
        `scale=200:200:force_original_aspect_ratio=decrease,pad=200:200:(ow-iw)/2:(oh-ih)/2:color=gray,drawtext=text='${label}':x=4:y=4:fontsize=22:fontcolor=yellow:box=1:boxcolor=black`,
        join(tmp, `f${String(i).padStart(4, "0")}.png`)], { why: "pack frame" });
    });
    const cols = Math.min(10, items.length);
    const rows = Math.ceil(items.length / cols);
    ctx.ffmpeg(["-framerate", "1", "-i", join(tmp, "f%04d.png"), "-vf", `tile=${cols}x${rows}:color=gray`, "-frames:v", "1", out], { why: "pack sheet" });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- notes ----------
function placeFromName(r) {
  const n = fold(basename(r));
  if (/elsa|elsavordova/.test(n)) return "Elsa Córdova";
  if (/coatepec/.test(n)) return "Coatepec";
  if (/humberto/.test(n)) return "Humberto";
  return null;
}

function notesFor(r, notes) {
  const out = {};
  // folder defaults, outermost first
  const parts = r.split("/");
  for (let i = 1; i < parts.length; i++) Object.assign(out, notes[`${parts.slice(0, i).join("/")}/*`] || {});
  const own = notes[r];
  if (own) Object.assign(out, own);
  return { merged: out, hasOwn: !!own };
}

// ---------- main ----------
const check = process.argv.includes("--check");
const { files, dirs } = walk(ASSETS);
const siblings = new Set(files.map(rel));
const prev = readJsonIf(OUT_JSON);
const prevBy = new Map((prev?.assets || []).map((a) => [a.path, a]));

if (check) {
  const why = [];
  if (!prev) why.push("no index.json yet");
  else {
    const seen = new Set();
    for (const f of files) {
      const r = rel(f);
      const c = classify(r, siblings);
      if (c.role !== "asset") continue;
      seen.add(r);
      const st = statSync(f);
      const p = prevBy.get(r);
      if (!p) why.push(`new: ${r}`);
      else if (p.bytes !== st.size || p.mtime !== Math.round(st.mtimeMs)) why.push(`changed: ${r}`);
    }
    for (const r of prevBy.keys()) if (!seen.has(r)) why.push(`removed: ${r}`);
    if (existsSync(NOTES) && statSync(NOTES).mtimeMs > Date.parse(prev.generated)) why.push("notes.json edited since the last index");
  }
  if (why.length) {
    console.log(`index is stale (${why.length}):\n  ${why.slice(0, 40).join("\n  ")}${why.length > 40 ? `\n  … ${why.length - 40} more` : ""}\nrun: node tools/index-assets.mjs`);
    process.exit(1);
  }
  console.log(`index is current (${prev.assets.length} assets)`);
  process.exit(0);
}

mkdirSync(SHEETS, { recursive: true });
if (!existsSync(NOTES)) writeFileSync(NOTES, "{}\n");
const notes = JSON.parse(readFileSync(NOTES, "utf8"));
const moods = musicMoods();

const assets = [];
const companions = [];
const strays = [];
let measured = 0;
const t0 = Date.now();

for (const f of files.sort((a, b) => rel(a).localeCompare(rel(b)))) {
  const r = rel(f);
  const c = classify(r, siblings);
  if (c.role === "self") continue;
  if (c.role === "companion") {
    companions.push({ path: r, of: c.of, what: c.what });
    continue;
  }
  if (c.role === "stray") {
    strays.push({ path: r, why: c.why });
    continue;
  }
  const st = statSync(f);
  const mtime = Math.round(st.mtimeMs);
  const p = prevBy.get(r);
  let m;
  if (p && p.bytes === st.size && p.mtime === mtime && p.v === VERSION) m = p.measured;
  else {
    measured++;
    process.stdout.write(`measure ${r}\n`);
    m = { hash: quickHash(f, st.size) };
    if (c.kind === "clip" || c.kind === "sfx" || c.kind === "music") Object.assign(m, ffprobe(f));
    if (c.kind === "sfx") Object.assign(m, volume(f));
    // Stock packs carry silent audio tracks: only call it audio if something is audible.
    if (c.kind === "clip" && m.hasAudio) {
      const { peakDb } = volume(f);
      m.audioPeakDb = peakDb;
      if (peakDb != null && peakDb < -60) m.hasAudio = false;
    }
    if (c.kind === "image") Object.assign(m, imageInfo(f));
    if (c.kind === "icon") Object.assign(m, svgInfo(f));
    if (c.kind === "animation") Object.assign(m, htmlInfo(f));
  }
  const a = { path: r, kind: c.kind, folder: dirname(r) === "." ? "" : dirname(r), bytes: st.size, mtime, v: VERSION, measured: m };
  if (r.startsWith(`${PACK_ROOT}/`) && dirname(r) !== PACK_ROOT) a.pack = basename(dirname(r));
  if (c.kind === "sfx") m.class = sfxClass(m.duration);
  if (c.kind === "music") {
    const name = basename(r, extname(r));
    const prof = readJsonIf(join(dirname(f), `${name}.profile.json`));
    a.music = prof ? { profiled: true, bedStart: prof.bedStart ?? null, tailStart: prof.tailStart ?? null, drops: (prof.drops || []).length, lufs: prof.lufs ?? null } : { profiled: false };
    if (moods[name]) a.mood = moods[name];
  }
  // sheets (named by hash, so a changed file gets a new one)
  if (c.kind === "clip" || c.kind === "image") {
    const sh = join(SHEETS, `${slug(r.replace(/\.[^.]+$/, ""))}.${m.hash.slice(0, 8)}.jpg`);
    if (!existsSync(sh)) {
      try {
        if (c.kind === "clip" && m.duration) clipSheet(f, m.duration, sh);
        if (c.kind === "image") imageThumb(f, sh);
        process.stdout.write(`sheet   ${rel(sh)}\n`);
      } catch (e) {
        console.error(`WARN ${r}: ${e.message}`);
      }
    }
    if (existsSync(sh)) a.sheet = rel(sh);
  }
  const { merged, hasOwn } = notesFor(r, notes);
  a.notes = merged;
  a.place = merged.place ?? placeFromName(r);
  a.hasNotes = hasOwn || !!merged.description || !!a.mood;
  assets.push(a);
}

// duplicates: same quick hash
const byHash = new Map();
for (const a of assets) byHash.set(a.measured.hash, [...(byHash.get(a.measured.hash) || []), a]);
const duplicates = [...byHash.values()].filter((g) => g.length > 1).map((g) => g.map((a) => a.path));
for (const g of duplicates) for (const a of assets) if (g.includes(a.path)) a.duplicateOf = g.filter((x) => x !== a.path);

// pack overview sheets
const packs = {};
for (const a of assets) if (a.pack) (packs[a.folder] ||= []).push(a);
const packSheets = {};
for (const [folder, items] of Object.entries(packs)) {
  items.sort((x, y) => x.path.localeCompare(y.path, undefined, { numeric: true }));
  const key = createHash("sha1").update(items.map((i) => i.measured.hash).join()).digest("hex").slice(0, 8);
  const sh = join(SHEETS, `pack-${slug(basename(folder))}.${key}.jpg`);
  if (!existsSync(sh)) {
    try {
      packSheet(items.map((i) => ({ file: join(ASSETS, i.path), duration: i.measured.duration, label: (basename(i.path).match(/\d+/) || [basename(i.path)])[0] })), sh);
      process.stdout.write(`sheet   ${rel(sh)}\n`);
    } catch (e) {
      console.error(`WARN pack ${folder}: ${e.message}`);
    }
  }
  if (existsSync(sh)) packSheets[folder] = rel(sh);
}

// drop sheets nothing points at any more
const live = new Set([...assets.map((a) => a.sheet), ...Object.values(packSheets)].filter(Boolean).map((s) => basename(s)));
for (const f of readdirSync(SHEETS)) if (!live.has(f)) rmSync(join(SHEETS, f));

// flags
for (const a of assets) {
  const n = a.notes;
  a.flags = [
    n.origin === "ai-generated" && "ai",
    n.realPerson && "realPerson",
    n.legibleText && "legibleText",
    a.duplicateOf && "duplicate",
    !a.hasNotes && "noNotes",
    n.verify && "verify",
    a.measured.bgSquare && "bgSquare",
  ].filter(Boolean);
}

const emptyFolders = dirs.filter((d) => !files.some((f) => f.startsWith(d + "\\") || f.startsWith(d + "/"))).map(rel);
const unknownNotes = Object.keys(notes).filter((k) => !k.endsWith("/*") && !siblings.has(k));
const index = {
  generated: new Date().toISOString(),
  root: "videos/ASSETS",
  counts: Object.fromEntries(["clip", "image", "icon", "animation", "sfx", "music"].map((k) => [k, assets.filter((a) => a.kind === k).length])),
  assets,
  packSheets,
  duplicates,
  companions,
  strays,
  emptyFolders,
  unknownNotes,
};
writeFileSync(OUT_JSON, JSON.stringify(index, null, 1) + "\n");
writeFileSync(OUT_MD, renderMd(index));

const noNotes = assets.filter((a) => !a.hasNotes).length;
console.log(`\n${assets.length} assets (${Object.entries(index.counts).map(([k, v]) => `${v} ${k}`).join(", ")}), ${measured} measured in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`${duplicates.length} duplicate group(s), ${strays.length} stray(s), ${emptyFolders.length} empty folder(s), ${noNotes} asset(s) without notes`);
if (unknownNotes.length) console.log(`WARN notes.json keys with no file: ${unknownNotes.join(", ")}`);
console.log(`wrote ${rel(OUT_JSON)} and ${rel(OUT_MD)}`);

// ---------- INDEX.md ----------
function renderMd(ix) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const code = (s) => `\`${String(s).replace(/`/g, "")}\``;
  const dur = (d) => (d == null ? "" : `${d.toFixed(1)}s`);
  const flags = (a) => a.flags.map((f) => (f === "duplicate" ? `⚠dup of ${a.duplicateOf.map((x) => code(basename(x))).join(", ")}` : FLAG[f])).join(" ");
  const desc = (a) => cell([a.notes.description || a.mood || "", a.notes.use && `**use:** ${a.notes.use}`, a.notes.avoid && `**avoid:** ${a.notes.avoid}`].filter(Boolean).join(" · "));
  const tags = (a) => cell((a.notes.tags || []).join(", "));
  const L = [];
  L.push("# ASSETS index", "");
  L.push("Generated by `node tools/index-assets.mjs`. **Do not edit**: write descriptions and tags in");
  L.push("`_index/notes.json`, then re-run. `node tools/index-assets.mjs --check` tells you if this is stale.", "");
  L.push("- **Search:** `node tools/find-asset.mjs <words> [--kind clip|image|icon|animation|sfx|music] [--place …] [--min s] [--max s] [--safe]`");
  L.push("- **Paths** are relative to `videos/ASSETS`, the form `edit.json` inserts and `sfx.json` sounds take.");
  L.push("- **Look before you use:** every clip and image has a contact sheet (`_index/sheets/…`, the `sheet` column); open it.");
  L.push("- **Flags:** ⚠AI = generated imagery · ⚠real-person = shows an identifiable real person (anonymity invariant) ·");
  L.push("  ⚠text = legible words on screen (no-words invariant) · ⚠dup = byte-identical to another file · ⚠no-notes = not described yet · ⚠verify = description is a guess ·");
  L.push("  ⚠bg-square = traced SVG whose first path is a solid full-canvas background: remove or hide it before laying the icon over footage");
  L.push("");
  L.push(`**${ix.assets.length} assets:** ${Object.entries(ix.counts).map(([k, v]) => `${v} ${k}`).join(" · ")}. Generated ${ix.generated.slice(0, 16).replace("T", " ")} UTC.`, "");

  const house = [];
  for (const g of ix.duplicates) house.push(`- duplicate: ${g.map(code).join(" = ")}`);
  for (const s of ix.strays) house.push(`- stray: ${code(s.path)}: ${s.why}`);
  for (const d of ix.emptyFolders) house.push(`- empty folder: ${code(d + "/")}`);
  const un = ix.assets.filter((a) => !a.hasNotes);
  if (un.length) house.push(`- ${un.length} asset(s) without notes (⚠no-notes below)`);
  if (ix.unknownNotes.length) house.push(`- notes.json keys with no file: ${ix.unknownNotes.map(code).join(", ")}`);
  const mapAt = L.length; // the section map goes here once the line numbers are known
  if (house.length) L.push("## Housekeeping", "", ...house, "");

  const groups = new Map();
  for (const a of ix.assets) groups.set(a.folder, [...(groups.get(a.folder) || []), a]);
  const order = [...groups.keys()].sort((x, y) => {
    const rank = (k) => ["clips", "images", "animations", "svg-icons", "sound-effects", "music"].findIndex((t) => k === t || k.startsWith(t + "/"));
    return rank(x) - rank(y) || x.localeCompare(y);
  });

  for (const folder of order) {
    const items = groups.get(folder).sort((x, y) => x.path.localeCompare(y.path, undefined, { numeric: true }));
    const kind = items[0].kind;
    L.push(`## ${folder || "(root)"}/ (${items.length})`, "");
    const fd = notes[`${folder}/*`]?.description;
    if (fd) L.push(fd, "");
    if (ix.packSheets[folder]) L.push(`Overview sheet (mid-frame of every item, labelled by number): ${code(ix.packSheets[folder])}`, "");
    const comp = ix.companions.filter((c) => dirname(c.of) === folder || c.of === folder);
    if (kind === "music") {
      L.push("music-score's `library.txt` (built from the `.profile.json` files) is the authority for picking a track; `TIMING-DESCRIPTIONS.md` has the section layout.", "");
      L.push("| path | dur | bed starts | drops | mood / description | tags | flags |", "|---|---|---|---|---|---|---|");
      for (const a of items) L.push(`| ${code(a.path)} | ${dur(a.measured.duration)} | ${a.music.profiled ? `${a.music.bedStart}s` : "not profiled"} | ${a.music.profiled ? a.music.drops : ""} | ${desc(a)} | ${tags(a)} | ${flags(a)} |`);
    } else if (kind === "sfx") {
      L.push("Length class: short <1.5 s (a tick or hit), medium 1.5–5 s (a whoosh or riser), long >5 s (often several sounds in one file: pick a stretch).", "");
      L.push("| path | dur | class | starts at | peak dB | description | tags | flags |", "|---|---|---|---|---|---|---|---|");
      for (const a of items) L.push(`| ${code(a.path)} | ${dur(a.measured.duration)} | ${a.measured.class || ""} | ${a.measured.onset ? `${a.measured.onset}s` : "0"} | ${a.measured.peakDb ?? ""} | ${desc(a)} | ${tags(a)} | ${flags(a)} |`);
    } else if (kind === "icon") {
      L.push("| path | style | shapes | description | tags | flags |", "|---|---|---|---|---|---|");
      L.splice(L.length - 2, 0, "style: stroke icons draw themselves line by line; fill and traced ones wipe in (icon-hero-enrich).", "");
      for (const a of items) L.push(`| ${code(a.path)} | ${a.measured.style}${a.measured.traced ? " (traced)" : ""} | ${a.measured.shapes} | ${desc(a)} | ${tags(a)} | ${flags(a)} |`);
    } else if (kind === "animation" && items.every((a) => a.kind === "animation")) {
      L.push("| path | composition id | dur | canvas | usage notes | description | flags |", "|---|---|---|---|---|---|---|");
      for (const a of items) {
        const md = comp.find((c) => c.of === a.path);
        const m = a.measured;
        L.push(`| ${code(a.path)} | ${code(m.compositionId || "?")} | ${dur(m.duration)} | ${m.width ? `${m.width}×${m.height}` : ""} | ${md ? code(md.path) : ""} | ${desc(a)} | ${flags(a)} |`);
      }
    } else {
      L.push("| path | kind | dur | size | place | description | tags | sheet | flags |", "|---|---|---|---|---|---|---|---|---|");
      for (const a of items) {
        const m = a.measured;
        const size = m.width ? `${m.width}×${m.height} ${shape(m.width, m.height) || ""}${m.alpha ? " α" : ""}${a.kind === "clip" ? (m.hasAudio ? " 🔊" : " 🔇") : ""}` : "";
        L.push(`| ${code(a.path)} | ${a.kind} | ${dur(m.duration)} | ${size.trim()} | ${cell(a.place || "")} | ${desc(a)} | ${tags(a)} | ${a.sheet ? code(a.sheet) : ""} | ${flags(a)} |`);
      }
    }
    const other = comp.filter((c) => c.what !== "usage notes" && c.what !== "music-score analysis");
    if (other.length) L.push("", `Notes in this folder: ${other.map((c) => code(c.path)).join(", ")}`);
    L.push("");
  }
  // Section map: the file is long, so read only the section you need (Read with offset).
  const secs = L.map((l, i) => [l, i]).filter(([l, i]) => i >= mapAt && l.startsWith("## "));
  const map = ["## Sections (line numbers)", "", ...secs.map(([l]) => l), ""];
  const shift = map.length;
  secs.forEach(([l, i], k) => (map[2 + k] = `- line ${i + 1 + shift}: ${l.slice(3)}`));
  L.splice(mapAt, 0, ...map);
  return L.join("\n");
}
