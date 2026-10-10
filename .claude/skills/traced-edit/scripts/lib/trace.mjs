// The trace contract. Every state runs inside a Ctx, which records what went in, every command
// that ran (copy-pasteable), what came out, which checks passed, and why it failed. It writes:
//   <state dir>/state.json   machine-readable record (status.mjs and trace.html read it)
//   <state dir>/log.txt      timestamped log of this run, incl. each command's stderr tail
//   <state dir>/TRACE.md     the same record for humans, with "what changed since last run"
// The previous run is kept as state.prev.json / log.prev.txt so you can compare.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, openSync, readSync, readdirSync, closeSync, rmSync, statSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ID, STATES, UserError, ensureDir, missingMedia, readJsonIf, shortPath, writeJson } from "./paths.mjs";

const SMALL = 8 * 1024 * 1024;

/** sha1 of the whole file when small; size + sha1 of the first and last MB for big media. */
export function fingerprint(file) {
  if (!existsSync(file)) return null;
  const st = statSync(file);
  if (st.isDirectory()) return null;
  const h = createHash("sha1");
  if (st.size <= SMALL) {
    h.update(readFileSync(file));
    return h.digest("hex").slice(0, 16);
  }
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  readSync(fd, buf, 0, buf.length, 0);
  h.update(buf);
  readSync(fd, buf, 0, buf.length, st.size - buf.length);
  h.update(buf);
  closeSync(fd);
  return `${st.size}-${h.digest("hex").slice(0, 12)}`;
}

/** Quote a command so it can be pasted into Git Bash. */
export function shellQuote(bin, args) {
  const q = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
  return [bin, ...args].map(q).join(" ");
}

export class Ctx {
  constructor(P, def, opts = {}) {
    this.P = P;
    this.def = def;
    this.S = P.st[def.id];
    this.opts = opts;
    this.t0 = Date.now();
    this.inputs = [];
    this.watched = [];
    this.commands = [];
    this.outputs = [];
    this.checks = [];
    this.warnings = [];
    this.images = [];
    this.notes = [];
    this.params = null;
    this.extra = {};
    ensureDir(this.S.dir);
    const log = join(this.S.dir, "log.txt");
    if (existsSync(log)) renameSync(log, join(this.S.dir, "log.prev.txt"));
    if (existsSync(this.S.state)) {
      const prev = readJsonIf(this.S.state);
      // Keep the approval across the rotation; status decides whether it still holds.
      this.review = prev?.review || null;
      // The preview project and its server outlive a run: keep them until a new build replaces them.
      this.carry = { generated: prev?.generated, preview: prev?.preview, portedEdits: prev?.portedEdits };
      if (prev && prev.status !== "running") renameSync(this.S.state, join(this.S.dir, "state.prev.json"));
    }
    this.logFile = log;
    writeFileSync(log, `# ${def.id} ${def.name}  ${new Date().toISOString()}  args: ${JSON.stringify(opts)}\n`);
    this.write("running");
  }

  log(msg) {
    const line = `[${((Date.now() - this.t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`;
    console.log(line);
    appendFileSync(this.logFile, line + "\n");
  }

  /** Declare a file this state depends on. Its fingerprint decides staleness later. */
  input(file, role) {
    this.inputs.push({ path: this.P.rel(file), role, fp: fingerprint(file) });
  }

  /** Declare a folder whose file list this state depends on: a file added or removed makes it STALE. */
  watchDir(dir, re = /./) {
    this.watched.push({ dir: this.P.rel(dir), files: listDir(dir, re), re: re.source });
  }

  /**
   * Run a command, traced. Returns { status, stdout, stderr }. Throws on non-zero exit unless allowFail.
   * `env`: extra environment variables, shown in front of the command so it still pastes as-is.
   */
  exec(bin, args, { shell = false, cwd, allowFail = false, input, why = "", maxBuffer = 1 << 30, env } = {}) {
    const n = this.commands.length + 1;
    const vars = env ? Object.entries(env).map(([k, v]) => `${k}=${shellQuote(String(v), []).trim()} `).join("") : "";
    const line = vars + (shell ? args.join(" ") : shellQuote(bin, args));
    const t = Date.now();
    this.log(`$${n} ${why ? `(${why}) ` : ""}${line.length > 400 ? line.slice(0, 400) + " …" : line}`);
    const environ = env ? { ...process.env, ...env } : undefined;
    const r = shell
      ? spawnSync(`${bin} ${args.join(" ")}`, { shell: true, cwd, encoding: "utf8", maxBuffer, input, env: environ })
      : spawnSync(bin, args, { cwd, encoding: "utf8", maxBuffer, input, env: environ });
    const stderr = (r.stderr || "") + (r.error ? `\n${r.error.message}` : "");
    const tail = stderr.split("\n").filter((l) => l.trim() && !/Fontconfig/.test(l)).slice(-40).join("\n");
    const rec = { n, why, cmd: line, cwd: cwd ? this.P.rel(cwd) || "." : undefined, ms: Date.now() - t, exit: r.status, stderrTail: r.status === 0 ? undefined : tail };
    this.commands.push(rec);
    appendFileSync(this.logFile, `      exit ${r.status} in ${(rec.ms / 1000).toFixed(1)}s\n` + (r.status !== 0 && tail ? tail.replace(/^/gm, "      | ") + "\n" : ""));
    if (r.status !== 0 && !allowFail) {
      const e = new Error(`command $${n} failed (exit ${r.status}): ${why || bin}\n${tail.split("\n").slice(-8).join("\n")}`);
      e.command = rec;
      throw e;
    }
    return { status: r.status, stdout: r.stdout || "", stderr };
  }

  ffmpeg(args, opts = {}) {
    return this.exec("ffmpeg", ["-hide_banner", "-y", "-nostats", ...args], opts);
  }

  output(file, note = "", extra = {}) {
    const st = existsSync(file) ? statSync(file) : null;
    this.outputs.push({ path: this.P.rel(file), note, bytes: st?.size ?? null, fp: fingerprint(file), ...extra });
  }

  image(file, caption = "") {
    if (existsSync(file)) this.images.push({ path: this.P.rel(file), caption });
  }

  check(name, pass, detail = "") {
    this.checks.push({ name, pass: !!pass, detail });
    this.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  }

  warn(msg) {
    this.warnings.push(msg);
    this.log(`WARNING  ${msg}`);
  }

  note(msg) {
    this.notes.push(msg);
    this.log(msg);
  }

  record(status, err) {
    return {
      id: this.def.id,
      name: this.def.name,
      status,
      pid: status === "running" ? process.pid : undefined,
      startedAt: new Date(this.t0).toISOString(),
      ms: Date.now() - this.t0,
      args: this.opts,
      dry: !!this.opts.dry,
      inputs: this.inputs,
      watched: this.watched,
      params: this.params,
      commands: this.commands,
      outputs: this.outputs,
      checks: this.checks,
      warnings: this.warnings,
      notes: this.notes,
      images: this.images,
      error: err || null,
      review: this.def.human ? this.review || { approved: false } : undefined,
      ...(this.carry || {}),
      ...this.extra,
    };
  }

  write(status, err) {
    writeJson(this.S.state, this.record(status, err));
  }

  /** Close the run. A failed check turns an otherwise clean run into a failure. */
  end(e) {
    let err = null;
    if (e) {
      err = { message: e.message, user: e instanceof UserError, command: e.command || (e instanceof UserError ? null : this.commands.at(-1)) || null };
      if (!(e instanceof UserError) && !e.command) err.stack = (e.stack || "").split("\n").slice(0, 6).join("\n");
      this.log(`ERROR  ${e.message}`);
    } else if (this.checks.some((c) => !c.pass)) {
      const failed = this.checks.filter((c) => !c.pass).map((c) => c.name);
      err = { message: `${failed.length} check(s) failed: ${failed.join("; ")}`, user: false, command: null };
      this.log(`ERROR  ${err.message}`);
    }
    const status = err ? "failed" : "ok";
    this.write(status, err);
    rewriteTraceMd(this.P, this.def.id);
    return status;
  }
}

/** File names in a folder (not recursive), sorted; [] when it does not exist. */
function listDir(dir, re) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f) && !statSync(join(dir, f)).isDirectory()).sort() : [];
}

// ---------- feedback log (the user's words, per state) ----------

/**
 * Append { at, kind, text, ... } to <state dir>/feedback.jsonl.
 * kind: feedback | approved | revoked | studio-edit | reply (Claude's answer to a note).
 * Optional: source ("phone" when it came from the review page), t (cut seconds), near (what was there).
 */
export function addFeedback(P, id, entry) {
  const f = join(P.st[id].dir, "feedback.jsonl");
  ensureDir(P.st[id].dir);
  appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function readFeedback(P, id) {
  const f = join(P.st[id].dir, "feedback.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { at: "", kind: "unreadable", text: l };
    }
  });
}

/**
 * Record the USER's approval of a human-review state (approve.mjs, or the phone review page).
 * Returns null when approved, or why it was refused.
 */
export function approveState(P, id, note, { source } = {}) {
  const rec = readJsonIf(P.st[id].state);
  const d = deriveAll(P)[id];
  if (!rec || rec.status !== "ok") return `state ${id} has not run successfully (${d.code}). Run it first.`;
  if (rec.dry) return `the last run of state ${id} was --dry; there is nothing to review yet. Run it without --dry.`;
  if (d.code === "STUDIO EDIT") return `the Studio preview of state ${id} was edited by hand. Port the edit into the config and rebuild (--ported) before approving: what gets approved must be reproducible.`;
  if (d.code === "STALE") return `state ${id} is STALE (${d.reason}). Run it again, then review the new result.`;
  if (!note) return '--note "<what the user said>" is required. The approval records the user\'s own words.';
  const src = source ? { source } : {};
  patchState(P, id, { review: { approved: true, note, at: new Date().toISOString(), key: reviewKey(P, id), ...src } });
  addFeedback(P, id, { kind: "approved", text: note, ...src });
  return null;
}

/** One feedback entry as a line: "📱 1:11.40 · near … · text". */
export function feedbackLine(f) {
  const t = typeof f.t === "number" ? `${Math.floor(f.t / 60)}:${(f.t % 60).toFixed(2).padStart(5, "0")}` : "";
  return [f.source === "phone" ? `📱${t ? ` ${t}` : ""}` : t, f.near ? `near ${f.near}` : "", f.text || ""].filter(Boolean).join(" · ");
}

/** Rewrite TRACE.md from state.json (after a run, an approval, a preview or new feedback). */
export function rewriteTraceMd(P, id) {
  const S = P.st[id];
  const rec = readJsonIf(S.state);
  if (!rec) return;
  writeFileSync(join(S.dir, "TRACE.md"), traceMd(P, rec, readJsonIf(join(S.dir, "state.prev.json")), readFeedback(P, id), studioEdits(P, id)));
}

/** Update fields of a finished state.json without a new run (preview info, review). */
export function patchState(P, id, fields) {
  const S = P.st[id];
  const rec = readJsonIf(S.state);
  if (!rec) return null;
  const next = { ...rec, ...fields };
  writeJson(S.state, next);
  rewriteTraceMd(P, id);
  return next;
}

// ---------- Studio edits: hand changes to a generated preview project ----------

/**
 * HyperFrames Studio rewrites a project's HTML when it opens it, without changing what it does:
 * it stamps data-hf-id="…" on elements, writes <!DOCTYPE html>, drops the "/" of void tags and
 * writes boolean attributes as attr="". Those are normalized away so that only real edits count.
 */
export function canonicalHtml(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/<!doctype html>/i, "<!doctype html>")
    .replace(/\s+data-hf-id="[^"]*"/g, "")
    .replace(/(\s[\w:-]+)=""/g, "$1")
    .replace(/\s*\/>/g, ">")
    .replace(/[ \t]+$/gm, "");
}

export function htmlFingerprint(file) {
  if (!existsSync(file)) return null;
  return createHash("sha1").update(canonicalHtml(readFileSync(file, "utf8"))).digest("hex").slice(0, 16);
}

/** Generated files of a state's preview project that no longer match what the build wrote. */
export function studioEdits(P, id) {
  const rec = readJsonIf(P.st[id].state);
  const g = rec?.generated;
  if (!g) return [];
  const dir = P.abs(g.dir);
  if (!existsSync(dir)) return [];
  const changed = [];
  for (const [rel, fp] of Object.entries(g.files)) {
    const now = htmlFingerprint(join(dir, rel));
    if (now !== fp) changed.push({ file: rel, how: now ? "edited" : "deleted" });
  }
  const comp = join(dir, "compositions");
  if (existsSync(comp))
    for (const f of readdirSync(comp).filter((x) => x.endsWith(".html")))
      if (!g.files[`compositions/${f}`]) changed.push({ file: `compositions/${f}`, how: "added" });
  return changed;
}

/** Unified diff, pristine (what the build wrote) vs current (what Studio left). */
export function studioDiff(P, id) {
  const g = readJsonIf(P.st[id].state)?.generated;
  if (!g) return "";
  const out = [];
  for (const { file, how } of studioEdits(P, id)) {
    const a = join(P.abs(g.pristine), file), b = join(P.abs(g.dir), file);
    if (how !== "edited") {
      out.push(`### ${file} was ${how} in Studio\n`);
      if (how === "added") out.push(readFileSync(b, "utf8"));
      continue;
    }
    // Diff the canonical forms, so Studio's own re-serialization does not drown the real edit.
    const tmp = mkdtempSync(join(tmpdir(), "traced-edit-diff-"));
    ensureDir(join(tmp, "generated", dirname(file)));
    ensureDir(join(tmp, "studio", dirname(file)));
    writeFileSync(join(tmp, "generated", file), canonicalHtml(readFileSync(a, "utf8")));
    writeFileSync(join(tmp, "studio", file), canonicalHtml(readFileSync(b, "utf8")));
    const r = spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "-U3", `generated/${file}`, `studio/${file}`], { cwd: tmp, encoding: "utf8" });
    rmSync(tmp, { recursive: true, force: true });
    if (r.status === 0) out.push(`### ${file}: identical once Studio's own re-serialization is ignored (no real edit)\n`);
    else out.push(r.stdout || `### ${file}: could not diff (exit ${r.status}: ${r.error?.message || r.stderr})\n`);
  }
  return out.join("\n");
}

// ---------- derived status (what status.mjs, run.mjs and trace.html show) ----------

/** The approval key: the decision files of a human state (its config + its main decision output). */
export function reviewFiles(P, id) {
  const S = P.st[id];
  // soundbites.json counts only once it exists, so approvals made before sound bites still hold.
  if (id === ID.script) return [S.config, join(S.dir, "script.txt"), join(S.dir, "beats.json"), ...[join(S.dir, "soundbites.json")].filter(existsSync)];
  if (id === ID.edit) return [S.config, join(S.out, "timeline.json")];
  if (id === ID.sfx) return [S.config, join(S.out, "cues.json")];
  if (id === ID.music) return [S.config, join(S.out, "sections.json")];
  if (id === ID.deliver) {
    const g = readJsonIf(S.state)?.generated;
    return [S.config, ...(g ? Object.keys(g.files).map((f) => join(P.abs(g.dir), f)) : [])];
  }
  return [];
}

export function reviewKey(P, id) {
  return reviewFiles(P, id).map((f) => (f.endsWith(".html") ? htmlFingerprint(f) : fingerprint(f)) || "none").join("+");
}

/**
 * For every state: { code, reason, rec }.
 * code ∈ NOT RUN | RUNNING | INTERRUPTED | STUDIO EDIT | FAILED | STALE | NEEDS REVIEW | BLOCKED | OK
 */
export function deriveAll(P) {
  const out = {};
  for (const def of STATES) {
    const S = P.st[def.id];
    const rec = readJsonIf(S.state);
    const d = { def, rec, code: "OK", reason: "" };
    out[def.id] = d;
    const gate = def.gate ? out[def.gate] : null;
    const gateOk = !gate || gate.code === "OK";

    if (!rec) {
      d.code = gateOk ? "NOT RUN" : "BLOCKED";
      d.reason = gateOk ? "" : `state ${def.gate} is ${gate.code}`;
      const missing = gateOk && missingMedia(P, def);
      if (missing) {
        d.code = "BLOCKED";
        d.reason = missing;
      }
      continue;
    }
    if (rec.status === "running") {
      let alive = false;
      try {
        process.kill(rec.pid, 0);
        alive = true;
      } catch {}
      d.code = alive ? "RUNNING" : "INTERRUPTED";
      d.reason = alive ? `pid ${rec.pid}` : "the process stopped before the state finished. Run it again.";
      continue;
    }
    const edits = studioEdits(P, def.id);
    if (edits.length) {
      d.code = "STUDIO EDIT";
      d.reason = `changed by hand in Studio: ${edits.map((e) => `${e.file} (${e.how})`).join(", ")}. Port it into ${def.config} (or deliver.json) before rebuilding.`;
      d.edits = edits;
      continue;
    }
    if (rec.status === "failed") {
      d.code = "FAILED";
      d.reason = rec.error?.message?.split("\n")[0] || "";
      continue;
    }
    const changed = rec.inputs.filter((i) => fingerprint(P.abs(i.path)) !== i.fp);
    const dirDiff = (rec.watched || []).map((w) => {
      const now = listDir(P.abs(w.dir), new RegExp(w.re));
      const added = now.filter((f) => !w.files.includes(f)), removed = w.files.filter((f) => !now.includes(f));
      return added.length || removed.length ? `${w.dir}/: ${[...added.map((f) => `${f} added`), ...removed.map((f) => `${f} removed`)].join(", ")}` : null;
    }).filter(Boolean);
    if (dirDiff.length && !changed.length) {
      d.code = "STALE";
      d.reason = dirDiff.join("; ");
      continue;
    }
    if (changed.length) {
      d.code = "STALE";
      d.reason = changed
        .slice(0, 3)
        .map((i) => {
          const f = P.abs(i.path);
          return existsSync(f) ? `${shortPath(i.path)} changed ${statSync(f).mtime.toTimeString().slice(0, 5)}` : `${shortPath(i.path)} is missing`;
        })
        .join("; ");
      continue;
    }
    const badDep = def.deps.map((x) => out[x]).find((u) => !["OK", "NEEDS REVIEW"].includes(u.code));
    if (badDep) {
      d.code = "STALE";
      d.reason = `upstream state ${badDep.def.id} is ${badDep.code}`;
      continue;
    }
    if (!gateOk) {
      d.code = "BLOCKED";
      d.reason = `state ${def.gate} is ${gate.code}${gate.reason ? ` (${gate.reason})` : ""}`;
      continue;
    }
    if (rec.dry) {
      d.code = def.human ? "NEEDS REVIEW" : "STALE";
      d.reason = "last run was --dry: run it without --dry";
      continue;
    }
    if (def.human) {
      const r = rec.review || {};
      if (rec.skipped) {
        // brief.json says there is nothing to review (e.g. "narration": false): passes as OK.
        d.reason = rec.skipped;
      } else if (!r.approved) {
        d.code = "NEEDS REVIEW";
        d.reason = rec.preview?.url ? `built; the user reviews it in Studio (${rec.preview.url}) and approves` : "built; waiting for the user's approval";
      } else if (r.key !== reviewKey(P, def.id)) {
        d.code = "NEEDS REVIEW";
        d.reason = "outputs changed after the approval";
      } else if (def.id === ID.deliver && !rec.rendered) {
        d.reason = "approved; not rendered yet (--render)";
      }
      continue;
    }
  }
  return out;
}

export function nextCommand(P, d) {
  const S = `node .claude/skills/traced-edit/scripts`;
  const rel = relative(process.cwd(), P.root);
  const p = `"${(rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : P.root).split("\\").join("/")}"`;
  const id = d.def.id;
  switch (d.code) {
    case "NOT RUN":
    case "STALE":
    case "INTERRUPTED":
      return `${S}/run.mjs ${p} ${id}`;
    case "FAILED":
      return `read ${d.def.dir}/TRACE.md, fix ${id === ID.script ? "script.txt (or brief.json)" : d.def.config}, then ${S}/run.mjs ${p} ${id}`;
    case "NEEDS REVIEW":
      if (d.rec?.dry) return `${S}/run.mjs ${p} ${id}`;
      if (id === ID.script) return `show the user the script (${d.def.dir}/out/teleprompter.txt); record what they say with ${S}/feedback.mjs ${p} ${id} "..."; on their OK ${S}/approve.mjs ${p} ${id} --note "..."`;
      if (id === ID.edit) return `show the user ${d.def.dir}/review, then (on their OK) ${S}/approve.mjs ${p} ${id} --note "..."`;
      return `the user reviews the Studio preview (${S}/preview.mjs ${p} ${id} reopens it) or on the phone (${S}/review.mjs ${p}; their notes and approvals arrive by themselves); record what they say with ${S}/feedback.mjs ${p} ${id} "..."; on their OK ${S}/approve.mjs ${p} ${id} --note "..."`;
    case "STUDIO EDIT":
      return `${S}/studio-diff.mjs ${p} ${id}, port the change into the config, then ${S}/run.mjs ${p} ${id} --ported "<what went where>"`;
    case "BLOCKED":
      if (d.reason.startsWith("no footage")) return `${S}/init.mjs ${p} --media <recorded video>`;
      if (d.reason.startsWith("no voiceover")) return `${S}/init.mjs ${p} --voice <recorded voiceover>`;
      return `finish state ${d.def.gate} first`;
    default:
      return id === ID.deliver && d.rec && !d.rec.rendered ? `${S}/run.mjs ${p} ${ID.deliver} --render` : "";
  }
}

// ---------- TRACE.md ----------

function traceMd(P, r, prev, feedback = [], edits = []) {
  const L = [];
  const icon = r.status === "ok" ? "OK" : "**FAILED**";
  L.push(`# State ${r.id} · ${r.name} — ${icon}`, "");
  L.push(`Ran ${localTime(r.startedAt)} for ${(r.ms / 1000).toFixed(1)} s. Args: \`${JSON.stringify(r.args)}\`${r.dry ? " — **dry run**" : ""}.`, "");
  if (r.error) {
    L.push("## What went wrong", "", "```", r.error.message, "```", "");
    if (r.error.command) {
      L.push(`Failing command $${r.error.command.n} (${r.error.command.why || ""})${r.error.command.cwd ? `, run from \`${r.error.command.cwd}\`` : ""}. Paste it into Git Bash to reproduce:`, "", "```bash", r.error.command.cmd, "```", "");
      if (r.error.command.stderrTail) L.push("Its stderr (last lines):", "", "```", r.error.command.stderrTail, "```", "");
    }
    if (r.error.stack) L.push("Script stack (this is a bug in the skill, not in your config):", "", "```", r.error.stack, "```", "");
  }
  if (edits.length) {
    L.push("## ⚠ Changed by hand in Studio", "",
      "These generated files no longer match what the build wrote. The next build would overwrite them, so it is refused until the change is ported into the config:", "",
      ...edits.map((e) => `- \`${r.generated.dir}/${e.file}\` ${e.how}`), "",
      `See the change with \`studio-diff.mjs <project> ${r.id}\`. After porting it, rebuild with \`run.mjs <project> ${r.id} --ported "<what went where>"\`.`, "");
  }
  if (r.preview) {
    L.push("## Studio preview", "", r.preview.ok && r.preview.stoppedAt
      ? `Was at ${r.preview.url} (opened ${localTime(r.preview.at)}, stopped ${localTime(r.preview.stoppedAt)} when another preview opened). Reopen it with \`preview.mjs <project> ${r.id}\`.`
      : r.preview.ok
      ? `Open: **${r.preview.url}** (opened ${localTime(r.preview.at)}). Reopen it with \`preview.mjs <project> ${r.id}\`.`
      : `The preview did not start: ${r.preview.error || "unknown error"}. Retry with \`preview.mjs <project> ${r.id}\`.`, "");
  }
  if (feedback.length) {
    L.push("## Feedback and approvals (the user's words)", "",
      ...feedback.map((f) => `- ${f.at ? localTime(f.at) : ""} **${f.kind}**: ${feedbackLine(f)}${f.diff ? ` (diff: \`${f.diff}\`)` : ""}`), "");
  }
  if (r.portedEdits?.length) {
    L.push("## Studio edits ported into the config", "", ...r.portedEdits.map((x) => `- ${localTime(x.at)}: ${x.note} (diff \`${x.diff}\`)`), "");
  }
  if (prev) {
    const before = Object.fromEntries((prev.inputs || []).map((i) => [i.path, i.fp]));
    const diff = r.inputs.filter((i) => before[i.path] !== i.fp).map((i) => `- \`${shortPath(i.path)}\` ${before[i.path] === undefined ? "is new" : "changed"}`);
    const gone = (prev.inputs || []).filter((i) => !r.inputs.some((x) => x.path === i.path)).map((i) => `- \`${shortPath(i.path)}\` no longer used`);
    L.push("## Changed since the previous run", "", ...(diff.length + gone.length ? [...diff, ...gone] : ["- no input changed (same inputs as last time)"]), "");
  }
  L.push("## Inputs", "", "| file | role | fingerprint |", "|---|---|---|", ...r.inputs.map((i) => `| \`${shortPath(i.path)}\` | ${i.role} | ${i.fp ?? "MISSING"} |`), "");
  if (r.params) L.push("## Params (snapshot of the config used)", "", "```json", JSON.stringify(r.params, null, 2).slice(0, 4000), "```", "");
  if (r.notes.length) L.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  L.push("## Commands", "", r.commands.length ? "Each one can be pasted into Git Bash (from the project root unless a cwd is given)." : "None.", "");
  for (const c of r.commands) L.push(`**$${c.n}** ${c.why || ""} — exit ${c.exit}, ${(c.ms / 1000).toFixed(1)} s${c.cwd ? `, cwd \`${c.cwd}\`` : ""}`, "", "```bash", c.cmd, "```", "");
  L.push("## Outputs", "", "| file | what | size |", "|---|---|---|", ...r.outputs.map((o) => `| \`${o.path}\` | ${o.note} | ${o.bytes == null ? "MISSING" : fmtBytes(o.bytes)} |`), "");
  if (r.checks.length) L.push("## Checks", "", ...r.checks.map((c) => `- ${c.pass ? "PASS" : "**FAIL**"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`), "");
  if (r.warnings.length) L.push("## Warnings", "", ...r.warnings.map((w) => `- ${w}`), "");
  if (r.images.length) L.push("## Pictures", "", ...r.images.map((i) => `- \`${i.path}\` ${i.caption}`), "");
  L.push("Full log: `log.txt` (previous run: `log.prev.txt`, `state.prev.json`). Whole pipeline: `trace.html` in the project root.");
  return L.join("\n") + "\n";
}

export function fmtBytes(b) {
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(2) + " GB";
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(1) + " MB";
  if (b > 1 << 10) return (b / (1 << 10)).toFixed(0) + " KB";
  return b + " B";
}

export function localTime(iso) {
  const d = new Date(iso);
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
