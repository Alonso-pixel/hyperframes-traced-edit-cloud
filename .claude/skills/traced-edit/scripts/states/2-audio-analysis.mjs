// State 2 · audio-analysis. Measurements of the footage's sound, and, when there is a script,
// where each of its paragraphs was said in the recording.
//   out/envelope.csv     50 ms RMS level of the footage (dBFS)
//   out/loudness.json    integrated LUFS, LRA, true peak
//   out/silences.json    runs below params.silenceDb for at least params.silenceMin s
//   out/onsets.json      sudden jumps (>= params.onsetJumpDb over the previous 0.15 s)
//   out/waveform.png     the whole waveform
//   out/transcript.json, words.tsv, sentences.txt   whisper on the speech (TIMING ONLY: whisper
//                        text is never copied to screen)
//   out/alignment.json   per paragraph of the approved script: the chosen take, its coverage, the
//                        segments to keep (pauses and stumbles cut out) and every other take
//   out/alignment.md     the same, for reading
// The speech is the footage itself in mode "planned" (the user on camera) and the voiceover in
// mode "footage". In "planned" mode the aligned takes are seeded into edit.json as pieces while
// it is still a scaffold: that is the trim, with state 1's sound bites (soundbites.json) spliced in
// after their paragraphs as pieces of their cabildo clips. Timings come from the recording, never the script.
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alignScript } from "../lib/align.mjs";
import { readSoundbites, soundbitesFile } from "../lib/enrich.mjs";
import { FRAME, envelope, loudness, probe, runs, transcribe } from "../lib/media.mjs";
import { ID, ensureDir, fmtT, projectMode, readJson, readJsonIf, sourceVideo, sourceVoice, writeJson } from "../lib/paths.mjs";
import { paragraphsOf } from "./1-script.mjs";

export const DEFAULT_PARAMS = {
  transcribe: false, language: "es", silenceDb: -45, silenceMin: 0.5, onsetJumpDb: 12, onsetMinGap: 0.5,
  maxPause: 0.7, minCoverage: 0.8, pad: 0.12,
};

export async function run(ctx) {
  const { P, S } = ctx;
  const src = sourceVideo(P);
  const mode = projectMode(P);
  const params = { ...DEFAULT_PARAMS, ...readJson(S.config) };
  ctx.params = { mode, ...params };
  ctx.input(src.file, "footage");
  ctx.input(S.config, "params");
  const scriptFile = join(P.st[ID.script].out, "teleprompter.txt");
  const hasScript = mode !== "none" && existsSync(scriptFile);
  if (hasScript) ctx.input(scriptFile, "approved script (state 1): what was read");
  else ctx.note(mode === "none" ? 'no script (mode "none": no voice)' : "no teleprompter.txt from state 1");
  const out = ensureDir(S.out);

  // ---------- the footage's sound ----------
  const info = probe(ctx, src.file);
  if (mode === "footage") {
    if (!info.hasAudio) ctx.note("the footage has no sound of its own: only the voiceover will be heard");
  } else ctx.check("source has an audio stream", info.hasAudio, info.hasAudio ? `${info.acodec} ${info.sampleRate} Hz` : "no audio stream");
  let L = null, silences = [], onsets = [];
  if (info.hasAudio) {
    const env = envelope(ctx, src.file);
    const audioDur = +(env.length * FRAME).toFixed(2);
    ctx.check("audio and video durations agree", Math.abs(audioDur - info.duration) < 0.3, `audio ${audioDur}s, container ${info.duration}s`);
    writeFileSync(join(out, "envelope.csv"), "t,db\n" + Array.from(env, (v, i) => `${(i * FRAME).toFixed(2)},${v.toFixed(1)}`).join("\n") + "\n");
    ctx.output(join(out, "envelope.csv"), "50 ms RMS level, dBFS");

    L = loudness(ctx, ["-i", src.file]);
    writeJson(join(out, "loudness.json"), L);
    ctx.output(join(out, "loudness.json"), `${L.I} LUFS, true peak ${L.truePeak} dBTP`);

    silences = runs(env.length, (i) => env[i] < params.silenceDb, params.silenceMin);
    writeJson(join(out, "silences.json"), silences);
    ctx.output(join(out, "silences.json"), `${silences.length} quiet runs below ${params.silenceDb} dB`);

    for (let i = 3; i < env.length; i++) {
      const jump = env[i] - Math.min(env[i - 1], env[i - 2], env[i - 3]);
      if (jump < params.onsetJumpDb || env[i] < params.silenceDb) continue;
      const t = +(i * FRAME).toFixed(2);
      const last = onsets.at(-1);
      if (last && t - last.t < params.onsetMinGap) {
        if (jump > last.jump) Object.assign(last, { t, jump: +jump.toFixed(1), db: env[i] });
        continue;
      }
      onsets.push({ t, jump: +jump.toFixed(1), db: env[i] });
    }
    writeJson(join(out, "onsets.json"), onsets);
    ctx.output(join(out, "onsets.json"), `${onsets.length} sudden sounds (jump >= ${params.onsetJumpDb} dB)`);

    const wave = join(out, "waveform.png");
    ctx.ffmpeg(["-i", src.file, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1800x240:colors=0x39e43a", "-frames:v", "1", wave], { why: "waveform picture" });
    ctx.output(wave, "waveform");
    ctx.image(wave, `waveform, 0–${info.duration}s`);
  }

  // ---------- the speech: whisper, then the script's paragraphs in it ----------
  let speech = null;
  if (hasScript) {
    if (mode === "footage") {
      const v = sourceVoice(P);
      ctx.input(v.file, "voiceover");
      speech = { file: v.file, what: "the voiceover" };
    } else if (info.hasAudio) speech = { file: src.file, what: "the footage (on camera)" };
  } else if (params.transcribe && info.hasAudio) speech = { file: src.file, what: "the footage" };

  let words = null;
  if (speech) {
    words = transcribe(ctx, speech.file, out, { language: params.language }) || [];
    writeFileSync(join(out, "words.tsv"), ["start\tend\tword", ...words.map((w) => `${w.start.toFixed(2)}\t${w.end.toFixed(2)}\t${w.text}`)].join("\n") + "\n");
    const lines = [];
    let cur = [], st = null;
    for (const w of words) {
      if (st === null) st = w.start;
      cur.push(w.text);
      if (/[.?!]$/.test(w.text.trim()) || cur.join(" ").length > 110) {
        lines.push(`${st.toFixed(2).padStart(7)}  ${cur.join(" ")}`);
        cur = [];
        st = null;
      }
    }
    if (cur.length) lines.push(`${st.toFixed(2).padStart(7)}  ${cur.join(" ")}`);
    writeFileSync(join(out, "sentences.txt"), lines.join("\n") + "\n");
    ctx.output(join(out, "transcript.json"), `${words.length} words from ${speech.what} (TIMING ONLY: never copy whisper text to screen)`);
    ctx.output(join(out, "words.tsv"), "one word per line with start/end");
    ctx.output(join(out, "sentences.txt"), `${lines.length} sentences with start times`);
  } else if (!hasScript) ctx.note("transcription skipped (no script, and params.transcribe is false)");

  let alignment = null;
  if (hasScript && words) {
    const paras = paragraphsOf(readFileSync(scriptFile, "utf8"));
    alignment = alignScript(paras, words, params);
    writeJson(join(out, "alignment.json"), { source: P.rel(speech.file), mode, paragraphs: alignment });
    const missing = alignment.filter((a) => !a.found || a.coverage < params.minCoverage);
    const where = (i) => {
      const before = alignment.slice(0, i).reverse().find((a) => a.found), after = alignment.slice(i + 1).find((a) => a.found);
      return `expected between ${before ? fmtT(before.end) : "the start"} and ${after ? fmtT(after.start) : "the end"}`;
    };
    ctx.check(`every paragraph found in ${speech.what}`, !missing.length,
      missing.map((a) => `p${a.p} ${a.found ? `only ${Math.round(a.coverage * 100)}% said` : "not found"} (${where(a.p - 1)})`).join("; ") || `${alignment.length} paragraphs`);
    const md = ["# Alignment: where each paragraph was said", "", `Speech: \`${P.rel(speech.file)}\` (${speech.what}). A retake replaces the take before it; pauses over ${params.maxPause} s and stumbles of 3+ words are cut out.`, "",
      "| p | kept | coverage | segments | other takes | paragraph |", "|---|---|---|---|---|---|"];
    alignment.forEach((a, i) => {
      const others = a.takes.filter((_, k) => k !== a.take && a.takes[k].coverage >= 0.5).map((t) => `${fmtT(t.start)} (${Math.round(t.coverage * 100)}%)`).join(", ");
      md.push(`| ${a.p} | ${a.found ? `${fmtT(a.start)}–${fmtT(a.end)}` : "**not found**"} | ${Math.round(a.coverage * 100)}% | ${a.segments.length} | ${others || "–"} | ${paras[i].slice(0, 70).replace(/\|/g, "\\|")}${paras[i].length > 70 ? "…" : ""} |`);
    });
    writeFileSync(join(out, "alignment.md"), md.join("\n") + "\n");
    ctx.output(join(out, "alignment.json"), `${alignment.filter((a) => a.found).length}/${alignment.length} paragraphs found, ${alignment.reduce((n, a) => n + a.segments.length, 0)} segments to keep`);
    ctx.output(join(out, "alignment.md"), "the alignment, for reading");
    const retaken = alignment.filter((a) => a.takes.filter((t) => t.coverage >= 0.5).length > 1);
    if (retaken.length) ctx.note(`retakes: ${retaken.map((a) => `p${a.p}`).join(", ")}; the last complete take of each is kept`);

    // planned: the trim. Seed edit.json with one piece per kept segment while it is a scaffold.
    if (mode === "planned") {
      const editFile = P.st[ID.edit].config;
      const edit = readJsonIf(editFile);
      if (edit?._scaffold) {
        const fps = edit.fps ?? 30, snap = (t) => Math.floor((Math.round(t * fps) / fps) * 1e6) / 1e6; // a frame time, floored to 6 decimals so trim keeps exactly the whole frames between two snaps
        const pieces = [], order = []; // order: the paragraph each piece belongs to, for placing sound bites
        for (const a of alignment)
          a.segments.forEach((s, k) => {
            const from = snap(Math.max(0, s.start - params.pad, pieces.at(-1)?.to ?? 0)), to = snap(Math.min(info.duration, s.end + params.pad));
            if (to > from) {
              pieces.push({ id: `P${a.p}${a.segments.length > 1 ? String.fromCharCode(97 + k) : ""}`, from, to, speed: 1, audio: true });
              order.push(a.p);
            }
          });
        // Sound bites (state 1 soundbites.json): a piece of the cabildo clip after the last piece of
        // paragraph "after" (0 = before the first), in list order when several share a paragraph.
        const bites = (pieces.length && readSoundbites(P)) || [];
        if (bites.length) ctx.input(soundbitesFile(P), "sound bites (state 1): spliced in after their paragraph");
        bites.forEach((b, k) => {
          pieces.push({ id: `S${k + 1}`, file: b.clip, from: snap(b.from), to: snap(b.to), speed: 1, audio: true, soundbite: b.id });
          order.push(b.after + 0.5);
        });
        const seeded = pieces.map((p, i) => [p, order[i], i]).sort((x, y) => x[1] - y[1] || x[2] - y[2]).map(([p]) => p);
        if (seeded.length) {
          writeJson(editFile, { ...edit, _scaffold: true, _seededBy: "audio-analysis (alignment)", pieces: seeded });
          ctx.note(`seeded ${P.rel(editFile)} with ${seeded.length} pieces (one per kept segment${bites.length ? `, plus ${bites.length} sound bite(s): ${bites.map((b, k) => `S${k + 1}=${b.id} after p${b.after}`).join(", ")}` : ""}). It stays a scaffold until you edit it by hand.`);
        }
      }
    }
  }
  ctx.extra.summary = { duration: info.duration, lufs: L?.I ?? null, silences: silences.length, onsets: onsets.length, paragraphs: alignment?.length ?? 0, found: alignment?.filter((a) => a.found).length ?? 0 };
}
