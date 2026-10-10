// trace.html: the whole pipeline on one local page. Open it in a browser from the project root.
// - pipeline strip: one card per state, coloured by its derived status
// - one time axis: source pieces -> cut pieces, events (srcT -> t), scene cuts, silences,
//   detector candidates, every SFX cue coloured by the rule that made it, and the music sections
//   (track bars, ◆ hits with their measured jump), the sound bites (state 1 soundbites.json, spliced
//   into the cut from videos/ASSETS/clips/cabildo)
// - per state: error + reproduce command, inputs, numbered commands, outputs, checks, pictures
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ID, STATES, readJsonIf, shortPath } from "./paths.mjs";
import { deriveAll, feedbackLine, fmtBytes, localTime, nextCommand, readFeedback } from "./trace.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const href = (p) => (/^[A-Za-z]:\//.test(p) ? "file:///" : "") + encodeURI(p).replace(/#/g, "%23");
const CODE_CLASS = { OK: "ok", "NOT RUN": "idle", STALE: "stale", "NEEDS REVIEW": "review", BLOCKED: "blocked", FAILED: "fail", RUNNING: "run", INTERRUPTED: "fail", "STUDIO EDIT": "fail" };
const tickStep = (d) => (d <= 40 ? 5 : d <= 120 ? 10 : d <= 400 ? 30 : 60);
const RULE_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#1f77b4", "#d62728"];

function axis(P) {
  const manifest = readJsonIf(P.manifest);
  const tl = readJsonIf(join(P.st[ID.edit].out, "timeline.json"));
  const srcDur = manifest?.probe?.duration;
  if (!srcDur) return "";
  const cues = readJsonIf(join(P.st[ID.sfx].out, "cues.json"))?.cues || [];
  const sections = readJsonIf(join(P.st[ID.music].out, "sections.json"))?.sections || [];
  const scenes = readJsonIf(join(P.st[ID.video].out, "scenes.json")) || [];
  const cands = readJsonIf(join(P.st[ID.video].out, "candidates.json")) || [];
  const sil = readJsonIf(join(P.st[ID.audio].out, "silences.json")) || [];
  const X0 = 70, WID = 1000;
  const sx = (t) => X0 + (t / srcDur) * WID;
  const cutDur = tl?.duration || srcDur;
  const cx = (t) => X0 + (t / cutDur) * WID;
  const Y = { src: 50, cut: 190, cue: 250 };
  if (tl?.voice?.length) [Y.voice, Y.cue] = [Y.cue, Y.cue + 26]; // footage mode: the voiceover gets a lane
  if (tl?.inserts?.length) [Y.ins, Y.cue] = [Y.cue, Y.cue + 26]; // inserts from videos/ASSETS get a lane
  if (tl?.soundbites?.length) [Y.bites, Y.cue] = [Y.cue, Y.cue + 26]; // sound bites: the session's own voice
  const g = [];
  const label = (y, s) => g.push(`<text x="4" y="${y + 14}" class="lane">${s}</text>`);
  label(Y.src, "source");
  g.push(`<rect x="${X0}" y="${Y.src}" width="${WID}" height="22" class="bg"/>`);
  for (const s of sil) g.push(`<rect x="${sx(s.start)}" y="${Y.src - 8}" width="${Math.max(1, sx(s.end) - sx(s.start))}" height="5" class="sil"><title>quiet ${s.start}–${s.end}s (state 2)</title></rect>`);
  for (const t of scenes) g.push(`<line x1="${sx(t)}" x2="${sx(t)}" y1="${Y.src - 2}" y2="${Y.src + 26}" class="scene"><title>scene cut ${t}s (state 3)</title></line>`);
  for (let m = 0; m <= srcDur; m += tickStep(srcDur)) g.push(`<text x="${sx(m)}" y="${Y.src - 14}" class="tick">${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}</text>`);
  for (const c of cands) g.push(`<path d="M${sx(c.t) - 4},${Y.src + 34} l4,-7 l4,7z" class="cand"><title>candidate ${c.id}: ${c.t}s, ${c.detector} ${c.score} (state 3, proposal)</title></path>`);
  if (tl) {
    label(Y.cut, "cut");
    label(Y.cue, "sfx");
    g.push(`<rect x="${X0}" y="${Y.cut}" width="${WID}" height="22" class="bg"/>`);
    tl.pieces.forEach((p, i) => {
      const col = RULE_COLORS[(i + 6) % RULE_COLORS.length];
      const c = cx(p.start), d = cx(p.start + p.duration);
      if (p.file) {
        // Not the footage: a stretch of a videos/ASSETS clip (a sound bite). Only the cut shows it.
        g.push(`<rect x="${c}" y="${Y.cut}" width="${d - c}" height="22" fill="${col}" class="piece ext"><title>piece ${esc(p.id)}: videos/ASSETS/${esc(p.file)} ${p.from}–${p.to}s${p.soundbite ? ` (sound bite ${esc(p.soundbite)})` : ""} → cut ${p.start}–${(p.start + p.duration).toFixed(3)}s</title></rect>`);
        g.push(`<text x="${(c + d) / 2}" y="${Y.cut + 15}" class="pid">${esc(p.id)}</text>`);
        return;
      }
      const a = sx(p.from), b = sx(p.to);
      g.push(`<polygon points="${a},${Y.src + 22} ${b},${Y.src + 22} ${d},${Y.cut} ${c},${Y.cut}" fill="${col}" class="map"/>`);
      g.push(`<rect x="${a}" y="${Y.src}" width="${b - a}" height="22" fill="${col}" class="piece"><title>piece ${p.id}: source ${p.from}–${p.to}s at ${p.speed}x</title></rect>`);
      g.push(`<rect x="${c}" y="${Y.cut}" width="${d - c}" height="22" fill="${col}" class="piece"><title>piece ${p.id}: cut ${p.start}–${(p.start + p.duration).toFixed(3)}s</title></rect>`);
      g.push(`<text x="${(c + d) / 2}" y="${Y.cut + 15}" class="pid">${esc(p.id)}${p.speed !== 1 ? ` ${p.speed}x` : ""}</text>`);
    });
    for (let m = 0; m <= cutDur; m += tickStep(cutDur)) g.push(`<text x="${cx(m)}" y="${Y.cut + 36}" class="tick">${m}s</text>`);
    for (const e of tl.events) {
      g.push(`<line x1="${sx(e.srcT)}" y1="${Y.src + 22}" x2="${cx(e.t)}" y2="${Y.cut}" class="evmap"/>`);
      g.push(`<circle cx="${sx(e.srcT)}" cy="${Y.src + 11}" r="3.5" class="ev"><title>event #${e.n}: source ${e.srcT}s → cut ${e.t}s (piece ${e.piece}, ${e.anchor || ""})</title></circle>`);
      g.push(`<circle cx="${cx(e.t)}" cy="${Y.cut + 11}" r="3.5" class="ev"><title>event #${e.n}: cut ${e.t}s ← source ${e.srcT}s</title></circle>`);
    }
    if (Y.voice) {
      label(Y.voice, "voice");
      g.push(`<rect x="${X0}" y="${Y.voice}" width="${WID}" height="16" class="bg"/>`);
      for (const v of tl.voice) {
        g.push(`<rect x="${cx(v.beat.cutEnd)}" y="${Y.voice + 13}" width="2" height="5" class="vbeat"><title>end of beat ${v.p}</title></rect>`);
        for (const s of v.segments) g.push(`<rect x="${cx(s.at)}" y="${Y.voice + 2}" width="${Math.max(2, cx(s.at + s.to - s.from) - cx(s.at))}" height="12" class="voice"><title>p${v.p}: voiceover ${s.from}–${s.to}s placed at cut ${s.at}s (beat from source ${v.beat.from}s)</title></rect>`);
        g.push(`<text x="${cx(v.at) + 3}" y="${Y.voice + 12}" class="pid" style="text-anchor:start">p${v.p}</text>`);
      }
    }
    if (Y.ins) {
      label(Y.ins, "inserts");
      g.push(`<rect x="${X0}" y="${Y.ins}" width="${WID}" height="16" class="bg"/>`);
      tl.inserts.forEach((x, i) => {
        const a = cx(x.t), w = Math.max(3, cx(x.t + x.dur) - a);
        g.push(`<rect x="${a}" y="${Y.ins + 2}" width="${w}" height="12" fill="${RULE_COLORS[(i + 9) % RULE_COLORS.length]}" class="piece"><title>insert ${esc(x.id)}: ${x.kind} videos/ASSETS/${esc(x.file)}, cut ${x.t}–${(x.t + x.dur).toFixed(3)}s (${esc(x.anchor)}), box ${x.box}</title></rect>`);
        if (w > 40) g.push(`<text x="${a + 3}" y="${Y.ins + 12}" class="pid" style="text-anchor:start">${esc(x.id)}</text>`);
      });
    }
    if (Y.bites) {
      label(Y.bites, "bites");
      g.push(`<rect x="${X0}" y="${Y.bites}" width="${WID}" height="16" class="bg"/>`);
      for (const s of tl.soundbites) {
        const a = cx(s.t), w = Math.max(3, cx(s.t + s.dur) - a);
        g.push(`<rect x="${a}" y="${Y.bites + 2}" width="${w}" height="12" class="bite"><title>sound bite ${esc(s.id)}: ${esc(s.speaker || "?")}${s.role ? `, ${esc(s.role)}` : ""}${s.session ? ` · ${esc(s.session)}` : ""}${s.date ? ` · ${esc(s.date)}` : ""}, cut ${s.t}–${(s.t + s.dur).toFixed(3)}s (piece ${esc(s.piece)}, videos/ASSETS/${esc(s.clip)} ${s.from}–${s.to}s): «${esc(s.caption)}»</title></rect>`);
        if (w > 30) g.push(`<text x="${a + 3}" y="${Y.bites + 12}" class="pid" style="text-anchor:start">${esc(s.id)}</text>`);
      }
    }
    const rows = {};
    for (const c of cues) {
      const row = (rows[c.sound] ??= Object.keys(rows).length);
      const y = Y.cue + row * 14;
      const w = c.dur ? cx(c.start + c.dur) - cx(c.start) : 2;
      g.push(`<rect x="${cx(c.start)}" y="${y}" width="${Math.max(3, w)}" height="10" fill="${RULE_COLORS[(c.rule - 1) % RULE_COLORS.length]}"><title>${esc(c.sound)} at ${c.at}s (starts ${c.start}s), gain ${c.gain}: rule ${c.rule} on ${esc(c.anchor)}</title></rect>`);
    }
    const legend = Object.entries(rows).map(([s, r]) => `<text x="${X0 + WID + 6}" y="${Y.cue + r * 14 + 9}" class="tick legend" text-anchor="start">${esc(s)}</text>`);
    g.push(...legend);
    Y.music = Y.cue + Math.max(1, Object.keys(rows).length) * 14 + 18;
    label(Y.music, "music");
    g.push(`<rect x="${X0}" y="${Y.music}" width="${WID}" height="20" class="bg"/>`);
    sections.forEach((m, i) => {
      const a = cx(m.from), b = cx(m.to);
      g.push(`<rect x="${a}" y="${Y.music}" width="${Math.max(2, b - a)}" height="20" fill="${RULE_COLORS[(i + 3) % RULE_COLORS.length]}" class="piece"><title>section ${m.n}: ${esc(m.track)} (${m.role}) cut ${m.from}–${m.to}s, track from ${m.trackIn}s, ${m.lufs} LUFS; set by ${esc(m.anchor)}</title></rect>`);
      if (b - a > 60) g.push(`<text x="${a + 4}" y="${Y.music + 14}" class="mname">${esc(m.track)}</text>`);
      if (m.hit) g.push(`<path d="M${cx(m.hit.at)},${Y.music - 6} l6,6 l-6,6 l-6,-6z" class="hit"><title>hit: drop ${m.hit.drop}s of ${esc(m.track)} lands at cut ${m.hit.at}s (${esc(m.hit.anchor)})${m.hit.rise != null ? `, music jumps +${m.hit.rise} dB` : ""}</title></path>`);
    });
    if (!sections.length) g.push(`<text x="${X0 + 6}" y="${Y.music + 14}" class="tick legend">no music (state 6 not built, or sections is empty)</text>`);
  }
  const H = (Y.music ?? Y.cue) + 40;
  return `<section class="card"><h2>Timeline</h2><p class="muted">Hover any mark. Top: the source (pieces kept, scene cuts, quiet runs, ▲ detector candidates). Bands: how each piece maps into the cut. Then: inserts from videos/ASSETS and sound bites (if any; a dashed cut piece is a clip from videos/ASSETS, not the footage), SFX cues, coloured by the rule that made them. Bottom: music sections, ◆ = a hit (drop on an anchor).</p>
<svg viewBox="0 0 1150 ${H}" class="axis">${g.join("")}</svg></section>`;
}

function table(rows, head) {
  if (!rows.length) return "";
  return `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
}

function stateCard(P, d) {
  const r = d.rec;
  const S = P.st[d.def.id];
  const cls = CODE_CLASS[d.code];
  const next = nextCommand(P, d);
  const head = `<summary><span class="badge ${cls}">${d.code}</span> <b>${d.def.id} · ${d.def.name}</b>${d.def.human ? ' <span class="muted">(human review)</span>' : ""}
    <span class="muted">${r ? `${localTime(r.startedAt)} · ${(r.ms / 1000).toFixed(1)} s${r.dry ? " · dry" : ""}` : ""}</span>${d.reason ? `<div class="reason">${esc(d.reason)}</div>` : ""}</summary>`;
  if (!r) return `<details class="card" id="s${d.def.id}">${head}<p class="muted">Not run yet. Folder: <code>${esc(d.def.dir)}</code>, config: <code>${esc(d.def.config)}</code>.</p>${next ? `<pre>${esc(next)}</pre>` : ""}</details>`;
  const parts = [head];
  if (d.edits?.length)
    parts.push(`<div class="banner"><b>Changed by hand in Studio:</b> ${d.edits.map((e) => `<code>${esc(e.file)}</code> ${e.how}`).join(", ")}. The next build would overwrite it, so it is refused until the change is ported into the config. See the diff with <code>studio-diff.mjs</code>.</div>`);
  if (next) parts.push(`<p>Next:</p><pre>${esc(next)}</pre>`);
  if (r.preview?.ok && !r.preview.stoppedAt) parts.push(`<a class="preview" href="${esc(r.preview.url)}" target="_blank">▶ Open the Studio preview</a> <span class="muted">${esc(r.preview.url)} · opened ${localTime(r.preview.at)}</span>`);
  else if (r.preview) parts.push(`<p class="muted">Studio preview ${r.preview.ok ? `stopped ${localTime(r.preview.stoppedAt)} (another preview opened)` : `did not start: ${esc(r.preview.error || "")}`}. Reopen: <code>preview.mjs &lt;project&gt; ${d.def.id}</code></p>`);
  const fb = readFeedback(P, d.def.id);
  if (fb.length) parts.push(`<h3>Feedback and approvals</h3><ul class="fb">${fb.map((f) => `<li class="${esc(f.kind)}"><span class="muted">${f.at ? localTime(f.at) : ""} · ${esc(f.kind)}${f.source ? ` · ${esc(f.source)}` : ""}</span><br>${esc(feedbackLine(f))}${f.diff ? ` — <a href="${href(f.diff)}">diff</a>` : ""}</li>`).join("")}</ul>`);
  if (r.error) {
    parts.push(`<div class="err"><h3>What went wrong</h3><pre>${esc(r.error.message)}</pre>`);
    if (r.error.command) parts.push(`<p>Failing command $${r.error.command.n} (${esc(r.error.command.why)})${r.error.command.cwd ? `, from <code>${esc(r.error.command.cwd)}</code>` : ""}:</p><pre>${esc(r.error.command.cmd)}</pre>${r.error.command.stderrTail ? `<pre class="muted">${esc(r.error.command.stderrTail)}</pre>` : ""}`);
    if (r.error.stack) parts.push(`<p>Script stack (a bug in the skill):</p><pre>${esc(r.error.stack)}</pre>`);
    parts.push(`</div>`);
  }
  const tp = join(S.out, "teleprompter.txt");
  if (d.def.id === ID.script && existsSync(tp)) parts.push(`<h3>Script (out/teleprompter.txt)</h3><pre class="script">${esc(readFileSync(tp, "utf8"))}</pre>`);
  if (r.enrich) parts.push(`<h3>Archivo de cabildo (fact-checker, ${esc(r.enrich.corpus)})</h3><p class="muted">Queries: ${r.enrich.queries.map((q) => `“${esc(q)}”`).join(", ")} · backend ${esc(r.enrich.backend || "?")} · ${r.enrich.hits} passage(s)${r.enrich.cached ? " · reused from the last run" : ""}${r.enrich.errors?.length ? ` · <span class="badge stale">${r.enrich.errors.length} problem(s)</span>` : ""}</p>` +
    table(r.enrich.clips.map((c) => [esc(c.id), esc(c.speaker || "?"), esc(c.session || "?"), esc(c.date || "?"), `${c.duration} s`, `<code>${esc(c.clip)}</code>`]), ["id", "speaker", "session", "date", "length", "clip (videos/ASSETS)"]));
  if (r.soundbites?.length) parts.push(`<h3>Sound bites</h3>` + table(r.soundbites.map((b) => [esc(b.id), b.t != null ? `cut ${b.t}–${(b.t + b.dur).toFixed(2)}s` : `after p${b.after}`, esc(`${b.speaker || "?"}${b.role ? `, ${b.role}` : ""}`), `<code>${esc(b.clip)}</code> ${b.from}–${b.to}s`, `«${esc(b.caption)}»`, b.verified === false ? '<span class="badge fail">not verified</span>' : '<span class="badge ok">verified</span>']), ["id", "where", "speaker", "clip", "caption", "by ear"]));
  if (r.beats?.length) parts.push(`<h3>Beats (footage under each paragraph)</h3>` + table(r.beats.map((x) => [`p${x.p}`, `${x.from}–${x.to}s`, `${x.words}/${x.budget}${x.words > x.budget ? ' <span class="badge stale">over</span>' : ""}`]), ["paragraph", "footage", "words / budget"]));
  if (r.review) parts.push(`<p>Review: ${r.review.approved ? `<span class="badge ok">approved</span> ${r.review.at ? localTime(r.review.at) : ""} — “${esc(r.review.note || "")}”` : '<span class="badge review">not approved</span>'}</p>`);
  if (r.checks.length) parts.push(`<h3>Checks</h3><ul class="checks">${r.checks.map((c) => `<li class="${c.pass ? "pass" : "failc"}">${c.pass ? "PASS" : "FAIL"} ${esc(c.name)}${c.detail ? ` <span class="muted">— ${esc(c.detail)}</span>` : ""}</li>`).join("")}</ul>`);
  if (r.warnings.length) parts.push(`<h3>Warnings</h3><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`);
  if (r.notes.length) parts.push(`<h3>Notes</h3><ul>${r.notes.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`);
  const changed = new Set((d.code === "STALE" ? d.reason : "").split("; ").map((x) => x.split(" ")[0]));
  parts.push(`<h3>Inputs</h3>` + table(r.inputs.map((i) => [`<a href="${href(i.path)}">${esc(shortPath(i.path))}</a>${changed.has(shortPath(i.path)) ? ' <span class="badge stale">changed</span>' : ""}`, esc(i.role), `<code>${esc(i.fp ?? "MISSING")}</code>`]), ["file", "role", "fingerprint"]));
  parts.push(`<h3>Outputs</h3>` + table(r.outputs.map((o) => [`<a href="${href(o.path)}">${esc(o.path)}</a>`, esc(o.note), o.bytes == null ? "MISSING" : fmtBytes(o.bytes)]), ["file", "what", "size"]));
  if (r.images.length) parts.push(`<h3>Pictures</h3><div class="imgs">${r.images.map((i) => `<figure><a href="${href(i.path)}"><img loading="lazy" src="${href(i.path)}"></a><figcaption>${esc(i.caption)}</figcaption></figure>`).join("")}</div>`);
  if (r.commands.length) parts.push(`<details><summary>Commands (${r.commands.length}) — paste into Git Bash to rerun one</summary>${r.commands.map((c) => `<p><b>$${c.n}</b> ${esc(c.why)} <span class="muted">exit ${c.exit} · ${(c.ms / 1000).toFixed(1)} s${c.cwd ? ` · cwd ${esc(c.cwd)}` : ""}</span></p><pre>${esc(c.cmd)}</pre>`).join("")}</details>`);
  if (r.params) parts.push(`<details><summary>Params used (${esc(d.def.config)})</summary><pre>${esc(JSON.stringify(r.params, null, 2))}</pre></details>`);
  parts.push(`<p class="muted">Files: <a href="${href(P.rel(join(S.dir, "TRACE.md")))}">TRACE.md</a> · <a href="${href(P.rel(join(S.dir, "log.txt")))}">log.txt</a> · <a href="${href(P.rel(S.state))}">state.json</a></p>`);
  return `<details class="card" id="s${d.def.id}" ${d.code !== "OK" ? "open" : ""}>${parts.join("\n")}</details>`;
}

/** The phone review server (review.mjs), when it runs: its QR page and the phone URL. */
function phoneLine(P) {
  const r = readJsonIf(join(P.root, ".review.json"));
  let up = false;
  try {
    up = !!r?.pid && process.kill(r.pid, 0);
  } catch {}
  if (!up) return `<p class="muted">Phone review: not running (<code>review.mjs &lt;project&gt;</code> starts it).</p>`;
  const urls = (r.urls || []).map((u) => `${u.url}/?k=${r.token}`);
  return `<p>📱 Phone review: <a class="preview" href="http://127.0.0.1:${r.port}/qr" target="_blank">QR code for the phone</a> <span class="muted">${urls.map(esc).join(" · ") || "no LAN address"}</span></p>`;
}

export function writeTraceHtml(P) {
  const all = deriveAll(P);
  const manifest = readJsonIf(P.manifest);
  const name = P.root.split(/[\\/]/).pop();
  // raw-media sits where the footage enters: after the script, before the first state that reads it.
  const firstMedia = STATES.find((s) => s.media)?.id;
  const strip = STATES.map((s, i) => {
    const d = all[s.id];
    const raw = s.id === firstMedia ? `${i ? '<span class="arrow">→</span>' : ""}<a class="node ${manifest ? "ok" : "idle"}" href="#raw"><b>raw-media</b><span>${esc(manifest?.file || "no footage yet")}</span></a>` : "";
    return `${raw}${i || raw ? `<span class="arrow">${s.gate ? "🔒" : "→"}</span>` : ""}<a class="node ${CODE_CLASS[d.code]}" href="#s${s.id}"><b>${s.id} ${s.name}</b><span>${d.code}</span></a>`;
  }).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} trace</title><style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#dcdcd8;--ok:#2e8540;--stale:#b8860b;--review:#1a73a8;--fail:#c0392b;--blocked:#8e44ad;--idle:#8a8a8a;--code:#f0f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1e1e21;--fg:#e8e8ea;--muted:#9a9aa0;--line:#33333a;--ok:#4caf68;--stale:#e0b23a;--review:#4aa3dd;--fail:#ef6a5b;--blocked:#b07cd0;--idle:#777;--code:#26262a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0}h2{font-size:16px;margin:0 0 6px}h3{font-size:13px;margin:14px 0 4px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:12px 0}
summary{cursor:pointer}.reason{margin:4px 0 0 2px;color:var(--muted)}
pre{background:var(--code);padding:8px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font-size:12px}
code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12.5px}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}td:first-child{word-break:break-all}
a{color:var(--review)}.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11.5px;font-weight:600;color:#fff;background:var(--idle)}
.badge.ok{background:var(--ok)}.badge.stale{background:var(--stale)}.badge.review{background:var(--review)}.badge.fail{background:var(--fail)}.badge.blocked{background:var(--blocked)}
.strip{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.node{display:flex;flex-direction:column;padding:8px 10px;border-radius:8px;border:2px solid var(--idle);text-decoration:none;color:var(--fg);background:var(--card);min-width:110px}
.node span{font-size:12px;color:var(--muted)}.node.ok{border-color:var(--ok)}.node.stale{border-color:var(--stale)}.node.review{border-color:var(--review)}.node.fail{border-color:var(--fail)}.node.blocked{border-color:var(--blocked)}.arrow{color:var(--muted)}
.err{border-left:4px solid var(--fail);padding-left:10px}.checks{list-style:none;padding:0}.pass{color:var(--ok)}.failc{color:var(--fail);font-weight:600}
.imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}figure{margin:0}img{width:100%;border-radius:4px;border:1px solid var(--line)}figcaption{font-size:12px;color:var(--muted)}
.axis{width:100%;height:auto}.axis .bg{fill:var(--code)}.axis .lane{fill:var(--muted);font-size:12px}.axis .tick{fill:var(--muted);font-size:10px;text-anchor:middle}.axis .legend{font-size:11px;text-anchor:start}
.axis .piece{opacity:.85}.axis .map{opacity:.18}.axis .pid{fill:#fff;font-size:11px;font-weight:700;text-anchor:middle}.axis .scene{stroke:var(--fg);stroke-width:1;opacity:.5}
.axis .sil{fill:var(--muted);opacity:.6}.axis .cand{fill:none;stroke:var(--stale);stroke-width:1.3}.axis .ev{fill:#fff;stroke:#111;stroke-width:1.2}.axis .evmap{stroke:var(--fg);opacity:.25}.axis .mname{fill:#fff;font-size:11px;font-weight:600}.axis .voice{fill:var(--review);opacity:.85}.axis .bite{fill:var(--stale);opacity:.9}.axis .ext{stroke:#111;stroke-width:1;stroke-dasharray:4 2}.axis .vbeat{fill:var(--fg);opacity:.6}.axis .hit{fill:var(--stale);stroke:#111;stroke-width:1}
.banner{background:var(--fail);color:#fff;border-radius:6px;padding:8px 10px;margin:8px 0}.banner a,.banner code{color:#fff}
.preview{display:inline-block;margin:6px 0;padding:6px 10px;border-radius:6px;background:var(--review);color:#fff;text-decoration:none;font-weight:600}
pre.script{white-space:pre-wrap;word-break:normal;font:15px/1.6 system-ui,sans-serif;padding:12px}
.fb{list-style:none;padding:0}.fb li{border-left:3px solid var(--line);padding:2px 8px;margin:4px 0}.fb .approved{border-color:var(--ok)}.fb .studio-edit{border-color:var(--fail)}
@media (max-width:640px){main{padding:10px 16px}.node{min-width:0;flex:1 1 40%}}
</style></head><body><main>
<h1>${esc(name)} <span class="muted">— traced-edit</span></h1>
<p class="muted">Generated ${localTime(new Date().toISOString())}. This page is regenerated by every <code>run.mjs</code> and <code>status.mjs</code>; reload it after a run.</p>
<section class="card"><div class="strip">${strip}</div>${phoneLine(P)}</section>
${axis(P)}
<section class="card" id="raw"><h2>raw-media</h2>${manifest ? `<p><code>${esc(manifest.file)}</code> — ${manifest.probe.width}x${manifest.probe.height} ${esc(manifest.probe.vcodec)}, ${manifest.probe.fps} fps, ${manifest.probe.duration}s${manifest.probe.hasAudio ? `, audio ${esc(manifest.probe.acodec)}` : ", no audio"}. Copied from <code>${esc(manifest.source)}</code> (${esc(manifest.how)}) on ${esc(manifest.at)}. Never modified.</p>` : "<p>No footage yet. Record it (reading the approved script), then add it with <code>init.mjs &lt;project&gt; --media &lt;video&gt;</code>.</p>"}</section>
${STATES.map((s) => stateCard(P, all[s.id])).join("\n")}
</main></body></html>`;
  writeFileSync(P.trace, html);
}
