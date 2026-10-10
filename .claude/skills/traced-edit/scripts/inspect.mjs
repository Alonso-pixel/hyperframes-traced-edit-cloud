#!/usr/bin/env node
// Look closer at the source or the cut. Pictures go to <project>/inspect/ and every ffmpeg
// command is appended to inspect/log.txt (inspection never changes a state).
//
//   node inspect.mjs <project> strip <sec> [dur=1.5] [--cut]
//        10 tiles per second, each stamped with its time. Find the exact frame of an event.
//   node inspect.mjs <project> frame <sec> [--cut]
//        One full frame with a coordinate grid (1080x1920 video px).
//   node inspect.mjs <project> sheet <from> <to> [step=1] [--cut]
//        Timestamped contact sheet for any range.
// Times are SOURCE seconds, or CUT seconds with --cut (states/4.../out/cut.mp4).
//   … --asset <file>   the same, on a clip of the shared library (path relative to videos/ASSETS,
//                      e.g. clips/avenida-inundada-coatepec.mp4): pick an insert and its "from".
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gridFilter, sheet, strip } from "./lib/media.mjs";
import { ID, UserError, assetFile, ensureDir, project, sourceVideo } from "./lib/paths.mjs";
import { Ctx } from "./lib/trace.mjs";

const args = process.argv.slice(2);
const useCut = args.includes("--cut");
const ai = args.indexOf("--asset");
const assetRel = ai >= 0 ? args[ai + 1] : null;
const [projArg, cmd, ...rest] = args.filter((a, i) => a !== "--cut" && (ai < 0 || (i !== ai && i !== ai + 1)));
if (!projArg || !cmd) {
  console.error("usage: node inspect.mjs <project> strip|frame|sheet … [--cut]  (see the header of this file)");
  process.exit(2);
}
const P = project(projArg);
let video;
try {
  video = assetRel ? assetFile(assetRel, "", "--asset").file : useCut ? join(P.st[ID.edit].out, "cut.mp4") : sourceVideo(P).file;
} catch (e) {
  if (!(e instanceof UserError)) throw e;
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
if (!existsSync(video)) {
  console.error(`ERROR: ${video} does not exist${useCut ? " (run state 4 without --dry)" : ""}`);
  process.exit(1);
}
const dir = ensureDir(join(P.root, "inspect"));
const tag = assetRel ? `asset-${assetRel.split(/[\\/]/).pop().replace(/\.[^.]+$/, "")}` : useCut ? "cut" : "src";

// A minimal ctx: same exec/ffmpeg tracing as a state, written to inspect/log.txt.
const ctx = Object.create(Ctx.prototype);
Object.assign(ctx, { P, commands: [], t0: Date.now(), logFile: join(dir, "log.txt") });
ctx.log = (m) => appendFileSync(ctx.logFile, `${new Date().toISOString()} ${m}\n`);

let out;
if (cmd === "strip") {
  const [t, d = "1.5"] = rest;
  out = strip(ctx, video, +t, +d, 10, join(dir, `${tag}-strip-${(+t).toFixed(2)}.jpg`));
  console.log("Each tile is 0.1 s; the stamp is the time in the " + (assetRel ? "library clip" : useCut ? "cut" : "source") + ".");
} else if (cmd === "frame") {
  const [t] = rest;
  out = join(dir, `${tag}-frame-${(+t).toFixed(2)}.jpg`);
  ctx.ffmpeg(["-ss", String(t), "-i", video, "-frames:v", "1", "-vf", gridFilter(), out], { why: "grid frame" });
  console.log("Grid lines every 100 video px; numbers are video px (1080 wide, 1920 tall).");
} else if (cmd === "sheet") {
  const [a, b, step = "1"] = rest;
  // A library clip keeps its own aspect (b-roll is often landscape); the footage is 9:16.
  out = sheet(ctx, video, +a, +b, +step, join(dir, `${tag}-sheet-${(+a).toFixed(1)}-${(+b).toFixed(1)}.jpg`), "contact sheet", assetRel ? "-2:240" : "180:320");
} else {
  console.error(`unknown command "${cmd}"`);
  process.exit(2);
}
console.log(out);
