#!/usr/bin/env node
// Run one state of a traced-edit project, or every state that is not OK yet.
//
//   node run.mjs <project> <1-7|script|audio|video|edit|sfx|music|deliver|all> [flags]
//
// --dry              states 4, 5, 6: timeline / cue sheet / section table only (fast; no gate)
// --render           state 7: render the APPROVED project (long; run it in the background)
// --no-preview       states 4, 5, 6, 7: do not start the Studio preview after the build
// --no-open          start the Studio server but do not pop up a browser tab (headless/remote, or
//                    while the user reviews on the phone)
// --no-phone         states 4, 5, 6, 7: do not start the phone review server (review.mjs)
// --ported "<note>"  rebuild a state whose preview was edited by hand in Studio, after the edit
//                    was ported into the config; the Studio diff is archived in the trace
//
// Each run writes the state's state.json, log.txt and TRACE.md, opens the Studio preview for
// states 4-7 and keeps the phone review server up (it serves the new out/preview.mp4 at once),
// then refreshes trace.html.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ctx, addFeedback, deriveAll, nextCommand, studioDiff, studioEdits } from "./lib/trace.mjs";
import { ID, PREVIEW_STATES, STATES, ensureDir, isProject, missingMedia, project, readJsonIf, stateDef } from "./lib/paths.mjs";
import { openPreview } from "./lib/preview.mjs";
import { ensureReviewServer, phoneUrls } from "./lib/review.mjs";
import { writeTraceHtml } from "./lib/trace-html.mjs";
import { printStatus } from "./status.mjs";

const MODULES = {
  1: () => import("./states/1-script.mjs"),
  2: () => import("./states/2-audio-analysis.mjs"),
  3: () => import("./states/3-video-analysis.mjs"),
  4: () => import("./states/4-video-edition.mjs"),
  5: () => import("./states/5-sound-effects.mjs"),
  6: () => import("./states/6-music.mjs"),
  7: () => import("./states/7-deliver.mjs"),
};

const args = process.argv.slice(2);
const pi = args.indexOf("--ported");
const flags = {
  dry: args.includes("--dry"),
  render: args.includes("--render"),
  preview: !args.includes("--no-preview"),
  open: !args.includes("--no-open"),
  phone: !args.includes("--no-phone"),
  ported: pi >= 0 ? args[pi + 1] : null,
};
const [projArg, which] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--ported");
if (!projArg || !which) {
  console.error("usage: node run.mjs <project> <1-7|script|audio|video|edit|sfx|music|deliver|all> [--dry] [--render] [--no-preview] [--no-open] [--no-phone] [--ported \"note\"]");
  process.exit(2);
}
if (pi >= 0 && !flags.ported) {
  console.error('ERROR: --ported needs a note: what was moved from the Studio edit into which config.');
  process.exit(2);
}
const P = project(projArg);
if (!isProject(P)) {
  console.error(`ERROR: ${P.root} is not a traced-edit project (no traced-edit.json). Run init.mjs first.`);
  process.exit(2);
}

async function runOne(def) {
  const all = deriveAll(P);
  const me = all[def.id];

  // A hand edit in Studio would be overwritten by this build: refuse until it is ported.
  const edits = studioEdits(P, def.id);
  let ported = null;
  if (edits.length) {
    if (!flags.ported) {
      console.error(`\nBLOCKED: the Studio preview of state ${def.id} was edited by hand (${edits.map((e) => `${e.file} ${e.how}`).join(", ")}).`);
      console.error(`Rebuilding would throw that work away. Next: ${nextCommand(P, me)}`);
      return "blocked";
    }
    const S = P.st[def.id];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = join(ensureDir(join(S.dir, "studio-edits")), `${stamp}.diff`);
    writeFileSync(file, `# Studio edit on state ${def.id}, ported: ${flags.ported}\n\n${studioDiff(P, def.id)}`);
    ported = { at: new Date().toISOString(), note: flags.ported, diff: P.rel(file), files: edits.map((e) => e.file) };
    addFeedback(P, def.id, { kind: "studio-edit", text: flags.ported, diff: P.rel(file) });
    console.log(`Studio edit archived: ${P.rel(file)}`);
  }

  if (def.id === ID.deliver && flags.render && me.code !== "OK") {
    console.error(`\nBLOCKED: the render needs state 7 approved by the user, but it is ${me.code}${me.reason ? `: ${me.reason}` : ""}.`);
    console.error(`Next: ${nextCommand(P, me)}`);
    return "blocked";
  }
  if (def.gate && !flags.dry) {
    const g = all[def.gate];
    if (g.code !== "OK") {
      console.error(`\nBLOCKED: state ${def.id} (${def.name}) needs state ${def.gate} approved, but it is ${g.code}${g.reason ? `: ${g.reason}` : ""}.`);
      console.error(`Next: ${nextCommand(P, g)}`);
      return "blocked";
    }
  }
  for (const dep of def.deps) {
    const u = all[dep];
    if (!["OK", "NEEDS REVIEW"].includes(u.code) && !(flags.dry && u.rec)) {
      console.error(`\nBLOCKED: upstream state ${dep} is ${u.code}${u.reason ? `: ${u.reason}` : ""}. Next: ${nextCommand(P, u)}`);
      return "blocked";
    }
  }
  const missing = missingMedia(P, def);
  if (missing) {
    console.error(`\nBLOCKED: state ${def.id} (${def.name}): ${missing}. Next: ${nextCommand(P, { ...me, code: "BLOCKED", reason: missing })}`);
    return "blocked";
  }
  const opts = {};
  if (flags.dry && [ID.edit, ID.sfx, ID.music].includes(def.id)) opts.dry = true;
  if (flags.render && def.id === ID.deliver) opts.render = true;
  console.log(`\n=== state ${def.id} · ${def.name}${opts.dry ? " (dry)" : ""}${opts.render ? " (render)" : ""} ===`);
  const ctx = new Ctx(P, def, opts);
  if (ported) ctx.extra.portedEdits = [...(ctx.carry?.portedEdits || []), ported];
  let status;
  try {
    const mod = await MODULES[def.id]();
    await mod.run(ctx);
    status = ctx.end();
  } catch (e) {
    status = ctx.end(e);
  }
  const S = P.st[def.id];
  if (status === "failed") {
    console.error(`\nSTATE ${def.id} FAILED. Read ${P.rel(S.dir)}/TRACE.md (what went wrong + the command to reproduce).`);
  } else {
    console.log(`\nstate ${def.id} OK — ${ctx.checks.filter((c) => c.pass).length} checks passed, ${ctx.warnings.length} warning(s). Trace: ${P.rel(S.dir)}/TRACE.md`);
    // The feedback popup: every time the inserts, sound, music or the animations are (re)built.
    if (PREVIEW_STATES.includes(def.id) && !opts.dry && !opts.render && flags.preview && readJsonIf(S.state)?.generated) await openPreview(P, def.id, { open: flags.open });
    // The phone review page polls the server, so a running page sees the new build by itself.
    if (PREVIEW_STATES.includes(def.id) && !opts.dry && flags.phone) {
      const reg = await ensureReviewServer(P);
      if (reg) console.log(`\n📱 PHONE REVIEW (state ${def.id}): ${phoneUrls(reg)[0] || `no LAN address; QR page http://127.0.0.1:${reg.port}/qr`}`);
    }
  }
  return status;
}

let exit = 0;
try {
  if (which === "all") {
    for (const def of STATES) {
      const d = deriveAll(P)[def.id];
      if (d.code === "OK") continue;
      const missing = missingMedia(P, def);
      if (missing) {
        console.log(`\nstate ${def.id}: ${missing}. Next: ${nextCommand(P, { ...d, code: "BLOCKED", reason: missing })}`);
        break;
      }
      if (d.code === "NEEDS REVIEW" && !d.rec?.dry) {
        console.log(`\nstate ${def.id} is waiting for review: ${d.reason}. Stopping here.`);
        break;
      }
      const r = await runOne(def);
      if (r !== "ok") {
        exit = 1;
        break;
      }
      if (def.human && deriveAll(P)[def.id].code !== "OK") {
        console.log(`\nstate ${def.id} built. It needs the user's review before the pipeline continues.`);
        break;
      }
    }
  } else {
    const def = stateDef(which);
    if (!def) throw new Error(`unknown state "${which}"`);
    const r = await runOne(def);
    exit = r === "ok" ? 0 : 1;
  }
} finally {
  writeTraceHtml(P);
  printStatus(P);
}
process.exit(exit);
