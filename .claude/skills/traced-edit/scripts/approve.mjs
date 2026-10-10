#!/usr/bin/env node
// Record the USER's approval of a human-review state (1 script, 4 edit, 5 sfx, 6 music, 7 deliver). Only
// run this after the user has looked (and listened, in the Studio preview) and said yes; put
// what they said in --note.
//
//   node approve.mjs <project> <1|4|5|6|7|script|edit|sfx|music|deliver> --note "what the user said"
//   node approve.mjs <project> <id> --revoke
//
// The approval stores a fingerprint of the state's decision files (its config + timeline.json /
// cues.json / sections.json / the generated deliver project). If any of them changes later,
// the approval no longer holds and status shows NEEDS REVIEW.
import { addFeedback, approveState, patchState } from "./lib/trace.mjs";
import { project, readJsonIf, stateDef } from "./lib/paths.mjs";
import { writeTraceHtml } from "./lib/trace-html.mjs";
import { printStatus } from "./status.mjs";

const args = process.argv.slice(2);
const [projArg, which] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--note");
const ni = args.indexOf("--note");
const note = ni >= 0 ? args[ni + 1] : null;
const def = which && stateDef(which);
if (!projArg || !def) {
  console.error('usage: node approve.mjs <project> <1|4|5|6|7> --note "what the user said"   |   --revoke');
  process.exit(2);
}
if (!def.human) {
  console.error(`ERROR: state ${def.id} (${def.name}) is not a human-review state.`);
  process.exit(1);
}
const P = project(projArg);
const S = P.st[def.id];
const rec = readJsonIf(S.state);
if (args.includes("--revoke")) {
  if (rec) patchState(P, def.id, { review: { approved: false, revokedAt: new Date().toISOString() } });
  addFeedback(P, def.id, { kind: "revoked", text: note || "" });
  console.log(`state ${def.id} approval revoked.`);
} else {
  // The same checks as the phone review page (lib/trace.mjs approveState).
  const why = approveState(P, def.id, note);
  if (why) {
    console.error(`ERROR: ${why}`);
    process.exit(1);
  }
  console.log(`state ${def.id} approved: "${note}"`);
}
writeTraceHtml(P);
printStatus(P);
