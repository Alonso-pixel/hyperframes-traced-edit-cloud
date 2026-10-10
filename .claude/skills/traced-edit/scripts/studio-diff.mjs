#!/usr/bin/env node
// What did the user change by hand in a Studio preview? Prints a unified diff between what the
// build generated (.pristine-<name>/) and what is in the project now. Port each change into the
// config (see SKILL.md "Porting a Studio edit"), then rebuild with run.mjs <project> <id> --ported "…".
//
//   node studio-diff.mjs <project> <4|5|6|7|edit|sfx|music|deliver>
import { studioDiff, studioEdits } from "./lib/trace.mjs";
import { project, stateDef } from "./lib/paths.mjs";

const [projArg, which] = process.argv.slice(2);
const def = which && stateDef(which);
if (!projArg || !def) {
  console.error("usage: node studio-diff.mjs <project> <4|5|6|7>");
  process.exit(2);
}
const P = project(projArg);
const edits = studioEdits(P, def.id);
if (!edits.length) {
  console.log(`no hand edits in the Studio preview of state ${def.id}.`);
  process.exit(0);
}
console.log(`state ${def.id}: ${edits.map((e) => `${e.file} ${e.how}`).join(", ")}\n`);
console.log(studioDiff(P, def.id));
