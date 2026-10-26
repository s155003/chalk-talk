import { createSim, defaultPlay, defaultSituation, ROUTES, ROUTE_LABEL, FIELD_W } from "./sim.js";

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
const pct = (x) => `${Math.round(x * 100)}%`;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const signed = (x, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);

/* ---------- state ---------- */
const S = {
  model: null, sim: null,
  play: defaultPlay(),
  defense: { coverage: "Cover 3", team: null },
  sit: defaultSituation(),
  selected: null,
  result: null, pinned: null,
  chat: [], chatBusy: false,
  anim: null
};

/* ---------- board geometry ---------- */
const X_MIN = -12, X_MAX = 42;           // yards shown behind and beyond the line
const VW = FIELD_W, VH = X_MAX - X_MIN;  // viewBox is in yards: width across, height downfield
// field coords -> svg: svg x = y (across), svg y = X_MAX - x (downfield goes up)
const sx = (y) => y;
const sy = (x) => X_MAX - x;

function boardSetup() {
  const svg = $("#board");
  svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

function drawBoard() {
  const svg = $("#board");
  svg.replaceChildren();
  const g = sv("g");
  const ytoEZ = S.sit.ytoEZ;
  // end zone if in view
  if (ytoEZ <= X_MAX) {
    g.append(sv("rect", { class: "endzone", x: 0, y: 0, width: VW, height: sy(ytoEZ) }));
    g.append(sv("line", { class: "goal", x1: 0, x2: VW, y1: sy(ytoEZ), y2: sy(ytoEZ) }));
  }
  // yard lines every 5 yards, numbered every 10, relative to the line of scrimmage
  for (let x = Math.ceil(X_MIN / 5) * 5; x <= X_MAX; x += 5) {
    if (x > ytoEZ) break;
    if (x === 0) continue;
    g.append(sv("line", { class: "yard", x1: 0, x2: VW, y1: sy(x), y2: sy(x) }));
    if (x % 10 === 0) {
      const absolute = 100 - (ytoEZ - x); // yard line as it would be painted, offense's perspective
      const painted = absolute > 50 ? 100 - absolute : absolute;
      if (painted > 0) {
        g.append(sv("text", { class: "yardnum", x: 2.2, y: sy(x) - 0.4 }, painted));
        g.append(sv("text", { class: "yardnum", x: VW - 3.6, y: sy(x) - 0.4 }, painted));
      }
    }
  }
  // hashes
  for (let x = X_MIN; x <= Math.min(X_MAX, ytoEZ); x += 1) {
    for (const hy of [23.58, 29.75]) g.append(sv("line", { class: "hash", x1: hy - 0.4, x2: hy + 0.4, y1: sy(x), y2: sy(x) }));
  }
  // line of scrimmage and first-down line
  g.append(sv("line", { class: "los", x1: 0, x2: VW, y1: sy(0), y2: sy(0) }));
  if (S.sit.ytg < ytoEZ) g.append(sv("line", { class: "fd", x1: 0, x2: VW, y1: sy(S.sit.ytg), y2: sy(S.sit.ytg) }));
  // offensive line and QB
  for (let i = -2; i <= 2; i++) g.append(sv("circle", { class: "ol", cx: 26.65 + i * 1.4, cy: sy(-0.8), r: 0.5 }));
  const qbDepth = S.play.receivers.some((r) => r.pos === "RB" && r.x < -3) ? -5 : -5;
  g.append(sv("circle", { class: "qb", cx: 26.65, cy: sy(qbDepth), r: 0.7, id: "qb-dot" }));
  g.append(sv("text", { class: "olabel", x: 26.65, y: sy(qbDepth) + 0.5 }, "Q"));

  const man = S.sim.manSet.has(S.defense.coverage);
  const routesG = sv("g", { id: "routes" });
  const defG = sv("g", { id: "defenders" });
  const recvG = sv("g", { id: "receivers" });
  for (const r of S.play.receivers) {
    const pts = S.sim.routePoints(r, man).filter(Boolean);
    if (pts.length > 1) {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.y).toFixed(2)},${sy(p.x).toFixed(2)}`).join(" ");
      routesG.append(sv("path", { class: "route" + (S.selected && S.selected !== r.id ? " dim" : ""), d, "data-id": r.id }));
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const ang = Math.atan2(sy(b.x) - sy(a.x), sx(b.y) - sx(a.y));
      const tip = { x: sx(b.y), y: sy(b.x) };
      const L = 1.1, W = 0.6;
      const p1 = { x: tip.x - L * Math.cos(ang) + W * Math.sin(ang), y: tip.y - L * Math.sin(ang) - W * Math.cos(ang) };
      const p2 = { x: tip.x - L * Math.cos(ang) - W * Math.sin(ang), y: tip.y - L * Math.sin(ang) + W * Math.cos(ang) };
      routesG.append(sv("polygon", { class: "arrow", points: `${tip.x},${tip.y} ${p1.x},${p1.y} ${p2.x},${p2.y}` }));
    }
    const dp = S.sim.defenderPoints(r, man).filter(Boolean);
    if (dp.length) {
      const d0 = dp[0];
      const cx = sx(d0.y), cy = sy(d0.x), s = 0.6;
      defG.append(sv("path", { class: "x", d: `M${cx - s},${cy - s}L${cx + s},${cy + s}M${cx + s},${cy - s}L${cx - s},${cy + s}`, "data-id": r.id }));
    }
    const c = sv("circle", { class: "o" + (S.selected === r.id ? " sel" : ""), cx: sx(r.y), cy: sy(r.x), r: 0.85, "data-id": r.id });
    c.addEventListener("pointerdown", (e) => startDrag(e, r));
    recvG.append(c);
    recvG.append(sv("text", { class: "olabel", x: sx(r.y), y: sy(r.x) + 0.52 }, r.id));
  }
  g.append(routesG, defG, recvG);
  svg.append(g);
  if (S.anim) svg.append(S.anim.layer);
}

function startDrag(e, r) {
  const svg = $("#board");
  e.preventDefault();
  svg.setPointerCapture(e.pointerId);
  S.selected = r.id;
  const move = (ev) => {
    const pt = svgPoint(svg, ev.clientX, ev.clientY);
    r.y = Math.max(2, Math.min(FIELD_W - 2, +pt.x.toFixed(1)));
    r.x = Math.max(-8, Math.min(0, +(X_MAX - pt.y).toFixed(1)));
    drawBoard(); renderPlaybar();
  };
  const up = () => { try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ } svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); svg.removeEventListener("pointercancel", up); markDirty(); };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  drawBoard(); renderPlaybar();
}
function svgPoint(svg, cx, cy) {
  const p = svg.createSVGPoint(); p.x = cx; p.y = cy;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

/* ---------- play bar ---------- */
function renderPlaybar() {
  const bar = $("#playbar");
  bar.replaceChildren();
  bar.append(el("div", { class: "prow hdr" }, el("span"), el("span", null, "Pos"), el("span", null, "Route"), el("span", null, "Real receiver (optional)"), el("span", { class: "where" }, "")));
  for (const r of S.play.receivers) {
    const pos = el("select", { onchange: (e) => { r.pos = e.target.value; markDirty(); } },
      ["WR", "TE", "RB"].map((p) => el("option", { value: p, selected: r.pos === p }, p)));
    const route = el("select", { onchange: (e) => { r.route = e.target.value; drawBoard(); markDirty(); } },
      ROUTES.map((k) => el("option", { value: k, selected: r.route === k }, ROUTE_LABEL[k])));
    const recs = S.model.receivers.filter((p) => p.pos === r.pos || r.pos === "WR" && p.pos === "WR");
    const player = el("select", { onchange: (e) => { r.playerId = e.target.value ? Number(e.target.value) : null; markDirty(); } },
      el("option", { value: "" }, "League average"),
      S.model.receivers.map((p) => el("option", { value: p.id, selected: r.playerId === p.id }, `${p.name} (${p.pos}, ${p.team}) ${signed(p.shift, 2)} yd`)));
    const where = el("span", { class: "where" }, `${S.sim.alignOf(r.y)}, ${r.x === 0 ? "on the line" : `${Math.abs(r.x)} yd back`}`);
    const row = el("div", { class: "prow" + (S.selected === r.id ? " sel" : ""), onclick: () => { S.selected = r.id; drawBoard(); renderPlaybar(); } },
      el("span", { class: "tag" }, r.id), pos, route, player, where);
    bar.append(row);
  }
}

/* ---------- controls ---------- */
function setupControls() {
  const cov = $("#coverage");
  for (const c of S.model.coverages) cov.append(el("option", { value: c.name }, `${c.name} (${c.man ? "man" : "zone"}, ${pct(c.share)} of snaps)`));
  cov.append(el("option", { value: "mix" }, "Their real mix"));
  cov.value = S.defense.coverage;
  cov.addEventListener("change", () => { S.defense.coverage = cov.value; drawBoard(); defenseNote(); markDirty(); });
  const team = $("#team");
  team.append(el("option", { value: "" }, "League average"));
  for (const t of Object.keys(S.model.teams).sort()) team.append(el("option", { value: t }, t));
  team.addEventListener("change", () => { S.defense.team = team.value || null; defenseNote(); markDirty(); });
  $("#down").addEventListener("change", (e) => { S.sit.down = Number(e.target.value); drawBoard(); markDirty(); });
  $("#ytg").addEventListener("change", (e) => { S.sit.ytg = Math.max(1, Math.min(30, Number(e.target.value) || 10)); e.target.value = S.sit.ytg; drawBoard(); markDirty(); });
  $("#ytoez").addEventListener("change", (e) => { S.sit.ytoEZ = Math.max(1, Math.min(99, Number(e.target.value) || 65)); e.target.value = S.sit.ytoEZ; drawBoard(); markDirty(); });
  $("#run-btn").addEventListener("click", run);
  $("#watch-btn").addEventListener("click", watchOne);
  $("#pin-btn").addEventListener("click", () => { if (S.result) { S.pinned = { summary: S.result.summary, label: describeBoard() }; renderResults(); } });
  $("#chat-send").addEventListener("click", sendChat);
  $("#chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  const chips = $("#chips");
  for (const q of ["Critique this play", "Who is my first read?", "Beat Cover 3 on 3rd and 8", "Make this work in the red zone", "Why is Z so covered?"]) {
    chips.append(el("button", { class: "chip", onclick: () => { $("#chat-text").value = q; sendChat(); } }, q));
  }
  defenseNote();
  $("#meta-snaps").textContent = S.model.meta.receiver_snaps.toLocaleString();
  $("#meta-dropbacks").textContent = S.model.meta.dropbacks.toLocaleString();
}
function defenseNote() {
  const t = S.defense.team ? S.model.teams[S.defense.team] : null;
  const parts = [];
  if (S.defense.coverage === "mix") {
    const mix = t ? t.mix : Object.fromEntries(S.model.coverages.map((c) => [c.name, c.share]));
    const top = Object.entries(mix).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${pct(v)}`).join(", ");
    parts.push(`Coverage is drawn from ${t ? S.defense.team + "'s" : "the league's"} 2022 mix each snap: ${top}.`);
  }
  if (t) parts.push(`${S.defense.team} allowed ${signed(t.shift_man, 2)} yd vs expected in man and ${signed(t.shift_zone, 2)} in zone over ${t.n.toLocaleString()} receiver snaps.`);
  if (!parts.length) parts.push("League-average defense. Pick a team to use its 2022 coverage tightness.");
  $("#defense-note").textContent = parts.join(" ");
}
function markDirty() {
  if (S.result) $("#run-hint").textContent = "Board changed since the last run.";
}
function describeBoard() {
  const d = S.defense.coverage === "mix" ? `${S.defense.team || "league"} mix` : S.defense.coverage + (S.defense.team ? ` (${S.defense.team})` : "");
  return `${S.play.receivers.map((r) => `${r.id} ${ROUTE_LABEL[r.route]}`).join(", ")} vs ${d}, ${ordinal(S.sit.down)} and ${S.sit.ytg} at the ${S.sit.ytoEZ}`;
}
const ordinal = (n) => ["", "1st", "2nd", "3rd", "4th"][n] || `${n}th`;

/* ---------- run and results ---------- */
function run() {
  const t0 = performance.now();
  S.result = S.sim.simulate(S.play, S.defense, S.sit, { reps: 1000, seed: (Date.now() % 100000) });
  $("#run-hint").textContent = `1,000 snaps in ${Math.round(performance.now() - t0)} ms.`;
  renderResults();
}

function headline(s) {
  const best = [...s.perReceiver].sort((a, b) => b.targetShare - a.targetShare)[0];
  const open = [...s.perReceiver].sort((a, b) => b.openRate - a.openRate)[0];
  const d = S.defense.coverage === "mix" ? `${S.defense.team || "a league-average"} defense` : S.defense.coverage;
  return `Against ${d} on ${ordinal(S.sit.down)} and ${S.sit.ytg}, this play averages ${signed(s.epa, 2)} expected points per snap and moves the chains ${pct(s.firstDown)} of the time. ${open.id}'s ${ROUTE_LABEL[open.route].toLowerCase()} is open (3+ yards) on ${pct(open.openRate)} of snaps; ${best.id} draws ${pct(best.targetShare)} of the throws.`;
}

function renderResults() {
  const s = S.result?.summary;
  $("#results-empty").hidden = Boolean(s);
  const body = $("#results-body");
  body.hidden = !s;
  if (!s) return;
  body.replaceChildren();
  const P = S.pinned?.summary;
  const cell = (label, val, key, fmt, higherBetter = true) => {
    const d = el("div", null, el("span", { class: "label" }, label), el("span", { class: "val" }, fmt(val)));
    if (P && key) {
      const diff = val - P[key];
      const cls = diff === 0 ? "" : (diff > 0) === higherBetter ? "pos" : "neg";
      d.lastChild.append(el("span", { class: `delta ${cls}` }, key === "epa" ? signed(diff, 2) : (diff >= 0 ? "+" : "") + Math.round(diff * 100) + " pts"));
    }
    return d;
  };
  body.append(
    el("p", { class: "headline" }, headline(s)),
    el("div", { class: "strip" },
      cell("EPA per snap", s.epa, "epa", (v) => signed(v, 2)),
      cell("Success", s.success, "success", pct),
      cell("Completion", s.completion, "completion", pct),
      cell("First down", s.firstDown, "firstDown", pct),
      cell("15+ yards", s.explosive, "explosive", pct),
      cell("Picked off", s.interception, "interception", pct1, false),
      cell("Sacked", s.sack, "sack", pct1, false)),
    ...(P ? [el("p", { class: "note" }, `Deltas are against A: ${S.pinned.label}.`)] : []),
    histogram(s, P),
    el("div", { class: "sheet-wrap" }, receiverTable(s)),
    el("p", { class: "note" }, `Open means 3 or more yards from the nearest defender at the throw. Each row's separation comes from a table of ${s.perReceiver.map((r) => r.cellN.toLocaleString()).join(", ")} real snaps respectively. Expected points before the snap: ${s.ep0.toFixed(2)}.`)
  );
}

function receiverTable(s) {
  return el("table", { class: "sheet", "aria-label": "Per receiver" },
    el("thead", null, el("tr", null, el("th"), el("th", null, "Route"), el("th", { class: "num" }, "Targeted"), el("th", { class: "num" }, "Open"),
      el("th", { class: "num" }, "Sep (yd)"), el("th", { class: "num" }, "Caught"), el("th", { class: "num" }, "Yds/tgt"), el("th", { class: "num" }, "EPA/tgt"))),
    el("tbody", null, s.perReceiver.map((r) => el("tr", null,
      el("td", { class: "tag" }, r.id), el("td", null, ROUTE_LABEL[r.route]),
      el("td", { class: "num" }, pct(r.targetShare)), el("td", { class: "num" }, pct(r.openRate)),
      el("td", { class: "num" }, r.sepMean.toFixed(1)), el("td", { class: "num" }, r.targetShare > 0 ? pct(r.catchRate) : "n/a"),
      el("td", { class: "num" }, r.targetShare > 0 ? r.yardsPerTarget.toFixed(1) : "n/a"),
      el("td", { class: `num ${r.epaPerTarget > 0 ? "pos" : r.epaPerTarget < 0 ? "neg" : ""}` }, r.targetShare > 0 ? signed(r.epaPerTarget, 2) : "n/a")))));
}

/* Yards histogram: single series (plus a faint pinned series for comparison). One axis. */
function histogram(s, P) {
  const bins = [[-99, -1, "loss"], [0, 0, "0"], [1, 4, "1-4"], [5, 9, "5-9"], [10, 14, "10-14"], [15, 19, "15-19"], [20, 29, "20-29"], [30, 99, "30+"]];
  const count = (arr) => bins.map(([lo, hi]) => arr.filter((y) => y >= lo && y <= hi).length / arr.length);
  const cur = count(s.yards);
  const pin = P ? count(P.yards) : null;
  const W = 420, H = 120, L = 6, B = 18, T = 8;
  const bw = (W - L * 2) / bins.length;
  const max = Math.max(...cur, ...(pin || [0]), 0.05);
  const ys = (v) => T + (1 - v / max) * (H - T - B);
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Distribution of yards gained" });
  svg.append(sv("line", { class: "axis", x1: L, x2: W - L, y1: H - B, y2: H - B }));
  const wrap = el("div", { class: "chart" });
  const tip = el("div", { class: "tip", hidden: true });
  bins.forEach((b, i) => {
    const x = L + i * bw + 3;
    if (pin) svg.append(sv("rect", { class: "bar a", x: x - 1, y: ys(pin[i]), width: bw - 4, height: H - B - ys(pin[i]) }));
    svg.append(sv("rect", { class: "bar" + (b[2] === "loss" ? " neg" : ""), x, y: ys(cur[i]), width: bw - 6, height: Math.max(0, H - B - ys(cur[i])), rx: 1 }));
    svg.append(sv("text", { class: "tick", x: x + (bw - 6) / 2, y: H - 5, "text-anchor": "middle" }, b[2]));
    const hit = sv("rect", { class: "hit", x: L + i * bw, y: 0, width: bw, height: H });
    hit.addEventListener("mouseenter", () => {
      tip.replaceChildren(el("b", null, `${b[2]} yards: ${pct(cur[i])}`), pin ? el("span", null, ` (A: ${pct(pin[i])})`) : null);
      tip.hidden = false;
      tip.style.left = `${((L + i * bw) / W) * 100}%`; tip.style.top = "0px";
    });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; });
    svg.append(hit);
  });
  wrap.append(svg, tip);
  const legend = el("div", { class: "legend" }, el("span", null, el("i"), "This run"), pin ? el("span", null, el("i", { class: "a" }), "Pinned A") : null);
  return el("div", null, el("h3", { style: "margin-top:4px" }, "Yards gained, share of snaps"), wrap, legend);
}

/* ---------- animation of one sampled snap ---------- */
function watchOne() {
  if (S.anim) { cancelAnimationFrame(S.anim.raf); S.anim.layer.remove(); S.anim = null; }
  const rep = S.sim.snap(S.play, S.defense, S.sit, Math.random);
  const man = rep.man;
  const layer = sv("g", { id: "anim" });
  const throwFrame = Math.round(rep.ttt * 10);
  const tracks = S.play.receivers.map((r, i) => {
    const rp = S.sim.routePoints(r, man);
    const dp = S.sim.defenderPoints(r, man);
    const last = (arr, k) => { for (let j = Math.min(k, arr.length - 1); j >= 0; j--) if (arr[j]) return arr[j]; return { x: r.x, y: r.y }; };
    // scale the defender's offset from the receiver so that at the throw it equals the sampled separation
    const rT = last(rp, throwFrame), dT = last(dp, throwFrame);
    const meanSep = Math.hypot(dT.x - rT.x, dT.y - rT.y) || 1;
    const f = rep.recs[i].sep / meanSep;
    return { r, rp, dp, last, f };
  });
  const dots = tracks.map((t) => {
    const o = sv("circle", { class: "o", cx: sx(t.r.y), cy: sy(t.r.x), r: 0.85 });
    const x = sv("path", { class: "x live", d: "" });
    const lab = sv("text", { class: "seplabel", x: 0, y: 0 }, "");
    layer.append(x, o, lab);
    return { o, x, lab };
  });
  const ball = sv("circle", { class: "ball", cx: 26.65, cy: sy(-5), r: 0.4, visibility: "hidden" });
  layer.append(ball);
  $("#board").append(layer);
  const cap = $("#anim-caption");
  cap.hidden = false;
  cap.textContent = `${rep.cov}${S.defense.team ? ", " + S.defense.team : ""}. Ball out at ${rep.ttt.toFixed(1)} s.`;
  const flight = rep.target !== null ? Math.max(3, Math.round((rep.recs[rep.target].depth + 5) / 6)) : 0;
  const endFrame = rep.target !== null ? throwFrame + flight + 8 : throwFrame + 8;
  const t0 = performance.now();
  const msPerFrame = 110;
  const anim = { layer, raf: 0 };
  S.anim = anim;
  function frame(now) {
    const k = Math.min(endFrame, (now - t0) / msPerFrame);
    const ki = Math.floor(k);
    tracks.forEach((t, i) => {
      const kk = Math.min(ki, throwFrame + flight + 2);
      const rp = t.last(t.rp, kk), dp = t.last(t.dp, kk);
      const prog = Math.min(1, kk / Math.max(1, throwFrame));
      const scale = 1 + (t.f - 1) * prog;
      const dx = rp.x + (dp.x - rp.x) * scale, dy = rp.y + (dp.y - rp.y) * scale;
      dots[i].o.setAttribute("cx", sx(rp.y)); dots[i].o.setAttribute("cy", sy(rp.x));
      const cx = sx(dy), cy = sy(dx), s = 0.6;
      dots[i].x.setAttribute("d", `M${cx - s},${cy - s}L${cx + s},${cy + s}M${cx + s},${cy - s}L${cx - s},${cy + s}`);
      if (ki >= throwFrame) {
        dots[i].lab.setAttribute("x", sx(rp.y)); dots[i].lab.setAttribute("y", sy(rp.x) - 1.3);
        dots[i].lab.textContent = `${rep.recs[i].sep.toFixed(1)}`;
      }
    });
    if (rep.target !== null && ki >= throwFrame) {
      ball.setAttribute("visibility", "visible");
      const t = tracks[rep.target];
      const tgt = t.last(t.rp, Math.min(throwFrame + flight, t.rp.length - 1));
      const p = Math.min(1, (k - throwFrame) / flight);
      const bx = 26.65 + (sx(tgt.y) - 26.65) * p, by = sy(-5) + (sy(tgt.x) - sy(-5)) * p - Math.sin(p * Math.PI) * 2.5;
      ball.setAttribute("cx", bx); ball.setAttribute("cy", by);
      if (p >= 1) {
        const word = rep.type === "complete" ? `Complete to ${t.r.id} for ${rep.yards}${rep.yards >= S.sit.ytoEZ ? ", touchdown" : rep.yards >= S.sit.ytg ? ", first down" : ""}` : rep.type === "interception" ? `Intercepted, throw to ${t.r.id}` : `Incomplete, intended for ${t.r.id}`;
        cap.textContent = `${rep.cov}. ${word}. ${signed(rep.epa, 2)} EPA.`;
      }
    } else if (rep.target === null && ki >= throwFrame) {
      cap.textContent = `${rep.cov}. ${rep.type === "sack" ? `Sacked for ${rep.yards}` : `Scramble for ${rep.yards}`}. ${signed(rep.epa, 2)} EPA.`;
      $("#qb-dot")?.setAttribute("cy", sy(-5 + (rep.type === "sack" ? -2 : rep.yards)));
    }
    if (k < endFrame) anim.raf = requestAnimationFrame(frame);
  }
  anim.raf = requestAnimationFrame(frame);
}

/* ---------- coach ---------- */
function renderChat() {
  const box = $("#chat");
  box.replaceChildren();
  if (S.chat.length === 0) box.append(el("div", { class: "note" }, "Ask for a critique, a first read, or a play that beats the coverage you picked. The coordinator runs the simulator itself before answering."));
  for (const m of S.chat) {
    if (m.role === "user") box.append(el("div", { class: "msg user" }, m.content));
    else box.append(el("div", { class: "msg coach" }, el("span", { class: "who" }, "Coordinator"), m.content));
  }
  if (S.chatBusy) box.append(el("div", { class: "msg coach wait" }, el("i"), el("i"), el("i"), " running the numbers"));
  box.scrollTop = box.scrollHeight;
}
async function sendChat() {
  const ta = $("#chat-text");
  const text = ta.value.trim();
  if (!text || S.chatBusy) return;
  ta.value = "";
  $("#chat-error").hidden = true;
  S.chat.push({ role: "user", content: text });
  S.chatBusy = true;
  renderChat();
  try {
    const board = { play: S.play, defense: S.defense, situation: S.sit, lastResult: S.result ? { epa: +S.result.summary.epa.toFixed(3), success: +S.result.summary.success.toFixed(3) } : null };
    const res = await fetch("/api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: S.chat, board }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    S.chat.push({ role: "assistant", content: data.text || "(no reply)" });
    if (data.board) {
      if (data.board.play) { S.play = data.board.play; S.selected = null; }
      if (data.board.defense) { S.defense = data.board.defense; $("#coverage").value = S.defense.coverage; $("#team").value = S.defense.team || ""; defenseNote(); }
      if (data.board.situation) { S.sit = data.board.situation; $("#down").value = S.sit.down; $("#ytg").value = S.sit.ytg; $("#ytoez").value = S.sit.ytoEZ; }
      drawBoard(); renderPlaybar(); run();
    }
  } catch (err) {
    S.chat.pop();
    $("#chat-error").textContent = `The coordinator is unavailable: ${err.message}`;
    $("#chat-error").hidden = false;
    ta.value = text;
  } finally {
    S.chatBusy = false;
    renderChat();
  }
}

/* ---------- boot ---------- */
async function boot() {
  const res = await fetch("data/model.json");
  S.model = await res.json();
  S.sim = createSim(S.model);
  boardSetup();
  setupControls();
  drawBoard();
  renderPlaybar();
  renderChat();
}
boot();
