#!/usr/bin/env node
// Where is the pipeline, and what is wrong? One line per state, plus the next command.
// Also rewrites <project>/trace.html.
//
//   node status.mjs <project>
import { pathToFileURL } from "node:url";
import { deriveAll, localTime, nextCommand } from "./lib/trace.mjs";
import { STATES, project } from "./lib/paths.mjs";
import { writeTraceHtml } from "./lib/trace-html.mjs";

const COLORS = { OK: 32, "NOT RUN": 90, STALE: 33, "NEEDS REVIEW": 36, BLOCKED: 35, FAILED: 31, RUNNING: 34, INTERRUPTED: 31, "STUDIO EDIT": 31 };
const paint = (code, s) => (process.stdout.isTTY ? `\x1b[${COLORS[code] || 0}m${s}\x1b[0m` : s);

export function printStatus(P) {
  const all = deriveAll(P);
  console.log(`\n${P.root}`);
  for (const def of STATES) {
    const d = all[def.id];
    const r = d.rec;
    const when = r ? localTime(r.startedAt).slice(5, 16) : "";
    const dur = r ? `${(r.ms / 1000).toFixed(0)}s` : "";
    const checks = r ? `${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks` : "";
    const warn = r?.warnings?.length ? `${r.warnings.length} warn` : "";
    console.log(`  ${def.id} ${def.name.padEnd(15)} ${paint(d.code, d.code.padEnd(12))} ${when.padEnd(12)} ${dur.padStart(5)}  ${checks.padEnd(11)} ${warn}`);
    if (d.reason) console.log(`      ${d.reason}`);
    if (r?.preview?.ok && !r.preview.stoppedAt) console.log(`      preview: ${r.preview.url}`);
    const next = nextCommand(P, d);
    if (next) console.log(`      next: ${next}`);
  }
  console.log(`  trace: ${P.trace}`);
  return all;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node status.mjs <project>");
    process.exit(2);
  }
  const P = project(arg);
  writeTraceHtml(P);
  printStatus(P);
}
