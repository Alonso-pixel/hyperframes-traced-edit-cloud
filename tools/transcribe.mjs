#!/usr/bin/env node
// Audio-first pipeline: narration.mp3 -> whisper.cpp -> normalized transcript.json
// Usage: node tools/transcribe.mjs <audio-file> [--model large-v3-turbo] [--language es] [--out <path>] [--wav]
// See root CLAUDE.md for the full workflow.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism, tmpdir } from "node:os";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";
const WHISPER_CLI = process.env.WHISPER_CLI || (WIN ? "C:\\Program Files\\whisper\\Release\\whisper-cli.exe" : "whisper-cli");
const THREADS = String(process.env.WHISPER_THREADS || (WIN ? 8 : availableParallelism()));

// ---------- args ----------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: node tools/transcribe.mjs <audio-file> [options]

Options:
  --model <name>     whisper model (default: large-v3-turbo) -> tools/models/ggml-<name>.bin
  --language <iso>   spoken language (default: es). NEVER use a .en model for non-English.
  --out <path>       output transcript.json path (default: <project-root>/transcript.json,
                     found by walking up from the audio file to the nearest package.json)
  --wav              force ffmpeg conversion to 16kHz mono wav before transcribing
Env:
  WHISPER_CLI        override whisper-cli.exe path (default: C:\\Program Files\\whisper\\Release\\whisper-cli.exe;
                     whisper-cli on PATH outside Windows)
  WHISPER_THREADS    whisper threads (default: 8 on Windows, every core elsewhere)`);
  process.exit(argv.length === 0 ? 1 : 0);
}

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const audioFile = resolve(argv[0]);
const model = flag("model", "large-v3-turbo");
const language = flag("language", "es");
const forceWav = argv.includes("--wav");
const modelPath = join(TOOLS_DIR, "models", `ggml-${model}.bin`);

// ---------- preflight ----------
if (!existsSync(audioFile)) die(`Audio file not found: ${audioFile}`);
if (!existsSync(WHISPER_CLI))
  die(`whisper-cli.exe not found at: ${WHISPER_CLI}\nSet the WHISPER_CLI env var to override.`);
if (!existsSync(modelPath))
  die(`Model not found: ${modelPath}\nDownload it (PowerShell):\n  Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin" -OutFile "${modelPath}"`);
if (model.endsWith(".en") && language !== "en")
  die(`Model "${model}" is English-only (.en) but --language is "${language}". .en models silently TRANSLATE non-English audio. Use a non-.en model.`);

const outPath = resolve(flag("out", "") || join(findProjectRoot(audioFile), "transcript.json"));

// ---------- audio duration (ffprobe) ----------
let durationS = null;
try {
  durationS = parseFloat(
    execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audioFile], {
      encoding: "utf8",
    }).trim()
  );
} catch {
  console.warn("warn: ffprobe unavailable — skipping duration checks.");
}

// ---------- transcribe (mp3 direct; wav fallback) ----------
const outPrefix = audioFile.replace(/\.[^.]+$/, ""); // whisper writes <prefix>.json / <prefix>.srt
let inputFile = audioFile;
let tempWav = null;

if (forceWav) inputFile = tempWav = toWav(audioFile);

let result = runWhisper(inputFile);
if (result.status !== 0 && !tempWav) {
  console.warn("whisper-cli failed on the source file — retrying via 16kHz wav (ffmpeg)...");
  inputFile = tempWav = toWav(audioFile);
  result = runWhisper(inputFile);
}
if (result.status !== 0)
  die(`whisper-cli failed (exit ${result.status}).\n${(result.stderr || "").slice(-2000)}`);

const whisperJsonPath = `${outPrefix}.json`;
if (!existsSync(whisperJsonPath)) die(`whisper-cli succeeded but ${whisperJsonPath} was not written.`);
if (tempWav) rmSync(tempWav, { force: true });

// ---------- normalize ----------
const raw = JSON.parse(readFileSync(whisperJsonPath, "utf8"));
const segments = raw.transcription ?? [];
const words = [];

for (const seg of segments) {
  const text = (seg.text ?? "").trim();
  if (!text) continue;
  if (/^\[.*\]$|^\(.*\)$/.test(text)) continue; // [MUSIC], (applause) etc.
  const start = seg.offsets.from / 1000;
  const end = seg.offsets.to / 1000;
  // punctuation-only fragment -> glue onto previous word
  if (/^[\p{P}\p{S}]+$/u.test(text) && words.length > 0) {
    const prev = words[words.length - 1];
    prev.text += text;
    prev.end = Math.max(prev.end, r3(end));
    continue;
  }
  words.push({ id: `w${words.length}`, text, start: r3(start), end: r3(end) });
}

if (words.length === 0) die("Normalization produced 0 words — inspect the whisper JSON: " + whisperJsonPath);

// enforce monotonic, non-overlapping times
for (let i = 0; i < words.length; i++) {
  const w = words[i];
  if (w.end < w.start) w.end = w.start;
  if (i > 0 && w.start < words[i - 1].end) w.start = words[i - 1].end;
  if (w.end < w.start) w.end = w.start;
}
const lastEnd = words[words.length - 1].end;
if (durationS !== null && lastEnd > durationS + 0.5)
  die(`Last word ends at ${lastEnd}s but audio is only ${durationS.toFixed(2)}s — transcript is corrupt.`);

// ---------- write ----------
writeFileSync(outPath, JSON.stringify(words, null, 2) + "\n");
writeFileSync(
  `${outPrefix}.meta.json`,
  JSON.stringify(
    { duration_s: durationS, model, language, words: words.length, generated: new Date().toISOString(), source: basename(audioFile) },
    null, 2
  ) + "\n"
);

// ---------- report ----------
console.log(`\ntranscript.json -> ${outPath}`);
console.log(`words: ${words.length}   audio: ${durationS === null ? "?" : durationS.toFixed(2) + "s"}   last word ends: ${lastEnd}s`);
console.log(`artifacts: ${whisperJsonPath}, ${outPrefix}.srt, ${outPrefix}.meta.json`);
console.log(`\n--- full text (diff against SCRIPT.md) ---`);
console.log(words.map((w) => w.text).join(" "));

// ---------- helpers ----------
function runWhisper(file) {
  const args = ["-m", modelPath, "-l", language, "-t", THREADS, "-ml", "1", "-sow", "-bo", "5", "-bs", "5", "-oj", "-osrt", "-of", outPrefix, "-f", file];
  console.log(`> whisper-cli ${args.join(" ")}`);
  return spawnSync(WHISPER_CLI, args, { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function toWav(src) {
  const wav = join(tmpdir(), `${basename(src).replace(/\.[^.]+$/, "")}.16k.wav`);
  execFileSync("ffmpeg", ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: "pipe" });
  return wav;
}

function findProjectRoot(fromFile) {
  let dir = dirname(fromFile);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(fromFile); // no package.json found: next to the audio
    dir = parent;
  }
}

function r3(n) {
  return Math.round(n * 1000) / 1000;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
