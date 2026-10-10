#!/usr/bin/env node
// Phone review: a small server on this PC that the phone opens over the same Wi-Fi. It plays each
// state's phone proxy (out/preview.mp4) with the timeline drawn over it, records notes pinned to a
// moment (feedback.jsonl, source "phone") and the user's approvals, and reloads when a new build
// lands. Studio stays the editor on the PC; this is for watching, listening and saying what to change.
//
//   node review.mjs <project>                start it (if needed), open the QR code on the PC, print the URL
//   node review.mjs <project> --status       is it running, and where
//   node review.mjs <project> --stop         stop it
//   node review.mjs <project> --wait [--timeout <minutes>]
//        block until the user sends a note or an approval from the phone, print it, exit 0
//        (exit 3 after the timeout, default 120 min). Claude runs this in the background, so
//        every phone note wakes it.
//   node review.mjs <project> --serve        run the server in this process (what the start spawns)
// --no-open: do not open the QR page on the PC.
//
// Port: deliver.json "reviewPort" (default 3019). The server listens on every interface; each
// request needs the project's token (in the URL the QR code carries, then a cookie).
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, normalize, sep } from "node:path";
import { BOXES } from "./lib/hfproject.mjs";
import { ID, PREVIEW_STATES, TEMPLATES, hfSettings, isProject, project, projectMode, publicUrl, readJsonIf, stateDef } from "./lib/paths.mjs";
import { ensureReviewServer, insertRect, lanAddresses, nearContext, phoneUrls, reviewRegistry, reviewServer, writeRegistry } from "./lib/review.mjs";
import { addFeedback, approveState, deriveAll, feedbackLine, readFeedback, rewriteTraceMd } from "./lib/trace.mjs";
import { writeTraceHtml } from "./lib/trace-html.mjs";

const args = process.argv.slice(2);
const projArg = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--timeout");
if (!projArg) {
  console.error("usage: node review.mjs <project> [--status | --stop | --wait [--timeout <min>] | --serve] [--no-open]");
  process.exit(2);
}
const P = project(projArg);
if (!isProject(P)) {
  console.error(`ERROR: ${P.root} is not a traced-edit project (no traced-edit.json). Run init.mjs first.`);
  process.exit(2);
}

if (args.includes("--serve")) serve();
else if (args.includes("--stop")) stop();
else if (args.includes("--status")) status();
else if (args.includes("--wait")) waitForPhone();
else await start();

// ---------- CLI ----------

function printUrls(reg) {
  const urls = phoneUrls(reg);
  if (!urls.length) console.log("  no Wi-Fi/LAN address found on this PC: connect it to the same network as the phone.");
  for (const u of urls) console.log(`  📱 ${u}`);
  console.log(`  QR code (on this PC): http://127.0.0.1:${reg.port}/qr`);
}

async function start() {
  const was = reviewServer(P);
  const reg = was || (await ensureReviewServer(P));
  if (!reg) process.exit(1);
  console.log(`phone review ${was ? "already running" : "started"} (pid ${reg.pid}, port ${reg.port}). Open on the phone, same Wi-Fi:`);
  printUrls(reg);
  console.log("  If the phone cannot connect: Windows Firewall must allow Node.js on private networks (references/troubleshooting.md).");
  if (!args.includes("--no-open")) openOnPc(`http://127.0.0.1:${reg.port}/qr`);
}

function openOnPc(url) {
  const [cmd, a] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, a, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function status() {
  const reg = reviewServer(P);
  if (!reg) return console.log("phone review is not running. Start it: node review.mjs <project>");
  console.log(`phone review running (pid ${reg.pid}, port ${reg.port}, since ${reg.startedAt}).`);
  printUrls(reg);
}

function stop() {
  const reg = reviewServer(P);
  if (!reg) return console.log("phone review is not running.");
  try {
    process.kill(reg.pid);
  } catch {}
  writeRegistry(P, { pid: null, stoppedAt: new Date().toISOString() });
  console.log(`phone review stopped (pid ${reg.pid}).`);
}

/** Exit with the first phone note/approval made after this started. */
function waitForPhone() {
  const ti = args.indexOf("--timeout");
  const minutes = ti >= 0 ? +args[ti + 1] : 120;
  const since = new Date().toISOString();
  const deadline = Date.now() + minutes * 60000;
  if (!reviewServer(P)) console.log("note: the phone review server is not running (node review.mjs <project> starts it).");
  console.log(`waiting for a note or an approval from the phone (up to ${minutes} min)…`);
  const tick = () => {
    const fresh = [];
    for (const id of PREVIEW_STATES)
      for (const f of readFeedback(P, id)) if (f.source === "phone" && f.at > since) fresh.push({ id, f });
    if (fresh.length) {
      for (const { id, f } of fresh) {
        const def = stateDef(id);
        if (f.kind === "approved") console.log(`PHONE APPROVAL state ${id} (${def.name}): "${f.text}"`);
        else console.log(`PHONE NOTE state ${id} (${def.name}): ${feedbackLine(f)}`);
      }
      console.log("Act on it (feedback.mjs --reply tells the user what changed), then start --wait again.");
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.log(`no note from the phone in ${minutes} min.`);
      process.exit(3);
    }
    setTimeout(tick, 1000);
  };
  tick();
}

// ---------- the server ----------

function serve() {
  const settings = hfSettings(P);
  const port = settings.reviewPort;
  const reg = reviewRegistry(P);
  const token = reg.token;
  const name = P.root.split(/[\\/]/).pop();
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

  const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const local = (req) => /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "");
  const cookieKey = (req) => /(?:^|;\s*)te_k=([0-9a-f]+)/.exec(req.headers.cookie || "")?.[1];
  const authed = (req, url) => [url.searchParams.get("k"), req.headers["x-review-key"], cookieKey(req)].includes(token);

  /** The media the phone plays for a state: the render after state 7 --render, else the proxy. */
  function media(id) {
    const S = P.st[id];
    const rec = readJsonIf(S.state);
    if (id === ID.deliver && rec?.rendered) {
      const out = rec.outputs?.find((o) => /\.mp4$/i.test(o.path) && !/preview\.mp4$/.test(o.path));
      if (out && existsSync(P.abs(out.path))) return { file: P.abs(out.path), what: "the render" };
    }
    const f = join(S.out, "preview.mp4");
    return existsSync(f) ? { file: f, what: "phone proxy" } : null;
  }
  const relToState = (id, file) => file.slice(P.st[id].dir.length + 1).split(sep).join("/");
  const version = (id) => {
    const m = media(id);
    const st = m && statSync(m.file);
    return st ? `${Math.round(st.mtimeMs)}-${st.size}` : "none";
  };

  function stateList() {
    const all = deriveAll(P);
    return PREVIEW_STATES.map((id) => {
      const d = all[id];
      return {
        id, name: d.def.name, code: d.code, reason: d.reason, dry: !!d.rec?.dry,
        approved: !!d.rec?.review?.approved, version: version(id), feedback: readFeedback(P, id).length,
      };
    });
  }

  function reviewData(id) {
    const S = P.st[id];
    const rec = readJsonIf(S.state);
    const tl = readJsonIf(join(P.st[ID.edit].out, "timeline.json"));
    const m = media(id);
    const n = Number(id);
    const q = `k=${token}&v=${version(id)}`;
    const pics = (rec?.images || [])
      .map((i) => ({ file: P.abs(i.path), caption: i.caption }))
      .filter((i) => i.file.startsWith(S.dir + sep) && existsSync(i.file))
      .map((i) => ({ src: `/media/${id}/${relToState(id, i.file)}?${q}`, caption: i.caption }));
    const ov = settings.overlay;
    return {
      id, name: stateDef(id).name, project: name, mode: projectMode(P),
      video: m ? `/media/${id}/${relToState(id, m.file)}?${q}` : null, videoWhat: m?.what || null,
      duration: tl?.duration ?? null,
      pieces: tl?.pieces?.map((p) => ({ id: p.id, start: p.start, duration: p.duration, speed: p.speed })) || [],
      events: tl?.events?.map((e) => ({ n: e.n, t: e.t, piece: e.piece })) || [],
      inserts: (tl?.inserts || []).map((x) => ({ id: x.id, kind: x.kind, file: x.file, t: x.t, dur: x.dur, rect: insertRect(BOXES[x.box] || "", x.css || "") })),
      voice: (tl?.voice || []).map((v) => ({ p: v.p, at: v.at, dur: v.dur })),
      cues: n >= Number(ID.sfx) ? (readJsonIf(join(P.st[ID.sfx].out, "cues.json"))?.cues || []).map((c) => ({ at: c.at, start: c.start, sound: c.sound, rule: c.rule, gain: c.gain, n: c.n, anchor: c.anchor })) : [],
      sections: n >= Number(ID.music) ? (readJsonIf(join(P.st[ID.music].out, "sections.json"))?.sections || []).map((s) => ({ n: s.n, from: s.from, to: s.to, track: s.track, role: s.role, hit: s.hit ? { at: s.hit.at, rise: s.hit.rise } : null })) : [],
      overlay: ov ? { label: ov.vars?.label ?? "", fastPiece: ov.vars?.fastPiece ?? null } : null,
      pictures: pics,
      feedback: readFeedback(P, id),
    };
  }

  // Only what a review needs, inside the state's folder: never raw-media, configs or other projects.
  const ALLOWED = [/^out\/preview\.mp4$/, /^listen\/[^/]+\.mp4$/, /^review\/[^/]+\.jpg$/, /^snapshots\/[^/]+\/[^/]+\.jpg$/, /^[^/]+\.mp4$/];
  function mediaFile(id, rel) {
    if (!PREVIEW_STATES.includes(id) || rel.includes("..") || !ALLOWED.some((r) => r.test(rel))) return null;
    if (/^[^/]+\.mp4$/.test(rel) && id !== ID.deliver) return null; // the render, state 7 only
    const S = P.st[id];
    const file = normalize(join(S.dir, rel));
    return file.startsWith(S.dir + sep) && existsSync(file) ? file : null;
  }

  function sendFile(req, res, file) {
    const size = statSync(file).size;
    const type = file.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
    const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    let start = 0, end = size - 1, code = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = +m[1];
        if (m[2]) end = Math.min(+m[2], size - 1);
      } else start = Math.max(0, size - +m[2]);
      if (start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return res.end();
      }
      code = 206;
      head["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    head["Content-Length"] = end - start + 1;
    res.writeHead(code, head);
    if (req.method === "HEAD") return res.end();
    // A short-lived stream per request: a rebuild can replace the file between requests.
    const s = createReadStream(file, { start, end });
    s.pipe(res);
    res.on("close", () => s.destroy());
  }

  const body = (req) => new Promise((ok, fail) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 65536) fail(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        ok(b ? JSON.parse(b) : {});
      } catch (e) {
        fail(e);
      }
    });
  });

  const qrPage = (reg) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} phone review</title><link rel="icon" href="data:,">
<style>body{margin:0;background:#141416;color:#e8e8ea;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{text-align:center;padding:24px}
.qr{display:inline-block;background:#fff;padding:16px;border-radius:12px;margin:12px}code{background:#26262a;padding:3px 6px;border-radius:4px;word-break:break-all}.muted{color:#9a9aa0}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body><main>
<h1>📱 ${name}</h1><p>Scan with the phone (same Wi-Fi as this PC).</p>
${phoneUrls(reg).map((u, i) => `<div><div class="qr" id="q${i}"></div><p><code>${u}</code><br><span class="muted">${reg.urls[i].name}</span></p></div>`).join("") || "<p>No Wi-Fi/LAN address found on this PC.</p>"}
<p class="muted">If the phone cannot connect, allow Node.js through Windows Firewall on private networks.</p>
<script>${JSON.stringify(phoneUrls(reg))}.forEach(function(u,i){ if (window.QRCode) new QRCode(document.getElementById("q"+i), { text: u, width: 280, height: 280, correctLevel: QRCode.CorrectLevel.M }); });</script>
</main></body></html>`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    try {
      if (path === "/health") return send(res, 200, { ok: true, project: name });
      if (path === "/qr") return local(req) ? send(res, 200, qrPage(readJsonIf(join(P.root, ".review.json"))), "text/html; charset=utf-8") : send(res, 403, "forbidden", "text/plain");
      if (!authed(req, url)) return send(res, 403, "This review link needs its key: scan the QR code again (review.mjs <project> opens it on the PC).", "text/plain; charset=utf-8");
      if (path === "/" || path === "/index.html") {
        return send(res, 200, readFileSync(join(TEMPLATES, "review.html")), "text/html; charset=utf-8", { "Set-Cookie": `te_k=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` });
      }
      if (path === "/api/state") return send(res, 200, { project: name, mode: projectMode(P), states: stateList() });
      let m = /^\/api\/review\/(\d)$/.exec(path);
      if (m && PREVIEW_STATES.includes(m[1])) return send(res, 200, reviewData(m[1]));
      m = /^\/media\/(\d)\/(.+)$/.exec(path);
      if (m) {
        const file = mediaFile(m[1], decodeURIComponent(m[2]));
        return file ? sendFile(req, res, file) : send(res, 404, "not found", "text/plain");
      }
      m = /^\/api\/(feedback|approve)\/(\d)$/.exec(path);
      if (m && req.method === "POST" && PREVIEW_STATES.includes(m[2])) {
        const id = m[2];
        const b = await body(req);
        if (m[1] === "feedback") {
          const chips = Array.isArray(b.chips) ? b.chips.map(String).filter(Boolean) : [];
          const text = [chips.join(", "), String(b.text || "").trim()].filter(Boolean).join(" — ");
          if (!text) return send(res, 400, { error: "empty note" });
          const t = typeof b.t === "number" && Number.isFinite(b.t) ? +b.t.toFixed(2) : undefined;
          const entry = { kind: "feedback", source: "phone", text, t, near: nearContext(P, id, t) || undefined };
          addFeedback(P, id, entry);
          rewriteTraceMd(P, id);
          writeTraceHtml(P);
          log(`note on state ${id}: ${feedbackLine(entry)}`);
          return send(res, 200, { ok: true, entry });
        }
        const note = String(b.note || "").trim();
        const why = approveState(P, id, note, { source: "phone" });
        writeTraceHtml(P);
        log(why ? `approval of state ${id} refused: ${why}` : `state ${id} approved from the phone: "${note}"`);
        return why ? send(res, 409, { error: why }) : send(res, 200, { ok: true });
      }
      return send(res, 404, "not found", "text/plain");
    } catch (e) {
      log(`ERROR ${req.method} ${path}: ${e.stack || e.message}`);
      return send(res, 500, { error: e.message });
    }
  });

  server.on("error", (e) => {
    log(`cannot listen on port ${port}: ${e.message}${e.code === "EADDRINUSE" ? ' (set "reviewPort" in deliver.json to another port)' : ""}`);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    const pub = publicUrl(port);
    const urls = [...(pub ? [{ name: "public", url: pub }] : []), ...lanAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${port}` }))];
    writeRegistry(P, { pid: process.pid, port, urls, startedAt: new Date().toISOString(), stoppedAt: undefined });
    writeTraceHtml(P);
    log(`phone review for ${name} on port ${port}: ${urls.map((u) => u.url).join(", ") || "no LAN address"}`);
  });
  const bye = () => {
    const r = readJsonIf(join(P.root, ".review.json"));
    if (r?.pid === process.pid) writeRegistry(P, { pid: null, stoppedAt: new Date().toISOString() });
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

