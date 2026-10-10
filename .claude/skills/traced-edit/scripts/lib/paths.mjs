// Where everything lives: the skill, the workspace, and the layout of one project.
// The state folder names are the ones in the user's sketch (skill_structure/), parentheses included.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL = resolve(SCRIPTS, "..");
export const TEMPLATES = join(SKILL, "templates");
export const WORKSPACE = resolve(SKILL, "../../.."); // hyperframes-videos/
export const TRANSCRIBE = join(WORKSPACE, "tools", "transcribe.mjs");
export const DEFAULT_HF = "0.8.105";
// The shared media library. States 4 (inserts) and 5 (sounds) compose ONLY from here.
export const ASSETS = join(WORKSPACE, "videos", "ASSETS");

// One entry per state, in pipeline order. `config` is the one file a human (or the agent) edits.
// `deps` are upstream states whose staleness propagates; `gate` must be approved before running.
// `media`: the state reads the footage in raw-media/ (BLOCKED until init.mjs --media added it).
export const STATES = [
  { id: "1", key: "script", name: "script", dir: "states/1script(human-review)", config: "brief.json", deps: [], human: true, media: false },
  { id: "2", key: "audio", name: "audio-analysis", dir: "states/2audio-analysis", config: "params.json", deps: ["1"], gate: "1", human: false, media: true },
  { id: "3", key: "video", name: "video-analysis", dir: "states/3video-analysis", config: "params.json", deps: [], human: false, media: true },
  { id: "4", key: "edit", name: "video-edition", dir: "states/4video-edition(human-review)", config: "edit.json", deps: [], human: true, media: true },
  { id: "5", key: "sfx", name: "sound-effects", dir: "states/5sound-effects(human-review)", config: "sfx.json", deps: ["4"], gate: "4", human: true, media: true },
  { id: "6", key: "music", name: "music", dir: "states/6music(human-review)", config: "music.json", deps: ["4", "5"], gate: "5", human: true, media: true },
  { id: "7", key: "deliver", name: "deliver", dir: "deliverables", config: "deliver.json", deps: ["4", "5", "6"], gate: "6", human: true, media: true },
];

/** State ids by key (ID.edit === "4"). Code refers to states through this, never by number. */
export const ID = Object.fromEntries(STATES.map((s) => [s.key, s.id]));

// States that build a HyperFrames project and open it in Studio for the user's feedback.
export const PREVIEW_STATES = [ID.edit, ID.sfx, ID.music, ID.deliver];

const ALIASES = { ...ID, deliverables: ID.deliver };

export const projectName = (P) => P.root.split(/[\\/]/).pop();

/** The generated HyperFrames project of a preview state. Distinct names make Studio URLs readable. */
export function previewDir(P, id) {
  const name = projectName(P);
  if (id === ID.edit) return join(P.st[ID.edit].dir, "preview", `${name}-edit`);
  if (id === ID.sfx) return join(P.st[ID.sfx].dir, "preview", `${name}-sfx`);
  if (id === ID.music) return join(P.st[ID.music].dir, "preview", `${name}-music`);
  if (id === ID.deliver) return join(P.st[ID.deliver].dir, name);
  return null;
}

/** Project-wide HyperFrames settings live in deliver.json; previews read them without depending on it. */
export function hfSettings(P) {
  const d = readJsonIf(P.st[ID.deliver].config) || {};
  return {
    hf: d.hyperframes || DEFAULT_HF,
    port: d.previewPort || 3017,
    // The phone review server (scripts/review.mjs), on every interface of the PC.
    reviewPort: d.reviewPort || 3019,
    overlay: d.overlay || null,
    volumes: { base: 1, sfx: 1, music: 1, voice: 1, ambience: 1, ...(d.volumes || {}) },
  };
}

/** Where a local port is reachable from outside when this runs remotely, or null on the PC.
 *  TRACED_EDIT_PUBLIC_URL is a template ("https://box-{port}.example.com"); inside a GitHub
 *  Codespace the forwarded-port URL is used. */
export function publicUrl(port) {
  const t = process.env.TRACED_EDIT_PUBLIC_URL;
  if (t) return t.replace("{port}", port).replace(/\/$/, "");
  const cs = process.env.CODESPACE_NAME, dom = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  return cs && dom ? `https://${cs}-${port}.${dom}` : null;
}

export function stateDef(idOrKey) {
  const id = ALIASES[idOrKey] || String(idOrKey);
  return STATES.find((s) => s.id === id) || null;
}

export function project(rootArg) {
  const root = resolve(rootArg);
  const st = {};
  for (const s of STATES) {
    const dir = join(root, s.dir);
    st[s.id] = { def: s, dir, out: join(dir, "out"), config: join(dir, s.config), state: join(dir, "state.json") };
  }
  return {
    root,
    raw: join(root, "raw-media"),
    manifest: join(root, "raw-media", "manifest.json"),
    // The voiceover (footage mode). Unlike the footage it can be replaced by a new take.
    voiceManifest: join(root, "raw-media", "voice.json"),
    // Written by init.mjs: a project exists before its footage does (the script comes first).
    marker: join(root, "traced-edit.json"),
    trace: join(root, "trace.html"),
    st,
    // Inside the project: a relative path. Outside (sound library, templates): absolute, so it resolves anywhere.
    rel: (p) => {
      const r = relative(root, p);
      return (r.startsWith("..") || isAbsolute(r) ? resolve(p) : r).split("\\").join("/");
    },
    abs: (p) => (isAbsolute(p) ? p : join(root, p)),
  };
}

export const isProject = (P) => existsSync(P.marker) || existsSync(P.manifest);
export const hasMedia = (P) => existsSync(P.manifest);
export const hasVoice = (P) => existsSync(P.voiceManifest);

// How the project was made (brief.json "mode"), which decides what each state needs:
//   planned  script first, then the user records themselves on camera: the footage is the voice
//   footage  the footage came first; the script follows it and the voiceover is recorded after
//   none     footage with no voice (pintas): the script state is skipped
export const MODES = ["planned", "footage", "none"];
export function projectMode(P) {
  const b = readJsonIf(P.st[ID.script].config) || {};
  if (MODES.includes(b.mode)) return b.mode;
  return b.narration === false ? "none" : "planned"; // briefs written before "mode" existed
}

/**
 * What a state still needs from raw-media/ before it can run, as a reason (null = nothing).
 * The reason's first words are what nextCommand keys on ("no footage" / "no voiceover").
 */
export function missingMedia(P, def) {
  if (!def.media) return null;
  if (!hasMedia(P)) return "no footage yet: record it, then add it with init.mjs --media";
  if (def.key === "audio" && projectMode(P) === "footage" && !hasVoice(P)) return "no voiceover yet: record the approved script, then add it with init.mjs --voice";
  return null;
}

/** The source video in raw-media/, from the manifest that init.mjs wrote. */
export function sourceVideo(P) {
  if (!existsSync(P.manifest)) throw new UserError(`no footage yet in ${P.root}/raw-media. Add the recording: init.mjs ${P.root} --media <video>`);
  const m = readJson(P.manifest);
  return { ...m, name: m.file, file: join(P.raw, m.file) };
}

/** The voiceover in raw-media/ (footage mode), from raw-media/voice.json. */
export function sourceVoice(P) {
  if (!hasVoice(P)) throw new UserError(`no voiceover yet in ${P.root}/raw-media. Record the approved script, then: init.mjs ${P.root} --voice <audio>`);
  const m = readJson(P.voiceManifest);
  return { ...m, name: m.file, file: join(P.raw, m.file) };
}

/**
 * A file of the shared library: `rel` is relative to videos/ASSETS/<sub> ("" = ASSETS itself);
 * "sound-effects/x.mp3" with sub "sound-effects" is accepted too. Anything that resolves outside
 * `sub`, or does not exist, is a UserError. Returns { file (absolute), rel (ASSETS-relative) }.
 */
export function assetFile(rel, sub, who) {
  const base = join(ASSETS, sub);
  const where = `videos/ASSETS/${sub ? `${sub}/` : ""}`;
  if (typeof rel !== "string" || !rel) throw new UserError(`${who}: needs a file path relative to ${where}`);
  const doubled = sub && rel.split(/[\\/]/)[0] === sub && !existsSync(join(base, rel));
  const file = resolve(doubled ? ASSETS : base, rel);
  const inside = relative(base, file);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw new UserError(`${who}: ${rel} is outside ${where}. States 4 and 5 compose only from the shared library: copy the file into ${where} and refer to it from there.`);
  const shown = relative(ASSETS, file).split("\\").join("/");
  if (!existsSync(file)) throw new UserError(`${who}: file not found: videos/ASSETS/${shown}. Look in ${where} for the exact name.`);
  return { file, rel: shown };
}

/** An error the user can fix by editing a config file. No stack trace in the trace. */
export class UserError extends Error {}

export function readJson(p) {
  if (!existsSync(p)) throw new UserError(`missing file: ${p}`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new UserError(`${p} is not valid JSON: ${e.message}. Fix the syntax (commas, quotes, brackets) and run again.`);
  }
}

export function readJsonIf(p) {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
}

export function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function listFiles(dir, re = /./) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : [];
}

/** For display: workspace files as {workspace}/..., everything else unchanged. */
export function shortPath(p) {
  const ws = WORKSPACE.split("\\").join("/");
  return p.startsWith(ws + "/") ? "{workspace}/" + p.slice(ws.length + 1) : p;
}

export function fmtT(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
}
