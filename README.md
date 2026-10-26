# Chalk Talk

Two football simulators that run on real data, with an AI offensive coordinator that uses them as tools.

**College game** (`index.html`): pick any of the 138 FBS offenses and any defense, 2025 or 2026. The board shows both teams' real starters with jersey numbers. Hand it to a specific back, keep it with the quarterback, or throw to a specific receiver, and the simulator plays the snap a thousand times by drawing real plays: half from what that offense (or that player) has done on that kind of play, half from what that defense has allowed, narrowed to the same down and distance when the sample is big enough. Compare every call at once, read a scouting report on either side, and ask the coordinator what to call.

**Route lab** (`routes.html`): draw an NFL passing play by giving five receivers routes, pick a coverage or a real 2022 defense, and simulate how open each route actually gets using Big Data Bowl player-tracking data.

## What is real and what is modelled

### College game

Built by `build/build_cfb.py` from cfbfastR play-by-play, rosters and team info (sportsdataverse project, ESPN-sourced) for 2025 and 2026. Each team-season file in `public/data/cfb/teams/` holds:

| Field | What it is |
|---|---|
| `offense`, `defense` | every rush and pass that team ran or faced, as `[yards, kind, down, distance bucket, flags, player id]`; kind is hand off, QB rush, or pass; flags carry sack, interception, fumble lost, touchdown, completion and stuffed run |
| `players` | QBs, backs, receivers and tight ends with this season's usage and production; linemen from the roster; defenders ranked by sacks, breakups, interceptions and forced fumbles |
| `tendencies` | run rate, yards per play and success by run and pass, stuff, sack, interception and havoc rates, third-down conversions, red-zone touchdowns, by-down splits |

`league.json` holds the FBS averages and an expected-points table by down, distance and field position from the same plays. Simulated outcomes keep their real yards and flags and are rescored in expected points for the situation you set (`public/cfbsim.js`).

Not in the public feed, and therefore not in the simulator: tackles, formations, pass depth, coverage. Formations and fronts on the board are templates. Watch One is an illustration of the sampled outcome, not tracking. A defense's "allowed" numbers include the quality of the offenses it faced.

### Route lab

Built by `build/build_tables.py` from the Big Data Bowl 2025 release (2022 season, weeks 1 to 9). Separation at the throw per route x coverage x alignment, average receiver and defender paths, a target-choice model, completion and interception models, sack rates, yards after catch, team and receiver shifts. Fits: completion McFadden R² 0.11, interception 0.07, target choice 0.03 (top-1 32% vs 22% baseline).

## Run it

```
npm install
set ANTHROPIC_API_KEY=sk-ant-...     # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm run dev
```

Open http://localhost:3000. Both simulators run in the browser; only the coordinators call the API (`api/cfbcoach.js`, `api/coach.js`), which run the same engines server-side as tools for Claude Opus 5.5.

Rebuilding the tables:

```
npm run build:cfb      # needs data/cfb/*.parquet (see build/build_cfb.py for sources)
npm run build:model    # needs the Big Data Bowl parquet files from the Uncovered project
```

Refresh the college data any week by downloading the current `play_by_play_2026.parquet` from the `cfbfastR_cfb_pbp` release of `sportsdataverse/sportsdataverse-data` and the rosters from `sportsdataverse/cfbfastR-data`, then running `npm run build:cfb`.

## Verify

```
npm run verify:cfb                 # college page, one coordinator call
npm run verify:cfb -- --no-coach
npm run verify                     # route lab
```

Both scripts drive headless Chrome, screenshot each state into `screenshots/`, and fail on console errors, bad requests, literal `undefined`/`NaN`/`null`, em dashes, or horizontal overflow at phone width.

## Deploy

Vercel layout. From the project folder:

```
npx vercel login
npx vercel --prod
npx vercel env add ANTHROPIC_API_KEY production
npx vercel --prod
```

## Data

College: cfbfastR play-by-play, rosters and team info from the sportsdataverse project, derived from ESPN data. NFL: Next Gen Stats tracking released for the Big Data Bowl 2025, CC BY-NC 4.0. Non-commercial use only.
