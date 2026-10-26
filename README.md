# Chalk Talk

Draw a passing play on a whiteboard, pick a coverage or a real 2022 NFL defense, and run it a thousand times. The simulator samples how open each route actually got against that coverage in NFL player-tracking data, picks a target the way quarterbacks do, and resolves the pass. An AI offensive coordinator (Claude) can run the simulator itself, critique your design, and draw a better one on the board.

## What is real and what is modelled

Everything in `public/data/model.json` is built by `build/build_tables.py` from the Big Data Bowl 2025 release (2022 season, weeks 1 to 9; routes and coverages charted by PFF). From 37,627 receiver snaps on 8,201 dropbacks:

| Table | What it holds |
|---|---|
| `sep` | separation at the throw, as 19 quantiles, per route x coverage family x outside/slot (204 cells) |
| `paths` | the average receiver path and the average matched-defender path per route, 10 Hz, man and zone |
| `target` | conditional logit: which receiver gets the ball given each one's separation, depth and route type |
| `completion`, `interception` | logistic models on the 7,891 targeted throws |
| `dropback` | sack and scramble rates by coverage; time to throw by route depth |
| `yac` | yards after catch quantiles by route |
| `ep` | expected points by down, distance bucket and field position (from the release's EP column) |
| `teams` | each defense's coverage mix and how much tighter or looser than expected it played, man and zone |
| `receivers` | 120 receivers' separation above expectation, shrunk toward zero by sample size |

Model fits, so nobody has to take them on faith: completion McFadden R² 0.11, interception 0.07, target choice 0.03 (top-1 accuracy 32% against a 22% baseline). Target choice is genuinely hard to predict from openness, and the app says so.

The simulator does not model protection, play action, motion, specific defenders, route combinations that conflict one defender, or the quarterback's progression. Separation is sampled independently per receiver.

## Run it

```
npm install
set ANTHROPIC_API_KEY=sk-ant-...     # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm run dev
```

Open http://localhost:3000. The simulation runs entirely in the browser (`public/sim.js`); only the coordinator calls the API (`api/coach.js`), which runs the same `sim.js` server-side as a tool for Claude.

To rebuild the tables you need the raw tracking parquet files from the Uncovered project in `C:\Users\aarav\uncovered\data\raw`:

```
npm run build:model
```

## Verify

```
npm run verify            # full pass including one coordinator call
npm run verify -- --no-coach
```

`scripts/verify.mjs` drives headless Chrome through a run, a pin-and-compare, a drag, an animation and a coordinator question, screenshots each state into `screenshots/`, and fails on console errors, bad requests, literal `undefined`/`NaN`, em dashes, or horizontal overflow at phone width.

## Deploy

Vercel layout. From the project folder:

```
npx vercel login
npx vercel --prod
npx vercel env add ANTHROPIC_API_KEY production
npx vercel --prod
```

## Data license

NFL Next Gen Stats tracking data released for the NFL Big Data Bowl 2025, CC BY-NC 4.0. Non-commercial use only. Attribution to the National Football League.
