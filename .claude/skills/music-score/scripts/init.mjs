#!/usr/bin/env node
// Step 1 of music-score: analyze the library and the video, write the files the model reads.
//
//   node .claude/skills/music-score/scripts/init.mjs <video.mp4> [--work <dir>] [--music-from <s>]
//        [--out <output.mp4>] [--transcript <transcript.json> --transcript-offset <s>]
//
// Writes into <work> (default: <video folder>/music-score/):
//   words.tsv       every spoken word with its start time (VIDEO seconds)
//   sentences.txt   one sentence per line with its start time (VIDEO seconds)
//   library.txt     every music track: mood, where its bed starts, its MAIN drop, its quiet gaps
//   score.json      skeleton — the only file you edit
//   transcript.json whisper words (reused if present)

import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { relative } from "node:path";
import {
  ROOT, LIBRARY, fail, run, probe, profile, libraryTracks, moods, fmt,
  join, resolve, dirname, basename, existsSync, readFileSync, writeFileSync,
} from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const videoArg = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!videoArg) fail("usage: node .claude/skills/music-score/scripts/init.mjs <video.mp4> [--work dir] [--music-from s] [--out out.mp4]");
const video = resolve(videoArg);
if (!existsSync(video)) fail(`video not found: ${video}`);
const info = probe(video);
if (!info.streams.some((s) => s.codec_type === "audio")) fail("the video has no audio stream");
if (!info.streams.some((s) => s.codec_type === "video")) fail("the file has no video stream");
const total = info.duration;

const work = resolve(opt("work", join(dirname(video), "music-score")));
mkdirSync(work, { recursive: true });
const musicFrom = Number(opt("music-from", 0));
if (!(musicFrom >= 0 && musicFrom < total - 10)) fail(`--music-from ${musicFrom} must be between 0 and ${(total - 10).toFixed(2)}`);
const out = resolve(opt("out", join(dirname(video), `${basename(video).replace(/\.[^.]+$/, "")}-music.mp4`)));
if (out === video) fail("--out must be a NEW file; never overwrite the source video");
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

console.log(`video    ${rel(video)}  (${total.toFixed(2)} s)`);
console.log(`work dir ${rel(work)}`);

// 1. library profiles
console.log(`\nprofiling the music library (${rel(LIBRARY)}) — cached after the first run…`);
const mood = moods();
const tracks = libraryTracks().map((n) => profile(n));

// 2. transcript (video time)
const tjson = join(work, "transcript.json");
if (existsSync(tjson)) {
  console.log("transcript.json already exists in the work dir, reusing it");
} else if (opt("transcript")) {
  const off = Number(opt("transcript-offset", 0));
  const w = JSON.parse(readFileSync(resolve(opt("transcript")), "utf8"));
  writeFileSync(tjson, JSON.stringify(w.map((x) => ({ ...x, start: +(x.start + off).toFixed(3), end: +(x.end + off).toFixed(3) })), null, 1));
  console.log(`transcript copied from ${opt("transcript")} (+${off} s)`);
} else {
  console.log("extracting audio + transcribing with whisper (a few minutes)…");
  const wav = join(work, "speech.wav");
  run(["-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const r = spawnSync("node", [join(ROOT, "tools", "transcribe.mjs"), wav, "--out", tjson], { stdio: "inherit" });
  if (r.status !== 0 || !existsSync(tjson)) fail("transcription failed (see the output above)");
}
const words = JSON.parse(readFileSync(tjson, "utf8")).filter((w) => String(w.text).trim());

// 3. words.tsv + sentences.txt (only from musicFrom on)
const body = words.filter((w) => w.start >= musicFrom - 0.05);
writeFileSync(
  join(work, "words.tsv"),
  // start time only: an end column invites copying the wrong number
  "start\tword\n" + body.map((w) => `${w.start.toFixed(2)}\t${String(w.text).trim()}`).join("\n") + "\n",
);
const sentences = [];
let cur = null;
body.forEach((w, i) => {
  if (!cur) cur = { start: w.start, text: [] };
  cur.text.push(String(w.text).trim());
  const next = body[i + 1];
  const txt = String(w.text).trim();
  const long = w.end - cur.start;
  // a line ends at . ? !, at a pause, at a comma once it is 5 s long, or anywhere once it is 15 s long
  if (!next || /[.?!…]$/.test(txt) || next.start - w.end >= 0.6 || (/[,;:]$/.test(txt) && long >= 5) || long >= 15) {
    sentences.push(cur);
    cur = null;
  }
});
writeFileSync(
  join(work, "sentences.txt"),
  `# VIDEO seconds. Music starts at ${musicFrom.toFixed(2)}; the video ends at ${total.toFixed(2)}.\n` +
    `# A section "from" must be one of these start times (copy it exactly).\n` +
    sentences.map((s) => `${s.start.toFixed(2).padStart(8)}  ${s.text.join(" ")}`).join("\n") + "\n",
);

// 4. library.txt
const lines = [
  "# Music library — one block per track. Times are seconds INSIDE the track.",
  "# role \"hit\" needs a MAIN drop. Tracks without one can only be \"bed\" or \"ending\".",
  "",
];
for (const p of tracks) {
  const m = mood[p.name] || "(no mood description)";
  const stinger = /stinger/i.test(m);
  lines.push(`### ${p.name}`);
  lines.push(`mood: ${m}`);
  if (stinger) {
    lines.push("NOT A MUSIC BED — sound-effect file. Never use it in score.json.", "");
    continue;
  }
  const main = p.drops.find((d) => d.main);
  const others = p.drops.filter((d) => d.afterStop && !d.main && d.t > 20 && d.t < p.duration - 15 && d.sustain >= -4);
  lines.push(`length ${p.duration.toFixed(2)} s | bed starts at ${p.bedStart.toFixed(2)} | ends with a ${(p.duration - p.tailStart).toFixed(1)} s tail`);
  lines.push(main ? `MAIN drop: ${main.t.toFixed(2)}   <- copy this number into "drop" for a hit` : "MAIN drop: none (use as bed or ending only)");
  if (others.length) lines.push(`other drops after a stop: ${others.map((d) => d.t.toFixed(2)).join(", ")}`);
  lines.push("");
}
writeFileSync(join(work, "library.txt"), lines.join("\n"));

// 5. score.json skeleton (never overwrite an existing one)
const scorePath = join(work, "score.json");
if (!existsSync(scorePath)) {
  writeFileSync(
    scorePath,
    JSON.stringify(
      {
        video: rel(video),
        musicFrom: +musicFrom.toFixed(3),
        output: rel(out),
        sections: [],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${rel(scorePath)} (skeleton: fill in "sections")`);
} else {
  console.log(`\n${rel(scorePath)} already exists, left unchanged`);
}

console.log(`
Done. Next:
  1. Read ${rel(join(work, "sentences.txt"))}  (${sentences.length} sentences, ${fmt(musicFrom)} → ${fmt(total)})
  2. Read ${rel(join(work, "library.txt"))}  (${tracks.length} tracks)
  3. Fill "sections" in ${rel(scorePath)} (see SKILL.md step 3)
  4. node .claude/skills/music-score/scripts/build.mjs ${rel(scorePath)} --check`);
