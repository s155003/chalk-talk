/* Chalk Talk simulation engine. Runs in the browser and in the API functions.
   Everything here samples from tables built from 2022 NFL tracking data
   (public/data/model.json). No model call is involved in a simulation. */

export const ROUTES = ["GO", "POST", "CORNER", "OUT", "IN", "SLANT", "HITCH", "CROSS", "FLAT", "SCREEN", "ANGLE", "WHEEL"];
export const ROUTE_LABEL = {
  GO: "Go", POST: "Post", CORNER: "Corner", OUT: "Out", IN: "Dig (in)", SLANT: "Slant", HITCH: "Hitch",
  CROSS: "Crosser", FLAT: "Flat", SCREEN: "Screen", ANGLE: "Angle", WHEEL: "Wheel"
};
export const FIELD_W = 53.3;

// Deterministic PRNG so a seed reproduces a run (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

export function createSim(model) {
  const QS = model.meta.quantiles;
  const manSet = new Set(model.coverages.filter((c) => c.man).map((c) => c.name));
  const covNames = model.coverages.map((c) => c.name);

  // Inverse-CDF sample from stored quantiles with linear interpolation; tails extrapolated.
  function sampleQ(q, u) {
    if (!q || q.length === 0) return 0;
    const lo = QS[0], hi = QS[QS.length - 1];
    if (u <= lo) return q[0] - (q[1] - q[0]) * ((lo - u) / (QS[1] - QS[0]));
    if (u >= hi) return q[q.length - 1] + (q[q.length - 1] - q[q.length - 2]) * ((u - hi) / (QS[1] - QS[0]));
    let i = 0;
    while (QS[i + 1] < u) i++;
    const f = (u - QS[i]) / (QS[i + 1] - QS[i]);
    return q[i] + (q[i + 1] - q[i]) * f;
  }

  function alignOf(y) { return (y <= 12 || y >= FIELD_W - 12) ? "outside" : "slot"; }

  function sepCell(route, cov, align) {
    return model.sep[`${route}|${cov}|${align}`] || model.sep[`${route}|${cov}`] || model.sep[route];
  }

  function epLookup(down, ytg, ytoEZ) {
    const d = Math.max(1, Math.min(4, down));
    const yb = ytg <= 3 ? "1-3" : ytg <= 6 ? "4-6" : ytg <= 10 ? "7-10" : ytg <= 15 ? "11-15" : "16+";
    const eb = Math.floor((Math.max(1, Math.min(99, ytoEZ)) - 1) / 10);
    const v = model.ep[`${d}|${yb}|${eb}`];
    if (v !== undefined) return v;
    const w = model.ep[`${d}|*|${eb}`];
    return w !== undefined ? w : 0;
  }

  function nextStateEP(sit, yards, turnover) {
    const { down, ytg, ytoEZ } = sit;
    if (turnover) {
      // opponent takes over at the spot
      const spot = Math.max(1, Math.min(99, 100 - (ytoEZ - yards)));
      return -epLookup(1, 10, spot);
    }
    if (yards >= ytoEZ) return 6.95; // touchdown (approximate expected value of a TD)
    const newEZ = ytoEZ - yards;
    if (newEZ >= 100) return -2; // safety
    if (yards >= ytg) return epLookup(1, Math.min(10, newEZ), newEZ);
    if (down >= 4) return -epLookup(1, 10, Math.max(1, Math.min(99, 100 - newEZ)));
    return epLookup(down + 1, ytg - yards, newEZ);
  }

  function pickCoverage(defense, rand) {
    if (defense.coverage && defense.coverage !== "mix") return defense.coverage;
    const mix = defense.team && model.teams[defense.team] ? model.teams[defense.team].mix : null;
    const u = rand();
    let acc = 0;
    for (const c of model.coverages) {
      acc += mix ? mix[c.name] : c.share;
      if (u <= acc) return c.name;
    }
    return "Cover 3";
  }

  function receiverShift(r) {
    if (!r.playerId) return 0;
    const p = model.receivers.find((x) => x.id === r.playerId);
    return p ? p.shift : 0;
  }

  /* One snap. Returns a full record so the UI can animate it. */
  function snap(play, defense, sit, rand) {
    const cov = pickCoverage(defense, rand);
    const man = manSet.has(cov);
    const team = defense.team && model.teams[defense.team] ? model.teams[defense.team] : null;
    const teamShift = team ? (man ? team.shift_man : team.shift_zone) : 0;

    const recs = play.receivers.map((r) => {
      const cell = sepCell(r.route, cov, alignOf(r.y));
      let sep = sampleQ(cell.q, rand()) + teamShift + receiverShift(r);
      sep = Math.min(15, Math.max(0.1, sep));
      const depth = sampleQ(model.routes[r.route].depth_q, rand());
      return { id: r.id, route: r.route, sep, depth, cellN: cell.n };
    });

    const maxDepth = Math.max(...recs.map((r) => r.depth));
    const bucket = maxDepth <= 8 ? "short" : maxDepth <= 16 ? "medium" : "deep";
    const tttQ = (model.dropback[`ttt|${bucket}`] || model.dropback["ttt|medium"]).q;
    const ttt = Math.min(4.5, Math.max(1.0, sampleQ(tttQ, rand())));
    const rates = model.dropback[cov] || model.dropback["*"];
    const u0 = rand();
    const base = { cov, man, ttt, recs, target: null };
    if (u0 < rates.sack) {
      const yards = Math.round(sampleQ(model.sack_yards_q, rand()));
      return { ...base, type: "sack", yards, epa: nextStateEP(sit, yards, false) - epLookup(sit.down, sit.ytg, sit.ytoEZ) };
    }
    if (u0 < rates.sack + rates.scramble) {
      const yards = Math.round(sampleQ(model.scramble_yards_q, rand()));
      return { ...base, type: "scramble", yards, epa: nextStateEP(sit, yards, false) - epLookup(sit.down, sit.ytg, sit.ytoEZ) };
    }

    // target choice: conditional logit with Gumbel noise
    const tc = model.target.coef;
    let best = 0, bestU = -Infinity;
    recs.forEach((r, i) => {
      const sepC = Math.min(r.sep, 10);
      const isSF = (r.route === "SCREEN" || r.route === "FLAT") ? 1 : 0;
      const u = tc[0] * sepC + tc[1] * r.depth + tc[2] * (r.depth * r.depth / 100) + tc[3] * isSF
        - Math.log(-Math.log(Math.max(1e-9, rand())));
      if (u > bestU) { bestU = u; best = i; }
    });
    const t = recs[best];
    const sepC = Math.min(t.sep, 10);
    const feats = [1, sepC, t.depth, sepC * t.depth / 10, man ? 1 : 0];
    const pc = sigmoid(feats.reduce((a, f, i) => a + f * model.completion.coef[i], 0));
    const pi = sigmoid(feats.reduce((a, f, i) => a + f * model.interception.coef[i], 0));
    const u1 = rand();
    const ep0 = epLookup(sit.down, sit.ytg, sit.ytoEZ);
    if (u1 < pi) {
      return { ...base, target: best, type: "interception", yards: 0, epa: nextStateEP(sit, Math.round(t.depth), true) - ep0, pc, pi };
    }
    if (u1 < pi + Math.min(pc, 1 - pi)) {
      const yac = Math.max(0, sampleQ(model.yac[t.route].q, rand()));
      let yards = Math.round(t.depth + yac);
      yards = Math.min(yards, sit.ytoEZ);
      return { ...base, target: best, type: "complete", yards, yac, epa: nextStateEP(sit, yards, false) - ep0, pc, pi };
    }
    return { ...base, target: best, type: "incomplete", yards: 0, epa: nextStateEP(sit, 0, false) - ep0, pc, pi };
  }

  function summarize(reps, play, sit) {
    const n = reps.length;
    const count = (f) => reps.filter(f).length;
    const throws = reps.filter((r) => r.target !== null);
    const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const yards = reps.map((r) => r.yards).sort((a, b) => a - b);
    const q = (p) => yards[Math.min(n - 1, Math.floor(p * n))];
    const perReceiver = play.receivers.map((r, i) => {
      const tg = throws.filter((x) => x.target === i);
      const seps = reps.map((x) => x.recs[i].sep);
      return {
        id: r.id, route: r.route,
        targetShare: throws.length ? tg.length / throws.length : 0,
        openRate: mean(seps.map((s) => (s >= 3 ? 1 : 0))),
        sepMean: mean(seps),
        sepQ: [0.25, 0.5, 0.75].map((p) => { const s = [...seps].sort((a, b) => a - b); return s[Math.floor(p * s.length)]; }),
        catchRate: tg.length ? count((x) => x.target === i && x.type === "complete") / tg.length : 0,
        yardsPerTarget: tg.length ? mean(tg.map((x) => x.yards)) : 0,
        epaPerTarget: tg.length ? mean(tg.map((x) => x.epa)) : 0,
        cellN: reps[0].recs[i].cellN
      };
    });
    const covCounts = {};
    for (const r of reps) covCounts[r.cov] = (covCounts[r.cov] || 0) + 1;
    return {
      n,
      epa: mean(reps.map((r) => r.epa)),
      success: count((r) => r.epa > 0) / n,
      completion: throws.length ? count((r) => r.type === "complete") / throws.length : 0,
      firstDown: count((r) => r.yards >= sit.ytg || r.yards >= sit.ytoEZ) / n,
      touchdown: count((r) => r.yards >= sit.ytoEZ) / n,
      interception: count((r) => r.type === "interception") / n,
      sack: count((r) => r.type === "sack") / n,
      scramble: count((r) => r.type === "scramble") / n,
      yardsMean: mean(reps.map((r) => r.yards)),
      yardsQ: { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) },
      explosive: count((r) => r.yards >= 15) / n,
      yards,
      perReceiver,
      coverages: covCounts,
      ep0: epLookup(sit.down, sit.ytg, sit.ytoEZ)
    };
  }

  function simulate(play, defense, sit, opts = {}) {
    const reps = Math.max(10, Math.min(5000, opts.reps || 1000));
    const rand = rng(opts.seed ?? 12345);
    const out = [];
    for (let i = 0; i < reps; i++) out.push(snap(play, defense, sit, rand));
    const summary = summarize(out, play, sit);
    return { summary, reps: out };
  }

  // Geometry helpers for drawing and animation.
  function pathFor(route, role, man) {
    return model.paths[`${route}|${role}|${man ? "man" : "zone"}`] || model.paths[`${route}|${role}|zone`] || model.paths[`${route}|${role}|man`];
  }
  function sideSign(y) { return y < FIELD_W / 2 ? 1 : -1; } // inside is +y on the left half
  function routePoints(r, man) {
    const p = pathFor(r.route, "R", man);
    if (!p) return [];
    const s = sideSign(r.y);
    return p.pts.map((pt) => pt ? { x: r.x + pt[0], y: r.y + s * pt[1] } : null);
  }
  function defenderPoints(r, man) {
    const p = pathFor(r.route, "D", man);
    if (!p) return [];
    const s = sideSign(r.y);
    return p.pts.map((pt) => pt ? { x: r.x + pt[0], y: r.y + s * pt[1] } : null);
  }

  return { simulate, snap, summarize, epLookup, routePoints, defenderPoints, alignOf, sepCell, covNames, manSet, model };
}

/* A sensible default play: 3x1 with a dig, a go, a flat, a corner and a check-down. */
export function defaultPlay() {
  return {
    name: "Starter",
    receivers: [
      { id: "X", pos: "WR", x: 0, y: 6, route: "GO" },
      { id: "H", pos: "WR", x: -1, y: 15, route: "IN" },
      { id: "Y", pos: "TE", x: 0, y: 24, route: "FLAT" },
      { id: "Z", pos: "WR", x: 0, y: 47, route: "CORNER" },
      { id: "B", pos: "RB", x: -6, y: 30, route: "ANGLE" }
    ]
  };
}

export function defaultSituation() {
  return { down: 2, ytg: 7, ytoEZ: 65 };
}
