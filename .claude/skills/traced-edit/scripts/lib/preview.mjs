// The Studio preview popup. After states 4, 5, 6 and 7 build their HyperFrames project, run.mjs
// opens it in HyperFrames Studio (`hyperframes preview --background`, which opens the browser)
// so the user can watch, listen and give feedback. One server per traced-edit project at a time:
// opening a new one stops the previous one. Servers this skill started are listed in
// <project>/.previews.json; every start/stop is logged to the state's log.txt and recorded in
// its state.json under "preview".
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { hfSettings, publicUrl, readJsonIf, writeJson } from "./paths.mjs";
import { patchState } from "./trace.mjs";

const registry = (P) => join(P.root, ".previews.json");

function npxPreview(P, args) {
  const { hf } = hfSettings(P);
  const cmd = `npx --yes hyperframes@${hf} preview ${args.map((a) => (/^[\w@=.:/-]+$/.test(a) ? a : `"${a}"`)).join(" ")}`;
  const t = Date.now();
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 1 << 26, timeout: 240000 });
  const out = (r.stdout || "") + (r.stderr || "");
  let json = null;
  for (const line of out.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      json = JSON.parse(line);
      break;
    } catch {}
  }
  return { cmd, status: r.status, ms: Date.now() - t, json, tail: out.split("\n").filter((l) => l.trim()).slice(-8).join("\n") };
}

function logTo(P, id, lines) {
  const f = join(P.st[id].dir, "log.txt");
  if (existsSync(f)) appendFileSync(f, lines.map((l) => `[preview] ${l}`).join("\n") + "\n");
}

/** Stop every preview server this skill started for the project (or only the one of `id`). */
export function stopPreviews(P, id = null) {
  const list = readJsonIf(registry(P)) || [];
  const keep = [];
  for (const e of list) {
    if (id && e.id !== id) {
      keep.push(e);
      continue;
    }
    const r = npxPreview(P, [P.abs(e.dir), "--stop", "--json"]);
    logTo(P, e.id, [`stopped ${e.url} (exit ${r.status}): ${r.cmd}`]);
    const rec = readJsonIf(P.st[e.id].state);
    if (rec?.preview) patchState(P, e.id, { preview: { ...rec.preview, stoppedAt: new Date().toISOString() } });
    console.log(`preview stopped: ${e.url}`);
  }
  writeJson(registry(P), keep);
}

async function reachable(url, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/** Start Studio on the state's generated project and record where it is. */
export async function openPreview(P, id, { open = true } = {}) {
  const rec = readJsonIf(P.st[id].state);
  if (!rec?.generated) {
    console.log(`state ${id} has no HyperFrames project to preview yet.`);
    return null;
  }
  const dir = P.abs(rec.generated.dir);
  const { port } = hfSettings(P);
  stopPreviews(P);
  const r = npxPreview(P, [dir, "--background", "--port", String(port), "--json", open ? "--open" : "--no-open"]);
  const res = r.json?.result || {};
  const localUrl = res.studioUrl || `http://127.0.0.1:${res.port || port}/#project/${encodeURIComponent(basename(dir))}`;
  const pub = publicUrl(res.port || port);
  const url = pub ? pub + localUrl.replace(/^https?:\/\/[^/]+/, "") : localUrl;
  const ok = r.status === 0 && r.json?.ok !== false && (await reachable(res.serverUrl || localUrl.split("#")[0]));
  const info = {
    ok, stoppedAt: undefined, url, port: res.port || port, dir: P.rel(dir), at: new Date().toISOString(), cmd: r.cmd,
    pid: res.pid, serverLog: res.logPath, error: ok ? undefined : r.json?.error?.message || r.tail,
  };
  patchState(P, id, { preview: info });
  logTo(P, id, [`$ ${r.cmd}`, ok ? `Studio is up: ${url} (pid ${res.pid}, server log ${res.logPath})` : `FAILED (exit ${r.status}):\n${r.tail}`]);
  if (ok) {
    writeJson(registry(P), [{ id, dir: P.rel(dir), url, port: info.port, at: info.at }]);
    console.log(`\n▶ PREVIEW (state ${id}) — ${open ? "opened in your browser" : "server running, no browser tab (--no-open)"}: ${url}`);
    console.log(`  Watch it, then tell Claude what to change. Changes made by hand in Studio are detected and must be ported into the config.`);
  } else {
    console.log(`\nthe Studio preview did not start (state ${id}). Details in ${P.rel(join(P.st[id].dir, "log.txt"))}:\n${r.tail}`);
  }
  return info;
}

export function previewStatus(P) {
  const list = readJsonIf(registry(P)) || [];
  return list.map((e) => {
    const r = npxPreview(P, [P.abs(e.dir), "--status", "--json"]);
    return { ...e, state: r.json?.result?.state || "unknown" };
  });
}

