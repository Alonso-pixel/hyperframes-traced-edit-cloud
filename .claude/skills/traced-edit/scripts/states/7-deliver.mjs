// State 7 · deliver (human review). Builds the final HyperFrames project from the approved cut
// (state 4), sound effects (5) and music (6), injects the event times into the overlay (the
// animations), checks it, snapshots every event and opens it in Studio for the user's feedback.
// The render only runs with --render AFTER the user approved this state.
//   deliverables/<project>/       GENERATED project (index.html, compositions/overlay.html, assets/)
//   deliverables/snapshots/       one frame per event (+0.3 s) and contact sheets
//   deliverables/check.txt        full `hyperframes check` output
//   deliverables/<output>.mp4     the render (--render)
//   deliverables/out/preview.mp4  phone proxy: cut + sfx + music at deliver.json volumes (no overlay;
//                                 after --render the phone plays the render itself)
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProject } from "../lib/hfproject.mjs";
import { phoneProxy } from "../lib/review.mjs";
import { probe } from "../lib/media.mjs";
import { ID, DEFAULT_HF, UserError, ensureDir, listFiles, previewDir, readJson } from "../lib/paths.mjs";
import { reviewKey } from "../lib/trace.mjs";

export const DEFAULT_DELIVER = {
  hyperframes: DEFAULT_HF,
  output: "video.mp4",
  previewPort: 3017,
  volumes: { base: 1, sfx: 1, music: 1, voice: 1, ambience: 1 }, // voice + ambience: footage mode only
  // e.g. { "template": "counter", "vars": { "label": "#EsRoberto", "fastPiece": "B", "accent": "#39e43a" }, "css": "" }
  overlay: null,
  snapshots: true,
};

export async function run(ctx) {
  const { P, S, opts } = ctx;
  const cfg = { ...DEFAULT_DELIVER, ...readJson(S.config) };
  cfg.volumes = { ...DEFAULT_DELIVER.volumes, ...(cfg.volumes || {}) };
  ctx.params = cfg;
  const files = {
    timeline: join(P.st[ID.edit].out, "timeline.json"),
    cut: join(P.st[ID.edit].out, "cut.mp4"),
    sfx: join(P.st[ID.sfx].out, "sfx-mix.wav"),
    music: join(P.st[ID.music].out, "music-mix.wav"),
  };
  const from = { timeline: ID.edit, cut: ID.edit, sfx: ID.sfx, music: ID.music };
  for (const [k, f] of Object.entries(files)) if (!existsSync(f)) throw new UserError(`missing ${P.rel(f)}. Run state ${from[k]} without --dry first.`);
  ctx.input(S.config, "deliver settings");
  ctx.input(files.timeline, "timeline from state 4");
  ctx.input(files.cut, "cut from state 4");
  ctx.input(files.sfx, "sfx stem from state 5");
  ctx.input(files.music, "music stem from state 6");
  if (!cfg.overlay) ctx.note("no overlay (deliver.json overlay is null)");

  const { dir, duration: D, tl } = buildProject(ctx, P, previewDir(P, ID.deliver), { sfx: files.sfx, music: files.music, overlay: cfg.overlay, volumes: cfg.volumes });

  const npx = (args, why, allowFail = false) => ctx.exec("npx", ["--yes", `hyperframes@${cfg.hyperframes}`, ...args], { shell: true, cwd: dir, why, allowFail });

  if (opts.render) {
    // The approval covers deliver.json + the generated files; a deterministic rebuild must not change them.
    const approved = ctx.review?.approved ? ctx.review.key : null;
    if (!approved) throw new UserError("state 7 is not approved. The user reviews the Studio preview first; then approve.mjs <project> 7 --note \"...\".");
    if (approved !== reviewKey(P, ID.deliver))
      throw new UserError("the project changed since the user approved it (deliver.json or an upstream state). Run state 7 again without --render and get a new approval.");
    ctx.note("approved by the user; rendering the approved project");
    const outFile = resolve(S.dir, cfg.output);
    npx(["render", "-o", `"${outFile}"`], "render the final video");
    const info = probe(ctx, outFile);
    ctx.output(outFile, `${info.duration}s ${info.width}x${info.height}`);
    ctx.check("render duration equals the timeline", Math.abs(info.duration - D) <= 0.1, `${info.duration}s vs ${D}s`);
    ctx.check("render has an audio stream", info.hasAudio);
    ctx.extra.rendered = true;
    return;
  }

  const chk = npx(["check"], "hyperframes check", true);
  const chkOut = chk.stdout + chk.stderr;
  writeFileSync(join(S.dir, "check.txt"), chkOut);
  ctx.output(join(S.dir, "check.txt"), "full hyperframes check output");
  ctx.check("hyperframes check", chk.status === 0 && !/Check failed/.test(chkOut), chkOut.split("\n").filter((l) => /✗|error\(s\)|Check (passed|failed)/.test(l)).join(" | ").slice(0, 400));
  if (ctx.checks.at(-1).pass === false) return;

  if (cfg.snapshots && tl.events.length) {
    const sdir = join(S.dir, "snapshots");
    if (existsSync(sdir)) rmSync(sdir, { recursive: true, force: true });
    ensureDir(sdir);
    const times = tl.events.map((e) => +Math.min(D - 0.05, e.t + 0.3).toFixed(2));
    const BATCH = 12;
    for (let i = 0; i < times.length; i += BATCH) {
      const out = join(sdir, `batch-${String(i / BATCH + 1).padStart(2, "0")}`);
      npx(["snapshot", ".", "--at", times.slice(i, i + BATCH).join(","), "--no-end", "--describe", "false", "-o", `"${out}"`, "--timeout", "30000"], `snapshots ${i + 1}-${Math.min(times.length, i + BATCH)}`);
      for (const f of listFiles(out, /contact-sheet.*\.jpg$/)) ctx.image(f, `events ${i + 1}–${Math.min(times.length, i + BATCH)} at +0.3 s: the counter must read each event's number`);
    }
    ctx.output(sdir, `${times.length} event snapshots`);
  }
  phoneProxy(ctx, P, { sfx: files.sfx, music: files.music });
  ctx.extra.rendered = false;
  ctx.note(`not rendered: the user reviews the Studio preview and approves first; then run.mjs <project> ${ID.deliver} --render.`);
}
