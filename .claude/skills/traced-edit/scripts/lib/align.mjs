// Where each paragraph of the approved script was said in a recording. Pure functions: whisper
// words in, one aligned take per paragraph out. No file I/O, so it can be tested on its own.
//
// Each paragraph is matched against the transcript by local alignment (Smith-Waterman over
// normalized words: case, accents and punctuation ignored, numerals read as Spanish words, a
// close misspelling counts half). Every non-overlapping match is a take; the LAST take that
// covers enough of the paragraph wins (a retake replaces the take before it). Inside the chosen
// take, pauses longer than maxPause and runs of 3+ words that are not in the script (a stumble,
// a restarted sentence) are cut out, so a take is a list of segments to keep.

const UNITS = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"];
const TENS = { 3: "treinta", 4: "cuarenta", 5: "cincuenta", 6: "sesenta", 7: "setenta", 8: "ochenta", 9: "noventa" };
const HUNDREDS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

/** A non-negative integer as Spanish words (accents stripped, as the matcher sees them). */
export function numberWords(n) {
  if (n < 30) return [UNITS[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], "y", UNITS[n % 10]] : [TENS[n / 10]];
  if (n < 1000) return n === 100 ? ["cien"] : [HUNDREDS[Math.floor(n / 100)], ...(n % 100 ? numberWords(n % 100) : [])];
  if (n < 1e6) {
    const k = Math.floor(n / 1000), r = n % 1000;
    return [...(k === 1 ? [] : numberWords(k)), "mil", ...(r ? numberWords(r) : [])];
  }
  const m = Math.floor(n / 1e6), r = n % 1e6;
  return [...(m === 1 ? ["un", "millon"] : [...numberWords(m), "millones"]), ...(r ? numberWords(r) : [])];
}

const SAME = { un: "uno", una: "uno", unos: "uno", veintiun: "veintiuno" };

/** Words of a text as the matcher compares them. */
export function tokens(text) {
  const out = [];
  const clean = String(text).replace(/%/g, " por ciento ").replace(/(\d)[.,](?=\d{3}\b)/g, "$1");
  for (const raw of clean.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (/^\d+$/.test(raw) && raw.length <= 9) {
      out.push(...numberWords(+raw));
      continue;
    }
    const w = raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out.push(SAME[w] || w);
  }
  return out;
}

function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

const MATCH = 2, NEAR = 1, MISS = -1, GAP = -1;
function score(a, b) {
  if (a === b) return MATCH;
  if (a.length >= 4 && b.length >= 4 && 1 - lev(a, b) / Math.max(a.length, b.length) >= 0.75) return NEAR;
  return MISS;
}

/** Best local alignment of script tokens S against transcript tokens T (masked ones never match). */
function localAlign(S, T, masked) {
  const n = S.length, m = T.length;
  const H = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 diag, 2 up (skip script word), 3 left (extra transcript word)
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = masked[j - 1] ? -1e9 : score(S[i - 1], T[j - 1].w);
      const diag = H[i - 1][j - 1] + s, up = H[i - 1][j] + GAP, left = masked[j - 1] ? -1e9 : H[i][j - 1] + GAP;
      let h = 0, b = 0;
      if (diag > h) [h, b] = [diag, 1];
      if (up > h) [h, b] = [up, 2];
      if (left > h) [h, b] = [left, 3];
      H[i][j] = h;
      B[i][j] = b;
      if (h > best) [best, bi, bj] = [h, i, j];
    }
  if (!best) return null;
  const matched = new Set(); // transcript indexes matched to a script word
  let i = bi, j = bj, hits = 0;
  while (i > 0 && j > 0 && H[i][j] > 0) {
    const b = B[i][j];
    if (b === 1) {
      if (score(S[i - 1], T[j - 1].w) > 0) {
        matched.add(j - 1);
        hits++;
      }
      i--;
      j--;
    } else if (b === 2) i--;
    else j--;
  }
  return { score: best, j0: j, j1: bj - 1, matched, coverage: hits / n };
}

/**
 * paragraphs: the script's paragraphs (strings). words: whisper [{ text, start, end }].
 * Returns one entry per paragraph:
 *   { p, found, coverage, start, end, segments: [{ start, end }], takes: [{ start, end, coverage }], take }
 * `take` is the index of the chosen take in `takes`; found is false when no take reaches minFound.
 */
export function alignScript(paragraphs, words, { maxPause = 0.7, minCoverage = 0.8, minFound = 0.5, maxExtra = 3 } = {}) {
  const T = [];
  for (const w of words) for (const t of tokens(w.text)) T.push({ w: t, start: w.start, end: w.end });
  return paragraphs.map((text, k) => {
    const S = tokens(text);
    const masked = new Uint8Array(T.length);
    const takes = [];
    for (;;) {
      const a = S.length ? localAlign(S, T, masked) : null;
      if (!a || a.coverage < minFound / 2) break;
      takes.push(a);
      for (let j = a.j0; j <= a.j1; j++) masked[j] = 1;
    }
    takes.sort((x, y) => T[x.j0].start - T[y.j0].start);
    const good = takes.map((t, i) => [t, i]).filter(([t]) => t.coverage >= minCoverage);
    const pick = good.length ? good.at(-1)[1] : takes.reduce((b, t, i) => (b < 0 || t.coverage > takes[b].coverage ? i : b), -1);
    const shown = takes.map((t) => ({ start: T[t.j0].start, end: T[t.j1].end, coverage: +t.coverage.toFixed(3) }));
    const chosen = takes[pick];
    if (!chosen || chosen.coverage < minFound) return { p: k + 1, found: false, coverage: chosen ? +chosen.coverage.toFixed(3) : 0, start: null, end: null, segments: [], takes: shown, take: pick };

    // Segments to keep: split at long pauses and drop runs of maxExtra+ words not in the script.
    const segments = [];
    let cur = null, extra = [];
    const close = () => {
      if (cur) segments.push(cur);
      cur = null;
    };
    for (let j = chosen.j0; j <= chosen.j1; j++) {
      const t = T[j];
      if (!chosen.matched.has(j)) {
        extra.push(t);
        continue;
      }
      if (extra.length >= maxExtra) close(); // a stumble: cut it out
      else if (cur) for (const x of extra) cur.end = Math.max(cur.end, x.end); // a word or two: keep it
      extra = [];
      if (cur && t.start - cur.end > maxPause) close();
      if (!cur) cur = { start: t.start, end: t.end };
      else cur.end = Math.max(cur.end, t.end);
    }
    close();
    return {
      p: k + 1,
      found: true,
      coverage: +chosen.coverage.toFixed(3),
      start: segments[0].start,
      end: segments.at(-1).end,
      segments: segments.map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3) })),
      takes: shown,
      take: pick,
    };
  });
}
