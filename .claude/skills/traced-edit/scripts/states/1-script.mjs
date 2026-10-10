// State 1 · script (human review). The words the user will read off a teleprompter and record.
// You write, in the state folder: brief.json (mode, topic, context: from the user), script.txt
// (the script, in Spanish) and, in footage mode, beats.json (which stretch of the footage each
// paragraph speaks over). The user may drop images and video clips into context/.
//
// This state first digests everything you must look at before writing:
//   out/context.md               index of the brief, every context file and (footage mode) the
//                                footage: contact sheets, scene cuts, what is said in them
//   out/context/<file>/…         per clip: sheet-MM.jpg, transcript.json; per image: a preview
//   out/context/footage/…        footage mode: the footage itself, digested the same way
// then checks that script.txt is plain spoken text a teleprompter can show as-is:
//   out/teleprompter.txt         the script, plain UTF-8 text: paste it into the teleprompter
//   out/beats.md, out/beats/     footage mode: each paragraph next to the frames it speaks over
// The script never carries timings. In footage mode they live in beats.json (source seconds read
// off the contact sheets), and the recording sets the real ones (state 2 aligns it).
// brief.json "enrich" (a topic + a corpus) also asks the fact-checker's archive of council sessions
// for matching moments (lib/enrich.mjs): out/enrich/ENRICH.md, clips in videos/ASSETS/clips/cabildo/.
// soundbites.json (optional) picks moments of those clips to splice into the video with their own
// audio and a caption the user checked by ear. Its checks block the teleprompter copy like the others.
//   out/soundbites.md            the script with each sound bite where it plays, for the review
// mode "none" skips the state (footage with no voice): it passes as OK.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CHIRP_WARNING, SOURCE, captionOverlap, enrich, readSidecar, readSoundbites, sidecarFile, soundbitesFile } from "../lib/enrich.mjs";
import { digestVideo, previewImage, probe, quickProbe, sheet } from "../lib/media.mjs";
import { MODES, UserError, assetFile, ensureDir, fmtT, hasMedia, readJson, sourceVideo } from "../lib/paths.mjs";

export const DEFAULT_BRIEF = { mode: "planned", topic: "", context: "", audience: "", tone: "", sheetStep: 1 };

const WPM = 150; // a calm read-aloud pace: the length estimate and the beats' word budget
const IMAGE = /\.(jpe?g|png|webp)$/i;
const CLIP = /\.(mp4|mov|m4v|webm|mkv)$/i;

// Common Spanish and English function words: enough to tell the language of a paragraph.
const ES = new Set("de la que el en y a los se del las un por con no una su para es al lo como más mas pero sus le ya o este sí si porque esta entre cuando muy sin sobre también hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros os mío mía tuyo suyo nuestro nuestra son fue era ser han ha está están hace cada aquí así ahora".split(" "));
const EN = new Set("the and of to is in that it for you with on this are was be have not they but at what from by an or as his her we were which their has would will there can been".split(" "));

// Line-level problems: [check name, test(line) -> offending text or null].
const LINE_RULES = [
  ["no notes or directions in brackets", (l) => l.match(/[[\](){}<>]/)?.[0]],
  ["no timings", (l) => l.match(/\b\d{1,2}:\d{2}\b|\b\d+(?:[.,]\d+)?\s?(?:s|seg|segs|ms|min)\b\.?/i)?.[0]],
  ["no markdown or list markup", (l) => l.match(/^\s*(?:#{1,6}\s|[-*•+]\s|>\s?|\d+[.)]\s)|\*\*|__|`|~~|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/)?.[0]],
  // "NARRADOR:" (any label in capitals) or a role name; "Pero ojo: ..." is prose and passes.
  ["no speaker labels", (l) => (l.match(/^\s*\p{Lu}[\p{Lu}\s.]{1,24}:/u) || l.match(/^\s*(?:narrador|narradora|voz|voz en off|locutor|locutora|presentador|presentadora|host|v\.?o\.?)\s*:/i))?.[0]],
  ["no directions in capitals", (l) => l.match(/\b(?:PAUSA|CORTE|TOMA|PLANO|ESCENA|NOTA|SFX|MÚSICA|MUSICA|B-ROLL|BROLL|INTRO|OUTRO|CTA|GANCHO|HOOK)\b/u)?.[0]],
  ["no links or emojis", (l) => l.match(/https?:\/\/\S+|www\.\S+|\p{Extended_Pictographic}/u)?.[0]],
];

export const countWords = (s) => (s.toLowerCase().match(/[\p{L}\d]+/gu) || []).length;
export const paragraphsOf = (text) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** The transcript as timed sentences, for reading. */
function sentences(words) {
  const lines = [];
  let cur = [], st = null;
  for (const w of words) {
    if (st === null) st = w.start;
    cur.push(w.text);
    if (/[.?!]$/.test(w.text.trim()) || cur.join(" ").length > 110) {
      lines.push(`- ${fmtT(st)}  ${cur.join(" ")}`);
      cur = [];
      st = null;
    }
  }
  if (cur.length) lines.push(`- ${fmtT(st)}  ${cur.join(" ")}`);
  return lines;
}

function digestSection(P, title, d, note) {
  const L = [`## ${title}`, "", note, "", `${d.probe.duration}s${d.probe.hasVideo ? `, ${d.probe.width}x${d.probe.height}` : ""}${d.probe.hasAudio ? "" : ", no audio"}. Contact sheets (one tile every ${d.step} s, stamped with the time):`, ""];
  L.push(...d.sheets.map((s) => `- \`${P.rel(s)}\``), "");
  L.push(d.scenes.length ? `Scene cuts: ${d.scenes.map(fmtT).join(", ")}` : "Scene cuts: none (one continuous shot)", "");
  if (d.words?.length) L.push("What is said in it (whisper: content and timing only, never copied to screen; on music or street noise whisper can invent a line such as \"Gracias por ver el video\", so trust it only where the pictures show someone talking):", "", ...sentences(d.words), "");
  else if (d.probe.hasAudio) L.push("No speech heard in it.", "");
  return L;
}

export async function run(ctx) {
  const { P, S } = ctx;
  const raw0 = readJson(S.config);
  const brief = { ...DEFAULT_BRIEF, ...raw0 };
  if (!raw0.mode && raw0.narration === false) brief.mode = "none"; // briefs written before "mode" existed
  ctx.params = brief;
  ctx.input(S.config, "brief: mode, topic and context (from the user)");
  if (!MODES.includes(brief.mode)) throw new UserError(`brief.json "mode" is "${brief.mode}"; it must be one of: ${MODES.join(", ")}.`);
  const out = ensureDir(S.out);
  const tp = join(out, "teleprompter.txt");
  rmSync(tp, { force: true }); // only a script that passes every check gets a teleprompter copy

  if (brief.mode === "none") {
    ctx.note('mode "none" (footage with no voice): nothing to write or record. The state passes as OK.');
    ctx.extra.skipped = "skipped: no narration";
    return;
  }

  // ---------- context: everything to look at before writing ----------
  const cdir = ensureDir(join(S.dir, "context"));
  ctx.watchDir(cdir);
  const cout = join(out, "context");
  const md = ["# Context for the script", "", `Mode: **${brief.mode}**${brief.mode === "footage" ? " (the script follows the footage, beat by beat; the voiceover is recorded after it)" : " (the user records themselves on camera reading it)"}.`, ""];
  for (const k of ["topic", "context", "audience", "tone"]) if (String(brief[k]).trim()) md.push(`**${k}**: ${brief[k]}`, "");
  md.push("Open **every** picture listed below before writing.", "");
  const pictures = [];
  const files = readdirSync(cdir).filter((f) => !statSync(join(cdir, f)).isDirectory()).sort();
  for (const f of files) {
    const file = join(cdir, f);
    if (IMAGE.test(f)) {
      ctx.input(file, "context image");
      const prev = previewImage(ctx, file, join(ensureDir(cout), `${basename(f, extname(f))}.preview.jpg`));
      pictures.push(prev);
      ctx.image(prev, `context image ${f}`);
      md.push(`## Image: ${f}`, "", `- \`${P.rel(prev)}\``, "");
    } else if (CLIP.test(f)) {
      ctx.input(file, "context clip");
      const dur = quickProbe(file) || 60;
      const d = digestVideo(ctx, file, join(cout, basename(f, extname(f))), { step: dur <= 60 ? 1 : dur <= 300 ? 2 : 5 });
      pictures.push(...d.sheets);
      d.sheets.forEach((s, i) => ctx.image(s, `context clip ${f}, sheet ${i + 1}`));
      md.push(...digestSection(P, `Clip: ${f}`, d, "A reference clip from the user."));
    } else {
      ctx.warn(`context/${f} is not read (only images and video clips are). Put what matters from it in brief.json "context".`);
    }
  }
  let footage = null;
  if (brief.mode === "footage") {
    if (!hasMedia(P)) throw new UserError(`mode "footage" needs the footage first: init.mjs ${P.root} --media <video>`);
    const src = sourceVideo(P);
    ctx.input(src.file, "footage (the script follows it)");
    footage = digestVideo(ctx, src.file, join(cout, "footage"), { step: brief.sheetStep });
    pictures.push(...footage.sheets);
    footage.sheets.forEach((s, i) => ctx.image(s, `footage, minute ${i}`));
    md.push(...digestSection(P, `Footage: ${src.file.split(/[\\/]/).pop()}`, footage, "The footage the voiceover goes over. Its order sets the script's order: one paragraph per stretch, each stretch read off these sheets into beats.json."));
  }
  if (!String(brief.topic).trim() && !String(brief.context).trim() && !files.length && !footage)
    throw new UserError(`brief.json needs a "topic" or a "context" (what the script is about, in the user's words), or images/clips in ${P.rel(cdir)}/.`);
  // The council archive (brief.json "enrich"): candidate sound bites. It never fails the state.
  const enriched = enrich(ctx, brief);
  if (enriched) {
    md.push(...enriched.md);
    pictures.push(...enriched.pictures);
  }
  writeFileSync(join(out, "context.md"), md.join("\n") + "\n");
  ctx.output(join(out, "context.md"), `${files.length} context file(s)${footage ? " + the footage" : ""}${enriched ? ` + ${enriched.candidates.length} cabildo clip(s)` : ""}, ${pictures.length} picture(s) to open`);

  // ---------- the script ----------
  const file = join(S.dir, "script.txt");
  if (!existsSync(file))
    throw new UserError(`context digested. Read ${P.rel(join(out, "context.md"))} and open every picture in it, then write ${P.rel(file)}${footage ? ` and ${P.rel(join(S.dir, "beats.json"))}` : ""}: plain Spanish text, only the words to be read (references/script.md). Then run again.`);
  ctx.input(file, "script (written from the brief)");

  const raw = readFileSync(file, "utf8");
  const text = raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t   ]/g, " ")
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = text.split("\n");

  ctx.check("script is not empty", text.length > 0, text.length ? "" : "script.txt has no text");
  if (!text) return;

  for (const [name, test] of LINE_RULES) {
    const bad = [];
    lines.forEach((l, i) => {
      const hit = l && test(l);
      if (hit) bad.push(`line ${i + 1}: "${hit.trim()}"`);
    });
    ctx.check(name, !bad.length, bad.slice(0, 5).join("; ") + (bad.length > 5 ? `; … ${bad.length - 5} more` : ""));
  }

  const words = text.toLowerCase().match(/[\p{L}]+/gu) || [];
  const es = words.filter((w) => ES.has(w)).length;
  const en = words.filter((w) => EN.has(w)).length;
  ctx.check("written in Spanish", es >= Math.max(3, words.length * 0.15) && es > 2 * en, `${es} Spanish and ${en} English function words out of ${words.length}`);

  lines.forEach((l, i) => {
    const tag = l.match(/(?:^|\s)[#@][\p{L}\d_]+/u);
    if (tag) ctx.warn(`line ${i + 1}: "${tag[0].trim()}" will be read aloud exactly as written. Spell it the way it should be said, if that is not it.`);
    for (const sentence of l.split(/(?<=[.?!…])\s+/)) {
      const n = countWords(sentence);
      if (n > 40) ctx.warn(`line ${i + 1}: a ${n}-word sentence is hard to read in one breath ("${sentence.slice(0, 50)}…"). Split it.`);
    }
  });

  // ---------- footage mode: beats.json ----------
  const paras = paragraphsOf(text);
  let beats = null;
  if (footage) {
    const bf = join(S.dir, "beats.json");
    ctx.check("beats.json exists (footage mode)", existsSync(bf), existsSync(bf) ? "" : `write ${P.rel(bf)}: [{ "p": 1, "from": <s>, "to": <s> }, …], one per paragraph, times read off the footage sheets`);
    if (existsSync(bf)) {
      ctx.input(bf, "beats: the footage stretch under each paragraph");
      const j = readJson(bf);
      beats = Array.isArray(j) ? j : j.beats;
      if (!Array.isArray(beats)) throw new UserError(`${P.rel(bf)} must be a list: [{ "p": 1, "from": 0, "to": 7.5 }, …]`);
      // { "soundbite": "sb1", "afterBeat": 2 } entries say where a sound bite sits; they are not paragraphs.
      const sbBeats = beats.filter((b) => b && b.soundbite != null);
      beats = beats.filter((b) => !b || b.soundbite == null);
      const sbIds = new Set((readSoundbites(P) || []).map((b) => b?.id));
      for (const b of sbBeats) {
        if (!sbIds.has(b.soundbite)) ctx.warn(`beats.json: { "soundbite": ${JSON.stringify(b.soundbite)} } is not in soundbites.json`);
        if (!Number.isInteger(b.afterBeat) || b.afterBeat < 0 || b.afterBeat > paras.length) ctx.warn(`beats.json: sound bite ${b.soundbite} has "afterBeat": ${JSON.stringify(b.afterBeat)}; it must be a paragraph number (0 = before the first)`);
      }
      const D = footage.probe.duration;
      ctx.check("one beat per paragraph", beats.length === paras.length, `${beats.length} beat(s), ${paras.length} paragraph(s)`);
      const bad = [];
      beats.forEach((b, i) => {
        if (b.p !== i + 1) bad.push(`beat #${i + 1} has "p": ${b.p} (expected ${i + 1})`);
        if (!(b.to > b.from)) bad.push(`p${b.p}: "to" (${b.to}) must be greater than "from" (${b.from})`);
        if (b.from < 0 || b.to > D + 0.001) bad.push(`p${b.p}: ${b.from}–${b.to}s is outside the footage (0–${D}s)`);
        if (i && b.from < beats[i - 1].to - 0.001) bad.push(`p${b.p} starts at ${b.from}s, before p${beats[i - 1].p} ends (${beats[i - 1].to}s)`);
      });
      ctx.check("beats are in order and inside the footage", !bad.length, bad.slice(0, 5).join("; "));
      beats.forEach((b, i) => {
        if (!paras[i] || !(b.to > b.from)) return;
        const n = countWords(paras[i]), secs = b.to - b.from, budget = Math.floor((secs * WPM) / 60);
        b.words = n;
        b.budget = budget;
        if (n > budget) ctx.warn(`p${b.p}: ${n} words for ${secs.toFixed(1)} s of footage (~${Math.round((n / WPM) * 60)} s read; budget ${budget}). Shorten it, or give it a longer stretch.`);
      });
    }
  }

  const bites = checkSoundbites(ctx, paras, enriched);

  if (ctx.checks.some((c) => !c.pass)) return; // the failed checks fail the state; no teleprompter copy

  writeFileSync(tp, text + "\n");
  if (text + "\n" !== raw && text !== raw) ctx.note("whitespace normalized in the teleprompter copy (line endings, double spaces, blank lines, BOM)");
  ctx.output(tp, `${words.length} words, ${paras.length} paragraph(s): paste this into the teleprompter`);
  ctx.note(`about ${Math.round((words.length / WPM) * 60)} s read aloud at ${WPM} words/min (an estimate for the trace only; the script carries no timings)`);

  if (beats) {
    const bdir = join(out, "beats");
    rmSync(bdir, { recursive: true, force: true });
    ensureDir(bdir);
    const src = sourceVideo(P);
    const L = ["# Beats: what each paragraph speaks over", "", "| p | footage | words / budget | paragraph |", "|---|---|---|---|"];
    const pics = [];
    beats.forEach((b, i) => {
      const step = Math.max(0.5, +((b.to - b.from) / 8).toFixed(2));
      const img = sheet(ctx, src.file, b.from, b.to, step, join(bdir, `beat-${String(b.p).padStart(2, "0")}.jpg`), `beat p${b.p} frames`);
      ctx.image(img, `p${b.p}: footage ${fmtT(b.from)}–${fmtT(b.to)}`);
      L.push(`| ${b.p} | ${fmtT(b.from)}–${fmtT(b.to)} | ${b.words}/${b.budget}${b.words > b.budget ? " **over**" : ""} | ${paras[i].replace(/\|/g, "\\|")} |`);
      pics.push(`- p${b.p}: \`${P.rel(img)}\``);
    });
    writeFileSync(join(out, "beats.md"), [...L, "", ...pics, ""].join("\n"));
    ctx.output(join(out, "beats.md"), `${beats.length} beats with their frames, for the review`);
    ctx.extra.beats = beats.map(({ p, from, to, words: w, budget }) => ({ p, from, to, words: w, budget }));
  }
  if (bites) {
    // The script as it will play: each sound bite after its paragraph.
    const L = ["# The script with its sound bites", "",
      "The teleprompter copy has only the paragraphs. A sound bite is the council session's own audio, spliced into the cut after its paragraph while the narration pauses, with its verified caption on screen.", ""];
    for (let p = 0; p <= paras.length; p++) {
      if (p) L.push(`**p${p}.** ${paras[p - 1]}`, "");
      for (const b of bites.filter((x) => x.after === p))
        L.push(`> ▶ **${b.id}** · ${b.speaker || "?"}${b.role ? `, ${b.role}` : ""} · \`${b.clip}\` ${b.from}–${b.to} s (${(b.to - b.from).toFixed(1)} s)`, `> «${b.caption}»`, "");
    }
    writeFileSync(join(out, "soundbites.md"), L.join("\n"));
    ctx.output(join(out, "soundbites.md"), `${bites.length} sound bite(s) placed in the script, for the review`);
  } else rmSync(join(out, "soundbites.md"), { force: true });
  ctx.extra.summary = { mode: brief.mode, words: words.length, paragraphs: paras.length, context: files.length, soundbites: bites?.length ?? 0 };
}

/**
 * soundbites.json: moments of the cabildo archive to splice into the video. Each broken rule is a
 * check (so it blocks the teleprompter copy); matters of taste are warnings. Returns the list or null.
 */
function checkSoundbites(ctx, paras, enriched) {
  const { P } = ctx;
  const file = soundbitesFile(P);
  if (!existsSync(file)) return null;
  ctx.input(file, "sound bites: archive moments spliced into the video (captions checked by ear)");
  const bites = readSoundbites(P);
  const candidates = new Set((enriched?.candidates || []).map((c) => c.clip));
  const bad = { id: [], clip: [], after: [], range: [], caption: [], verified: [] };
  const seen = new Set();
  const out = [];
  for (const [i, b] of bites.entries()) {
    if (!b || typeof b !== "object") {
      bad.id.push(`#${i + 1} is not an object`);
      continue;
    }
    const who = `${b.id ?? `#${i + 1}`}`;
    if (!/^[A-Za-z][\w-]*$/.test(b.id || "")) bad.id.push(`#${i + 1}: "id" ${JSON.stringify(b.id)} must be a short name like "sb1"`);
    else if (seen.has(b.id)) bad.id.push(`"${b.id}" is used twice`);
    seen.add(b.id);
    let a = null, side = null, dur = null;
    try {
      a = assetFile(b.clip, "", `sound bite ${who}`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      bad.clip.push(e.message);
    }
    if (a) {
      side = readSidecar(a.file);
      if (side) ctx.input(sidecarFile(a.file), `sound bite ${who}: its fact-checker sidecar`);
      if (!candidates.has(a.rel) && side?.source !== SOURCE)
        bad.clip.push(`${who}: videos/ASSETS/${a.rel} is not a cabildo clip (not among this run's candidates, and no fact-checker sidecar next to it)`);
      const info = probe(ctx, a.file);
      dur = info.duration;
      if (!info.hasAudio) bad.clip.push(`${who}: videos/ASSETS/${a.rel} has no audio`);
    }
    if (!Number.isInteger(b.after) || b.after < 0 || b.after > paras.length)
      bad.after.push(`${who}: "after" is ${JSON.stringify(b.after)}; it must be 0..${paras.length} (0 = before p1, ${paras.length} = after the last paragraph)`);
    const nums = typeof b.from === "number" && typeof b.to === "number";
    if (!nums || !(b.from >= 0) || !(b.to > b.from) || (dur != null && b.to > dur + 0.001))
      bad.range.push(`${who}: from ${JSON.stringify(b.from)}, to ${JSON.stringify(b.to)}: they must be seconds of the clip with 0 <= from < to <= ${dur ?? "its length"}`);
    if (!String(b.caption || "").trim()) bad.caption.push(`${who}: "caption" is empty: the exact words said between from and to`);
    if (b.verified !== true) bad.verified.push(`${who} (verified: ${JSON.stringify(b.verified)})`);
    if (nums && b.to - b.from > 20) ctx.warn(`sound bite ${who} is ${(b.to - b.from).toFixed(1)} s long; over 20 s the video stalls. Trim "from"/"to" to the sentence that matters.`);
    if (side && nums && String(b.caption || "").trim()) {
      const o = captionOverlap(b.caption, side.words, b.from, b.to);
      if (!o.heard) ctx.warn(`sound bite ${who}: Chirp heard no words in ${b.from}–${b.to} s of the clip. Is that the right stretch?`);
      else if (o.share < 0.6) ctx.warn(`sound bite ${who}: only ${Math.round(o.share * 100)}% of the caption's words were heard by Chirp in ${b.from}–${b.to} s. Check the stretch and the caption with the user (they listen; you cannot).`);
    }
    out.push({ id: b.id, clip: a?.rel ?? b.clip, from: b.from, to: b.to, after: b.after, caption: String(b.caption || "").trim(), speaker: b.speaker || "", role: b.role || "", verified: b.verified === true, session: side?.session ?? null, date: side?.date ?? null });
  }
  if (bites.length > 3) ctx.warn(`${bites.length} sound bites: more than 3 turns the video into the session. Keep the strongest.`);
  ctx.check("sound bites: ids are unique short names", !bad.id.length, bad.id.join("; "));
  ctx.check("sound bites: every clip is a cabildo clip in videos/ASSETS", !bad.clip.length, bad.clip.join("; "));
  ctx.check(`sound bites: "after" is a paragraph number (0..${paras.length})`, !bad.after.length, bad.after.join("; "));
  ctx.check("sound bites: 0 <= from < to <= the clip's length", !bad.range.length, bad.range.join("; "));
  ctx.check("sound bites: every one has a caption", !bad.caption.length, bad.caption.join("; "));
  ctx.check("sound bites: every caption was checked by ear by the user (verified: true)", !bad.verified.length,
    bad.verified.length ? `${bad.verified.join(", ")}. The user listens to the clip from "from" to "to" and confirms the caption, speaker and role word for word; only then "verified": true. The Chirp text is a draft (${CHIRP_WARNING}).` : "");
  ctx.extra.soundbites = out;
  return out;
}
