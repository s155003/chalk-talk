import { createCfbSim, KIND, KIND_LABEL, F } from "./cfbsim.js";
import { FIELD_W } from "./sim.js";

const $ = (s) => document.querySelector(s);
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "hidden") n.hidden = Boolean(v); else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const NS = "http://www.w3.org/2000/svg";
function sv(tag, attrs, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const pct1 = (x) => `${((x || 0) * 100).toFixed(1)}%`;
const signed = (x, d = 2) => (x >= 0 ? "+" : "") + (x || 0).toFixed(d);
const ordinal = (n) => ["", "1st", "2nd", "3rd", "4th"][n] || `${n}th`;

/* ---------- state ---------- */
const S = {
  league: null, sim: null, season: null,
  offSlug: "texas-a-m", defSlug: "texas", off: null, def: null,
  sit: { down: 3, ytg: 4, ytoEZ: 55 },
  formation: "gun3x1", front: "425",
  call: { kind: KIND.RUSH, playerId: 0 },
  result: null, compareRows: null, scoutSide: "defense",
  chat: [], chatBusy: false, anim: null
};
const cache = new Map();
async function loadTeam(slug, season) {
  const key = `${slug}-${season}`;
  if (!cache.has(key)) {
    const res = await fetch(`data/cfb/teams/${key}.json`);
    if (!res.ok) throw new Error(`No data for ${key}`);
    cache.set(key, await res.json());
  }
  return cache.get(key);
}

/* ---------- formations and fronts (templates; the data has no formations) ---------- */
const OL = [[-0.8, 22.65], [-0.8, 24.65], [-0.8, 26.65], [-0.8, 28.65], [-0.8, 30.65]];
const FORMATIONS = {
  gun3x1: { label: "Shotgun 3x1 (11 personnel)", QB: [-5, 26.65], RB: [[-5, 30.5]], TE: [[-0.3, 32.6]], WR: [[0, 5], [-1, 14], [-1, 48]] },
  gun2x2: { label: "Shotgun 2x2 (11 personnel)", QB: [-5, 26.65], RB: [[-5, 22.8]], TE: [[-1, 38]], WR: [[0, 5], [-1, 15], [0, 48]] },
  iform: { label: "I-formation (21 personnel)", QB: [-1.5, 26.65], RB: [[-7, 26.65], [-4.5, 26.65]], TE: [[-0.3, 32.6]], WR: [[0, 6], [0, 47]] },
  twelve: { label: "12 personnel, two tight ends", QB: [-5, 26.65], RB: [[-5, 30.5]], TE: [[-0.3, 32.6], [-0.3, 20.7]], WR: [[0, 5], [0, 48]] },
  empty: { label: "Empty (10 personnel)", QB: [-5, 26.65], RB: [[-1, 20]], TE: [[-1, 34]], WR: [[0, 5], [-1, 13], [0, 48]] }
};
const FRONTS = {
  "425": { label: "4-2-5 nickel", DL: [[1.2, 22.2], [1.2, 25.6], [1.2, 27.7], [1.2, 31.1]], LB: [[4.8, 24.2], [4.8, 29.5]], DB: [[6.5, 6], [6.5, 48], [5.5, 14.5], [12, 19], [12, 36]] },
  "335": { label: "3-3-5", DL: [[1.2, 23.2], [1.2, 26.65], [1.2, 30.1]], LB: [[4.5, 22], [4.5, 26.65], [4.5, 31.5]], DB: [[6.5, 6], [6.5, 48], [5.5, 14.5], [12, 19], [12, 36]] },
  "43": { label: "4-3 base", DL: [[1.2, 22.2], [1.2, 25.6], [1.2, 27.7], [1.2, 31.1]], LB: [[4.8, 22.5], [4.8, 26.65], [4.8, 31]], DB: [[6.5, 6], [6.5, 48], [12, 19], [12, 36]] },
  "34": { label: "3-4 base", DL: [[1.2, 23.2], [1.2, 26.65], [1.2, 30.1]], LB: [[2.5, 20.8], [4.8, 24.5], [4.8, 28.8], [2.5, 32.5]], DB: [[6.5, 6], [6.5, 48], [12, 19], [12, 36]] }
};

/* ---------- board ---------- */
const X_MIN = -14, X_MAX = 22;
const VW = FIELD_W, VH = X_MAX - X_MIN;
const sx = (y) => y, sy = (x) => X_MAX - x;

function lineup() {
  const f = FORMATIONS[S.formation], fr = FRONTS[S.front];
  const P = S.off.players, D = S.def.players;
  const off = [];
  const qb = P.QB[0]; if (qb) off.push({ ...qb, grp: "QB", x: f.QB[0], y: f.QB[1] });
  f.RB.forEach((p, i) => { const pl = P.RB[i]; if (pl) off.push({ ...pl, grp: "RB", x: p[0], y: p[1] }); });
  f.TE.forEach((p, i) => { const pl = P.TE[i] || P.WR[f.WR.length + i]; if (pl) off.push({ ...pl, grp: "TE", x: p[0], y: p[1] }); });
  f.WR.forEach((p, i) => { const pl = P.WR[i]; if (pl) off.push({ ...pl, grp: "WR", x: p[0], y: p[1] }); });
  OL.forEach((p, i) => { const pl = P.OL[i]; off.push({ ...(pl || { name: "Lineman", jersey: null, pos: "OL" }), grp: "OL", x: p[0], y: p[1] }); });
  const def = [];
  fr.DL.forEach((p, i) => { const pl = D.DL[i]; if (pl) def.push({ ...pl, grp: "DL", x: p[0], y: p[1] }); });
  fr.LB.forEach((p, i) => { const pl = D.LB[i] || D.DL[fr.DL.length + i]; if (pl) def.push({ ...pl, grp: "LB", x: p[0], y: p[1] }); });
  fr.DB.forEach((p, i) => { const pl = D.DB[i]; if (pl) def.push({ ...pl, grp: "DB", x: p[0], y: p[1] }); });
  return { off, def };
}

function statLine(p) {
  const parts = [];
  if (p.att) parts.push(`${pct(p.comp)} comp, ${p.ypa} yds/att, ${p.td} TD, ${p.int} INT`);
  if (p.carries) parts.push(`${p.carries} car, ${p.ypc} yds/car, ${pct(p.success)} success`);
  if (p.targets) parts.push(`${p.targets} tgt, ${p.catches} rec, ${p.yards} yds, ${p.td} TD`);
  if (p.havoc !== undefined) parts.push(`${p.sacks} sk, ${p.pbu} PBU, ${p.int} INT, ${p.ff} FF`);
  return parts.join("; ") || (p.grp === "OL" ? "roster" : "no stats yet");
}

function drawBoard() {
  const svg = $("#board");
  svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
  svg.style.setProperty("--off-color", S.league.teams.find((t) => t.slug === S.offSlug)?.color || "#7a1f2b");
  svg.style.setProperty("--def-color", S.league.teams.find((t) => t.slug === S.defSlug)?.color || "#1f3f7a");
  svg.replaceChildren();
  const g = sv("g");
  const ytoEZ = S.sit.ytoEZ;
  if (ytoEZ <= X_MAX) {
    g.append(sv("rect", { class: "endzone", x: 0, y: 0, width: VW, height: sy(ytoEZ) }));
    g.append(sv("line", { class: "goal", x1: 0, x2: VW, y1: sy(ytoEZ), y2: sy(ytoEZ) }));
  }
  for (let x = Math.ceil(X_MIN / 5) * 5; x <= Math.min(X_MAX, ytoEZ); x += 5) {
    if (x === 0) continue;
    g.append(sv("line", { class: "yard", x1: 0, x2: VW, y1: sy(x), y2: sy(x) }));
    if (x % 10 === 0) {
      const absolute = 100 - (ytoEZ - x); const painted = absolute > 50 ? 100 - absolute : absolute;
      if (painted > 0) { g.append(sv("text", { class: "yardnum", x: 2.2, y: sy(x) - 0.4 }, painted)); g.append(sv("text", { class: "yardnum", x: VW - 3.6, y: sy(x) - 0.4 }, painted)); }
    }
  }
  for (let x = X_MIN; x <= Math.min(X_MAX, ytoEZ); x += 1) for (const hy of [23.58, 29.75]) g.append(sv("line", { class: "hash", x1: hy - 0.4, x2: hy + 0.4, y1: sy(x), y2: sy(x) }));
  g.append(sv("line", { class: "los", x1: 0, x2: VW, y1: sy(0), y2: sy(0) }));
  if (S.sit.ytg < ytoEZ) g.append(sv("line", { class: "fd", x1: 0, x2: VW, y1: sy(S.sit.ytg), y2: sy(S.sit.ytg) }));
  const { off, def } = lineup();
  const carrier = S.call.playerId || (S.call.kind === KIND.QB_RUSH ? off.find((p) => p.grp === "QB")?.id : 0);
  for (const side of [def, off]) {
    for (const p of side) {
      const isOff = side === off;
      const c = sv("circle", { class: `dot ${isOff ? "off" : "def"}${p.id && p.id === carrier ? " ball-carrier" : ""}`, cx: sx(p.y), cy: sy(p.x), r: 0.95, "data-id": p.id || "" });
      c.append(sv("title", {}, `${p.name}${p.jersey != null ? " #" + p.jersey : ""} (${p.pos || p.grp}): ${statLine(p)}`));
      g.append(c);
      g.append(sv("text", { class: "num", x: sx(p.y), y: sy(p.x) + 0.42 }, p.jersey != null ? p.jersey : p.grp));
      g.append(sv("text", { class: "pos", x: sx(p.y), y: sy(p.x) + (isOff ? 2.1 : -1.5) }, p.grp));
    }
  }
  svg.append(g);
  // any redraw ends a running illustration
  if (S.anim) { cancelAnimationFrame(S.anim.raf); S.anim = null; $("#anim-caption").hidden = true; }
}

/* ---------- personnel table ---------- */
function personnel() {
  const { off, def } = lineup();
  const offT = S.league.teams.find((t) => t.slug === S.offSlug), defT = S.league.teams.find((t) => t.slug === S.defSlug);
  const table = (rows, title, color) => el("div", null,
    el("div", { class: "teamname" }, el("span", { class: "swatch", style: `background:${color}` }), title),
    el("div", { class: "sheet-wrap" }, el("table", { class: "sheet" },
      el("thead", null, el("tr", null, el("th", null, "#"), el("th", null, "Player"), el("th", null, "This season"))),
      el("tbody", null, rows.map((p) => el("tr", { class: p.id && p.id === S.call.playerId ? "hl" : "" },
        el("td", { class: "num" }, p.jersey ?? ""), el("td", { class: "name" }, `${p.name} `, el("span", { class: "note" }, p.pos || p.grp)), el("td", { class: "note" }, statLine(p))))))));
  $("#personnel").replaceChildren(
    el("h3", null, "On the field"),
    el("div", { class: "two" }, table(off, `${offT?.name || S.off.team} offense`, offT?.color || "#7a1f2b"), table(def, `${defT?.name || S.def.team} defense`, defT?.color || "#1f3f7a")));
}

/* ---------- controls ---------- */
function fillTeams() {
  for (const id of ["#off-team", "#def-team"]) {
    const sel = $(id); sel.replaceChildren();
    const byConf = {};
    for (const t of S.league.teams) (byConf[t.conference || "Other"] ||= []).push(t);
    for (const conf of Object.keys(byConf).sort()) {
      const og = el("optgroup", { label: conf });
      for (const t of byConf[conf]) og.append(el("option", { value: t.slug }, t.name));
      sel.append(og);
    }
  }
  $("#off-team").value = S.offSlug; $("#def-team").value = S.defSlug;
  const ss = $("#season"); ss.replaceChildren();
  for (const y of Object.keys(S.league.seasons).sort().reverse()) ss.append(el("option", { value: y }, `${y}${S.league.seasons[y].max_week < 15 ? ` (wk ${S.league.seasons[y].max_week})` : ""}`));
  ss.value = S.season;
}
function fillCallOptions() {
  const fs = $("#formation"); fs.replaceChildren(); for (const [k, v] of Object.entries(FORMATIONS)) fs.append(el("option", { value: k, selected: k === S.formation }, v.label));
  const fr = $("#front"); fr.replaceChildren(); for (const [k, v] of Object.entries(FRONTS)) fr.append(el("option", { value: k, selected: k === S.front }, v.label));
  const ck = $("#call-kind"); ck.replaceChildren(); KIND_LABEL.forEach((l, i) => ck.append(el("option", { value: i, selected: i === S.call.kind }, l)));
  fillPlayers();
}
function fillPlayers() {
  const cp = $("#call-player"); cp.replaceChildren();
  const P = S.off.players;
  let list = [];
  if (S.call.kind === KIND.RUSH) list = P.RB.filter((p) => p.carries).map((p) => [p.id, `${p.name} (${p.carries} car, ${p.ypc} ypc)`]);
  else if (S.call.kind === KIND.QB_RUSH) list = P.QB.filter((p) => p.carries).map((p) => [p.id, `${p.name} (${p.carries} car, ${p.ypc} ypc)`]);
  else list = [...P.WR, ...P.TE, ...P.RB].filter((p) => p.targets).sort((a, b) => b.targets - a.targets).map((p) => [p.id, `${p.name} (${p.targets} tgt, ${p.ypt} yds/tgt)`]);
  cp.append(el("option", { value: 0 }, S.call.kind === KIND.PASS ? "Any target" : "Any back"));
  for (const [id, label] of list) cp.append(el("option", { value: id, selected: id === S.call.playerId }, label));
  if (!list.some(([id]) => id === S.call.playerId)) S.call.playerId = 0;
  cp.value = S.call.playerId;
}
function setupControls() {
  $("#off-team").addEventListener("change", async (e) => { S.offSlug = e.target.value; await reloadTeams(); });
  $("#def-team").addEventListener("change", async (e) => { S.defSlug = e.target.value; await reloadTeams(); });
  $("#season").addEventListener("change", async (e) => { S.season = e.target.value; S.sim = createCfbSim(S.league, S.season); await reloadTeams(); });
  $("#down").addEventListener("change", (e) => { S.sit.down = Number(e.target.value); drawBoard(); dirty(); });
  $("#ytg").addEventListener("change", (e) => { S.sit.ytg = Math.max(1, Math.min(30, Number(e.target.value) || 10)); e.target.value = S.sit.ytg; drawBoard(); dirty(); });
  $("#ytoez").addEventListener("change", (e) => { S.sit.ytoEZ = Math.max(1, Math.min(99, Number(e.target.value) || 55)); e.target.value = S.sit.ytoEZ; drawBoard(); dirty(); });
  $("#formation").addEventListener("change", (e) => { S.formation = e.target.value; drawBoard(); personnel(); });
  $("#front").addEventListener("change", (e) => { S.front = e.target.value; drawBoard(); personnel(); });
  $("#call-kind").addEventListener("change", (e) => { S.call.kind = Number(e.target.value); S.call.playerId = 0; fillPlayers(); drawBoard(); personnel(); dirty(); });
  $("#call-player").addEventListener("change", (e) => { S.call.playerId = Number(e.target.value) || 0; drawBoard(); personnel(); dirty(); });
  $("#run-btn").addEventListener("click", run);
  $("#compare-btn").addEventListener("click", compareAll);
  $("#watch-btn").addEventListener("click", watchOne);
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => { S.scoutSide = b.dataset.side; for (const x of document.querySelectorAll(".tab")) x.classList.toggle("sel", x === b); renderScout(); });
  $("#chat-send").addEventListener("click", sendChat);
  $("#chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  for (const q of ["What should I call here?", "Scout their defense", "Who is my best back right now?", "Is the deep ball worth it?", "Why does this defense give up runs?"]) {
    $("#chips").append(el("button", { class: "chip", onclick: () => { $("#chat-text").value = q; sendChat(); } }, q));
  }
}
function dirty() { if (S.result) $("#run-hint").textContent = "Changed since the last run."; }
async function reloadTeams() {
  [S.off, S.def] = await Promise.all([loadTeam(S.offSlug, S.season), loadTeam(S.defSlug, S.season)]);
  S.result = null; S.compareRows = null; $("#compare").hidden = true; $("#run-hint").textContent = "";
  fillPlayers(); drawBoard(); personnel(); renderResults(); renderScout();
}

/* ---------- run ---------- */
function callLabel(c = S.call) {
  const P = S.off.players;
  const all = [...P.QB, ...P.RB, ...P.WR, ...P.TE];
  const p = all.find((x) => x.id === c.playerId);
  if (c.kind === KIND.RUSH) return p ? `Hand off to ${p.name}` : "Hand off";
  if (c.kind === KIND.QB_RUSH) return p ? `QB keep, ${p.name}` : "QB keep";
  return p ? `Throw to ${p.name}` : "Throw";
}
function run() {
  const t0 = performance.now();
  S.result = S.sim.simulate(S.call, S.off, S.def, S.sit, { reps: 1000, seed: Date.now() % 100000 });
  $("#run-hint").textContent = `1,000 snaps in ${Math.round(performance.now() - t0)} ms.`;
  renderResults();
}
function headline(s) {
  const offT = S.league.teams.find((t) => t.slug === S.offSlug)?.name || S.off.team;
  const defT = S.league.teams.find((t) => t.slug === S.defSlug)?.name || S.def.team;
  return `${callLabel()} for ${offT} on ${ordinal(S.sit.down)} and ${S.sit.ytg} against ${defT}: ${signed(s.epa)} expected points per snap, a first down ${pct(s.firstDown)} of the time, a turnover ${pct1(s.turnover)}. It rests on ${s.offensePool.n} real ${offT} plays (${s.offensePool.level}) and ${s.defensePool.n} plays ${defT} has faced (${s.defensePool.level}).`;
}
function renderResults() {
  const s = S.result?.summary;
  $("#results-empty").hidden = Boolean(s);
  const body = $("#results-body"); body.hidden = !s;
  if (!s) return;
  body.replaceChildren();
  const B = S.sim.baseline;
  const base = S.call.kind === KIND.PASS ? B.pass : S.call.kind === KIND.QB_RUSH ? B.qb_rush : B.rush;
  const cell = (label, val, fmt) => el("div", null, el("span", { class: "label" }, label), el("span", { class: "val" }, fmt(val)));
  const P = S.off.players; const player = [...P.QB, ...P.RB, ...P.WR, ...P.TE].find((p) => p.id === S.call.playerId);
  body.append(
    el("p", { class: "headline" }, headline(s)),
    el("div", { class: "strip" },
      cell("EPA per snap", s.epa, (v) => signed(v)), cell("Success", s.success, pct), cell("First down", s.firstDown, pct), cell("Touchdown", s.touchdown, pct1),
      cell("15+ yards", s.explosive, pct), cell("Turnover", s.turnover, pct1), cell(S.call.kind === KIND.PASS ? "Sacked" : "Stuffed", S.call.kind === KIND.PASS ? s.sack : s.stuff, pct1)),
    ...(player ? [playerCard(player)] : []),
    histogram(s),
    el("h3", { style: "margin-top:10px" }, "Where the snaps come from"),
    el("div", { class: "sheet-wrap" }, el("table", { class: "sheet" },
      el("thead", null, el("tr", null, el("th", null, "Pool"), el("th", { class: "num" }, "Plays"), el("th", { class: "num" }, "Yds/play"), el("th", { class: "num" }, "15+"), el("th", { class: "num" }, "Turnover"), el("th", { class: "num" }, S.call.kind === KIND.PASS ? "Sack" : "Stuffed"))),
      el("tbody", null,
        poolRow(`Offense: ${s.offensePool.level}`, s.offensePool, S.call.kind),
        poolRow(`Defense allowed: ${s.defensePool.level}`, s.defensePool, S.call.kind),
        el("tr", null, el("td", null, "FBS average, this kind of play"), el("td", { class: "num" }, base.n.toLocaleString()), el("td", { class: "num" }, base.ypp.toFixed(1)), el("td", { class: "num" }, pct(base.explosive)), el("td", { class: "num" }, "n/a"), el("td", { class: "num" }, S.call.kind === KIND.PASS ? pct1(B.sack_rate) : pct1(B.stuff_rate)))))),
    el("p", { class: "note" }, `Expected points before the snap: ${s.ep0.toFixed(2)}. Yards are capped at the goal line, so deep field position changes the touchdown rate but not the sample.`)
  );
}
function poolRow(label, p, kind) {
  return el("tr", null, el("td", null, label), el("td", { class: "num" }, p.n), el("td", { class: "num" }, (p.ypp || 0).toFixed(1)), el("td", { class: "num" }, pct(p.explosive)), el("td", { class: "num" }, pct1(p.turnover)), el("td", { class: "num" }, kind === KIND.PASS ? pct1(p.sack) : pct1(p.stuff)));
}
function playerCard(p) {
  return el("div", { class: "pcard" },
    p.headshot ? el("img", { src: p.headshot, alt: p.name, loading: "lazy", onerror: (e) => { e.target.remove(); } }) : null,
    el("div", null, el("div", { class: "pname" }, `${p.name}${p.jersey != null ? " #" + p.jersey : ""}, ${p.pos || ""}${p.year ? `, year ${p.year}` : ""}`), el("div", { class: "pstat" }, statLine(p))));
}
function histogram(s) {
  const bins = [[-99, -1, "loss"], [0, 0, "0"], [1, 4, "1-4"], [5, 9, "5-9"], [10, 14, "10-14"], [15, 19, "15-19"], [20, 29, "20-29"], [30, 99, "30+"]];
  const cur = bins.map(([lo, hi]) => s.yards.filter((y) => y >= lo && y <= hi).length / (s.yards.length || 1));
  const W = 420, H = 110, L = 6, B = 18, T = 8; const bw = (W - L * 2) / bins.length; const max = Math.max(...cur, 0.05);
  const ys = (v) => T + (1 - v / max) * (H - T - B);
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Distribution of yards gained" });
  svg.append(sv("line", { class: "axis", x1: L, x2: W - L, y1: H - B, y2: H - B }));
  const wrap = el("div", { class: "chart" }); const tip = el("div", { class: "tip", hidden: true });
  bins.forEach((b, i) => {
    const x = L + i * bw + 3;
    svg.append(sv("rect", { class: "bar" + (b[2] === "loss" ? " neg" : ""), x, y: ys(cur[i]), width: bw - 6, height: Math.max(0, H - B - ys(cur[i])), rx: 1 }));
    svg.append(sv("text", { class: "tick", x: x + (bw - 6) / 2, y: H - 5, "text-anchor": "middle" }, b[2]));
    const hit = sv("rect", { class: "hit", x: L + i * bw, y: 0, width: bw, height: H });
    hit.addEventListener("mouseenter", () => { tip.replaceChildren(el("b", null, `${b[2]} yards: ${pct(cur[i])}`)); tip.hidden = false; tip.style.left = `${((L + i * bw) / W) * 100}%`; tip.style.top = "0px"; });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; });
    svg.append(hit);
  });
  wrap.append(svg, tip);
  return el("div", null, el("h3", { style: "margin-top:8px" }, "Yards gained, share of snaps"), wrap);
}

/* ---------- compare ---------- */
function compareAll() {
  const t0 = performance.now();
  S.compareRows = S.sim.compare(S.off, S.def, S.sit, { reps: 600, seed: Date.now() % 100000 });
  $("#run-hint").textContent = `${S.compareRows.length} calls compared in ${Math.round(performance.now() - t0)} ms.`;
  const panel = $("#compare"); panel.hidden = false;
  const body = $("#compare-body"); body.replaceChildren();
  const best = S.compareRows[0];
  body.append(
    el("p", { class: "headline" }, `On ${ordinal(S.sit.down)} and ${S.sit.ytg} at the ${S.sit.ytoEZ}, the best-scoring call is ${best.label.toLowerCase()} at ${signed(best.summary.epa)} per snap. Click a row to put it on the board.`),
    el("div", { class: "sheet-wrap" }, el("table", { class: "sheet" },
      el("thead", null, el("tr", null, el("th", null, "Call"), el("th", { class: "num" }, "EPA"), el("th", { class: "num" }, "Success"), el("th", { class: "num" }, "1st down"), el("th", { class: "num" }, "15+"), el("th", { class: "num" }, "Turnover"), el("th", { class: "num" }, "Plays"))),
      el("tbody", null, S.compareRows.map((r) => el("tr", { style: "cursor:pointer", onclick: () => { S.call = { kind: r.kind, playerId: r.playerId }; $("#call-kind").value = r.kind; fillPlayers(); drawBoard(); personnel(); run(); } },
        el("td", { class: "lab" }, r.label), el("td", { class: `num ${r.summary.epa > 0 ? "pos" : "neg"}` }, signed(r.summary.epa)), el("td", { class: "num" }, pct(r.summary.success)),
        el("td", { class: "num" }, pct(r.summary.firstDown)), el("td", { class: "num" }, pct(r.summary.explosive)), el("td", { class: "num" }, pct1(r.summary.turnover)),
        el("td", { class: "num" }, `${r.summary.offensePool.n} / ${r.summary.defensePool.n}`)))))),
    el("p", { class: "note" }, "Plays shows how many real offense plays and defense plays each row samples from. Rows with small offense samples lean on the defense's history. 600 snaps per row."));
}

/* ---------- scouting ---------- */
function renderScout() {
  const side = S.scoutSide;
  const team = side === "defense" ? S.def : S.off;
  const t = team.tendencies[side];
  const B = S.sim.baseline;
  const name = S.league.teams.find((x) => x.slug === (side === "defense" ? S.defSlug : S.offSlug))?.name || team.team;
  const body = $("#scout-body"); body.replaceChildren();
  const delta = (v, b, higherGood) => { const d = v - b; const cls = Math.abs(d) < 0.005 ? "" : (d > 0) === higherGood ? "pos" : "neg"; return el("span", { class: `delta ${cls}` }, ` ${d >= 0 ? "+" : ""}${(d * 100).toFixed(0)}`); };
  const dpct = (v, b, higherGood) => el("span", null, pct(v), delta(v, b, higherGood));
  const ypp = (v, b, higherGood) => { const d = v - b; const cls = Math.abs(d) < 0.05 ? "" : (d > 0) === higherGood ? "pos" : "neg"; return el("span", null, v.toFixed(1), el("span", { class: `delta ${cls}` }, ` ${signed(d, 1)}`)); };
  const good = side === "offense"; // for the offense higher is good; for the defense, allowing more is bad
  const rows = [
    ["Plays", t.plays, ""],
    ["Run rate", pct(t.run_rate), `FBS ${pct(B.run_rate)}`],
    ["Rush yards/play", ypp(t.rush.ypp, B.rush.ypp, good), ""],
    ["Rush success", dpct(t.rush.success, B.rush.success, good), ""],
    ["Stuffed runs", dpct(t.stuff_rate, B.stuff_rate, !good), ""],
    ["Pass yards/play", ypp(t.pass.ypp, B.pass.ypp, good), ""],
    ["Pass success", dpct(t.pass.success, B.pass.success, good), ""],
    ["Completion", pct(t.completion), ""],
    ["Explosive passes (15+)", dpct(t.pass.explosive, B.pass.explosive, good), ""],
    ["Sack rate", dpct(t.sack_rate, B.sack_rate, !good), ""],
    ["Interception rate", dpct(t.int_rate, B.int_rate, !good), ""],
    ["Havoc (sack, PBU, INT, FF per play)", pct(t.havoc), ""],
    ["3rd and 4th down conversions", pct(t.third_conv), ""],
    ["Red zone touchdown rate", pct(t.redzone_td), ""]
  ];
  body.append(
    el("p", { class: "note" }, side === "defense" ? `What ${name}'s defense has allowed this season, against the FBS average. Green is good for them.` : `What ${name}'s offense has done this season, against the FBS average.`),
    el("div", { class: "sheet-wrap" }, el("table", { class: "sheet" }, el("tbody", null, rows.map(([k, v, n]) => el("tr", null, el("td", null, k), el("td", { class: "num" }, v), el("td", { class: "note" }, n)))))),
    el("h3", { style: "margin-top:10px" }, "By down"),
    el("div", { class: "sheet-wrap" }, el("table", { class: "sheet" },
      el("thead", null, el("tr", null, el("th", null, "Down"), el("th", { class: "num" }, "Plays"), el("th", { class: "num" }, "Run rate"), el("th", { class: "num" }, "Success"), el("th", { class: "num" }, "Yds/play"))),
      el("tbody", null, Object.entries(t.by_down).map(([d, v]) => el("tr", null, el("td", null, ordinal(Number(d))), el("td", { class: "num" }, v.n), el("td", { class: "num" }, pct(v.run_rate)), el("td", { class: "num" }, pct(v.success)), el("td", { class: "num" }, v.ypp.toFixed(1))))))),
    el("p", { class: "note" }, `Opponents so far: ${team.opponents.join(", ")}.`)
  );
}

/* ---------- animation (illustration of one sampled snap) ---------- */
function watchOne() {
  if (S.anim) { cancelAnimationFrame(S.anim.raf); S.anim.layer.remove(); S.anim = null; }
  const { reps } = S.sim.simulate(S.call, S.off, S.def, S.sit, { reps: 1, seed: Math.floor(Math.random() * 1e9) });
  const rep = reps[0]; if (!rep) return;
  const { off, def } = lineup();
  const layer = sv("g", { id: "anim" });
  const kind = S.call.kind;
  const qb = off.find((p) => p.grp === "QB");
  let carrier = off.find((p) => p.id === S.call.playerId);
  if (!carrier) carrier = kind === KIND.RUSH ? off.find((p) => p.grp === "RB") : kind === KIND.QB_RUSH ? qb : off.find((p) => p.grp === "WR");
  const endX = rep.sack ? -7 : Math.max(-6, Math.min(X_MAX - 1, rep.yards));
  const laneY = kind === KIND.PASS ? carrier.y + (carrier.y < 26.65 ? 2 : -2) : 26.65 + (Math.random() - 0.5) * 10;
  const dots = new Map();
  for (const p of [...def, ...off]) {
    const d = sv("circle", { class: `dot ${off.includes(p) ? "off" : "def"}`, cx: sx(p.y), cy: sy(p.x), r: 0.95 });
    layer.append(d); dots.set(p, d);
  }
  const ball = sv("circle", { class: "ball", cx: sx(qb.y), cy: sy(qb.x), r: 0.4 });
  layer.append(ball);
  $("#board").append(layer);
  const cap = $("#anim-caption"); cap.hidden = false;
  const word = rep.sack ? `Sack for ${rep.yards}` : rep.int ? "Intercepted" : rep.fumble ? "Fumble, lost" : kind === KIND.PASS && !rep.complete ? "Incomplete" : `${rep.yards} yard${Math.abs(rep.yards) === 1 ? "" : "s"}${rep.td ? ", touchdown" : rep.firstDown ? ", first down" : ""}`;
  cap.textContent = `${callLabel()}: ${word}. ${signed(rep.epa)} EPA. Illustration of one sampled play.`;
  const T = 2200; const t0 = performance.now(); const anim = { layer, raf: 0 }; S.anim = anim;
  const lerp = (a, b, t) => a + (b - a) * t;
  function frame(now) {
    const t = Math.min(1, (now - t0) / T);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    for (const p of off) {
      const d = dots.get(p);
      let x = p.x, y = p.y;
      if (p === carrier) {
        if (kind === KIND.PASS) { x = lerp(p.x, rep.complete ? Math.max(1, endX) : Math.max(1, S.sit.ytg + 3), e); y = lerp(p.y, laneY, e); }
        else { x = lerp(p.x, endX, e); y = lerp(p.y, laneY, e); }
      } else if (p.grp === "WR" || p.grp === "TE") { x = lerp(p.x, p.x + 8 + (p.y % 7), e); }
      else if (p.grp === "OL") { x = lerp(p.x, kind === KIND.PASS ? p.x - 1.5 : p.x + 1.2, Math.min(1, e * 2)); }
      else if (p.grp === "QB" && kind === KIND.PASS) { x = lerp(p.x, p.x - 2, Math.min(1, e * 2)); }
      d.setAttribute("cx", sx(y)); d.setAttribute("cy", sy(x));
    }
    for (const p of def) {
      const d = dots.get(p);
      const tx = kind === KIND.PASS ? (rep.complete ? endX : S.sit.ytg + 3) : endX, ty = laneY;
      const pull = p.grp === "DL" ? 0.5 : p.grp === "LB" ? 0.7 : 0.6;
      d.setAttribute("cx", sx(lerp(p.y, ty, e * pull))); d.setAttribute("cy", sy(lerp(p.x, tx, e * pull)));
    }
    if (kind === KIND.PASS) {
      const t2 = Math.max(0, Math.min(1, (t - 0.35) / 0.45));
      const bx = lerp(sx(qb.y), sx(laneY), t2), by = lerp(sy(qb.x - 2), sy(rep.complete ? Math.max(1, endX) : Math.max(1, S.sit.ytg + 3)), t2) - Math.sin(t2 * Math.PI) * 3;
      ball.setAttribute("cx", bx); ball.setAttribute("cy", by);
    } else { const c = dots.get(carrier); ball.setAttribute("cx", c.getAttribute("cx")); ball.setAttribute("cy", Number(c.getAttribute("cy")) - 0.6); }
    if (t < 1) anim.raf = requestAnimationFrame(frame);
  }
  anim.raf = requestAnimationFrame(frame);
}

/* ---------- coach ---------- */
function renderChat() {
  const box = $("#chat"); box.replaceChildren();
  if (S.chat.length === 0) box.append(el("div", { class: "note" }, "The coordinator can simulate any call, compare them all, and read both scouting reports. Ask what to call and why."));
  for (const m of S.chat) box.append(m.role === "user" ? el("div", { class: "msg user" }, m.content) : el("div", { class: "msg coach" }, el("span", { class: "who" }, "Coordinator"), m.content));
  if (S.chatBusy) box.append(el("div", { class: "msg coach wait" }, el("i"), el("i"), el("i"), " running the numbers"));
  box.scrollTop = box.scrollHeight;
}
async function sendChat() {
  const ta = $("#chat-text"); const text = ta.value.trim();
  if (!text || S.chatBusy) return;
  ta.value = ""; $("#chat-error").hidden = true;
  S.chat.push({ role: "user", content: text }); S.chatBusy = true; renderChat();
  try {
    const board = { offense: S.offSlug, defense: S.defSlug, season: S.season, situation: S.sit, call: S.call, callLabel: callLabel(),
      lastResult: S.result ? { epa: +S.result.summary.epa.toFixed(3), success: +S.result.summary.success.toFixed(3), firstDown: +S.result.summary.firstDown.toFixed(3) } : null };
    const res = await fetch("/api/cfbcoach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: S.chat, board }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    S.chat.push({ role: "assistant", content: data.text || "(no reply)" });
    if (data.board) {
      if (data.board.situation) { S.sit = data.board.situation; $("#down").value = S.sit.down; $("#ytg").value = S.sit.ytg; $("#ytoez").value = S.sit.ytoEZ; }
      if (data.board.call) { S.call = { kind: data.board.call.kind, playerId: data.board.call.playerId || 0 }; $("#call-kind").value = S.call.kind; fillPlayers(); }
      drawBoard(); personnel(); run();
    }
  } catch (err) {
    S.chat.pop(); $("#chat-error").textContent = `The coordinator is unavailable: ${err.message}`; $("#chat-error").hidden = false; ta.value = text;
  } finally { S.chatBusy = false; renderChat(); }
}

/* ---------- boot ---------- */
async function boot() {
  const res = await fetch("data/cfb/league.json");
  S.league = await res.json();
  S.season = Object.keys(S.league.seasons).sort().at(-1);
  S.sim = createCfbSim(S.league, S.season);
  if (!S.league.teams.some((t) => t.slug === S.offSlug)) S.offSlug = S.league.teams[0].slug;
  if (!S.league.teams.some((t) => t.slug === S.defSlug)) S.defSlug = S.league.teams[1].slug;
  fillTeams();
  [S.off, S.def] = await Promise.all([loadTeam(S.offSlug, S.season), loadTeam(S.defSlug, S.season)]);
  fillCallOptions();
  setupControls();
  drawBoard(); personnel(); renderScout(); renderChat();
  const ms = S.league.seasons[S.season];
  $("#meta-note").textContent = `${S.season} season through week ${ms.max_week}, ${ms.plays.toLocaleString()} FBS-versus-FBS plays, built ${S.league.meta.built}`;
}
boot();
