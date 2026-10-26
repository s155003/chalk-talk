import fs from "node:fs";
const m = JSON.parse(fs.readFileSync(new URL("../public/data/model.json", import.meta.url)));
console.log("meta", m.meta);
console.log("coverages", m.coverages);
for (const r of Object.keys(m.routes)) {
  const p = m.paths[`${r}|R|zone`] || m.paths[`${r}|R|man`];
  const d = m.paths[`${r}|D|zone`];
  const last = p.pts.filter(Boolean).at(-1);
  const at20 = p.pts[20];
  console.log(r.padEnd(7), "depth_mean", m.routes[r].depth_mean, "frames", p.pts.length, "n", p.n, "at2.0s", at20, "end", last, "| D start", d && d.pts[0], "D at2.0s", d && d.pts[20]);
}
console.log("sep GO|Cover 3|outside", m.sep["GO|Cover 3|outside"]);
console.log("sep HITCH|Cover 1", m.sep["HITCH|Cover 1"]);
console.log("dropback", Object.entries(m.dropback).slice(0, 6));
console.log("yac GO", m.yac.GO, "yac FLAT", m.yac.FLAT);
console.log("ep 1|7-10|7", m.ep["1|7-10|7"], "ep 3|1-3|0", m.ep["3|1-3|0"], "ep 1|*|9", m.ep["1|*|9"]);
console.log("teams PHI", m.teams.PHI, "NYJ", m.teams.NYJ);
console.log("receivers", m.receivers.slice(0, 8).map((r) => `${r.name} ${r.pos} ${r.team} n${r.n} ${r.shift}`));
