import fs from "node:fs";
const base = new URL("../public/data/cfb/", import.meta.url);
const league = JSON.parse(fs.readFileSync(new URL("league.json", base)));
console.log("teams", league.teams.length, league.teams.slice(0, 3));
console.log("baseline 2026", league.seasons["2026"].baseline, "ep cells", Object.keys(league.seasons["2026"].ep).length);
const t = JSON.parse(fs.readFileSync(new URL("teams/texas-a-m-2026.json", base)));
console.log("A&M 2026 games", t.games, "off plays", t.offense.length, "def plays", t.defense.length, "opponents", t.opponents.join(", "));
console.log("tendencies", JSON.stringify(t.tendencies.offense).slice(0, 600));
for (const b of ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB"]) {
  console.log(b, t.players[b].slice(0, 5).map((p) => `${p.name} #${p.jersey} ${p.pos} ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !["name", "jersey", "pos", "headshot", "id", "year"].includes(k))))}`).join("\n   "));
}
console.log("sample off rows", t.offense.slice(0, 5));
const kinds = [0, 1, 2].map((k) => t.offense.filter((r) => r[1] === k).length);
console.log("kinds rush/qbrush/pass", kinds);
