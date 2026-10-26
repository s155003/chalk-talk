import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createSim, ROUTES, ROUTE_LABEL } from "../public/sim.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(fs.readFileSync(path.join(here, "..", "public", "data", "model.json"), "utf8"));
const sim = createSim(model);
const MODEL = "claude-opus-5-5";
let client = null;

const PLAY_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    receivers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "One of X, H, Y, Z, B" },
          pos: { type: "string", enum: ["WR", "TE", "RB"] },
          x: { type: "number", description: "Yards behind the line of scrimmage (0 on the line, negative in the backfield, -8 at most)" },
          y: { type: "number", description: "Yards from the left sideline, 2 to 51. The field is 53.3 wide; 26.65 is the middle." },
          route: { type: "string", enum: ROUTES }
        },
        required: ["id", "pos", "x", "y", "route"],
        additionalProperties: false
      }
    }
  },
  required: ["name", "receivers"],
  additionalProperties: false
};
const DEFENSE_SCHEMA = {
  type: "object",
  properties: {
    coverage: { type: "string", description: `One of ${sim.covNames.join(", ")} or "mix" for the team's real coverage mix` },
    team: { type: ["string", "null"], description: "Three-letter 2022 NFL team code or null for league average" }
  },
  required: ["coverage", "team"],
  additionalProperties: false
};
const SIT_SCHEMA = {
  type: "object",
  properties: { down: { type: "integer" }, ytg: { type: "integer" }, ytoEZ: { type: "integer", description: "Yards to the opponent's end zone" } },
  required: ["down", "ytg", "ytoEZ"],
  additionalProperties: false
};

const TOOLS = [
  {
    name: "simulate_play",
    description: "Run a play against a defense in a situation for N snaps on the 2022 tracking-data tables. Returns EPA per snap, success rate, completion rate, first-down rate, interception and sack rates, yards distribution, and per-receiver target share, openness and separation.",
    input_schema: {
      type: "object",
      properties: { play: PLAY_SCHEMA, defense: DEFENSE_SCHEMA, situation: SIT_SCHEMA, reps: { type: "integer" } },
      required: ["play", "defense", "situation"],
      additionalProperties: false
    }
  },
  {
    name: "set_board",
    description: "Put a play (and optionally a defense and situation) on the user's whiteboard. Use this when you propose or adjust a play so the user can see it drawn. Call simulate_play first so your claims about it are grounded.",
    input_schema: {
      type: "object",
      properties: { play: PLAY_SCHEMA, defense: DEFENSE_SCHEMA, situation: SIT_SCHEMA },
      required: ["play"],
      additionalProperties: false
    }
  }
];

function medianTable() {
  const lines = [];
  for (const c of sim.covNames) {
    const cells = ROUTES.map((r) => {
      const o = model.sep[`${r}|${c}|outside`], s = model.sep[`${r}|${c}|slot`], any = model.sep[`${r}|${c}`] || model.sep[r];
      const med = (q) => q ? q.q[9].toFixed(1) : "-";
      return `${r} ${med(o)}/${med(s)}${!o && !s ? `(${med(any)})` : ""}`;
    });
    lines.push(`${c}: ${cells.join(", ")}`);
  }
  return lines.join("\n");
}

function trimSummary(s) {
  return {
    epa_per_snap: +s.epa.toFixed(3), success_rate: +s.success.toFixed(3), completion_rate: +s.completion.toFixed(3),
    first_down_rate: +s.firstDown.toFixed(3), touchdown_rate: +s.touchdown.toFixed(3), interception_rate: +s.interception.toFixed(3),
    sack_rate: +s.sack.toFixed(3), explosive_rate_15plus: +s.explosive.toFixed(3), yards_mean: +s.yardsMean.toFixed(2), yards_quantiles: s.yardsQ,
    receivers: s.perReceiver.map((r) => ({ id: r.id, route: r.route, target_share: +r.targetShare.toFixed(3), open_at_throw_3yd: +r.openRate.toFixed(3),
      separation_mean: +r.sepMean.toFixed(2), catch_rate: +r.catchRate.toFixed(3), yards_per_target: +r.yardsPerTarget.toFixed(2), epa_per_target: +r.epaPerTarget.toFixed(3) })),
    coverages_seen: s.coverages
  };
}

function validatePlay(p) {
  if (!p || !Array.isArray(p.receivers) || p.receivers.length < 1 || p.receivers.length > 5) throw new Error("A play needs 1 to 5 receivers");
  for (const r of p.receivers) {
    if (!ROUTES.includes(r.route)) throw new Error(`Unknown route ${r.route}`);
    r.x = Math.max(-8, Math.min(0, Number(r.x) || 0));
    r.y = Math.max(2, Math.min(51, Number(r.y) || 26));
    if (!["WR", "TE", "RB"].includes(r.pos)) r.pos = "WR";
    r.id = String(r.id || "R").slice(0, 2);
  }
  return p;
}
function validateDefense(d) {
  if (!d) return { coverage: "Cover 3", team: null };
  const coverage = d.coverage === "mix" || sim.covNames.includes(d.coverage) ? d.coverage : "Cover 3";
  const team = d.team && model.teams[d.team] ? d.team : null;
  return { coverage, team };
}
function validateSit(s) {
  if (!s) return { down: 2, ytg: 7, ytoEZ: 65 };
  return { down: Math.max(1, Math.min(4, s.down | 0 || 1)), ytg: Math.max(1, Math.min(30, s.ytg | 0 || 10)), ytoEZ: Math.max(1, Math.min(99, s.ytoEZ | 0 || 65)) };
}

function systemPrompt(board) {
  return `You are the offensive coordinator inside Chalk Talk, a passing-play simulator built on NFL player-tracking data (2022 season, weeks 1 to 9, ${model.meta.receiver_snaps.toLocaleString()} receiver snaps). The user draws a play on a whiteboard; the simulator samples how open each receiver gets at the throw from real separation distributions for that route against that coverage, picks a target the way quarterbacks actually do, and resolves the pass with completion and interception models fitted on the same data. You talk to the user like a sharp, friendly coordinator in a film room.

Rules:
- Every number you state must come from a simulate_play result in this conversation. Never guess rates. If you want to compare designs, simulate each one.
- When you propose or change a play, simulate it first, then call set_board so it appears on the whiteboard, then explain in plain English what changed and what the numbers say.
- Keep answers short: three to six sentences, or a short list. Plain text, no markdown headers, no em dashes.
- Be honest about limits: the separation tables are averages over many quarterbacks and receivers; the sim does not model protection, play action, motion, or specific defenders. Target choice in the data is only weakly predicted by openness (quarterbacks are hard to predict), so the sim's target shares are noisy.
- Receiver ids: X and Z are usually the outside receivers, H the slot, Y the tight end, B the back. Keep the user's ids when adjusting their play.
- Coordinates: x is yards behind the line (0 to -8), y is yards from the left sideline (2 to 51). Outside receivers sit within 12 yards of a sideline; everything else counts as slot.

Routes available: ${ROUTES.map((r) => `${r} (${ROUTE_LABEL[r]})`).join(", ")}.

Median separation at the throw, in yards, outside/slot, by route and coverage (from the data):
${medianTable()}

League coverage mix on dropbacks: ${model.coverages.map((c) => `${c.name} ${(c.share * 100).toFixed(0)}%`).join(", ")}.

The user's current whiteboard:
${JSON.stringify(board)}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { messages, board } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "No messages" });
    const clean = messages.slice(-12).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 2000) }));
    if (clean[clean.length - 1].role !== "user") return res.status(400).json({ error: "Last message must be from the user" });
    const safeBoard = {
      play: validatePlay(board?.play || { name: "Untitled", receivers: [] }),
      defense: validateDefense(board?.defense),
      situation: validateSit(board?.situation),
      lastResult: board?.lastResult || null
    };

    if (!client) client = new Anthropic();
    const system = [{ type: "text", text: systemPrompt(safeBoard), cache_control: { type: "ephemeral" } }];
    const convo = [...clean];
    let proposedBoard = null;
    let text = "";
    let usage = { input: 0, output: 0 };

    for (let iter = 0; iter < 7; iter++) {
      const resp = await client.beta.messages.create({
        model: MODEL, max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        system, messages: convo, tools: TOOLS,
        output_config: { effort: "medium" }
      });
      usage.input += resp.usage.input_tokens; usage.output += resp.usage.output_tokens;
      if (resp.stop_reason === "refusal") throw new Error("The coordinator declined to answer that.");
      convo.push({ role: "assistant", content: resp.content });
      const toolUses = resp.content.filter((b) => b.type === "tool_use");
      text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || text;
      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) break;
      const results = [];
      for (const tu of toolUses) {
        try {
          if (tu.name === "simulate_play") {
            const play = validatePlay(tu.input.play), defense = validateDefense(tu.input.defense), sit = validateSit(tu.input.situation);
            const { summary } = sim.simulate(play, defense, sit, { reps: Math.min(3000, tu.input.reps || 1500), seed: 7 });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(trimSummary(summary)) });
          } else if (tu.name === "set_board") {
            proposedBoard = {
              play: validatePlay(tu.input.play),
              defense: tu.input.defense ? validateDefense(tu.input.defense) : null,
              situation: tu.input.situation ? validateSit(tu.input.situation) : null
            };
            results.push({ type: "tool_result", tool_use_id: tu.id, content: "Board updated. The user can see the play now." });
          } else {
            results.push({ type: "tool_result", tool_use_id: tu.id, content: "Unknown tool", is_error: true });
          }
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      convo.push({ role: "user", content: results });
    }
    res.status(200).json({ text: text.replace(/—/g, ","), board: proposedBoard, usage, model: MODEL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
