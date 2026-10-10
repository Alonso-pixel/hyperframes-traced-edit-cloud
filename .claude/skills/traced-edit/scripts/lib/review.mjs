// Phone review. Studio only listens on the PC, so states 4-7 also leave a small MP4 the phone can
// play (out/preview.mp4), and scripts/review.mjs serves it, with a review page, on the Wi-Fi:
//   phoneProxy          the cut at 720 px + the state's audio, mixed like the HyperFrames project
//   nearContext         what is on the timeline at a cut time (a note's "near")
//   insertRect          where an insert sits on the 1080x1920 frame (for the page's outlines)
//   reviewServer / ensureReviewServer / phoneUrls   the server's registry, <project>/.review.json
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ID, SCRIPTS, UserError, ensureDir, hfSettings, projectMode, readJsonIf, writeJson } from "./paths.mjs";

export const PHONE_WIDTH = 720;
export const DEFAULT_REVIEW_PORT = 3019;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** ffmpeg writes `tmp`, then it replaces `file`: a phone streaming the old one never blocks the build. */
function replaceWith(tmp, file) {
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 10) {
        rmSync(tmp, { force: true });
        throw new UserError(`cannot replace ${file} (${e.code}): something holds it open. Stop the review server (review.mjs <project> --stop) and run again.`);
      }
      sleep(300);
    }
  }
}

/**
 * The phone proxy of this state: out/preview.mp4 = the cut at 720 px with the same audio layout as
 * the state's HyperFrames project (lib/hfproject.mjs): the footage's sound at volumes.base (footage
 * mode: ambience.wav + voice-mix.wav at volumes.ambience / .voice), + sfx at volumes.sfx, + music
 * at volumes.music, summed without normalization. State 4 encodes the picture once
 * (out/phone-video.mp4); later states only copy it and mix their audio, which takes seconds.
 */
export function phoneProxy(ctx, P, { sfx = null, music = null } = {}) {
  const E = P.st[ID.edit].out;
  const cut = join(E, "cut.mp4");
  if (!existsSync(cut)) throw new UserError("state 4 has no cut.mp4 (it was only run with --dry). Run state 4 without --dry.");
  const pv = join(E, "phone-video.mp4");
  if (ctx.def.id === ID.edit) {
    const tmp = join(E, "phone-video.tmp.mp4");
    ctx.ffmpeg(["-i", cut, "-an", "-vf", `scale=${PHONE_WIDTH}:-2`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp], { why: `phone video: the cut at ${PHONE_WIDTH} px, no audio` });
    replaceWith(tmp, pv);
    ctx.output(pv, `the cut at ${PHONE_WIDTH} px for the phone proxies (no audio)`);
  }
  // A cut rebuilt after the phone video (or a project from before phone review) is re-encoded here.
  const reuse = existsSync(pv) && statSync(pv).mtimeMs >= statSync(cut).mtimeMs;

  const vol = hfSettings(P).volumes;
  const inputs = ["-i", reuse ? pv : cut];
  const audio = [];
  const add = (file, v, what) => {
    inputs.push("-i", file);
    audio.push({ i: inputs.length / 2 - 1, v, what });
  };
  const vmix = join(E, "voice-mix.wav"), amb = join(E, "ambience.wav");
  if (projectMode(P) === "footage" && existsSync(vmix) && existsSync(amb)) {
    add(amb, vol.ambience, "ambience");
    add(vmix, vol.voice, "voice");
  } else add(cut, vol.base, "footage");
  if (sfx) add(sfx, vol.sfx, "sfx");
  if (music) add(music, vol.music, "music");

  const f = audio.map((a, k) => `[${a.i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${a.v}[a${k}]`);
  // duration=first: the first stem is the footage's own sound, exactly the cut's length.
  f.push(audio.length > 1 ? `${audio.map((_, k) => `[a${k}]`).join("")}amix=inputs=${audio.length}:normalize=0:duration=first[a]` : "[a0]anull[a]");
  if (!reuse) f.unshift(`[0:v]scale=${PHONE_WIDTH}:-2[v]`);
  const video = reuse ? ["-map", "0:v", "-c:v", "copy"] : ["-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p"];
  const out = join(ensureDir(ctx.S.out), "preview.mp4");
  const tmp = join(ctx.S.out, "preview.tmp.mp4");
  ctx.ffmpeg([...inputs, "-filter_complex", f.join(";"), ...video, "-map", "[a]", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tmp],
    { why: `phone proxy: ${audio.map((a) => `${a.what}×${a.v}`).join(" + ")}` });
  replaceWith(tmp, out);
  ctx.output(out, `phone proxy, ${PHONE_WIDTH} px: ${audio.map((a) => `${a.what} ×${a.v}`).join(" + ")} (deliver.json volumes)`);
  return out;
}

/** What is on the timeline at cut time t, for a note made on the phone: "piece B 4x · event #12 (+0.20s) · …". */
export function nearContext(P, id, t) {
  const tl = readJsonIf(join(P.st[ID.edit].out, "timeline.json"));
  if (!tl || typeof t !== "number" || !Number.isFinite(t)) return null;
  const n = Number(id);
  const parts = [];
  const sgn = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}s`;
  const piece = tl.pieces.find((p) => t >= p.start && t < p.start + p.duration) || tl.pieces.at(-1);
  if (piece) parts.push(`piece ${piece.id}${piece.speed !== 1 ? ` ${piece.speed}x` : ""}`);
  const nearest = (list, at) => list.reduce((b, x) => (!b || Math.abs(at(x) - t) < Math.abs(at(b) - t) ? x : b), null);
  const e = nearest(tl.events || [], (x) => x.t);
  if (e && Math.abs(e.t - t) <= 1.5) parts.push(`event #${e.n} (${sgn(t - e.t)})`);
  if (n === Number(ID.edit))
    for (const x of tl.inserts || []) if (t >= x.t && t <= x.t + x.dur) parts.push(`insert ${x.id}`);
  if (n >= Number(ID.sfx)) {
    const c = nearest(readJsonIf(join(P.st[ID.sfx].out, "cues.json"))?.cues || [], (x) => x.at);
    if (c && Math.abs(c.at - t) <= 1.0) parts.push(`cue ${c.sound} at ${c.at}s (rule ${c.rule}, gain ${c.gain}, ${sgn(t - c.at)})`);
  }
  if (n >= Number(ID.music)) {
    const secs = readJsonIf(join(P.st[ID.music].out, "sections.json"))?.sections || [];
    const s = secs.find((x) => t >= x.from && t < x.to);
    if (s) parts.push(`music section ${s.n} ${s.track}`);
    const h = secs.find((x) => x.hit && Math.abs(x.hit.at - t) <= 2);
    if (h) parts.push(`hit at ${h.hit.at}s (${sgn(t - h.hit.at)})`);
  }
  return parts.join(" · ") || null;
}

/** An insert's box as { left, top, width, height } in 1080x1920 px (BOXES + its own css), or null. */
export function insertRect(boxCss, extraCss = "") {
  const v = {};
  for (const m of `${boxCss};${extraCss}`.matchAll(/(left|top|right|bottom|width|height)\s*:\s*(-?[\d.]+)px/g)) v[m[1]] = +m[2];
  if (v.width == null || v.height == null) return null;
  const left = v.left ?? (v.right != null ? 1080 - v.right - v.width : 0);
  const top = v.top ?? (v.bottom != null ? 1920 - v.bottom - v.height : 0);
  return { left, top, width: v.width, height: v.height };
}

// ---------- the review server's registry ----------

const registryFile = (P) => join(P.root, ".review.json");

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The registry, with a token that survives restarts (the phone's bookmark keeps working). */
export function reviewRegistry(P) {
  const r = readJsonIf(registryFile(P)) || {};
  if (!r.token) {
    r.token = randomBytes(12).toString("hex");
    writeJson(registryFile(P), r);
  }
  return r;
}

export function writeRegistry(P, fields) {
  writeJson(registryFile(P), { ...reviewRegistry(P), ...fields });
}

/** The running server of this project ({ pid, port, token, urls, ... }), or null. */
export function reviewServer(P) {
  const r = readJsonIf(registryFile(P));
  return r && alive(r.pid) ? r : null;
}

/** Private IPv4 addresses of this PC on real adapters (no WSL, Hyper-V, VirtualBox, VMware, VPN bridges). */
export function lanAddresses() {
  const skip = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vboxnet|docker|br-|Loopback|Tailscale|ZeroTier/i;
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of list || []) if (a.family === "IPv4" && !a.internal && priv.test(a.address)) out.push({ name, address: a.address });
  }
  return out;
}

export const phoneUrls = (reg) => (reg.urls || []).map((u) => `${u.url}/?k=${reg.token}`);

async function reachable(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

/** Start the review server for the project if it is not running (detached: it outlives this process). */
export async function ensureReviewServer(P) {
  const running = reviewServer(P);
  if (running) return running;
  reviewRegistry(P); // the token exists before the server reads it
  const log = openSync(join(P.root, "review-server.log"), "a");
  const child = spawn(process.execPath, [join(SCRIPTS, "review.mjs"), P.root, "--serve"], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  const port = hfSettings(P).reviewPort;
  if (!(await reachable(`http://127.0.0.1:${port}/health`))) {
    console.log(`the phone review server did not start; see ${join(P.root, "review-server.log")}`);
    return null;
  }
  return reviewServer(P);
}
