#!/usr/bin/env node
// Steps 4–6 of music-score: validate score.json, plan the cues, build the bed, mix it under the
// video, and verify the result by measurement.
//
//   node .claude/skills/music-score/scripts/build.mjs <work>/score.json [--check]
//
//   --check   validate and print the cue plan only (fast; no audio is written)
//
// Writes into the work dir: cues.json, bed.wav, stem-voice.wav, stem-bed.wav, report.txt,
// listen/*.mp4 — and the output video named in score.json.

import { mkdirSync, rmSync } from "node:fs";
import {
  ROOT, fail, run, probe, measure, loudness, envelope, smooth, meanDb, runs, FRAME,
  profile, libraryTracks, moods, trackFile, fmt, readJson,
  join, resolve, dirname, existsSync, readFileSync, writeFileSync,
} from "./lib.mjs";

const args = process.argv.slice(2);
const scoreArg = args.find((a) => !a.startsWith("--"));
if (!scoreArg) fail("usage: node .claude/skills/music-score/scripts/build.mjs <work>/score.json [--check]");
const scorePath = resolve(scoreArg);
const work = dirname(scorePath);
const checkOnly = args.includes("--check");
const sc = readJson(scorePath);

const LEVEL = { bed: -24, hit: -21, ending: -22 }; // LUFS per role, before ducking
const errors = [];
const warns = [];
const E = (m) => errors.push(m);
const W = (m) => warns.push(m);
const f2 = (x) => Number(x).toFixed(2);

// ---------- inputs ----------
if (typeof sc.video !== "string") fail(`score.json: "video" is missing`);
if (typeof sc.output !== "string") fail(`score.json: "output" is missing`);
const video = resolve(ROOT, sc.video);
const out = resolve(ROOT, sc.output);
if (!existsSync(video)) fail(`video not found: ${sc.video}`);
if (out === video) fail(`"output" must be a new file, not the source video`);
const vinfo = probe(video);
const total = vinfo.duration;
const musicFrom = Number(sc.musicFrom ?? 0);
if (!(musicFrom >= 0 && musicFrom < total)) fail(`"musicFrom" must be between 0 and ${f2(total)}`);

for (const f of ["words.tsv", "sentences.txt"]) if (!existsSync(join(work, f))) fail(`${f} is missing in ${work}. Run init.mjs first.`);
const words = readFileSync(join(work, "words.tsv"), "utf8").trim().split("\n").slice(1)
  .map((l) => l.split("\t")).map((c) => ({ start: Number(c[0]), text: c[c.length - 1] })); // start<TAB>word (older: start<TAB>end<TAB>word)
const sentences = readFileSync(join(work, "sentences.txt"), "utf8").split("\n")
  .filter((l) => /^\s*\d/.test(l)).map((l) => {
    const m = l.match(/^\s*([\d.]+)\s+(.*)$/);
    return { start: Number(m[1]), text: m[2] };
  });
const nearest = (list, t, n = 3) => [...list].sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t)).slice(0, n);
const show = (x) => `${f2(x.start)} "${x.text.slice(0, 50)}"`;

// ---------- validate sections ----------
const S = Array.isArray(sc.sections) ? sc.sections : fail(`"sections" must be a list`);
if (S.length === 0) fail(`"sections" is empty. Add sections (SKILL.md step 3).`);
const known = new Set(libraryTracks());
const mood = moods();
const plan = [];

S.forEach((s, k) => {
  const tag = `section ${k + 1}`;
  const from = Number(s.from);
  if (!Number.isFinite(from)) return E(`${tag}: "from" must be a number (a start time copied from sentences.txt)`);
  const end = k + 1 < S.length ? Number(S[k + 1].from) : total;
  const len = end - from;
  const name = String(s.track || "").replace(/\.mp3$/i, "");
  const role = s.role;

  if (k === 0 && Math.abs(from - musicFrom) > 0.05) E(`${tag}: the first section must start at musicFrom (${f2(musicFrom)}), not ${f2(from)}`);
  if (k > 0 && !sentences.some((x) => Math.abs(x.start - from) <= 0.05))
    E(`${tag}: "from": ${f2(from)} is not a sentence start. Copy one from sentences.txt. Nearest: ${nearest(sentences, from).map(show).join(" | ")}`);
  if (!(len > 0)) return E(`${tag}: sections must be in time order (this one ends at ${f2(end)}, before it starts)`);
  if (len < 8) E(`${tag}: only ${len.toFixed(1)} s long (${f2(from)}–${f2(end)}); a section needs at least 8 s. Merge it with a neighbour.`);
  if (len > 90) W(`${tag}: ${len.toFixed(0)} s long; consider splitting it at a sentence start where the mood changes`);
  if (!known.has(name)) return E(`${tag}: track "${s.track}" is not in the library. Use a name from library.txt (without .mp3).`);
  if (/stinger/i.test(mood[name] || "")) return E(`${tag}: "${name}" is a sound-effect file, not a music bed. Pick another track.`);
  if (k > 0 && String(S[k - 1].track || "").replace(/\.mp3$/i, "") === name) E(`${tag}: same track as the section before it. Merge the two sections or pick another track.`);
  if (!["bed", "hit", "ending"].includes(role)) return E(`${tag}: "role" must be "bed", "hit" or "ending"`);
  if (role === "ending" && k !== S.length - 1) E(`${tag}: role "ending" is only allowed on the LAST section`);
  const gain = Number(s.gain ?? 0);
  if (!(gain >= -8 && gain <= 6)) E(`${tag}: "gain" must be between -8 and 6`);

  const p = profile(name);
  let trackIn;
  let hit = null;
  if (role === "bed") {
    trackIn = s.trackIn != null ? Number(s.trackIn) : p.bedStart;
  } else if (role === "hit") {
    const hitAt = Number(s.hitAt);
    if (!Number.isFinite(hitAt)) return E(`${tag}: role "hit" needs "hitAt" = the start time of the key word, copied from words.tsv`);
    if (!words.some((w) => Math.abs(w.start - hitAt) <= 0.02))
      E(`${tag}: "hitAt": ${f2(hitAt)} is not a word start in words.tsv. Nearest: ${nearest(words, hitAt).map(show).join(" | ")}`);
    const line = [...sentences].reverse().find((x) => x.start <= hitAt + 0.02);
    if (line && Math.abs(line.start - hitAt) > 0.02)
      W(`${tag}: "hitAt" ${f2(hitAt)} is in the middle of the line ${show(line)}. A hit normally lands on the FIRST word of the key line: "hitAt": ${f2(line.start)}. Keep ${f2(hitAt)} only if the key word really is mid-line (e.g. a number).`);
    if (hitAt - from < 4) E(`${tag}: "hitAt" (${f2(hitAt)}) must be at least 4 s after "from" (${f2(from)}) so the build-up is heard. Start the section at an earlier sentence (≤ ${f2(hitAt - 4)}).`);
    if (hitAt > end - 3) E(`${tag}: "hitAt" (${f2(hitAt)}) must be at least 3 s before the section ends (${f2(end)}). Start the next section later.`);
    const drop = Number(s.drop);
    const d = p.drops.find((x) => Math.abs(x.t - drop) <= 0.3);
    const main = p.drops.find((x) => x.main);
    if (!d) return E(`${tag}: "drop": ${s.drop} is not a drop of ${name}. ${main ? `Its MAIN drop is ${f2(main.t)} (library.txt).` : `${name} has no MAIN drop: use another track for a hit.`}`);
    if (!d.afterStop) W(`${tag}: drop ${f2(d.t)} has no silence before it, so the hit will be weak. ${main ? `The MAIN drop is ${f2(main.t)}.` : ""}`);
    else if (!d.main) W(`${tag}: drop ${f2(d.t)} is not ${name}'s MAIN drop (${main ? f2(main.t) : "none"}). Fine only if you chose it on purpose.`);
    trackIn = d.t - (hitAt - from);
    hit = { hitAt, drop: d.t };
    if (trackIn < 0) E(`${tag}: the drop (${f2(d.t)} in the track) is too early to fit ${f2(hitAt - from)} s of music before "hitAt". Start this section later: "from" must be ≥ ${f2(hitAt - d.t)} (a sentence start).`);
  } else {
    trackIn = p.duration - len;
    if (trackIn < 0) E(`${tag}: the ending is ${len.toFixed(1)} s but ${name} is only ${p.duration.toFixed(1)} s long. Start this section at a sentence at or after ${f2(total - p.duration + 1)}.`);
  }
  if (trackIn >= 0 && trackIn + len > p.duration + 0.05)
    E(`${tag}: ${name} runs out at video ${f2(from + p.duration - trackIn)}, before this section ends (${f2(end)}). Start the next section earlier, or pick another track.`);

  // quiet gaps (>= 1.5 s) inside the part we play — except the breakdown (8 s) before a hit's drop
  // and, for an ending, anything in the last 15 s of the track (that is its outro)
  for (const st of p.stops) {
    if (st.end - st.start < 1.5) continue;
    if (st.end <= trackIn + 0.3 || st.start >= trackIn + len - 0.3) continue;
    if (hit && hit.drop - st.end >= -0.3 && hit.drop - st.end <= 8) continue;
    if (role === "ending" && st.start >= p.duration - 15) continue;
    E(`${tag}: ${name} goes quiet at track ${f2(st.start)}–${f2(st.end)} = video ${f2(from + st.start - trackIn)}–${f2(from + st.end - trackIn)}. Move a section boundary to avoid it, or pick another track.`);
  }
  plan.push({ k, name, role, from, end, len, trackIn, gain, hit, p });
});

// ---------- cues (2 s crossfades centred on the boundaries) ----------
const cues = plan.map((c, i) => {
  const first = i === 0;
  const last = i === plan.length - 1;
  let pre = first ? 0 : Math.min(1, Math.max(0, c.trackIn));
  let post = last ? 0 : Math.max(0, Math.min(1, c.p.duration - (c.trackIn + c.len)));
  return {
    name: `${c.k + 1}-${c.role}`,
    track: c.name,
    trackIn: +(c.trackIn - pre).toFixed(3),
    bodyIn: +(c.from - pre - musicFrom).toFixed(3),
    bodyOut: +(c.end + post - musicFrom).toFixed(3),
    fadeIn: first ? 0.3 : +(pre + 1).toFixed(3),
    fadeOut: last ? (c.role === "ending" ? 0.05 : 2) : +(post + 1).toFixed(3),
    lufs: LEVEL[c.role] + c.gain,
    hitAt: c.hit?.hitAt,
  };
});

// ---------- report plan ----------
console.log(`\nvideo ${sc.video}  ${f2(total)} s   music ${f2(musicFrom)} → ${f2(total)}\n`);
console.log(" #  role    track                     video from–to        track in–out       level");
plan.forEach((c, i) =>
  console.log(
    `${String(i + 1).padStart(2)}  ${c.role.padEnd(7)} ${c.name.padEnd(25)} ${f2(c.from).padStart(7)}–${f2(c.end).padEnd(8)}  ` +
      `${f2(c.trackIn).padStart(7)}–${f2(c.trackIn + c.len).padEnd(8)}  ${cues[i].lufs} LUFS` +
      (c.hit ? `   drop ${f2(c.hit.drop)} → ${f2(c.hit.hitAt)} "${(words.find((w) => Math.abs(w.start - c.hit.hitAt) <= 0.02) || {}).text || "?"}"` : ""),
  ),
);
if (!plan.some((c) => c.role === "hit") && sc.noHits !== true)
  E(`no section has role "hit". Every score needs 1–3 hits on the strongest lines: follow SKILL.md, "How to place a hit". (Only if the user asked for no hits, add "noHits": true.)`);
for (const w of warns) console.log(`WARNING: ${w}`);
if (errors.length) {
  for (const e of errors) console.log(`ERROR: ${e}`);
  console.log(`\n${errors.length} error(s). Nothing was built. Fix score.json and run again.`);
  process.exit(1);
}
writeFileSync(join(work, "cues.json"), JSON.stringify({ musicFrom, duration: +(total - musicFrom).toFixed(3), cues }, null, 1));
if (checkOnly) {
  console.log(`\nCHECK OK. Run again without --check to build.`);
  process.exit(0);
}

// ---------- one build at a time per work dir ----------
const lock = join(work, ".build.lock");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    alive = e.code === "EPERM"; // exists, but not ours to signal
  }
  if (alive) fail(`another build (pid ${pid}) is still running in this work dir. Wait for it to finish; never run two builds at once.`);
}
writeFileSync(lock, String(process.pid));
process.on("exit", () => rmSync(lock, { force: true }));

// ---------- bed ----------
const bodyDur = +(total - musicFrom).toFixed(3);
const bedPath = join(work, "bed.wav");
console.log("\nbuilding the music bed…");
{
  const inputs = [];
  const chains = [];
  cues.forEach((c, i) => {
    const dur = +(c.bodyOut - c.bodyIn).toFixed(3);
    const trim = `aresample=48000,aformat=channel_layouts=stereo,atrim=start=${c.trackIn}:duration=${dur},asetpts=PTS-STARTPTS`;
    const m = measure(["-i", trackFile(c.track)], trim);
    const g = c.lufs - Number(m.input_i);
    inputs.push("-i", trackFile(c.track));
    chains.push(
      `[${i}:a]${trim},volume=${g.toFixed(2)}dB,afade=t=in:st=0:d=${c.fadeIn},` +
        `afade=t=out:st=${Math.max(0, dur - c.fadeOut).toFixed(3)}:d=${c.fadeOut},adelay=${Math.round(c.bodyIn * 1000)}:all=1[c${i}]`,
    );
  });
  // A silent track from 0 to bodyDur is the first amix input, so the bed starts at 0 and is
  // exactly bodyDur long. (apad + atrim=duration after amix breaks when the first cue is
  // delayed: the bed came out 0.02 s long, or never ended.) latency=1 removes alimiter's
  // 5 ms lookahead delay, which would put every drop late.
  const fc = [
    `anullsrc=r=48000:cl=stereo,atrim=end=${bodyDur}[z]`,
    ...chains,
    `[z]${cues.map((_, i) => `[c${i}]`).join("")}amix=inputs=${cues.length + 1}:normalize=0:duration=first,` +
      `alimiter=limit=0.708:level=false:latency=1[bed]`,
  ].join(";");
  run(["-y", ...inputs, "-filter_complex", fc, "-map", "[bed]", "-t", String(bodyDur), "-ar", "48000", "-c:a", "pcm_s16le", bedPath]);
  const bedDur = probe(bedPath).duration;
  if (!(Math.abs(bedDur - bodyDur) <= 0.1))
    fail(`the music bed came out ${f2(bedDur)} s long instead of ${f2(bodyDur)} s. This is a bug in the skill's scripts, not in score.json: stop and tell the user this exact line.`);
}

// ---------- mix ----------
console.log("mixing under the speech (2-pass loudness, a few minutes for long videos)…");
const split = musicFrom;
const hasIntro = split >= 0.05;
const bodySeg = ["-ss", String(split), "-t", String(bodyDur), "-i", video];
const raw = measure(bodySeg);
const preGain = Math.max(0, Math.min(30, -20 - Number(raw.input_i)));
const speechChain =
  `aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,volume=${preGain.toFixed(2)}dB,` +
  `acompressor=threshold=-24dB:ratio=3:attack=5:release=200`;
const sm = measure(bodySeg, speechChain, "I=-14:TP=-1.5:LRA=11:");
const norm = (m, target) =>
  `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
  `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
mkdirSync(dirname(out), { recursive: true });
const fc = [
  ...(hasIntro
    ? [`[0:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${split},asetpts=PTS-STARTPTS,afade=t=out:st=${(split - 0.015).toFixed(3)}:d=0.015[intro]`]
    : []),
  `[0:a]atrim=start=${split},asetpts=PTS-STARTPTS,${speechChain},${norm(sm, -14)},` +
    `aresample=48000,atrim=duration=${bodyDur},afade=t=in:d=0.015,asplit=3[voice][key][vstem]`,
  `[1:a]aresample=48000,aformat=channel_layouts=stereo[mus]`,
  `[mus][key]sidechaincompress=threshold=0.06:ratio=4:attack=15:release=400:makeup=1,asplit=2[bed][bstem]`,
  `[voice][bed]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89:level=false:latency=1[body]`,
  hasIntro ? `[intro][body]concat=n=2:v=0:a=1[out]` : `[body]anull[out]`,
].join(";");
run([
  "-y", "-i", video, "-i", bedPath, "-filter_complex", fc,
  "-map", "0:v", "-map", "[out]", "-t", String(total), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out,
  "-map", "[vstem]", "-t", String(bodyDur), "-c:a", "pcm_s16le", join(work, "stem-voice.wav"),
  "-map", "[bstem]", "-t", String(bodyDur), "-c:a", "pcm_s16le", join(work, "stem-bed.wav"),
]);
console.log(`wrote ${sc.output}`);

// ---------- verify ----------
console.log("\nverifying…");
const report = [];
let failed = 0;
const check = (ok, label, detail, fix) => {
  report.push(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}${ok || !fix ? "" : `\n      fix: ${fix}`}`);
  if (!ok) failed++;
};
const oinfo = probe(out);
check(Math.abs(oinfo.duration - total) <= 0.1, "duration", `${f2(oinfo.duration)} s (source ${f2(total)} s)`);
const vi = vinfo.streams.find((s) => s.codec_type === "video");
const vo = oinfo.streams.find((s) => s.codec_type === "video");
check(vo && vo.codec_name === vi.codec_name && (!vi.nb_frames || vi.nb_frames === vo.nb_frames), "video untouched",
  `${vo?.codec_name} ${vo?.nb_frames ?? "?"} frames (source ${vi.codec_name} ${vi.nb_frames ?? "?"})`);
if (split >= 1) {
  const a = loudness(["-t", String(split - 0.1), "-i", video]).I;
  const b = loudness(["-t", String(split - 0.1), "-i", out]).I;
  check(Math.abs(a - b) <= 0.5, "audio before musicFrom untouched", `${a} vs ${b} LUFS`);
}
const bodyL = loudness(["-ss", String(split), "-i", out]);
check(Math.abs(bodyL.I + 14) <= 1, "loudness", `${bodyL.I} LUFS (target -14 ±1)`);
check(bodyL.tp <= -0.8, "true peak", `${bodyL.tp} dBTP (max -0.8)`);
const vI = loudness(["-i", join(work, "stem-voice.wav")]).I;
const bI = loudness(["-i", join(work, "stem-bed.wav")]).I;
const gap = +(vI - bI).toFixed(1);
check(gap >= 12 && gap <= 18, "music under the voice", `${gap} dB below the voice (want 12–18)`,
  gap < 12 ? `music too loud: add "gain": -3 to the loudest sections`
  : gap > 25 ? `far more than "gain" can fix (max 6), so the bed is broken. This is a bug in the skill's scripts, not in score.json: stop and tell the user this exact line`
  : `music too quiet: add "gain": 3 to the sections (max 6)`);

const env = envelope(bedPath);
const senv = smooth(env);
const hits = plan.filter((c) => c.hit).map((c) => c.hit.hitAt);
const last = plan[plan.length - 1];
const holes = runs(senv.length, (i) => senv[i] < -50, 1.5)
  .map((r) => ({ a: r.start + split, b: r.end + split }))
  .filter((r) => !hits.some((h) => r.a >= h - 10 && r.b <= h + 0.3))
  .filter((r) => !(last.role === "ending" && r.a >= total - (last.p.duration - last.p.tailStart) - 0.5)); // the ending's natural decay
check(holes.length === 0, "no silent holes in the music",
  holes.length ? holes.map((r) => `${f2(r.a)}–${f2(r.b)}`).join(", ") : "none",
  "a track goes silent there: move a section boundary or pick another track");
for (const h of hits) {
  const t = h - split;
  const rise = +(meanDb(env, t + 0.05, t + 0.9) - meanDb(env, t - 1.0, t - 0.15)).toFixed(1);
  check(rise >= 8, `hit at ${f2(h)}`, `music jumps +${rise} dB on the word`,
    "the drop is weak or misplaced: use the track's MAIN drop from library.txt, or another track with one");
}

// listen clips: every hit and every seam
const listen = join(work, "listen");
rmSync(listen, { recursive: true, force: true });
mkdirSync(listen, { recursive: true });
const marks = [
  ...hits.map((h) => ({ t: h, kind: "hit" })),
  ...plan.slice(1).map((c) => ({ t: c.from, kind: "seam" })),
].sort((a, b) => a.t - b.t);
marks.forEach((m, i) => {
  const ss = Math.max(0, m.t - 6);
  run(["-y", "-ss", String(ss), "-t", "10", "-i", out, "-vf", "scale=540:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    "-c:a", "aac", "-b:a", "128k", join(listen, `${String(i + 1).padStart(2, "0")}-${m.kind}-${f2(m.t)}.mp4`)]);
});

const text = report.join("\n") + `\n\n${failed ? `${failed} check(s) FAILED — see "If a check fails" in SKILL.md` : "ALL CHECKS PASSED"}\n` +
  `listen clips: ${marks.length} in ${listen}\n`;
writeFileSync(join(work, "report.txt"), text);
console.log(text);
process.exit(failed ? 1 : 0);
