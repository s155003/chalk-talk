import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createCfbSim, KIND, KIND_LABEL } from "../public/cfbsim.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "public", "data", "cfb");
const league = JSON.parse(fs.readFileSync(path.join(DATA, "league.json"), "utf8"));
const MODEL = "claude-opus-5-5";
let client = null;
const teamCache = new Map();
function loadTeam(slug, season) {
  const key = `${slug}-${season}`;
  if (!teamCache.has(key)) {
    const p = path.join(DATA, "teams", `${key}.json`);
    if (!fs.existsSync(p) || !/^[a-z0-9-]+$/.test(key)) throw new Error(`No data for ${key}`);
    teamCache.set(key, JSON.parse(fs.readFileSync(p, "utf8")));
  }
  return teamCache.get(key);
}

const SIT_SCHEMA = {
  type: "object",
  properties: { down: { type: "integer" }, ytg: { type: "integer" }, ytoEZ: { type: "integer", description: "Yards to the opponent's end zone" } },
  required: ["down", "ytg", "ytoEZ"], additionalProperties: false
};
const CALL_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "integer", description: "0 hand off to a back, 1 QB keep, 2 throw" },
    playerId: { type: "integer", description: "Athlete id from the roster list, or 0 for any player of that kind" }
  },
  required: ["kind", "playerId"], additionalProperties: false
};
const TOOLS = [
  { name: "simulate_call", description: "Simulate one call in a situation for 1,000 snaps drawn from real plays (half the offense's, half what the defense allowed). Returns EPA per snap, success, first-down, touchdown, turnover, sack/stuff and explosive rates, yards quantiles, and the size and specificity of both play pools.",
    input_schema: { type: "object", properties: { call: CALL_SCHEMA, situation: SIT_SCHEMA }, required: ["call", "situation"], additionalProperties: false } },
  { name: "compare_calls", description: "Simulate every sensible call for this offense (each back, the QB keeper, each receiver with enough targets) in a situation and return them ranked by EPA per snap.",
    input_schema: { type: "object", properties: { situation: SIT_SCHEMA }, required: ["situation"], additionalProperties: false } },
  { name: "scout", description: "Return the season tendencies of the offense or the defense on the board: run rate, yards per play and success by run and pass, stuff, sack, interception and havoc rates, third-down conversions, red-zone touchdowns, by-down splits, and the FBS averages to compare against.",
    input_schema: { type: "object", properties: { side: { type: "string", enum: ["offense", "defense"] } }, required: ["side"], additionalProperties: false } },
  { name: "set_board", description: "Put a call (and optionally a situation) on the user's board. Simulate it first so your claim about it is grounded.",
    input_schema: { type: "object", properties: { call: CALL_SCHEMA, situation: SIT_SCHEMA }, required: ["call"], additionalProperties: false } }
];

function validSit(s, fallback) {
  if (!s) return fallback;
  return { down: Math.max(1, Math.min(4, s.down | 0 || 1)), ytg: Math.max(1, Math.min(30, s.ytg | 0 || 10)), ytoEZ: Math.max(1, Math.min(99, s.ytoEZ | 0 || 55)) };
}
function validCall(c) {
  const kind = [0, 1, 2].includes(c?.kind) ? c.kind : 0;
  return { kind, playerId: Number(c?.playerId) || 0 };
}
function trim(s) {
  return { epa_per_snap: +s.epa.toFixed(3), success: +s.success.toFixed(3), first_down: +s.firstDown.toFixed(3), touchdown: +s.touchdown.toFixed(3),
    turnover: +s.turnover.toFixed(3), sack: +s.sack.toFixed(3), stuffed: +s.stuff.toFixed(3), explosive_15plus: +s.explosive.toFixed(3),
    yards_mean: +s.yardsMean.toFixed(2), yards_quantiles: s.yardsQ,
    offense_pool: { plays: s.offensePool.n, filter: s.offensePool.level, yards_per_play: +(s.offensePool.ypp || 0).toFixed(2) },
    defense_pool: { plays: s.defensePool.n, filter: s.defensePool.level, yards_per_play: +(s.defensePool.ypp || 0).toFixed(2) } };
}
function rosterText(team, side) {
  const P = team.players;
  if (side === "offense") {
    const lines = [];
    for (const q of P.QB.slice(0, 2)) lines.push(`QB ${q.name} (id ${q.id}): ${q.att} att, ${Math.round(q.comp * 100)}% comp, ${q.ypa} yds/att, ${q.td} TD, ${q.int} INT, ${q.sacks} sacks taken${q.carries ? `, ${q.carries} carries at ${q.ypc} ypc` : ""}`);
    for (const r of P.RB.slice(0, 4)) lines.push(`RB ${r.name} (id ${r.id}): ${r.carries || 0} carries, ${r.ypc ?? "-"} ypc, ${Math.round((r.success || 0) * 100)}% success${r.targets ? `, ${r.targets} targets` : ""}`);
    for (const w of [...P.WR, ...P.TE].sort((a, b) => (b.targets || 0) - (a.targets || 0)).slice(0, 7)) lines.push(`${w.pos || "WR"} ${w.name} (id ${w.id}): ${w.targets} targets, ${w.catches} catches, ${w.yards} yds, ${w.ypt} yds/target, ${w.td} TD, ${Math.round((w.explosive || 0) * 100)}% explosive`);
    return lines.join("\n");
  }
  return [...P.DL.slice(0, 4), ...P.LB.slice(0, 3), ...P.DB.slice(0, 5)].map((d) => `${d.pos || ""} ${d.name}: ${d.sacks} sacks, ${d.pbu} PBU, ${d.int} INT, ${d.ff} FF`).join("\n");
}
function systemPrompt(board, off, def, sim) {
  const offName = league.teams.find((t) => t.slug === board.offense)?.name || off.team;
  const defName = league.teams.find((t) => t.slug === board.defense)?.name || def.team;
  return `You are the offensive coordinator inside Chalk Talk, a college football play-call simulator. The user has ${offName}'s offense on the board against ${defName}'s defense, ${board.season} season (through week ${league.seasons[board.season].max_week}). Every simulated snap is a real play: half drawn from what ${offName} has done on that kind of play, half from what ${defName} has allowed, narrowed to the same down and distance when the sample is big enough, then scored in expected points for the situation. You talk like a sharp, friendly coordinator in a film room.

Rules:
- Every number you state must come from a tool result in this conversation. Never guess rates or yards. To recommend a call, run compare_calls or simulate_call first.
- When you recommend a call, call set_board with it after simulating, so it appears on the board. Keep the user's situation unless they ask to change it.
- Keep answers short: three to six sentences or a short list. Plain text, no markdown headers, no em dashes.
- Say how big the sample is when it is small (under 40 plays) and say so when the defense pool is doing most of the work.
- Be honest about limits: no formations, coverages, pass depth or tackles exist in this data; defensive starters are inferred from impact plays; a defense's "allowed" numbers include the quality of the offenses it faced.
- Call kinds: 0 hand off to a back, 1 QB keep, 2 throw. Use the athlete ids below for playerId, or 0 for any.

${offName} offense, ${off.games} games:
${rosterText(off, "offense")}

${defName} defense, ${def.games} games (impact plays only):
${rosterText(def, "defense")}

FBS averages this season: rush ${sim.baseline.rush.ypp} yds/play (${Math.round(sim.baseline.rush.success * 100)}% success), QB rush ${sim.baseline.qb_rush.ypp}, pass ${sim.baseline.pass.ypp} yds/play (${Math.round(sim.baseline.pass.success * 100)}% success), sack rate ${Math.round(sim.baseline.sack_rate * 1000) / 10}%, stuff rate ${Math.round(sim.baseline.stuff_rate * 100)}%.

Current board: ${JSON.stringify({ situation: board.situation, call: board.callLabel, lastResult: board.lastResult })}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { messages, board } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "No messages" });
    if (!board || !board.offense || !board.defense) return res.status(400).json({ error: "No board" });
    const season = String(board.season || Object.keys(league.seasons).sort().at(-1));
    if (!league.seasons[season]) return res.status(400).json({ error: "Bad season" });
    const off = loadTeam(String(board.offense), season), def = loadTeam(String(board.defense), season);
    const sim = createCfbSim(league, season);
    const sit0 = validSit(board.situation, { down: 3, ytg: 4, ytoEZ: 55 });
    const clean = messages.slice(-12).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 2000) }));
    if (clean[clean.length - 1].role !== "user") return res.status(400).json({ error: "Last message must be from the user" });

    if (!client) client = new Anthropic();
    const system = [{ type: "text", text: systemPrompt({ ...board, season, situation: sit0 }, off, def, sim), cache_control: { type: "ephemeral" } }];
    const convo = [...clean];
    let proposed = null, text = "", usage = { input: 0, output: 0 };
    for (let iter = 0; iter < 7; iter++) {
      const resp = await client.beta.messages.create({ model: MODEL, max_tokens: 4000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", system, messages: convo, tools: TOOLS, output_config: { effort: "medium" } });
      usage.input += resp.usage.input_tokens; usage.output += resp.usage.output_tokens;
      if (resp.stop_reason === "refusal") throw new Error("The coordinator declined to answer that.");
      convo.push({ role: "assistant", content: resp.content });
      const toolUses = resp.content.filter((b) => b.type === "tool_use");
      text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || text;
      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) break;
      const results = [];
      for (const tu of toolUses) {
        try {
          if (tu.name === "simulate_call") {
            const { summary } = sim.simulate(validCall(tu.input.call), off, def, validSit(tu.input.situation, sit0), { reps: 1000, seed: 11 });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(trim(summary)) });
          } else if (tu.name === "compare_calls") {
            const rows = sim.compare(off, def, validSit(tu.input.situation, sit0), { reps: 600, seed: 11 });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(rows.map((r) => ({ label: r.label, kind: r.kind, playerId: r.playerId, ...trim(r.summary) }))) });
          } else if (tu.name === "scout") {
            const side = tu.input.side === "offense" ? "offense" : "defense";
            const team = side === "offense" ? off : def;
            results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ team: team.team, side, tendencies: team.tendencies[side], opponents: team.opponents, fbs_average: sim.baseline }) });
          } else if (tu.name === "set_board") {
            proposed = { call: validCall(tu.input.call), situation: tu.input.situation ? validSit(tu.input.situation, sit0) : null };
            results.push({ type: "tool_result", tool_use_id: tu.id, content: "Board updated." });
          } else results.push({ type: "tool_result", tool_use_id: tu.id, content: "Unknown tool", is_error: true });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      convo.push({ role: "user", content: results });
    }
    const plain = text.replace(new RegExp(String.fromCharCode(8212), "g"), ",").replace(/\*\*/g, "").replace(/^#+\s*/gm, "");
    res.status(200).json({ text: plain, board: proposed, usage, model: MODEL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
