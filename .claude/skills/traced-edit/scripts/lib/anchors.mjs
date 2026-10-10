// Anchors: how sfx rules and music sections say WHEN, in terms of the edit instead of seconds.
// Shared by state 5 (sound effects) and state 6 (music) so both speak the same language.
//   { "on": "event", "where": { "piece": "B", "every": 10, "exceptLast": true } }
//   { "on": "event", "n": 12 }   { "on": "firstEvent" }   { "on": "lastEvent" }
//   { "on": "pieceStart", "piece": "B" }   { "on": "pieceEnd", "piece": "B" }   { "on": "at", "t": 12.5 }
//   { "on": "soundbiteStart", "id": "sb1" }   { "on": "soundbiteEnd", "id": "sb1" }   (timeline soundbites[])
// plus an optional "offset" (seconds, negative = earlier). All times are CUT seconds.
import { UserError } from "./paths.mjs";

export const ONS = ["event", "firstEvent", "lastEvent", "pieceStart", "pieceEnd", "soundbiteStart", "soundbiteEnd", "at"];

/** Every time an anchor fires: [{ t, anchor (description), n?, piece? }]. Offset NOT applied. */
export function anchors(rule, tl, who = "rule") {
  const ev = tl.events;
  const piece = (id) => {
    const p = tl.pieces.find((x) => x.id === id);
    if (!p) throw new UserError(`${who}: piece "${id}" is not in the timeline (pieces: ${tl.pieces.map((x) => x.id).join(", ")})`);
    return p;
  };
  const list = (v) => (v == null ? null : [].concat(v));
  switch (rule.on) {
    case "event": {
      const w = { ...(rule.where || {}), ...(rule.n != null ? { n: rule.n } : {}) };
      const last = ev.at(-1)?.n;
      return ev
        .filter((e) => !list(w.piece) || list(w.piece).includes(e.piece))
        .filter((e) => !list(w.notPiece) || !list(w.notPiece).includes(e.piece))
        .filter((e) => !w.every || e.n % w.every === 0)
        .filter((e) => !w.exceptLast || e.n !== last)
        .filter((e) => !list(w.n) || list(w.n).includes(e.n))
        .map((e) => ({ t: e.t, anchor: `event #${e.n}`, n: e.n }));
    }
    case "firstEvent":
      return ev.length ? [{ t: ev[0].t, anchor: `first event #${ev[0].n}`, n: ev[0].n }] : [];
    case "lastEvent":
      return ev.length ? [{ t: ev.at(-1).t, anchor: `last event #${ev.at(-1).n}`, n: ev.at(-1).n }] : [];
    case "pieceStart": {
      const p = piece(rule.piece);
      return [{ t: p.start, anchor: `start of piece ${p.id}`, piece: p }];
    }
    case "pieceEnd": {
      const p = piece(rule.piece);
      return [{ t: p.start + p.duration, anchor: `end of piece ${p.id}`, piece: p }];
    }
    case "soundbiteStart":
    case "soundbiteEnd": {
      const all = tl.soundbites || [];
      const s = all.find((x) => x.id === rule.id);
      if (!s) throw new UserError(`${who}: sound bite "${rule.id}" is not in the timeline (${all.length ? `sound bites: ${all.map((x) => x.id).join(", ")}` : "it has none: state 1 soundbites.json + a piece with \"soundbite\""})`);
      return rule.on === "soundbiteStart" ? [{ t: s.t, anchor: `start of sound bite ${s.id}` }] : [{ t: +(s.t + s.dur).toFixed(3), anchor: `end of sound bite ${s.id}` }];
    }
    case "at":
      return [{ t: rule.t, anchor: `fixed ${rule.t}s` }];
    default:
      throw new UserError(`${who}: "on" must be one of ${ONS.join(", ")} (got ${JSON.stringify(rule.on)})`);
  }
}

/**
 * One time from a number (cut seconds) or an anchor that fires exactly once. Returns
 * { t, anchor } with the offset applied.
 */
export function resolveTime(x, tl, who) {
  if (typeof x === "number") return { t: x, anchor: `${x}s` };
  if (!x || typeof x !== "object") throw new UserError(`${who}: must be cut seconds (a number) or an anchor like {"on": "pieceStart", "piece": "B"}`);
  const hits = anchors(x, tl, who);
  if (hits.length !== 1)
    throw new UserError(`${who}: the anchor ${JSON.stringify(x)} fires ${hits.length} times; it must fire exactly once (for "event", give "n")`);
  const off = x.offset || 0;
  return { t: +(hits[0].t + off).toFixed(4), anchor: hits[0].anchor + (off ? ` ${off > 0 ? "+" : ""}${off}s` : "") };
}
