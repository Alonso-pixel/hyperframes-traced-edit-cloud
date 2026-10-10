// State 1's archive lookup: the fact-checker's corpus of Facebook-Live council sessions ("cabildo").
// brief.json "enrich" asks it for the moments that match the topic; the fact-checker cuts each hit
// into a clip, which lands in videos/ASSETS/clips/cabildo/<passage>.mp4 next to a <passage>.json
// sidecar (who speaks, which session, the Chirp words). You pick SOUND BITES from them into
// soundbites.json: their original audio is spliced into the cut (state 2 seeds the pieces, state 4
// places them and captions them with the verified words) while the narration pauses.
//   out/enrich/ENRICH.md         every candidate, for reading: who, session, date, agenda item, words
//   out/enrich/candidates.json   the same for the scripts, and the cache key (a rerun reuses it)
//   out/enrich/<pid>/sheet.jpg   one tile per second of each clip
// Every fc call is traced. A fact-checker that is missing or fails is a warning: state 1 goes on.
// fc is called by its venv path or through uv, never as bare "fc" (on Windows that is fc.exe, the
// file comparer).
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probe, sheet } from "./media.mjs";
import { ASSETS, ID, UserError, WORKSPACE, ensureDir, readJsonIf, writeJson } from "./paths.mjs";
import { fingerprint } from "./trace.mjs";

export const DEFAULT_ENRICH = { corpus: "cabildo", k: 10, queries: [], maxClips: 6, factChecker: resolve(WORKSPACE, "..", "fact-checker"), refresh: false };
export const CABILDO_REL = "clips/cabildo"; // relative to videos/ASSETS: written by the skill, not by hand
export const CABILDO = join(ASSETS, "clips", "cabildo");
export const SOURCE = "fact-checker cabildo";
export const CHIRP_WARNING = "texto de Chirp: verificar de oído, nunca copiar a pantalla sin verificar";

// Python on Windows prints in the console code page unless told otherwise; the JSON carries accents.
const PY_ENV = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

/** brief.json "enrich" with its defaults, or null when the state should not query the archive. */
export function enrichConfig(brief) {
  if (!brief.enrich || typeof brief.enrich !== "object") return null;
  const cfg = { ...DEFAULT_ENRICH, ...brief.enrich };
  if (process.env.FACTCHECKER_DIR) cfg.factChecker = process.env.FACTCHECKER_DIR;
  const qs = Array.isArray(cfg.queries) ? cfg.queries.map((q) => String(q).trim()).filter(Boolean) : [];
  cfg.queries = qs.length ? qs : String(brief.topic || "").trim() ? [String(brief.topic).trim()] : [];
  if (!cfg.corpus || !cfg.queries.length) return null;
  if (!(cfg.k >= 1)) throw new UserError(`brief.json enrich.k must be a positive number (got ${JSON.stringify(brief.enrich.k)})`);
  if (!(cfg.maxClips >= 1)) throw new UserError(`brief.json enrich.maxClips must be a positive number (got ${JSON.stringify(brief.enrich.maxClips)})`);
  return cfg;
}

/** How fc is started: brief.enrich.command (tests), the venv's fc.exe, or uv run. Never bare "fc". */
export function fcCommand(cfg) {
  if (Array.isArray(cfg.command) && cfg.command.length) {
    const [bin, ...pre] = cfg.command.map(String);
    return { bin: bin === "node" ? process.execPath : bin, pre, how: "brief.json enrich.command" };
  }
  for (const exe of [join(cfg.factChecker, ".venv", "Scripts", "fc.exe"), join(cfg.factChecker, ".venv", "bin", "fc")])
    if (existsSync(exe)) return { bin: exe, pre: [], how: "the fact-checker's venv" };
  return { bin: "uv", pre: ["run", "--project", cfg.factChecker, "fc"], how: "uv run (no venv found)" };
}

/** A passage id as a file name. */
export const safeId = (pid) => String(pid).replace(/[^\w.-]+/g, "_");

/** state 1's soundbites.json (it may not exist). */
export const soundbitesFile = (P) => join(P.st[ID.script].dir, "soundbites.json");

/** The sound bites as a list, or null when there is no soundbites.json. */
export function readSoundbites(P) {
  const f = soundbitesFile(P);
  if (!existsSync(f)) return null;
  let j;
  try {
    j = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    throw new UserError(`${P.rel(f)} is not valid JSON: ${e.message}. Fix the syntax and run again.`);
  }
  const list = Array.isArray(j) ? j : j?.soundbites;
  if (!Array.isArray(list)) throw new UserError(`${P.rel(f)} must be a list: [{ "id": "sb1", "clip": "clips/cabildo/<pid>.mp4", "from": 3.2, "to": 14.8, "after": 2, "caption": "…", "speaker": "…", "role": "", "verified": false }]`);
  return list;
}

/** The fact-checker sidecar next to a clip (<clip>.json), or null. */
export const sidecarFile = (clipAbs) => clipAbs.replace(/\.[^./\\]+$/, ".json");
export const readSidecar = (clipAbs) => readJsonIf(sidecarFile(clipAbs));

/** Lower-case words without accents or punctuation, for comparing a caption with what Chirp heard. */
export const tokens = (s) => (String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\d]+/gu) || []);

/** Share of the caption's words that Chirp heard in [from, to] (each heard word counts once). */
export function captionOverlap(caption, words, from, to) {
  const heard = new Map();
  let n = 0;
  for (const w of words || [])
    if (w.end > from - 0.3 && w.start < to + 0.3)
      for (const t of tokens(w.text)) {
        heard.set(t, (heard.get(t) || 0) + 1);
        n++;
      }
  const cap = tokens(caption);
  let hit = 0;
  for (const t of cap)
    if (heard.get(t) > 0) {
      hit++;
      heard.set(t, heard.get(t) - 1);
    }
  return { share: cap.length ? hit / cap.length : 0, heard: n };
}

/** Words as timed lines (~10 words each), for reading where to set "from" and "to". */
function timedLines(words) {
  const out = [];
  let cur = [], st = null;
  for (const w of words || []) {
    if (st === null) st = w.start;
    cur.push(w.text);
    if (cur.length >= 10 || /[.?!]$/.test(String(w.text).trim())) {
      out.push(`  - ${st.toFixed(2)}–${w.end.toFixed(2)} s: ${cur.join(" ")}`);
      cur = [];
      st = null;
    }
  }
  if (cur.length) out.push(`  - ${st.toFixed(2)}–${words.at(-1).end.toFixed(2)} s: ${cur.join(" ")}`);
  return out;
}

/** Run one fc subcommand. Returns { status, doc } (doc = the parsed JSON, or null). */
function fc(ctx, F, args, why, cwd) {
  const r = ctx.exec(F.bin, [...F.pre, ...args], { allowFail: true, why, cwd, env: PY_ENV });
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {}
  return { status: r.status, doc, stderr: r.stderr };
}

const tail = (s) => String(s || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" / ").slice(0, 300);

/**
 * Query the archive, cut the best moments into videos/ASSETS/clips/cabildo/ and write
 * out/enrich/. Never throws for a fact-checker problem (warnings instead). Returns
 * { candidates, md (lines for context.md), pictures } or null when enrich is off.
 */
export function enrich(ctx, brief) {
  const { P, S } = ctx;
  const cfg = enrichConfig(brief);
  if (!cfg) {
    if (brief.enrich) ctx.note("enrich: skipped (it needs enrich.corpus and a topic or enrich.queries)");
    return null;
  }
  const F = fcCommand(cfg);
  const edir = ensureDir(join(S.out, "enrich"));
  const candFile = join(edir, "candidates.json"), mdFile = join(edir, "ENRICH.md");
  const key = { corpus: cfg.corpus, k: cfg.k, maxClips: cfg.maxClips, queries: cfg.queries, fc: [F.bin, ...F.pre] };
  ctx.note(`enrich: corpus "${cfg.corpus}", ${cfg.queries.length} quer${cfg.queries.length === 1 ? "y" : "ies"}, fc via ${F.how}`);

  // A rerun of state 1 (after writing the script, after each fix) reuses the last lookup.
  const cached = readJsonIf(candFile);
  // A lookup that hit a problem is never reused: the next run asks again.
  const fresh = cached && JSON.stringify(cached.key) === JSON.stringify(key) && !cfg.refresh && !cached.errors?.length && existsSync(mdFile) &&
    cached.candidates.every((c) => existsSync(join(ASSETS, c.clip)) && fingerprint(join(ASSETS, c.clip)) === c.fp && (!c.sheet || existsSync(P.abs(c.sheet))));
  let result;
  if (fresh) {
    ctx.note(`enrich: same queries as the last run, reusing ${P.rel(candFile)} (set enrich.refresh: true, or change the queries, to ask the fact-checker again)`);
    result = cached;
  } else {
    result = lookup(ctx, cfg, F, edir, key);
    // The fact-checker failed outright: keep offering the last lookup's clips (still in videos/ASSETS).
    const last = cached?.candidates?.filter((c) => existsSync(join(ASSETS, c.clip))) || [];
    if (result.errors.length && !result.candidates.length && last.length) {
      ctx.warn(`enrich: the lookup failed, so ENRICH.md keeps the last lookup's ${last.length} candidate(s) (${cached.at})`);
      result = { ...cached, candidates: last, errors: [...result.errors, `showing the candidates of the lookup of ${cached.at}`] };
    }
    writeJson(candFile, result);
  }

  const { candidates } = result;
  for (const c of candidates) {
    const clip = join(ASSETS, c.clip);
    ctx.input(sidecarFile(clip), `cabildo sidecar ${c.id} (fact-checker)`);
    if (c.sheet) ctx.image(P.abs(c.sheet), `${c.id}: ${c.speaker || "?"}, ${c.session || "?"} ${c.date || ""} (${c.duration}s)`);
  }

  // ENRICH.md: everything needed to choose sound bites without hearing them.
  const L = ["# Archivo de cabildo: candidate sound bites", "",
    `Corpus \`${cfg.corpus}\` (fact-checker, backend ${result.backend || "?"}). Queries: ${cfg.queries.map((q) => `"${q}"`).join(", ")}. ${result.hits} passage(s) found, ${candidates.length} cut into clips in \`videos/ASSETS/${CABILDO_REL}/\`.`, "",
    `The text of each one is what Chirp heard: **${CHIRP_WARNING}**. A caption on screen is the exact words, checked by ear by the user (\`"verified": true\` in soundbites.json).`, ""];
  if (result.errors?.length) L.push("Problems while asking the fact-checker:", "", ...result.errors.map((e) => `- ${e}`), "");
  for (const c of candidates) {
    L.push(`## ${c.id} · ${c.speaker || "(hablante sin identificar)"} — ${c.session || "(sesión sin título)"}${c.date ? `, ${c.date}` : ""}`, "",
      `- clip: \`${c.clip}\` (${c.duration} s): paste this into soundbites.json "clip"; "from"/"to" are seconds of this clip`,
      `- passage \`${c.passage_id}\`, video \`${c.video_id ?? "?"}\`, kind ${c.kind || "?"}, score ${c.score ?? "?"}, found by ${c.queries.map((q) => `"${q}"`).join(", ")}`,
      `- agenda item: ${[c.agenda_item, c.agenda_title].filter((x) => x != null && x !== "").join(" · ") || "(none)"}`,
      `- in the session at ${c.timestamp || "?"}: ${c.deep_link || "(no link)"}`,
      c.sheet ? `- contact sheet: \`${c.sheet}\` (open it)` : "- no picture (the clip has no video)",
      `- ${CHIRP_WARNING}:`, "", ...String(c.text || "(sin texto)").split("\n").map((l) => `  > ${l}`), "");
    const lines = timedLines(c.words);
    if (lines.length) L.push("- the same words with their times in the clip (Chirp, for choosing \"from\"/\"to\" only):", "", ...lines, "");
  }
  if (!candidates.length) L.push("No candidates. Change enrich.queries (shorter, the words a regidor would say), or go on without sound bites.", "");
  writeFileSync(mdFile, L.join("\n"));
  ctx.output(mdFile, `${candidates.length} candidate sound bite(s) from the cabildo archive`);
  ctx.output(candFile, "the candidates, for the scripts (and the cache of this lookup)");
  ctx.extra.enrich = {
    corpus: cfg.corpus, queries: cfg.queries, backend: result.backend, hits: result.hits, errors: result.errors, cached: !!fresh,
    clips: candidates.map((c) => ({ id: c.id, passage_id: c.passage_id, clip: c.clip, duration: c.duration, speaker: c.speaker, session: c.session, date: c.date, score: c.score })),
  };

  // The section of context.md.
  const md = ["## Archivo de cabildo (fact-checker)", "",
    `${candidates.length} moment(s) of council sessions found for ${cfg.queries.map((q) => `"${q}"`).join(", ")}. Read \`${P.rel(mdFile)}\` (who, which session, the agenda item, the words with their times) and open every contact sheet below.`, ""];
  if (candidates.length) {
    md.push("| id | speaker | session | date | length | clip |", "|---|---|---|---|---|---|",
      ...candidates.map((c) => `| ${c.id} | ${c.speaker || "?"} | ${String(c.session || "?").replace(/\|/g, "\\|")} | ${c.date || "?"} | ${c.duration} s | \`${c.clip}\` |`), "",
      ...candidates.filter((c) => c.sheet).map((c) => `- ${c.id}: \`${c.sheet}\``), "",
      "**Sound bites.** To put one of these moments in the video (its own audio plays, captioned, and the narration pauses for it), write `soundbites.json` next to script.txt:", "",
      "```json", `[{ "id": "sb1", "clip": "${candidates[0].clip}", "from": 3.2, "to": 14.8, "after": 2, "caption": "the exact words said", "speaker": "Regidora …", "role": "", "verified": false }]`, "```", "",
      "- `from`/`to`: seconds of the clip (the word times in ENRICH.md). Keep a bite under 20 s, and use at most 3.",
      "- `after`: the paragraph it plays after (0 = before the first). Write the script around it: the paragraph before introduces who speaks, the one after reacts. The script itself stays plain text, with no marker for the bite.",
      `- \`caption\`: the exact words said between from and to. The Chirp text is a draft: ${CHIRP_WARNING}.`,
      "- `verified`: `true` only after the USER listened to the clip from `from` to `to` and confirmed the caption, speaker and role. You cannot hear: ask them.", "");
  } else md.push("No candidates (see the warnings in TRACE.md). Write the script without sound bites, or change enrich.queries.", "");
  return { candidates, md, pictures: candidates.filter((c) => c.sheet).map((c) => P.abs(c.sheet)) };
}

/** Ask the fact-checker: search every query, merge, cut the best into clips. */
function lookup(ctx, cfg, F, edir, key) {
  const { P } = ctx;
  const errors = [];
  const problem = (m) => {
    errors.push(m);
    ctx.warn(`enrich: ${m}`);
  };
  const byId = new Map();
  let backend = null;
  for (const q of cfg.queries) {
    const r = fc(ctx, F, ["search", q, "--corpus", cfg.corpus, "-k", String(cfg.k), "--json"], `fact-checker search "${q}"`, P.root);
    if (r.status === null) {
      problem(`could not start the fact-checker (${F.bin}): ${tail(r.stderr)}. See references/troubleshooting.md ("fact-checker").`);
      break; // the next query would fail the same way
    }
    if (r.status === 3) {
      ctx.note(`enrich: no evidence in "${cfg.corpus}" for "${q}" (fc exit 3)`);
      continue;
    }
    if (r.status === 4) {
      problem(`the fact-checker's search backend failed for "${q}" (fc exit 4): ${r.doc?.errors?.join("; ") || tail(r.stderr)}`);
      continue;
    }
    if (r.status !== 0) {
      problem(`fc search "${q}" failed (exit ${r.status}): ${tail(r.stderr)}`);
      continue;
    }
    if (!r.doc || !Array.isArray(r.doc.hits)) {
      problem(`fc search "${q}" did not print the expected JSON ({ "hits": [...] })`);
      continue;
    }
    backend ??= r.doc.backend;
    if (r.doc.errors?.length) ctx.note(`enrich: fc search "${q}" reported: ${r.doc.errors.join("; ")}`);
    for (const h of r.doc.hits) {
      if (!h?.passage_id) continue;
      const prev = byId.get(h.passage_id);
      if (!prev) byId.set(h.passage_id, { ...h, queries: [q] });
      else {
        prev.queries.push(q);
        if ((h.score ?? -Infinity) > (prev.score ?? -Infinity)) Object.assign(prev, h, { queries: prev.queries });
      }
    }
  }
  const hits = [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  // Neighbouring passages of one session share sentences: keep the better of two that overlap
  // by more than half the shorter one, so the same moment is not cut twice.
  const overlaps = (a, b) => a.video_id === b.video_id && a.start_ms != null && b.start_ms != null &&
    Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms) > 0.5 * Math.min(a.end_ms - a.start_ms, b.end_ms - b.start_ms);
  const distinct = [];
  for (const h of hits) if (!distinct.some((d) => overlaps(d, h))) distinct.push(h);
  if (distinct.length < hits.length) ctx.note(`enrich: ${hits.length - distinct.length} hit(s) dropped: they overlap a better hit in the same session`);
  const keep = distinct.slice(0, cfg.maxClips);
  if (hits.length) ctx.log(`enrich: ${distinct.length} distinct passage(s), keeping the best ${keep.length}`);

  ensureDir(CABILDO);
  const candidates = [];
  for (const h of keep) {
    const pid = h.passage_id;
    const r = fc(ctx, F, ["clip", pid, "--json"], `fact-checker clip ${pid}`, P.root);
    if (r.status !== 0 || !r.doc?.path) {
      problem(`fc clip ${pid} failed (exit ${r.status})${r.doc && !r.doc.path ? ': no "path" in its JSON' : ""}: ${tail(r.stderr)}`);
      continue;
    }
    const from = resolve(P.root, r.doc.path);
    if (!existsSync(from)) {
      problem(`fc clip ${pid} printed a path that does not exist: ${r.doc.path}`);
      continue;
    }
    const name = safeId(pid);
    const dest = join(CABILDO, `${name}.mp4`);
    if (existsSync(dest) && fingerprint(dest) === fingerprint(from)) ctx.log(`enrich: videos/ASSETS/${CABILDO_REL}/${name}.mp4 is already there (same bytes)`);
    else {
      copyFileSync(from, dest);
      ctx.log(`enrich: copied ${from} -> videos/ASSETS/${CABILDO_REL}/${name}.mp4`);
    }
    const info = probe(ctx, dest);
    if (!info.hasAudio) ctx.warn(`enrich: ${name}.mp4 has no audio: it cannot be a sound bite`);
    const side = {
      passage_id: pid, video_id: h.video_id ?? null, session: h.event_title ?? null, date: h.event_date ?? null, speaker: h.speaker ?? null,
      agenda_item: h.agenda_item ?? null, agenda_title: h.agenda_title ?? null, kind: h.kind ?? null,
      text: r.doc.text ?? h.text ?? "", words: Array.isArray(r.doc.words) ? r.doc.words : [],
      deep_link: r.doc.deep_link ?? h.deep_link ?? null, timestamp: h.timestamp ?? null, channel: h.channel ?? null,
      start_ms: h.start_ms ?? null, end_ms: h.end_ms ?? null, clip_start_s: r.doc.start_s ?? null, clip_end_s: r.doc.end_s ?? null,
      source: SOURCE, duration: info.duration,
    };
    writeJson(sidecarFile(dest), side);
    const id = `c${candidates.length + 1}`;
    const sdir = ensureDir(join(edir, name));
    const step = info.duration <= 30 ? 1 : info.duration <= 90 ? 2 : 5;
    const pic = join(sdir, "sheet.jpg");
    rmSync(pic, { force: true });
    if (info.hasVideo) sheet(ctx, dest, 0, info.duration, step, pic, `contact sheet of ${id}`, (info.width || 16) >= (info.height || 9) ? "320:-2" : "-2:320");
    candidates.push({
      id, passage_id: pid, video_id: side.video_id, clip: `${CABILDO_REL}/${name}.mp4`, fp: fingerprint(dest), sheet: info.hasVideo ? P.rel(pic) : null, duration: info.duration, score: h.score ?? null,
      speaker: side.speaker, session: side.session, date: side.date, agenda_item: side.agenda_item, agenda_title: side.agenda_title, kind: side.kind,
      timestamp: side.timestamp, deep_link: side.deep_link, text: side.text, words: side.words, queries: h.queries,
    });
  }
  return { key, at: new Date().toISOString(), backend, hits: hits.length, errors, candidates };
}
