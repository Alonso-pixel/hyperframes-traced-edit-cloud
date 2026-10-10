// One HyperFrames project generator for every state that previews or delivers:
//   state 4  states/4…/preview/<project>-edit/    cut + inserts (+ overlay)
//   state 5  states/5…/preview/<project>-sfx/     cut + sfx (+ overlay)
//   state 6  states/6…/preview/<project>-music/   cut + sfx + music (+ overlay)
//   state 7  deliverables/<project>/              the final project that gets rendered
// Files are written IN PLACE (never rm -rf), so a Studio server already showing the project
// hot-reloads instead of breaking. Next to the project, .pristine-<name>/ keeps a copy of every
// generated HTML file: comparing against it is how hand edits made in Studio are detected.
// Every project also carries state 4's inserts (timeline.json inserts[]): clips, images, icons and
// animations from videos/ASSETS laid over the cut, under the overlay. And its sound bites
// (timeline.json soundbites[]): one caption sub-composition each, compositions/soundbite-<id>.html
// from templates/soundbite.html, with the verified caption, the speaker and the session.
import { copyFileSync, existsSync, linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { ASSETS, ID, TEMPLATES, UserError, ensureDir, listFiles, projectMode, readJson, writeJson } from "./paths.mjs";
import { canonicalHtml, fingerprint, htmlFingerprint } from "./trace.mjs";

/** Hard link (or copy) unless the target already holds the same bytes; an open file is left alone. */
function linkOrCopy(from, to) {
  if (existsSync(to) && fingerprint(to) === fingerprint(from)) return "unchanged";
  try {
    if (existsSync(to)) rmSync(to);
  } catch (e) {
    throw new UserError(`cannot replace ${to} (${e.code}): a preview server may be holding it. Stop it with preview.mjs <project> --stop and run again.`);
  }
  try {
    linkSync(from, to);
    return "hard link";
  } catch {
    copyFileSync(from, to);
    return "copy";
  }
}

// Where an insert sits on the 1080x1920 frame. edit.json inserts[].css adds declarations to it.
export const BOXES = {
  full: "left: 0; top: 0; width: 1080px; height: 1920px;",
  top: "left: 60px; top: 200px; width: 960px; height: 640px; border-radius: 24px; overflow: hidden;",
  center: "left: 290px; top: 610px; width: 500px; height: 500px;",
  lower: "left: 0; top: 1380px; width: 1080px; height: 340px;",
  pip: "right: 60px; top: 220px; width: 360px; height: 640px; border-radius: 18px; overflow: hidden;",
};

/** An icon drawn in currentColor is inlined (so css "color" tints it); any other SVG is an <img>. */
const inlineSvg = (text) => (/currentColor/.test(text) ? text.replace(/<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, "").trim() : null);

/**
 * The inserts of timeline.json as HyperFrames elements: media hard-linked into assets/inserts/,
 * animations copied into compositions/insert-<id>.html. Returns { tags, css, tweens, outputs }.
 */
function insertParts(ctx, P, dir, tl) {
  const tags = [], css = [], tweens = [], keep = new Set(), keepComp = new Set();
  const lanes = []; // greedy: inserts that do not overlap share a Studio lane (2..)
  for (const ins of tl.inserts || []) {
    const from = join(ASSETS, ins.file);
    if (!existsSync(from)) throw new UserError(`insert ${ins.id}: videos/ASSETS/${ins.file} is gone. Put it back, or remove the insert from edit.json and rerun state 4.`);
    if (ctx.def.id !== ID.edit) ctx.input(from, `insert ${ins.id} (videos/ASSETS)`); // state 4 already declared it
    let lane = lanes.findIndex((end) => end <= ins.t + 0.001);
    if (lane < 0) lane = lanes.push(0) - 1;
    lanes[lane] = ins.t + ins.dur;
    const id = `ins-${ins.id}`;
    const at = `data-start="${ins.t}" data-duration="${ins.dur}" data-track-index="${2 + lane}"`;
    const note = `      <!-- insert ${ins.id}: videos/ASSETS/${ins.file}, ${ins.anchor} (edit.json) -->`;
    const fit = ins.kind === "icon" || ins.box === "center" ? "contain" : "cover";
    const svg = ins.kind === "icon" ? inlineSvg(readFileSync(from, "utf8")) : null;
    const tint = svg ? "color: #fdfdfd; filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.55)); " : "";
    css.push(`      #${id} { position: absolute; z-index: 2; ${BOXES[ins.box]} object-fit: ${fit}; ${tint}${ins.css || ""} }`);
    if (ins.kind === "animation") {
      const file = `insert-${ins.id}.html`;
      write(join(dir, "compositions", file), readFileSync(from, "utf8"));
      keepComp.add(file);
      tags.push(note, `      <div id="${id}" class="clip" data-composition-id="${ins.compId}" data-composition-src="compositions/${file}" ${at} data-width="${ins.width}" data-height="${ins.height}"></div>`);
    } else if (svg) {
      css.push(`      #${id} svg { width: 100%; height: 100%; }`);
      tags.push(note, `      <div id="${id}" class="clip" ${at}>${svg}</div>`);
    } else {
      const file = `${ins.id}${extname(ins.file).toLowerCase()}`;
      linkOrCopy(from, join(dir, "assets", "inserts", file));
      keep.add(file);
      tags.push(note, ins.kind === "clip"
        ? `      <video id="${id}" src="assets/inserts/${file}" ${at} data-media-start="${ins.from || 0}" muted playsinline></video>`
        : `      <img id="${id}" class="clip" src="assets/inserts/${file}" ${at} alt="" />`);
    }
    if (ins.fadeIn) tweens.push(`      tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${ins.fadeIn}, ease: "none" }, ${ins.t});`);
    if (ins.fadeOut) tweens.push(`      tl.to("#${id}", { opacity: 0, duration: ${ins.fadeOut}, ease: "none" }, ${+(ins.t + ins.dur - ins.fadeOut).toFixed(3)});`);
  }
  // Inserts removed from edit.json leave nothing behind.
  for (const f of listFiles(join(dir, "assets", "inserts"))) if (!keep.has(basename(f))) rmSync(f, { force: true });
  for (const f of listFiles(join(dir, "compositions"), /^insert-.*\.html$/)) if (!keepComp.has(basename(f))) rmSync(f, { force: true });
  return { tags, css, tweens };
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** "2024-05-13" -> "13 de mayo de 2024"; anything else is shown as it is. */
const fechaEs = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${+m[3]} de ${MONTHS[+m[2] - 1]} de ${m[1]}` : String(d || "");
};

/**
 * When each word of a verified caption lights up, local to the bite, in pages of up to two lines.
 * The words are the caption's; the times come from the fact-checker's words (cut seconds): one to
 * one when the counts match, otherwise spread over the speech by the length of each word.
 */
export function captionPages(s, { maxChars = 50 } = {}) {
  const words = String(s.caption).split(/\s+/).filter(Boolean);
  const heard = (s.words || []).map((w) => ({ start: w.start - s.t, end: w.end - s.t }));
  const a = heard.length ? Math.max(0, heard[0].start) : Math.min(0.15, s.dur / 4);
  const b = heard.length ? Math.min(s.dur, heard.at(-1).end) : Math.max(a, s.dur - 0.2);
  let times;
  if (heard.length === words.length) times = heard.map((w) => Math.max(0, w.start));
  else {
    const len = words.map((w) => w.length + 1), total = len.reduce((x, y) => x + y, 0);
    let acc = 0;
    times = len.map((l) => {
      const t = a + ((b - a) * acc) / total;
      acc += l;
      return t;
    });
  }
  // Pages: about two lines of ~25 characters; a sentence end closes a page that has 4+ words.
  const pages = [];
  let cur = [], chars = 0;
  words.forEach((w, i) => {
    if (cur.length && chars + w.length > maxChars) {
      pages.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push({ w, t: +times[i].toFixed(3) });
    chars += w.length + 1;
    if (/[.?!…]$/.test(w) && cur.length >= 4 && i < words.length - 1) {
      pages.push(cur);
      cur = [];
      chars = 0;
    }
  });
  if (cur.length) pages.push(cur);
  return pages.map((ws, k) => ({ start: k ? ws[0].t : 0, end: k < pages.length - 1 ? pages[k + 1][0].t : s.dur, words: ws }));
}

/** One caption sub-composition per sound bite. Returns { tags, css }. */
function soundbiteParts(ctx, P, dir, tl, accent) {
  const tags = [], css = [], keep = new Set();
  const bites = tl.soundbites || [];
  if (bites.length) {
    const tpl = join(TEMPLATES, "soundbite.html");
    ctx.input(tpl, "sound bite caption template");
    const src = readFileSync(tpl, "utf8");
    for (const s of bites) {
      const compId = `soundbite-${s.id}`, file = `${compId}.html`;
      const config = { dur: s.dur, speaker: s.speaker || "", role: s.role || "", session: [s.session, fechaEs(s.date)].filter(Boolean).join(" · "), accent, pages: captionPages(s) };
      // The caption is text: "<" escaped so it can never close the <script>; a function so "$" stays literal.
      const line = `var CFG = ${JSON.stringify(config).replace(/</g, "\\u003c")};`;
      const html = src.replaceAll("__ID__", compId).replaceAll("__DURATION__", String(s.dur)).replace("var CFG = __CONFIG__;", () => line);
      if (!html.includes(line)) throw new Error(`template ${tpl} has no "var CFG = __CONFIG__;" line to inject into`);
      write(join(dir, "compositions", file), html);
      keep.add(file);
      tags.push(`      <!-- sound bite ${s.id}: ${String(s.speaker || "?").replace(/--/g, "–")}, caption verified by ear (state 1 soundbites.json), cut ${s.t}+${s.dur}s -->`,
        `      <div id="sb-${s.id}" data-composition-id="${compId}" data-composition-src="compositions/${file}" data-start="${s.t}" data-duration="${s.dur}" data-track-index="8" data-width="1080" data-height="1920"></div>`);
      css.push(`      #sb-${s.id} { position: absolute; inset: 0; z-index: 4; }`);
    }
  }
  for (const f of listFiles(join(dir, "compositions"), /^soundbite-.*\.html$/)) if (!keep.has(basename(f))) rmSync(f, { force: true });
  return { tags, css };
}

const hexRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || "");
  if (!m) throw new UserError(`deliver.json overlay.vars.accent must be a hex colour like "#39e43a" (got ${JSON.stringify(h)})`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
};

// Skip the write when only Studio's re-serialization differs: no needless hot reload.
const write = (file, text) => {
  if (!existsSync(file) || canonicalHtml(readFileSync(file, "utf8")) !== canonicalHtml(text)) writeFileSync(file, text);
};

/**
 * Generate the project in `dir`. opts: { sfx?, music?, overlay?, volumes } (stem paths absolute).
 * Records ctx.extra.generated = { dir, files: { relPath: fingerprint } } for Studio-edit detection.
 */
export function buildProject(ctx, P, dir, { sfx = null, music = null, overlay = null, volumes = {} } = {}) {
  const T3 = P.st[ID.edit];
  const tl = readJson(join(T3.out, "timeline.json"));
  const cut = join(T3.out, "cut.mp4");
  if (!existsSync(cut)) throw new UserError("state 4 has no cut.mp4 (it was only run with --dry). Run state 4 without --dry.");
  const D = tl.duration;
  const name = basename(dir);
  const vol = { base: 1, sfx: 1, music: 1, voice: 1, ambience: 1, ...volumes };
  // Footage mode: the footage's own sound comes from ambience.wav (ducked under the voice), and the
  // voiceover from voice-mix.wav, both built by state 4.
  const vmix = join(T3.out, "voice-mix.wav"), amb = join(T3.out, "ambience.wav");
  const withVoice = projectMode(P) === "footage" && existsSync(vmix) && existsSync(amb);
  if (withVoice) {
    ctx.input(vmix, "voiceover on the cut (state 4)");
    ctx.input(amb, "footage sound ducked under the voice (state 4)");
  }
  ensureDir(join(dir, "assets", "fonts"));
  ensureDir(join(dir, "assets", "inserts"));
  ensureDir(join(dir, "compositions"));

  const linked = [`cut.mp4 (${linkOrCopy(cut, join(dir, "assets", "cut.mp4"))})`];
  for (const [file, stem] of [["sfx-mix.wav", sfx], ["music-mix.wav", music], ["voice-mix.wav", withVoice ? vmix : null], ["ambience.wav", withVoice ? amb : null]]) {
    const to = join(dir, "assets", file);
    if (stem) linked.push(`${file} (${linkOrCopy(stem, to)})`);
    else if (existsSync(to)) rmSync(to, { force: true });
  }
  ctx.log(`project ${name}: assets ${linked.join(", ")}`);
  for (const f of listFiles(join(TEMPLATES, "fonts"), /\.woff2$/)) {
    const to = join(dir, "assets", "fonts", basename(f));
    if (!existsSync(to)) copyFileSync(f, to);
  }

  let overlayTag = "";
  const overlayFile = join(dir, "compositions", "overlay.html");
  if (overlay) {
    const tpl = join(TEMPLATES, `${overlay.template}.html`);
    if (!existsSync(tpl)) throw new UserError(`overlay template "${overlay.template}" not found (looked for ${tpl})`);
    ctx.input(tpl, "overlay template");
    const v = overlay.vars || {};
    let fast = null;
    if (v.fastPiece) {
      const p = tl.pieces.find((x) => x.id === v.fastPiece);
      if (!p) throw new UserError(`deliver.json overlay.vars.fastPiece "${v.fastPiece}" is not a piece (${tl.pieces.map((x) => x.id).join(", ")})`);
      fast = { start: p.start, end: +(p.start + p.duration).toFixed(3), label: v.fastLabel ?? `×${p.speed}` };
    }
    if (tl.events.length > 99) throw new UserError(`the counter shows two digits; the timeline has ${tl.events.length} events`);
    const config = { duration: D, events: tl.events.map((e) => e.t), fast, label: v.label ?? "", accent: hexRgb(v.accent ?? "#39e43a") };
    const line = `var CFG = ${JSON.stringify(config)};`;
    let html = readFileSync(tpl, "utf8").replaceAll("__DURATION__", String(D)).replace("var CFG = __CONFIG__;", line);
    if (!html.includes(line)) throw new Error(`template ${tpl} has no "var CFG = __CONFIG__;" line to inject into`);
    html = html.replace("/* __EXTRA_CSS__ */", overlay.css ? `/* from deliver.json overlay.css */\n${overlay.css}` : "");
    write(overlayFile, html);
    ctx.output(overlayFile, `${overlay.template} with ${config.events.length} injected event times${overlay.css ? " + overlay.css" : ""}`);
    ctx.extra.injected = config;
    overlayTag = `      <!-- overlay: templates/${overlay.template}.html, event times injected from timeline.json -->\n      <div id="overlay" data-composition-id="${overlay.template}" data-composition-src="compositions/overlay.html" data-start="0" data-duration="${D}" data-track-index="1" data-width="1080" data-height="1920"></div>`;
  } else if (existsSync(overlayFile)) {
    rmSync(overlayFile, { force: true });
  }

  const ins = insertParts(ctx, P, dir, tl);
  if (ins.tags.length) ctx.log(`project ${name}: ${tl.inserts.length} insert(s) from videos/ASSETS`);
  // Sound bites ride with the inserts (above them, under the overlay); none = the same index.html as before.
  const sb = soundbiteParts(ctx, P, dir, tl, hexRgb("#F3C80F"));
  if (sb.tags.length) ctx.log(`project ${name}: ${tl.soundbites.length} sound bite caption(s)`);

  const audio = (id, file, track, v, from) =>
    `      <!-- assets/${file} = ${from} -->\n      <audio id="${id}" src="assets/${file}" data-start="0" data-duration="${D}" data-track-index="${track}" data-volume="${v}"></audio>`;
  const tplIndex = join(TEMPLATES, "index.html");
  ctx.input(tplIndex, "root template");
  const index = join(dir, "index.html");
  write(index, readFileSync(tplIndex, "utf8")
    .replaceAll("__TITLE__", name).replaceAll("__DURATION__", String(D)).replace("__BUILT_BY__", `state ${ctx.def.id} ${ctx.def.name}`)
    .replace("__BASE_AUDIO__", withVoice ? `      <!-- assets/ambience.wav = ${P.rel(amb)}: the footage's own sound, ducked under the voice -->\n      <audio id="base-audio" src="assets/ambience.wav" data-start="0" data-duration="${D}" data-track-index="10" data-volume="${vol.ambience}"></audio>`
      : `      <audio id="base-audio" src="assets/cut.mp4" data-start="0" data-duration="${D}" data-track-index="10" data-volume="${vol.base}"></audio>`)
    .replace("__VOICE__", withVoice ? audio("voice", "voice-mix.wav", 9, vol.voice, P.rel(vmix)) : "")
    .replace("__SFX__", sfx ? audio("sfx", "sfx-mix.wav", 11, vol.sfx, P.rel(sfx)) : "")
    .replace("__MUSIC__", music ? audio("music", "music-mix.wav", 12, vol.music, P.rel(music)) : "")
    // Functions, so nothing in an inlined SVG is read as a $-pattern.
    .replace("__INSERTS__", () => [...ins.tags, ...sb.tags].join("\n"))
    .replace("/* __INSERT_CSS__ */", () => [...ins.css, ...sb.css].join("\n"))
    .replace("__TIMELINE__", () => ins.tweens.join("\n"))
    .replace("__OVERLAY__", overlayTag));
  writeJson(join(dir, "package.json"), { name, private: true, type: "module" });
  writeJson(join(dir, "hyperframes.json"), { $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", assets: "assets" }, media: { autoProxy: true } });
  ctx.output(index, `HyperFrames project "${name}", ${D}s${withVoice ? " + voice" : ""}${sfx ? " + sfx" : ""}${music ? " + music" : ""}${tl.inserts?.length ? ` + ${tl.inserts.length} insert(s)` : ""}${tl.soundbites?.length ? ` + ${tl.soundbites.length} sound bite(s)` : ""}${overlay ? " + overlay" : ""}`);

  // Pristine copies + fingerprints of everything generated that Studio could edit.
  const pristine = join(dirname(dir), `.pristine-${name}`);
  ensureDir(join(pristine, "compositions"));
  const files = {};
  for (const f of [index, ...listFiles(join(dir, "compositions"), /\.html$/)]) {
    const rel = relative(dir, f).split("\\").join("/");
    copyFileSync(f, join(pristine, rel));
    files[rel] = htmlFingerprint(f);
  }
  for (const f of listFiles(join(pristine, "compositions"), /\.html$/)) if (!files[`compositions/${basename(f)}`]) rmSync(f, { force: true });
  ctx.extra.generated = { dir: P.rel(dir), pristine: P.rel(pristine), files };
  return { dir, name, duration: D, tl };
}
