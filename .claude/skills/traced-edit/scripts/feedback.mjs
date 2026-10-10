#!/usr/bin/env node
// Record what the user said about a state (usually while watching its Studio preview), so every
// config change in the trace has a visible reason: feedback -> config edit -> rerun -> approval.
//
//   node feedback.mjs <project> <1|4|5|6|7|script|edit|sfx|music|deliver> "what the user said"
//   node feedback.mjs <project> <id> --reply "what Claude changed"   (answer to a phone note; the
//                                                                     user reads it on the phone)
//   node feedback.mjs <project> <id>            (list the feedback so far)
//
// Entries go to <state dir>/feedback.jsonl and show in TRACE.md, trace.html and the phone page.
// Notes made on the phone page (review.mjs) land in the same file with source "phone".
import { addFeedback, feedbackLine, readFeedback, rewriteTraceMd, localTime } from "./lib/trace.mjs";
import { project, stateDef } from "./lib/paths.mjs";
import { writeTraceHtml } from "./lib/trace-html.mjs";

const args = process.argv.slice(2);
const reply = args.includes("--reply");
const [projArg, which, ...words] = args.filter((a) => a !== "--reply");
const def = which && stateDef(which);
if (!projArg || !def) {
  console.error('usage: node feedback.mjs <project> <state> [--reply] "what the user said"');
  process.exit(2);
}
const P = project(projArg);
const text = words.join(" ").trim();
if (text) {
  addFeedback(P, def.id, reply ? { kind: "reply", source: "claude", text } : { kind: "feedback", text });
  rewriteTraceMd(P, def.id);
  writeTraceHtml(P);
  console.log(`${reply ? "reply" : "feedback"} recorded on state ${def.id} (${def.name}).`);
}
for (const f of readFeedback(P, def.id)) console.log(`  ${f.at ? localTime(f.at) : ""}  ${f.kind.padEnd(11)} ${feedbackLine(f)}${f.diff ? `  [${f.diff}]` : ""}`);
