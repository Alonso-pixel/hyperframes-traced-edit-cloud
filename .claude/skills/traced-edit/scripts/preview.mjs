#!/usr/bin/env node
// Open (or reopen) the HyperFrames Studio preview of a state, so the user can watch, listen and
// give feedback. run.mjs does this automatically after states 4, 5, 6 and 7; use this to reopen it.
//
//   node preview.mjs <project> <4|5|6|7|edit|sfx|music|deliver>  open Studio on that state's project
//   node preview.mjs <project> --status                     what this skill has running
//   node preview.mjs <project> --stop                       stop it
// --no-open starts the server without popping up a browser tab.
import { PREVIEW_STATES, project, stateDef } from "./lib/paths.mjs";
import { openPreview, previewStatus, stopPreviews } from "./lib/preview.mjs";
import { writeTraceHtml } from "./lib/trace-html.mjs";

const args = process.argv.slice(2);
const [projArg, which] = args.filter((a) => !a.startsWith("--"));
if (!projArg) {
  console.error("usage: node preview.mjs <project> <4|5|6|7> | --status | --stop");
  process.exit(2);
}
const P = project(projArg);
if (args.includes("--stop")) {
  stopPreviews(P);
} else if (args.includes("--status")) {
  const list = previewStatus(P);
  if (!list.length) console.log("no preview started by traced-edit for this project.");
  for (const e of list) console.log(`state ${e.id}: ${e.state}  ${e.url}`);
} else {
  const def = which && stateDef(which);
  if (!def || !PREVIEW_STATES.includes(def.id)) {
    console.error(`ERROR: previews exist for states ${PREVIEW_STATES.join(", ")} (edit, sfx, music, deliver).`);
    process.exit(2);
  }
  const info = await openPreview(P, def.id, { open: !args.includes("--no-open") });
  if (!info?.ok) process.exitCode = 1;
}
writeTraceHtml(P);
