// State 3 · video-analysis. Read-only pictures and measurements of the source footage, so the
// edit (state 4) can be decided by eye.
//   out/probe.json            codec, size, fps, duration
//   out/scenes.json           hard cuts (scene score > params.sceneThreshold)
//   out/motion.csv            5 fps change score (near 0 = nothing moves)
//   out/sheets/sheet-MM.jpg   one timestamped contact sheet per minute
//   out/series-<det>.csv      per-frame colour score of each detector
//   out/candidates.json       detector peaks: PROPOSALS ONLY, confirm each by eye
//   out/candidates/cand-NN-<t>.jpg   ±1.2 s strip at 5 fps around each candidate
// Colour detection is the generalized scripts/detect-pintas.mjs from pintas-presupuesto.
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { frameScores, probe, sceneCuts, sheet, strip } from "../lib/media.mjs";
import { ID, ensureDir, readJson, sourceVideo, writeJson } from "../lib/paths.mjs";

export const DEFAULT_PARAMS = { sheetStep: 1, sceneThreshold: 0.35, motion: true, detectors: [] };

// HSV of an 8-bit RGB pixel: h in degrees, s and v in 0..1.
function hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [h < 0 ? h + 360 : h, max ? d / max : 0, max / 255];
}

const inHue = (h, [lo, hi]) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi); // [330, 20] wraps

function scan(ctx, video, det, [from, to]) {
  const W = 108, H = 192, fps = det.fps ?? 10;
  const [x0, x1] = det.region ?? [0, 1];
  const args = ["-v", "error", "-ss", String(from), "-t", String(to - from), "-i", video, "-vf", `fps=${fps},scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
  ctx.log(`$ ffmpeg ${args.join(" ")}   (detector "${det.name}" scan ${from}-${to}s)`);
  ctx.commands.push({ n: ctx.commands.length + 1, why: `detector ${det.name} ${from}-${to}s`, cmd: `ffmpeg ${args.map((a) => (/[ ,=()]/.test(a) ? `'${a}'` : a)).join(" ")}`, ms: 0, exit: 0 });
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);
    const frameBytes = W * H * 3;
    let buf = Buffer.alloc(0), i = 0, err = "";
    const rows = [];
    ff.stderr.on("data", (c) => (err += c));
    ff.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameBytes) {
        let hit = 0, n = 0;
        for (let p = 0, px = 0; p < frameBytes; p += 3, px++) {
          const x = (px % W) / W;
          if (x < x0 || x > x1) continue;
          n++;
          const [h, s, v] = hsv(buf[p], buf[p + 1], buf[p + 2]);
          if (inHue(h, det.hue) && s >= det.sat[0] && s <= det.sat[1] && v >= det.val[0] && v <= det.val[1]) hit++;
        }
        rows.push({ t: +(from + i / fps).toFixed(2), score: hit / n });
        buf = buf.subarray(frameBytes);
        i++;
      }
    });
    ff.on("close", (code) => (code === 0 ? resolve(rows) : reject(new Error(`detector scan failed (exit ${code}): ${err.slice(-500)}`))));
  });
}

function peaks(rows, det) {
  const k = det.smooth ?? 3;
  const sm = rows.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(rows.length - 1, i + k); j++) (s += rows[j].score), c++;
    return s / c;
  });
  const out = [];
  for (let i = 1; i < rows.length - 1; i++) {
    if (sm[i] < det.floor || sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
    const last = out.at(-1);
    if (last && rows[i].t - last.t < (det.minGap ?? 2.5)) {
      if (sm[i] > last.score) Object.assign(last, { t: rows[i].t, score: +sm[i].toFixed(4) });
      continue;
    }
    out.push({ t: rows[i].t, score: +sm[i].toFixed(4), detector: det.name });
  }
  return out;
}

export async function run(ctx) {
  const { P, S } = ctx;
  const src = sourceVideo(P);
  const params = { ...DEFAULT_PARAMS, ...readJson(S.config) };
  ctx.params = params;
  ctx.input(src.file, "source video");
  ctx.input(S.config, "params");
  const out = ensureDir(S.out);

  const info = probe(ctx, src.file);
  writeJson(join(out, "probe.json"), info);
  ctx.output(join(out, "probe.json"), `${info.width}x${info.height} ${info.vcodec} ${info.fps} fps, ${info.duration}s`);
  if (info.width && info.height && info.width / info.height > 0.6) ctx.warn(`source is ${info.width}x${info.height}, not 9:16; the overlay templates are made for 1080x1920`);

  const cuts = sceneCuts(ctx, src.file, params.sceneThreshold);
  writeJson(join(out, "scenes.json"), cuts);
  ctx.output(join(out, "scenes.json"), `${cuts.length} hard cuts (threshold ${params.sceneThreshold})`);

  if (params.motion) {
    const m = frameScores(ctx, src.file);
    writeFileSync(join(out, "motion.csv"), "t,score\n" + m.map(([t, s]) => `${t},${s}`).join("\n") + "\n");
    ctx.output(join(out, "motion.csv"), "5 fps change score");
  }

  for (const f of ["sheets", "candidates"]) if (existsSync(join(out, f))) rmSync(join(out, f), { recursive: true, force: true });
  const sheets = ensureDir(join(out, "sheets"));
  for (let a = 0, k = 0; a < info.duration; a += 60, k++) {
    const b = Math.min(info.duration, a + 60);
    const f = sheet(ctx, src.file, a, b, params.sheetStep, join(sheets, `sheet-${String(k).padStart(2, "0")}.jpg`), `contact sheet minute ${k}`);
    ctx.output(f, `${a}–${b.toFixed(1)}s, one tile per ${params.sheetStep}s`);
    ctx.image(f, `source ${a}–${b.toFixed(0)}s`);
  }

  const candidates = [];
  for (const det of params.detectors) {
    for (const key of ["name", "hue", "sat", "val", "floor"]) if (det[key] == null) throw new Error(`detector is missing "${key}" in params.json`);
    const ranges = det.ranges ?? [[0, info.duration]];
    const rows = [];
    const found = [];
    for (const r of ranges) {
      const part = await scan(ctx, src.file, det, r);
      rows.push(...part);
      found.push(...peaks(part, det));
    }
    writeFileSync(join(out, `series-${det.name}.csv`), "t,score\n" + rows.map((r) => `${r.t},${r.score.toFixed(5)}`).join("\n") + "\n");
    ctx.output(join(out, `series-${det.name}.csv`), `per-frame score of detector ${det.name}`);
    ctx.log(`detector ${det.name}: ${found.length} peaks above ${det.floor}`);
    candidates.push(...found);
  }
  candidates.sort((a, b) => a.t - b.t);
  candidates.forEach((c, i) => (c.id = i + 1));
  writeJson(join(out, "candidates.json"), candidates);
  ctx.output(join(out, "candidates.json"), `${candidates.length} candidates: proposals only, confirm each strip by eye`);

  if (candidates.length) {
    const cdir = ensureDir(join(out, "candidates"));
    for (const c of candidates) {
      const f = strip(ctx, src.file, c.t - 1.2, 2.4, 5, join(cdir, `cand-${String(c.id).padStart(2, "0")}-${c.t.toFixed(1)}.jpg`), `strip around candidate ${c.id}`);
      c.strip = P.rel(f);
      ctx.image(f, `candidate ${c.id} at ${c.t}s (${c.detector}, score ${c.score}); tiles are 0.2 s apart`);
    }
    writeJson(join(out, "candidates.json"), candidates);
    ctx.note(`${candidates.length} candidates. Detection misses washed-out or angled shots: also scan the contact sheets.`);
  }

  // Seed the edit with the candidates, but only while edit.json is still the untouched scaffold.
  const editFile = P.st[ID.edit].config;
  const edit = existsSync(editFile) ? readJson(editFile) : null;
  if (edit && edit._scaffold && candidates.length) {
    // Each candidate goes to the piece that holds it; one outside every piece is cut out anyway.
    // Pieces with a "file" (sound bites from videos/ASSETS) are another source: never theirs.
    const inside = candidates.map((c) => [c, edit.pieces.find((p) => !p.file && c.t >= p.from && c.t <= p.to)]).filter(([, p]) => p);
    edit.events = inside.map(([c, p], i) => ({ n: i + 1, srcT: c.t, piece: p.id, anchor: c.detector, verified: false }));
    delete edit._scaffold;
    writeJson(editFile, edit);
    ctx.note(`seeded ${P.rel(editFile)} with ${candidates.length} events marked verified:false`);
  }
  ctx.extra.summary = { duration: info.duration, cuts: cuts.length, candidates: candidates.length };
}
