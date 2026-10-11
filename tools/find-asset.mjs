#!/usr/bin/env node
// Search the shared asset library through videos/ASSETS/index.json (built by index-assets.mjs).
//
//   node tools/find-asset.mjs inundación calle --kind clip --place coatepec --min 4 --max 15
//   node tools/find-asset.mjs whoosh --kind sfx --class short
//
// Options: --kind clip|image|icon|animation|sfx|music|data   --place <text>   --tag <tag>
//          --class short|medium|long (sfx length: <1.5 s, 1.5–5 s, >5 s)   --min/--max <seconds> (clips longer than --max stay, marked "trim it")   --pack <folder name>
//          --safe (drop ⚠real-person, ⚠text and duplicates)   --limit N (15)   --json
// Matching ignores accents and case, and a shared 5-letter prefix counts as a partial hit, so
// "inundación" finds "inundada" and "inundado". Paths print relative to videos/ASSETS.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(WORKSPACE, "videos", "ASSETS", "index.json");

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport")[0].replace(/^#!.*\n/, "").replace(/^\/\/ ?/gm, ""));
  process.exit(argv.length ? 0 : 1);
}
if (!existsSync(INDEX)) {
  console.error("ERROR: videos/ASSETS/index.json is missing. Run: node tools/index-assets.mjs");
  process.exit(1);
}

const opt = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--safe" || a === "--json") opt[a.slice(2)] = true;
  else if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
  else words.push(a);
}

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const tokens = (s) => fold(s).split(/[^a-z0-9ñ]+/).filter((t) => t.length > 1);
const q = words.flatMap(tokens);

function wordScore(qt, list) {
  let best = 0;
  for (const w of list) {
    if (w === qt) return 1;
    const n = Math.min(5, qt.length);
    if (n >= 4 && w.length >= n && w.slice(0, n) === qt.slice(0, n)) best = Math.max(best, 0.6);
    else if (qt.length >= 4 && w.includes(qt)) best = Math.max(best, 0.5); // run-together names: "callesinpavimento"
  }
  return best;
}

const ix = JSON.parse(readFileSync(INDEX, "utf8"));
const results = [];
for (const a of ix.assets) {
  const m = a.measured;
  const n = a.notes || {};
  const d = m.duration ?? n.duration;
  if (opt.kind && a.kind !== opt.kind) continue;
  if (opt.place && !fold(a.place).includes(fold(opt.place))) continue;
  if (opt.tag && !(n.tags || []).some((t) => fold(t) === fold(opt.tag))) continue;
  if (opt.class && !fold(m.class).includes(fold(opt.class))) continue;
  if (opt.pack && !fold(a.pack).includes(fold(opt.pack))) continue;
  if (opt.min && !(d >= +opt.min)) continue;
  // A longer clip can still be trimmed: keep it, ranked lower and marked. Audio must fit.
  const over = opt.max && d > +opt.max;
  if (over && a.kind !== "clip") continue;
  if (opt.safe && a.flags.some((f) => ["realPerson", "legibleText", "duplicate"].includes(f))) continue;
  const fields = [
    [tokens(n.tags?.join(" ")), 3],
    [tokens(n.description), 2],
    [tokens(a.mood), 2],
    [tokens(a.place), 2],
    [tokens(a.path.split("/").pop()), 2],
    [tokens(a.folder), 1],
    [tokens(n.use), 1],
    [tokens(m.columns?.join(" ").replace(/_/g, " ")), 1], // data tables: their column names
  ];
  let score = 0;
  for (const qt of q) score += Math.max(0, ...fields.map(([list, w]) => wordScore(qt, list) * w));
  if (q.length && score === 0) continue;
  if (a.duplicateOf) score -= 0.1; // keep one copy of a pair on top
  if (over) score -= 0.5;
  results.push({ a, score: +score.toFixed(2), trim: !!over });
}
results.sort((x, y) => y.score - x.score || x.a.path.localeCompare(y.a.path));
const top = results.slice(0, +(opt.limit || 15));

if (opt.json) {
  console.log(JSON.stringify(top.map(({ a, score }) => ({ score, path: a.path, kind: a.kind, duration: a.measured.duration, place: a.place, description: a.notes.description || a.mood, use: a.notes.use, avoid: a.notes.avoid, tags: a.notes.tags, onset: a.measured.onset, sheet: a.sheet, flags: a.flags })), null, 1));
} else if (!top.length) {
  console.log("no match. Try fewer or broader words, or read videos/ASSETS/INDEX.md");
} else {
  for (const { a, score, trim } of top) {
    const m = a.measured;
    const bits = [a.kind, m.duration != null ? `${m.duration}s${trim ? " (longer than --max: trim it)" : ""}` : null, m.onset ? `sound starts at ${m.onset}s` : null, (a.kind !== "sfx" && a.kind !== "music" && m.width) ? `${m.width}x${m.height}` : null, m.class, a.place, m.rows != null ? `${m.rows} rows: ${(m.columns || []).slice(0, 6).join(", ")}` : null].filter(Boolean).join(" · ");
    console.log(`${score.toFixed(1).padStart(4)}  ${a.path}\n      ${bits}${a.flags.length ? `  [${a.flags.join(", ")}]` : ""}`);
    const desc = a.notes.description || a.mood;
    if (desc) console.log(`      ${desc}`);
    if (a.notes.use) console.log(`      use: ${a.notes.use}`);
    if (a.notes.avoid) console.log(`      avoid: ${a.notes.avoid}`);
    if (a.sheet) console.log(`      sheet: videos/ASSETS/${a.sheet}`);
  }
  if (results.length > top.length) console.log(`… ${results.length - top.length} more (--limit)`);
}
