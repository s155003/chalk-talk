/* College play-call simulator. Runs in the browser and in the API.
   A simulated snap is drawn from real plays: half from what the offense (or
   the chosen player) has done on that kind of play, half from what the
   defense has allowed on it, filtered to the down and distance when the
   sample is big enough. Outcomes keep their real yards, sacks, picks and
   fumbles, then get scored in expected points for the situation you set. */

import { rng } from "./sim.js";

export const KIND = { RUSH: 0, QB_RUSH: 1, PASS: 2 };
export const KIND_LABEL = ["Hand off", "QB keep", "Throw"];
export const F = { SACK: 1, INT: 2, FUMBLE: 4, TD: 8, COMPLETE: 16, STUFF: 32 };
// row layout: [yards, kind, down, distBucket, flags, playerId]
const Y = 0, K = 1, DN = 2, DB = 3, FL = 4, PID = 5;

export function distBucket(d) { return d <= 3 ? 0 : d <= 7 ? 1 : 2; }
export function downGroup(d) { return d <= 1 ? 1 : d === 2 ? 2 : 3; } // 3rd and 4th share a group
const dg = (d) => downGroup(d);

export function createCfbSim(league, season) {
  const S = league.seasons[season] || league.seasons[Object.keys(league.seasons).at(-1)];
  const ep = S.ep;

  function epLookup(down, ytg, ytoEZ) {
    const d = Math.max(1, Math.min(4, down));
    const yb = ytg <= 3 ? "1-3" : ytg <= 6 ? "4-6" : ytg <= 10 ? "7-10" : ytg <= 15 ? "11-15" : "16+";
    const eb = Math.floor((Math.max(1, Math.min(99, ytoEZ)) - 1) / 10);
    const v = ep[`${d}|${yb}|${eb}`];
    if (v !== undefined) return v;
    const w = ep[`${d}|*|${eb}`];
    return w !== undefined ? w : 0;
  }
  function afterEP(sit, yards, turnover) {
    const { down, ytg, ytoEZ } = sit;
    if (turnover) {
      const spot = Math.max(1, Math.min(99, 100 - (ytoEZ - yards)));
      return -epLookup(1, 10, spot);
    }
    if (yards >= ytoEZ) return 6.95;
    const newEZ = ytoEZ - yards;
    if (newEZ >= 100) return -2;
    if (yards >= ytg) return epLookup(1, Math.min(10, newEZ), newEZ);
    if (down >= 4) return -epLookup(1, 10, Math.max(1, Math.min(99, 100 - newEZ)));
    return epLookup(down + 1, ytg - yards, newEZ);
  }

  /* Pick the rows that describe this call. Prefer the tightest filter with
     enough plays; fall back step by step. Returns {rows, level} where level
     says how specific the sample is, for display. */
  function pool(rows, kind, sit, playerId, minN) {
    const steps = [];
    if (playerId) {
      steps.push(["player, same down and distance", (r) => r[K] === kind && r[PID] === playerId && dg(r[DN]) === dg(sit.down) && r[DB] === distBucket(sit.ytg)]);
      steps.push(["player, same down", (r) => r[K] === kind && r[PID] === playerId && dg(r[DN]) === dg(sit.down)]);
      steps.push(["player, all plays", (r) => r[K] === kind && r[PID] === playerId]);
    }
    steps.push(["same down and distance", (r) => r[K] === kind && dg(r[DN]) === dg(sit.down) && r[DB] === distBucket(sit.ytg)]);
    steps.push(["same down", (r) => r[K] === kind && dg(r[DN]) === dg(sit.down)]);
    steps.push(["all plays of this kind", (r) => r[K] === kind]);
    for (const [level, f] of steps) {
      const sel = rows.filter(f);
      if (sel.length >= minN) return { rows: sel, level };
    }
    // nothing reached minN: take the most specific non-empty step
    for (const [level, f] of steps) {
      const sel = rows.filter(f);
      if (sel.length > 0) return { rows: sel, level: `${level} (small sample)` };
    }
    return { rows: [], level: "no plays" };
  }

  function outcome(row, sit) {
    const flags = row[FL];
    const turnover = Boolean(flags & (F.INT | F.FUMBLE));
    let yards = row[Y];
    if (!turnover) yards = Math.min(yards, sit.ytoEZ);
    const td = !turnover && yards >= sit.ytoEZ;
    const e = afterEP(sit, turnover ? Math.max(0, row[Y]) : yards, turnover) - epLookup(sit.down, sit.ytg, sit.ytoEZ);
    return { yards, flags, turnover, td, sack: Boolean(flags & F.SACK), int: Boolean(flags & F.INT), fumble: Boolean(flags & F.FUMBLE),
      complete: Boolean(flags & F.COMPLETE), stuff: Boolean(flags & F.STUFF), epa: e, firstDown: !turnover && yards >= sit.ytg };
  }

  /* call = { kind, playerId } ; off/def are team files ; sit = {down, ytg, ytoEZ} */
  function simulate(call, off, def, sit, opts = {}) {
    const reps = Math.max(50, Math.min(5000, opts.reps || 1000));
    const rand = rng(opts.seed ?? 42);
    const po = pool(off.offense, call.kind, sit, call.playerId || 0, opts.minN || 30);
    const pd = pool(def.defense, call.kind, sit, 0, opts.minN || 30);
    const mix = opts.mix ?? 0.5;
    const out = [];
    for (let i = 0; i < reps; i++) {
      const fromOff = rand() < mix;
      const rows = fromOff ? po.rows : pd.rows;
      if (rows.length === 0) continue;
      const row = rows[Math.floor(rand() * rows.length)];
      out.push({ ...outcome(row, sit), src: fromOff ? "offense" : "defense" });
    }
    return { summary: summarize(out, sit, po, pd), reps: out, pools: { offense: po, defense: pd } };
  }

  function stats(rows) {
    const n = rows.length;
    if (!n) return null;
    const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / n;
    return { n, ypp: mean((r) => r[Y]), explosive: mean((r) => (r[Y] >= 15 ? 1 : 0)), sack: mean((r) => (r[FL] & F.SACK ? 1 : 0)),
      turnover: mean((r) => (r[FL] & (F.INT | F.FUMBLE) ? 1 : 0)), stuff: mean((r) => (r[FL] & F.STUFF ? 1 : 0)), complete: mean((r) => (r[FL] & F.COMPLETE ? 1 : 0)) };
  }

  function summarize(out, sit, po, pd) {
    const n = out.length || 1;
    const mean = (f) => out.reduce((a, r) => a + f(r), 0) / n;
    const yards = out.map((r) => r.yards).sort((a, b) => a - b);
    const q = (p) => yards[Math.min(yards.length - 1, Math.floor(p * yards.length))] ?? 0;
    return {
      n: out.length,
      epa: mean((r) => r.epa), success: mean((r) => (r.epa > 0 ? 1 : 0)), firstDown: mean((r) => (r.firstDown ? 1 : 0)),
      touchdown: mean((r) => (r.td ? 1 : 0)), turnover: mean((r) => (r.turnover ? 1 : 0)), sack: mean((r) => (r.sack ? 1 : 0)),
      stuff: mean((r) => (r.stuff ? 1 : 0)), complete: mean((r) => (r.complete ? 1 : 0)), explosive: mean((r) => (r.yards >= 15 ? 1 : 0)),
      yardsMean: mean((r) => r.yards), yardsQ: { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) }, yards,
      ep0: epLookup(sit.down, sit.ytg, sit.ytoEZ),
      offensePool: { level: po.level, ...stats(po.rows) }, defensePool: { level: pd.level, ...stats(pd.rows) }
    };
  }

  /* Every sensible call for this offense, ranked by EPA. */
  function compare(off, def, sit, opts = {}) {
    const calls = [];
    const P = off.players;
    for (const p of (P.RB || []).slice(0, 3)) if (p.carries >= 15) calls.push({ kind: KIND.RUSH, playerId: p.id, label: `Hand off to ${p.name}` });
    for (const p of (P.QB || []).slice(0, 1)) if ((p.carries || 0) >= 10) calls.push({ kind: KIND.QB_RUSH, playerId: p.id, label: `QB keep, ${p.name}` });
    for (const p of [...(P.WR || []), ...(P.TE || []), ...(P.RB || [])].filter((x) => (x.targets || 0) >= 12).sort((a, b) => b.targets - a.targets).slice(0, 5)) {
      calls.push({ kind: KIND.PASS, playerId: p.id, label: `Throw to ${p.name}` });
    }
    calls.push({ kind: KIND.RUSH, playerId: 0, label: "Hand off (any back)" });
    calls.push({ kind: KIND.PASS, playerId: 0, label: "Throw (any target)" });
    const rows = calls.map((c, i) => {
      const { summary } = simulate(c, off, def, sit, { ...opts, reps: opts.reps || 600, seed: (opts.seed ?? 42) + i });
      return { ...c, summary };
    });
    rows.sort((a, b) => b.summary.epa - a.summary.epa);
    return rows;
  }

  return { simulate, compare, pool, epLookup, stats, baseline: S.baseline, season: Number(season) };
}
