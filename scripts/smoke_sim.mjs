import fs from "node:fs";
import { createSim, defaultPlay, defaultSituation } from "../public/sim.js";
const model = JSON.parse(fs.readFileSync(new URL("../public/data/model.json", import.meta.url)));
const sim = createSim(model);
const play = defaultPlay();
const sit = defaultSituation();
for (const cov of ["Cover 1", "Cover 3", "Quarters", "mix"]) {
  const t0 = Date.now();
  const { summary } = sim.simulate(play, { coverage: cov, team: null }, sit, { reps: 2000 });
  console.log(cov.padEnd(9), `epa ${summary.epa.toFixed(3)} succ ${(summary.success * 100).toFixed(0)}% comp ${(summary.completion * 100).toFixed(0)}% 1st ${(summary.firstDown * 100).toFixed(0)}% int ${(summary.interception * 100).toFixed(1)}% sack ${(summary.sack * 100).toFixed(1)}% yds ${summary.yardsMean.toFixed(1)} p50 ${summary.yardsQ.p50} ${Date.now() - t0}ms`);
  console.log("   ", summary.perReceiver.map((r) => `${r.id}:${r.route} tgt ${(r.targetShare * 100).toFixed(0)}% sep ${r.sepMean.toFixed(1)} open ${(r.openRate * 100).toFixed(0)}% catch ${(r.catchRate * 100).toFixed(0)}% ypt ${r.yardsPerTarget.toFixed(1)}`).join(" | "));
}
const vsPHI = sim.simulate(play, { coverage: "mix", team: "PHI" }, sit, { reps: 2000 }).summary;
const vsNYJ = sim.simulate(play, { coverage: "mix", team: "NYJ" }, sit, { reps: 2000 }).summary;
console.log("PHI mix epa", vsPHI.epa.toFixed(3), "NYJ mix epa", vsNYJ.epa.toFixed(3));
const one = sim.snap(play, { coverage: "Cover 3" }, sit, () => Math.random());
console.log("one snap", JSON.stringify(one).slice(0, 300));
console.log("route pts X GO zone:", sim.routePoints(play.receivers[0], false).slice(0, 3), "D:", sim.defenderPoints(play.receivers[0], false).slice(0, 3));
