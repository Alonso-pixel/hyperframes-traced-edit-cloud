#!/usr/bin/env node
// Scaffold a traced-edit project (the layout of the user's skill_structure/), and add its media.
//
//   node init.mjs <projectDir>                    planned: no footage yet. The script comes first,
//                                                 then the user records themselves on camera
//   node init.mjs <projectDir> --media <video>    on a NEW project: footage-first. The script follows
//                                                 the footage; the voiceover is recorded after it.
//                                                 On an existing project: add the recorded footage
//   node init.mjs <projectDir> --voice <audio>    footage mode: add the recorded voiceover (a new
//                                                 take replaces the old one, which is kept)
//   node init.mjs <video> <projectDir>            footage with no voice (mode "none", pintas)
//
// --mode planned|footage|none   override the mode (also on an existing project)
// --link  hard-link the media into raw-media/ instead of copying it (same drive only; falls back
//         to a copy). The footage in raw-media/ is never written to again.
// Config files that already exist are never overwritten.
import { copyFileSync, existsSync, linkSync, renameSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_BRIEF } from "./states/1-script.mjs";
import { DEFAULT_PARAMS as AUDIO } from "./states/2-audio-analysis.mjs";
import { DEFAULT_PARAMS as VIDEO } from "./states/3-video-analysis.mjs";
import { DEFAULT_MUSIC } from "./states/6-music.mjs";
import { DEFAULT_DELIVER } from "./states/7-deliver.mjs";
import { ID, MODES, STATES, ensureDir, hasMedia, hasVoice, isProject, project, projectMode, readJsonIf, writeJson } from "./lib/paths.mjs";
import { fingerprint } from "./lib/trace.mjs";
import { writeTraceHtml } from "./lib/trace-html.mjs";
import { printStatus } from "./status.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] ?? "" : null);
const VALUED = ["--media", "--voice", "--mode"];
const pos = args.filter((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));
let videoArg = opt("--media");
const voiceArg = opt("--voice");
const modeArg = opt("--mode");
let dirArg = pos[0];
const legacy = pos.length === 2 && videoArg === null;
if (legacy) [videoArg, dirArg] = pos;
const die = (m, code = 1) => {
  console.error(m);
  process.exit(code);
};
if (!dirArg || pos.length > 2 || videoArg === "" || voiceArg === "" || modeArg === "")
  die("usage: node init.mjs <projectDir> [--media <video>] [--voice <audio>] [--mode planned|footage|none] [--link]   |   node init.mjs <video> <projectDir>", 2);
if (modeArg && !MODES.includes(modeArg)) die(`ERROR: --mode must be one of: ${MODES.join(", ")}`, 2);
const P = project(dirArg);
const existed = isProject(P);
if (!videoArg && !voiceArg && !modeArg && existed) die(`ERROR: ${P.root} is already a traced-edit project. Add media with --media / --voice, or use run.mjs / status.mjs on it.`);
if (videoArg && hasMedia(P)) die(`ERROR: ${P.root} already has its footage (raw-media/manifest.json). The footage is written once and never again.`);
if (voiceArg && !existed && !videoArg) die(`ERROR: ${P.root} is not a project yet. Create it first (init.mjs <dir> --media <footage>).`);

/** ffprobe a media file: what the manifests record. */
function probeFile(file) {
  const pr = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate", "-of", "json", file], { encoding: "utf8" });
  if (pr.status !== 0) die(`ERROR: ffprobe cannot read ${file}:\n${pr.stderr}`);
  const j = JSON.parse(pr.stdout);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  const [n, d] = String(v?.r_frame_rate || "0/1").split("/").map(Number);
  return {
    duration: +(+j.format.duration).toFixed(3), hasVideo: !!v, width: v?.width, height: v?.height, fps: d ? +(n / d).toFixed(3) : null, vcodec: v?.codec_name,
    hasAudio: !!a, acodec: a?.codec_name, sampleRate: a ? +a.sample_rate : null,
  };
}

/** Copy (or hard-link) a file into raw-media/. */
function bring(src, dest) {
  ensureDir(P.raw);
  if (args.includes("--link")) {
    try {
      linkSync(src, dest);
      return "hard link";
    } catch {}
  }
  copyFileSync(src, dest);
  return "copy";
}

const writeIfMissing = (file, value) => existsSync(file) || writeJson(file, value);

// ---- the project: folders, marker, the mode and every config that does not depend on the media ----
// A new project's mode follows how it was started: no footage = planned, footage = footage-first,
// the old "<video> <dir>" form = footage with no voice.
const mode = modeArg || (existed ? projectMode(P) : legacy ? "none" : videoArg ? "footage" : "planned");
for (const s of STATES) ensureDir(P.st[s.id].dir);
ensureDir(join(P.st[ID.script].dir, "context"));
writeIfMissing(P.marker, { createdAt: new Date().toISOString(), by: "traced-edit init.mjs" });
const brief = readJsonIf(P.st[ID.script].config);
if (!brief) writeJson(P.st[ID.script].config, { ...DEFAULT_BRIEF, mode });
else if (modeArg && brief.mode !== modeArg) {
  const { narration, ...rest } = brief;
  writeJson(P.st[ID.script].config, { ...rest, mode: modeArg });
  console.log(`brief.json mode: ${brief.mode ?? (narration === false ? "none" : "planned")} -> ${modeArg}`);
}
writeIfMissing(P.st[ID.audio].config, AUDIO);
writeIfMissing(P.st[ID.video].config, VIDEO);
writeIfMissing(P.st[ID.sfx].config, { library: "videos/ASSETS/sound-effects", sounds: {}, rules: [] });
writeIfMissing(P.st[ID.music].config, DEFAULT_MUSIC);
writeIfMissing(P.st[ID.deliver].config, { ...DEFAULT_DELIVER, output: `${basename(P.root)}.mp4` });

// ---- the footage ----
if (videoArg) {
  const video = resolve(videoArg);
  if (!existsSync(video)) die(`ERROR: video not found: ${video}`);
  const probe = probeFile(video);
  if (!probe.hasVideo) die("ERROR: the file has no video stream");
  const file = basename(video);
  const dest = resolve(P.raw, file);
  const how = bring(video, dest);
  writeJson(P.manifest, { file, source: video, how, at: new Date().toISOString(), fingerprint: fingerprint(dest), probe });

  // The edit scaffold needs the footage's length; a hand-written edit.json is left alone.
  const edit = readJsonIf(P.st[ID.edit].config);
  if (!edit || edit._scaffold)
    writeJson(P.st[ID.edit].config, {
      _scaffold: true,
      fps: 30,
      freezeEnd: 0,
      pieces: [{ id: "A", from: 0, to: probe.duration, speed: 1, audio: true }],
      events: [],
    });
  console.log(`raw-media/${file} (${how}): ${probe.width}x${probe.height} ${probe.vcodec} ${probe.fps} fps, ${probe.duration}s${probe.hasAudio ? `, audio ${probe.acodec}` : ", NO audio"}`);
}

// ---- the voiceover (footage mode) ----
if (voiceArg) {
  const voice = resolve(voiceArg);
  if (!existsSync(voice)) die(`ERROR: voiceover not found: ${voice}`);
  const probe = probeFile(voice);
  if (!probe.hasAudio) die("ERROR: the voiceover file has no audio stream");
  if (mode !== "footage") console.warn(`WARNING: the project is in mode "${mode}"; a separate voiceover is only used in mode "footage" (--mode footage).`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const prev = hasVoice(P) ? readJsonIf(P.voiceManifest) : null;
  const replaced = [...(prev?.replaced || [])];
  if (prev) {
    // A new take: keep the old one next to it, and the history in voice.json.
    const kept = join(ensureDir(join(P.raw, "voice-takes")), `${stamp}-${prev.file}`);
    renameSync(join(P.raw, prev.file), kept);
    replaced.push({ file: P.rel(kept), source: prev.source, fingerprint: prev.fingerprint, at: prev.at, replacedAt: new Date().toISOString() });
  }
  const file = `voice${extname(voice).toLowerCase()}`;
  const dest = join(P.raw, file);
  const how = bring(voice, dest);
  writeJson(P.voiceManifest, { file, source: voice, how, at: new Date().toISOString(), fingerprint: fingerprint(dest), probe, replaced });
  console.log(`raw-media/${file} (${how}): ${probe.duration}s, ${probe.acodec}${prev ? ` (replaces the previous take, kept in raw-media/voice-takes/)` : ""}`);
}

if (!existed) {
  const next = {
    planned: "Start with state 1: fill brief.json (and context/ with images or clips), then write the script.",
    footage: "Start with state 1: run it once to digest the footage, then write the script and beats.json.",
    none: "No voice: state 1 is skipped (run it once), then audio/video analysis.",
  }[mode];
  console.log(`project created, mode "${mode}". ${next}`);
}
writeTraceHtml(P);
printStatus(P);
