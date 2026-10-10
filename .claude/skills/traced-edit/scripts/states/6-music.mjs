// State 6 · music (human review). music.json lays stretches of the mood library
// (videos/ASSETS/music) under the cut: one track per section, crossfaded, levelled, and ducked
// under the sound effects; a "hit" lands a track's drop exactly on an anchor (an event, the cut
// into a fast piece…), an "ending" lands the track's own ending on the last frame.
//   out/library.txt     every track: mood, length, bed start, MAIN drop  <- pick tracks here
//   out/sections.json   each section resolved: cut times, the anchor that set them, track in/out
//   out/bed.wav         the music before ducking (what the checks measure)
//   out/music-mix.wav   the stem: exactly the cut's length, ducked under sfx-mix.wav
//   out/preview.mp4     phone proxy: cut + its audio + sfx + music at deliver.json volumes
//   listen/*.mp4        10 s around every seam and every hit
//   preview/<project>-music/   HyperFrames project that run.mjs opens in Studio
//   --dry   library.txt + validation + the section table only
// Validation, cue and mix logic: .claude/skills/music-score/scripts/build.mjs, anchored to the
// edit instead of to words. Track analysis is imported from music-score (cached profiles).
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY, libraryTracks, moods, profile, trackFile } from "../../../music-score/scripts/lib.mjs";
import { resolveTime } from "../lib/anchors.mjs";
import { buildProject } from "../lib/hfproject.mjs";
import { phoneProxy } from "../lib/review.mjs";
import { envelope, loudness, measure, meanDb, probe, runs, smooth } from "../lib/media.mjs";
import { ID, UserError, ensureDir, fmtT, hfSettings, previewDir, readJson, writeJson } from "../lib/paths.mjs";

export const DEFAULT_MUSIC = { level: 0, duckUnderSfx: true, sections: [] };
const LEVEL = { bed: -24, hit: -21, ending: -22 }; // LUFS per role (music-score), plus music.json "level"
const f2 = (x) => Number(x).toFixed(2);

function libraryTxt(profiles, mood) {
  const lines = [
    "# Music library: one block per track. Times are seconds INSIDE the track.",
    '# role "hit" needs a drop: copy the MAIN drop into "drop". Tracks without one: "bed" or "ending" only.',
    "",
  ];
  for (const p of profiles) {
    const m = mood[p.name] || "(no mood description)";
    lines.push(`### ${p.name}`, `mood: ${m}`);
    if (/stinger/i.test(m)) {
      lines.push("NOT A MUSIC BED: sound-effect file. Never use it in music.json.", "");
      continue;
    }
    const main = p.drops.find((d) => d.main);
    const others = p.drops.filter((d) => d.afterStop && !d.main && d.t > 20 && d.t < p.duration - 15 && d.sustain >= -4);
    lines.push(`length ${p.duration.toFixed(2)} s | bed starts at ${p.bedStart.toFixed(2)} | ends with a ${(p.duration - p.tailStart).toFixed(1)} s tail`);
    lines.push(main ? `MAIN drop: ${main.t.toFixed(2)}   <- copy this number into "drop" for a hit` : "MAIN drop: none (use as bed or ending only)");
    if (others.length) lines.push(`other drops after a stop: ${others.map((d) => d.t.toFixed(2)).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function run(ctx) {
  const { P, S, opts } = ctx;
  const cfg = { ...DEFAULT_MUSIC, ...readJson(S.config) };
  ctx.params = cfg;
  const T3 = P.st[ID.edit], T4 = P.st[ID.sfx];
  const tlFile = join(T3.out, "timeline.json"), cut = join(T3.out, "cut.mp4"), sfx = join(T4.out, "sfx-mix.wav");
  if (!existsSync(tlFile)) throw new UserError("no timeline.json from state 4. Run state 4 first.");
  ctx.input(S.config, "music (human)");
  ctx.input(tlFile, "timeline from state 4");
  const tl = readJson(tlFile);
  const total = tl.duration;
  const out = ensureDir(S.out);

  // ---------- the library (profiles are cached next to each track by music-score) ----------
  if (!existsSync(LIBRARY)) throw new UserError(`music library not found: ${LIBRARY}`);
  const known = libraryTracks();
  const mood = moods();
  const profiles = known.map((n) => profile(n));
  writeFileSync(join(out, "library.txt"), libraryTxt(profiles, mood));
  ctx.output(join(out, "library.txt"), `${known.length} tracks: mood, bed start, MAIN drop`);
  ctx.note(`track analysis: music-score profiles (cached as <track>.profile.json in ${LIBRARY})`);

  // ---------- validate and plan ----------
  const Sx = cfg.sections;
  if (!Array.isArray(Sx)) throw new UserError(`music.json "sections" must be a list (use [] for no music)`);
  const errors = [];
  const E = (m) => errors.push(m);
  const time = (x, who) => {
    try {
      return resolveTime(x, tl, who);
    } catch (e) {
      E(e.message);
      return null;
    }
  };
  const froms = Sx.map((s, k) => time(s.from, `section ${k + 1} "from"`));
  const plan = [];
  Sx.forEach((s, k) => {
    const tag = `section ${k + 1}`;
    const F = froms[k];
    if (!F) return;
    const from = F.t;
    const end = k + 1 < Sx.length ? froms[k + 1]?.t ?? total : total;
    const len = end - from;
    const name = String(s.track || "").replace(/\.mp3$/i, "");
    const role = s.role;
    if (from < 0 || from >= total) return E(`${tag}: "from" resolves to ${f2(from)}s, outside the cut (0–${f2(total)}s)`);
    if (!(len > 0)) return E(`${tag}: sections must be in time order (this one starts at ${f2(from)}s and the next at ${f2(end)}s)`);
    if (len < 6) E(`${tag}: only ${len.toFixed(1)} s long (${f2(from)}–${f2(end)}); a section needs at least 6 s. Merge it with a neighbour.`);
    if (!known.includes(name)) return E(`${tag}: track "${s.track}" is not in the library. Use a name from out/library.txt (without .mp3).`);
    if (/stinger/i.test(mood[name] || "")) return E(`${tag}: "${name}" is a sound-effect file, not a music bed. Pick another track.`);
    if (k > 0 && String(Sx[k - 1].track || "").replace(/\.mp3$/i, "") === name) E(`${tag}: same track as the section before it. Merge the two or pick another track.`);
    if (!["bed", "hit", "ending"].includes(role)) return E(`${tag}: "role" must be "bed", "hit" or "ending"`);
    if (role === "ending" && k !== Sx.length - 1) E(`${tag}: role "ending" is only allowed on the LAST section`);
    const gain = Number(s.gain ?? 0);
    if (!(gain >= -8 && gain <= 6)) E(`${tag}: "gain" must be between -8 and 6 (dB)`);

    const p = profiles[known.indexOf(name)];
    let trackIn, hit = null;
    if (role === "bed") {
      trackIn = s.trackIn != null ? Number(s.trackIn) : p.bedStart;
    } else if (role === "hit") {
      const H = time(s.hitAt, `${tag} "hitAt"`);
      if (!H) return;
      const hitAt = H.t;
      if (hitAt - from < 4) E(`${tag}: "hitAt" (${f2(hitAt)}s, ${H.anchor}) must be at least 4 s after "from" (${f2(from)}s) so the build-up is heard. Start the section earlier (≤ ${f2(hitAt - 4)}s), e.g. with "offset".`);
      if (hitAt > end - 2) E(`${tag}: "hitAt" (${f2(hitAt)}s) must be at least 2 s before the section ends (${f2(end)}s). Start the next section later.`);
      const d = p.drops.find((x) => Math.abs(x.t - Number(s.drop)) <= 0.3);
      const main = p.drops.find((x) => x.main);
      if (!d) return E(`${tag}: "drop": ${s.drop} is not a drop of ${name}. ${main ? `Its MAIN drop is ${f2(main.t)} (library.txt).` : `${name} has no MAIN drop: use another track for a hit.`}`);
      if (!d.afterStop) ctx.warn(`${tag}: drop ${f2(d.t)} has no silence before it, so the hit will be weak.${main ? ` The MAIN drop is ${f2(main.t)}.` : ""}`);
      else if (!d.main) ctx.warn(`${tag}: drop ${f2(d.t)} is not ${name}'s MAIN drop (${main ? f2(main.t) : "none"}). Fine only if chosen on purpose.`);
      trackIn = d.t - (hitAt - from);
      hit = { hitAt, drop: d.t, anchor: H.anchor };
      if (trackIn < 0) E(`${tag}: the drop (${f2(d.t)} in the track) comes too early for ${f2(hitAt - from)} s of build-up. Start the section later: "from" ≥ ${f2(hitAt - d.t)}s.`);
    } else {
      trackIn = p.duration - len;
      if (trackIn < 0) E(`${tag}: the ending is ${len.toFixed(1)} s but ${name} is only ${p.duration.toFixed(1)} s long. Start this section at or after ${f2(total - p.duration + 1)}s.`);
    }
    if (trackIn >= 0 && trackIn + len > p.duration + 0.05)
      E(`${tag}: ${name} runs out at cut ${f2(from + p.duration - trackIn)}s, before this section ends (${f2(end)}s). Start the next section earlier, or pick another track.`);
    for (const st of p.stops) {
      if (st.end - st.start < 1.5) continue;
      if (st.end <= trackIn + 0.3 || st.start >= trackIn + len - 0.3) continue;
      if (hit && hit.drop - st.end >= -0.3 && hit.drop - st.end <= 8) continue; // the breakdown before the drop
      if (role === "ending" && st.start >= p.duration - 15) continue;
      E(`${tag}: ${name} goes quiet at track ${f2(st.start)}–${f2(st.end)} = cut ${f2(from + st.start - trackIn)}–${f2(from + st.end - trackIn)}s. Move a boundary or pick another track.`);
    }
    plan.push({ k, name, role, from, end, len, trackIn, gain, hit, p, anchor: F.anchor });
  });

  // ---------- cues: 2 s crossfades centred on the boundaries (music-score) ----------
  const cues = plan.map((c, i) => {
    const first = i === 0, last = i === plan.length - 1;
    const pre = first ? 0 : Math.min(1, Math.max(0, c.trackIn));
    const post = last ? 0 : Math.max(0, Math.min(1, c.p.duration - (c.trackIn + c.len)));
    return {
      track: c.name, role: c.role,
      trackIn: +(c.trackIn - pre).toFixed(3),
      bodyIn: +(c.from - pre).toFixed(3),
      bodyOut: +(c.end + post).toFixed(3),
      fadeIn: first ? (c.from > 0 ? 1.0 : 0.3) : +(pre + 1).toFixed(3),
      fadeOut: last ? (c.role === "ending" ? 0.05 : 2) : +(post + 1).toFixed(3),
      lufs: LEVEL[c.role] + c.gain + Number(cfg.level || 0),
    };
  });
  console.log("\n #  role    track                     cut from–to          track in–out       level     set by");
  plan.forEach((c, i) =>
    console.log(`${String(i + 1).padStart(2)}  ${c.role.padEnd(7)} ${c.name.padEnd(25)} ${f2(c.from).padStart(7)}–${f2(c.end).padEnd(8)}   ${f2(c.trackIn).padStart(7)}–${f2(c.trackIn + c.len).padEnd(8)}  ${cues[i].lufs} LUFS  ${c.anchor}` +
      (c.hit ? `   drop ${f2(c.hit.drop)} → ${f2(c.hit.hitAt)}s (${c.hit.anchor})` : "")));
  if (errors.length) throw new UserError(`music.json has ${errors.length} error(s); nothing was built:\n- ${errors.join("\n- ")}`);

  writeJson(join(out, "sections.json"), {
    duration: total,
    sections: plan.map((c, i) => ({
      n: i + 1, track: c.name, role: c.role, from: +c.from.toFixed(3), to: +c.end.toFixed(3), anchor: c.anchor,
      trackIn: +c.trackIn.toFixed(3), lufs: cues[i].lufs, hit: c.hit ? { at: +c.hit.hitAt.toFixed(3), drop: c.hit.drop, anchor: c.hit.anchor } : undefined,
    })),
    cues,
  });
  ctx.output(join(out, "sections.json"), plan.length ? `${plan.length} sections, ${plan.filter((c) => c.hit).length} hit(s)` : "no music (sections is empty)");
  ctx.extra.summary = { sections: plan.length, hits: plan.filter((c) => c.hit).length };
  for (const c of plan) ctx.input(trackFile(c.name), "music track");
  if (plan.length && !plan.some((c) => c.hit)) ctx.note("no hit: the music never drops on a moment of the edit. Fine if intended.");
  if (opts.dry) {
    ctx.note("--dry: validation and the section table only. bed.wav, music-mix.wav, previews were NOT rebuilt.");
    return;
  }
  if (!existsSync(cut)) throw new UserError("state 4 was only run with --dry: there is no cut.mp4. Run state 4 without --dry.");
  ctx.input(cut, "cut from state 4");
  // The music ducks under the sound effects, in footage mode under the voiceover, and under every
  // sound bite (state 4's soundbites-key.wav: the cut's sound only while an official speaks).
  const voice = join(T3.out, "voice-mix.wav"), bites = join(T3.out, "soundbites-key.wav");
  const keys = [];
  if (cfg.duckUnderSfx && existsSync(sfx)) keys.push([sfx, "sfx"]);
  if (existsSync(voice)) keys.push([voice, "voiceover"]);
  if (tl.soundbites?.length && existsSync(bites)) keys.push([bites, "sound bites"]);
  const duck = keys.length > 0;
  for (const [f, what] of keys) ctx.input(f, `${what} stem (ducking key)`);

  // ---------- bed + ducked stem ----------
  const bed = join(out, "bed.wav"), mix = join(out, "music-mix.wav");
  if (!plan.length) {
    ctx.ffmpeg(["-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`, "-t", String(total), "-c:a", "pcm_s16le", mix], { why: "silent stem (no music)" });
    ctx.output(mix, "silent stem: no music");
  } else {
    const inputs = [], chains = [];
    cues.forEach((c, i) => {
      const dur = +(c.bodyOut - c.bodyIn).toFixed(3);
      const trim = `aresample=48000,aformat=channel_layouts=stereo,atrim=start=${c.trackIn}:duration=${dur},asetpts=PTS-STARTPTS`;
      const m = measure(ctx, ["-i", trackFile(c.track)], trim, `level of section ${i + 1} (${c.track})`);
      const g = c.lufs - Number(m.input_i);
      inputs.push("-i", trackFile(c.track));
      chains.push(`[${i}:a]${trim},volume=${g.toFixed(2)}dB,afade=t=in:st=0:d=${c.fadeIn},afade=t=out:st=${Math.max(0, dur - c.fadeOut).toFixed(3)}:d=${c.fadeOut},adelay=${Math.round(c.bodyIn * 1000)}:all=1[c${i}]`);
    });
    const fc = [
      `anullsrc=r=48000:cl=stereo,atrim=end=${total}[z]`,
      ...chains,
      `[z]${cues.map((_, i) => `[c${i}]`).join("")}amix=inputs=${cues.length + 1}:normalize=0:duration=first,alimiter=limit=0.708:level=false:latency=1[bed]`,
    ].join(";");
    ctx.ffmpeg([...inputs, "-filter_complex", fc, "-map", "[bed]", "-t", String(total), "-ar", "48000", "-c:a", "pcm_s16le", bed], { why: "build the music bed" });
    // Ducking is a second, separate pass: one graph with two outputs raced (the stem came out short).
    const fit = `apad=whole_dur=${total},atrim=0:${total}`;
    if (duck) {
      const fmt = keys.map((_, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo[k${i}]`);
      const key = keys.length > 1 ? `;${keys.map((_, i) => `[k${i}]`).join("")}amix=inputs=${keys.length}:normalize=0[key]` : "";
      ctx.ffmpeg(["-i", bed, ...keys.flatMap(([f]) => ["-i", f]), "-filter_complex",
        `${fmt.join(";")}${key};[0:a][${keys.length > 1 ? "key" : "k0"}]sidechaincompress=threshold=0.05:ratio=4:attack=5:release=300,${fit}[mix]`,
        "-map", "[mix]", "-ar", "48000", "-c:a", "pcm_s16le", mix], { why: `duck the music under the ${keys.map(([, w]) => w).join(" + ")}` });
    }
    else ctx.ffmpeg(["-i", bed, "-af", fit, "-ar", "48000", "-c:a", "pcm_s16le", mix], { why: "music stem (no ducking)" });
    ctx.output(bed, "music before ducking");
    ctx.output(mix, duck ? `music stem, ducked under the ${keys.map(([, w]) => w).join(" + ")}` : "music stem");
  }

  const mi = probe(ctx, mix);
  ctx.check("stem length equals the cut", Math.abs(mi.duration - total) <= 0.05, `${mi.duration}s vs ${total}s`);
  if (plan.length) {
    const L = loudness(ctx, ["-i", mix], "stem peak");
    ctx.check("stem true peak under -1 dBTP", L.truePeak <= -1, `${L.truePeak} dBTP`);
    const env = envelope(ctx, bed);
    const senv = smooth(env);
    const first = plan[0], last = plan.at(-1);
    const hits = plan.filter((c) => c.hit).map((c) => c.hit.hitAt);
    const holes = runs(senv.length, (i) => senv[i] < -50, 1.5)
      .filter((r) => r.end > first.from + 1.5) // before the music starts
      .filter((r) => !hits.some((h) => r.start >= h - 10 && r.end <= h + 0.3)) // a hit's breakdown
      .filter((r) => !(last.role === "ending" && r.start >= total - (last.p.duration - last.p.tailStart) - 0.5));
    ctx.check("no silent holes in the music", holes.length === 0, holes.length ? holes.map((r) => `${f2(r.start)}–${f2(r.end)}s`).join(", ") + ": move a boundary or pick another track" : "none");
    for (const c of plan.filter((x) => x.hit)) {
      const t = c.hit.hitAt;
      // From a -70 dB floor: a drop out of a full stop would otherwise read as "+88 dB".
      const rise = +(Math.max(-70, meanDb(env, t + 0.05, t + 0.9)) - Math.max(-70, meanDb(env, t - 1.0, t - 0.15))).toFixed(1);
      c.hit.rise = rise;
      ctx.check(`hit at ${f2(t)}s (${c.hit.anchor})`, rise >= 8, `music jumps +${rise} dB${rise >= 8 ? "" : ": use the track's MAIN drop, or another track"}`);
    }
    const sec = readJson(join(out, "sections.json"));
    sec.sections.forEach((s, i) => s.hit && (s.hit.rise = plan[i].hit.rise));
    writeJson(join(out, "sections.json"), sec);
  } else {
    ctx.note("no music: sections is empty. Approve it if that is what the user wants.");
  }

  // ---------- previews ----------
  const preview = phoneProxy(ctx, P, { sfx: existsSync(sfx) ? sfx : null, music: mix });
  const ldir = join(S.dir, "listen");
  if (existsSync(ldir)) rmSync(ldir, { recursive: true, force: true });
  ensureDir(ldir);
  const marks = [...plan.filter((c) => c.hit).map((c) => ({ t: c.hit.hitAt, kind: "hit" })), ...plan.slice(1).map((c) => ({ t: c.from, kind: "seam" }))].sort((a, b) => a.t - b.t);
  marks.forEach((m, i) => {
    const f = join(ldir, `${String(i + 1).padStart(2, "0")}-${m.kind}-${f2(m.t)}.mp4`);
    ctx.ffmpeg(["-ss", String(Math.max(0, m.t - 6)), "-t", "10", "-i", preview, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", f], { why: `listen clip ${m.kind} ${fmtT(m.t)}` });
    ctx.output(f, `10 s around the ${m.kind} at ${f2(m.t)}s`);
  });

  const hs = hfSettings(P);
  buildProject(ctx, P, previewDir(P, ID.music), { sfx: existsSync(sfx) ? sfx : null, music: mix, overlay: hs.overlay, volumes: hs.volumes });
  ctx.note("You cannot hear the music: the user listens in the Studio preview or on the phone (review.mjs), and listen/ and gives feedback before approving.");
}
