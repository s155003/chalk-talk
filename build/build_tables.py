"""
Builds public/data/model.json from the Big Data Bowl 2025 tracking data in
C:/Users/aarav/uncovered/data (2022 season, weeks 1 to 9).

Everything the browser simulator needs is precomputed here:
  - separation-at-the-throw distributions per route x coverage x alignment
  - average route paths (receiver) and average defender paths, by frame
  - a target-choice model (which receiver the QB throws to, given openness)
  - completion and interception models given separation and depth
  - sack / scramble rates and time to throw, by coverage and route depth
  - yards-after-catch distributions by route
  - an expected-points table by down, distance and field position
  - per-team coverage mix and coverage tightness shifts
  - per-receiver separation shifts (how much more open than expected)

Memory is tight on this laptop, so tracking files are read one row group at
a time with only the needed columns.
"""
import json, math, os, sys
from collections import defaultdict
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

RAW = r"C:\Users\aarav\uncovered\data\raw"
SNAPS = r"C:\Users\aarav\uncovered\data\snaps.parquet"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "model.json")

ROUTES = ["GO", "POST", "CORNER", "OUT", "IN", "SLANT", "HITCH", "CROSS", "FLAT", "SCREEN", "ANGLE", "WHEEL"]
INSIDE_BREAKING = {"POST", "IN", "SLANT", "CROSS", "ANGLE", "SCREEN"}  # mirrored so the break points toward field centre

COV_FAMILY = {
    "Cover-0": "Cover 0",
    "Cover-1": "Cover 1", "Cover-1 Double": "Cover 1",
    "Cover-2": "Cover 2",
    "2-Man": "2-Man",
    "Cover-3": "Cover 3", "Cover-3 Seam": "Cover 3", "Cover-3 Cloud Right": "Cover 3",
    "Cover-3 Cloud Left": "Cover 3", "Cover-3 Double Cloud": "Cover 3",
    "Quarters": "Quarters",
    "Cover 6-Left": "Cover 6", "Cover-6 Right": "Cover 6",
}
COVERAGES = ["Cover 0", "Cover 1", "2-Man", "Cover 2", "Cover 3", "Quarters", "Cover 6"]
MAN = {"Cover 0", "Cover 1", "2-Man"}
QS = [round(q, 2) for q in np.linspace(0.05, 0.95, 19)]
FRAMES = 45  # 4.5 seconds after the snap at 10 Hz


def quantiles(x):
    x = np.asarray(x, dtype=float)
    return [round(float(v), 2) for v in np.quantile(x, QS)]


def logistic_fit(X, y, l2=1e-3, iters=3000, lr=0.05):
    """Plain gradient-descent logistic regression with standardized inputs."""
    X = np.asarray(X, dtype=float); y = np.asarray(y, dtype=float)
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = (X - mu) / sd
    Z = np.c_[np.ones(len(Z)), Z]
    w = np.zeros(Z.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w))
        g = Z.T @ (p - y) / len(y) + l2 * np.r_[0, w[1:]]
        w -= lr * g
    # fold standardization back into raw-space coefficients
    b = w[1:] / sd
    b0 = w[0] - (b * mu).sum()
    p = 1 / (1 + np.exp(-(X @ b + b0)))
    ll = (y * np.log(p + 1e-9) + (1 - y) * np.log(1 - p + 1e-9)).mean()
    base = y.mean()
    ll0 = base * math.log(base) + (1 - base) * math.log(1 - base)
    return [round(float(b0), 5)] + [round(float(v), 5) for v in b], {"n": int(len(y)), "rate": round(float(base), 4), "mcfadden_r2": round(float(1 - ll / ll0), 4)}


def conditional_logit(groups, iters=2500, lr=0.05, l2=1e-3):
    """groups: list of (features[n_i, k], chosen_index). Maximizes log softmax.
    Vectorized: all alternatives stacked, group membership via index arrays."""
    k = groups[0][0].shape[1]
    allX = np.vstack([g[0] for g in groups]); mu, sd = allX.mean(0), allX.std(0) + 1e-9
    Z = (allX - mu) / sd
    gid = np.concatenate([np.full(len(g[0]), i) for i, g in enumerate(groups)])
    starts = np.cumsum([0] + [len(g[0]) for g in groups[:-1]])
    chosen = starts + np.array([g[1] for g in groups])
    G = len(groups)
    w = np.zeros(k)
    for _ in range(iters):
        u = Z @ w
        umax = np.full(G, -np.inf); np.maximum.at(umax, gid, u)
        e = np.exp(u - umax[gid])
        denom = np.zeros(G); np.add.at(denom, gid, e)
        p = e / denom[gid]
        grad = Z[chosen].sum(0) - (p[:, None] * Z).sum(0)
        w += lr * (grad / G - l2 * w)
    b = w / sd
    # accuracy and log-lik vs uniform
    hit = 0; ll = 0.0; ll0 = 0.0
    for X, c in groups:
        u = X @ b; u -= u.max(); p = np.exp(u); p /= p.sum()
        hit += int(np.argmax(p) == c); ll += math.log(p[c] + 1e-12); ll0 += math.log(1 / len(X))
    return [round(float(v), 5) for v in b], {"n": len(groups), "top1": round(hit / len(groups), 4), "mcfadden_r2": round(1 - ll / ll0, 4)}


def main():
    print("loading tables")
    plays = pd.read_parquet(os.path.join(RAW, "plays.parquet"))
    pp = pd.read_parquet(os.path.join(RAW, "player_play.parquet"), columns=[
        "gameId", "playId", "nflId", "teamAbbr", "routeRan", "wasTargettedReceiver", "hadPassReception",
        "yardageGainedAfterTheCatch"])
    players = pd.read_parquet(os.path.join(RAW, "players.parquet"))
    games = pd.read_parquet(os.path.join(RAW, "games.parquet"))
    snaps = pd.read_parquet(SNAPS, columns=[
        "recv_id", "recv_pos", "def_id", "sep", "gameId", "playId", "passResult", "pff_passCoverage",
        "timeToThrow", "depth", "from_sideline", "routeRan", "targeted", "recv_name"])
    plays = plays[["gameId", "playId", "down", "yardsToGo", "possessionTeam", "defensiveTeam", "yardlineSide",
                   "yardlineNumber", "passResult", "yardsGained", "expectedPoints", "timeToThrow", "isDropback",
                   "pff_passCoverage"]].copy()

    plays["cov"] = plays["pff_passCoverage"].map(COV_FAMILY)
    snaps["cov"] = snaps["pff_passCoverage"].map(COV_FAMILY)
    snaps = snaps[snaps["cov"].notna() & snaps["routeRan"].isin(ROUTES)].copy()
    snaps = snaps.drop(columns=["pff_passCoverage"]).reset_index(drop=True)
    snaps["align"] = np.where(snaps["from_sideline"] <= 12, "outside", "slot")
    for c in ["recv_pos", "passResult", "routeRan", "cov", "align", "recv_name"]:
        snaps[c] = snaps[c].astype("category")
    print("snaps with family coverage and a route:", len(snaps))
    print(snaps["align"].value_counts().to_dict())

    model = {"meta": {
        "season": 2022, "weeks": "1 to 9", "source": "NFL Big Data Bowl 2025 tracking data (CC BY-NC 4.0)",
        "receiver_snaps": int(len(snaps)), "dropbacks": int(snaps[["gameId", "playId"]].drop_duplicates().shape[0]),
        "quantiles": QS, "frames": FRAMES, "hz": 10}}

    # ---- coverage frequency (dropbacks) ----
    db = plays[plays["isDropback"] == True].copy()  # noqa: E712
    db = db[db["cov"].notna()]
    covfreq = db["cov"].value_counts(normalize=True)
    model["coverages"] = [{"name": c, "man": c in MAN, "share": round(float(covfreq.get(c, 0)), 4)} for c in COVERAGES]

    # ---- separation cells ----
    cells = {}
    cell_mean = {}
    for (r, c, a), g in snaps.groupby(["routeRan", "cov", "align"], observed=True):
        if len(g) >= 40:
            cells[f"{r}|{c}|{a}"] = {"n": int(len(g)), "q": quantiles(g["sep"])}
    for (r, c), g in snaps.groupby(["routeRan", "cov"], observed=True):
        if len(g) >= 25:
            cells[f"{r}|{c}"] = {"n": int(len(g)), "q": quantiles(g["sep"])}
            cell_mean[(r, c)] = float(g["sep"].mean())
    for r, g in snaps.groupby("routeRan", observed=True):
        cells[f"{r}"] = {"n": int(len(g)), "q": quantiles(g["sep"])}
    model["sep"] = cells
    print("separation cells:", len(cells))

    # expected separation per snap for shifts: cell mean of (route, cov), else route mean
    route_mean = snaps.groupby("routeRan", observed=True)["sep"].mean().to_dict()
    snaps["exp"] = [cell_mean.get((r, c), route_mean[r]) for r, c in zip(snaps["routeRan"], snaps["cov"])]
    snaps["resid"] = snaps["sep"] - snaps["exp"]

    # ---- routes: mean depth at throw, typical time to throw ----
    routes = {}
    for r, g in snaps.groupby("routeRan", observed=True):
        routes[r] = {"n": int(len(g)), "depth_q": quantiles(g["depth"]), "depth_mean": round(float(g["depth"].mean()), 2)}
    model["routes"] = routes

    # ---- target choice: conditional logit over receivers on a play ----
    groups = []
    for (gid, pid), g in snaps.groupby(["gameId", "playId"]):
        if g["targeted"].sum() != 1 or len(g) < 2:
            continue
        X = np.c_[np.minimum(g["sep"].values, 10.0), g["depth"].values, g["depth"].values ** 2 / 100.0,
                  g["routeRan"].isin(["SCREEN", "FLAT"]).values.astype(float)]
        groups.append((X, int(np.argmax(g["targeted"].values))))
    print("target-choice plays:", len(groups))
    tb, tfit = conditional_logit(groups)
    model["target"] = {"features": ["sep_capped10", "depth", "depth_sq_over100", "is_screen_or_flat"], "coef": tb, "fit": tfit}
    print("target fit", tfit, tb)

    # ---- completion given target ----
    tg = snaps[snaps["targeted"] == True].copy()  # noqa: E712
    tg = tg[tg["passResult"].isin(["C", "I", "IN"])]
    man = tg["cov"].isin(MAN).astype(float).values
    Xc = np.c_[np.minimum(tg["sep"].values, 10.0), tg["depth"].values, np.minimum(tg["sep"].values, 10.0) * tg["depth"].values / 10.0, man]
    cb, cfit = logistic_fit(Xc, (tg["passResult"] == "C").values.astype(float))
    model["completion"] = {"features": ["sep_capped10", "depth", "sep_x_depth_over10", "man"], "coef": cb, "fit": cfit}
    print("completion fit", cfit, cb)
    ib, ifit = logistic_fit(Xc, (tg["passResult"] == "IN").values.astype(float))
    model["interception"] = {"features": ["sep_capped10", "depth", "sep_x_depth_over10", "man"], "coef": ib, "fit": ifit}
    print("interception fit", ifit, ib)

    # ---- sacks, scrambles, time to throw by coverage x play depth bucket ----
    play_depth = snaps.groupby(["gameId", "playId"])["depth"].max().rename("maxdepth").reset_index()
    dbx = db.merge(play_depth, on=["gameId", "playId"], how="inner")
    dbx = dbx[dbx["passResult"].isin(["C", "I", "IN", "S", "R"])]
    dbx["bucket"] = pd.cut(dbx["maxdepth"], [-99, 8, 16, 999], labels=["short", "medium", "deep"]).astype(str)
    # Sacks and scrambles have no throw frame, so they never appear in the snap table.
    # Their rates therefore come from the full dropback list, by coverage family.
    sack = {}
    dball = db[db["passResult"].isin(["C", "I", "IN", "S", "R"])]
    for c, g in dball.groupby("cov"):
        sack[c] = {"n": int(len(g)), "sack": round(float((g["passResult"] == "S").mean()), 4),
                   "scramble": round(float((g["passResult"] == "R").mean()), 4)}
    sack["*"] = {"n": int(len(dball)), "sack": round(float((dball["passResult"] == "S").mean()), 4),
                 "scramble": round(float((dball["passResult"] == "R").mean()), 4)}
    for b, g in dbx.groupby("bucket"):
        thrown = g[g["passResult"].isin(["C", "I", "IN"])]
        sack[f"ttt|{b}"] = {"n": int(len(thrown)), "q": quantiles(thrown["timeToThrow"].dropna())}
    model["dropback"] = sack
    print("dropback", sack["*"], {k: v["sack"] for k, v in sack.items() if k in COVERAGES})
    model["sack_yards_q"] = quantiles(db.loc[db["passResult"] == "S", "yardsGained"])
    model["scramble_yards_q"] = quantiles(db.loc[db["passResult"] == "R", "yardsGained"])

    # ---- yards after catch by route ----
    rec = pp[(pp["hadPassReception"] == 1) & pp["routeRan"].isin(ROUTES)]
    del pp
    yac = {}
    for r, g in rec.groupby("routeRan"):
        yac[r] = {"n": int(len(g)), "q": quantiles(g["yardageGainedAfterTheCatch"].fillna(0))}
    model["yac"] = yac

    # ---- expected points table ----
    pl = plays.copy()
    side_is_off = pl["yardlineSide"] == pl["possessionTeam"]
    pl["yds_to_ez"] = np.where(pl["yardlineSide"].isna(), 50, np.where(side_is_off, 100 - pl["yardlineNumber"], pl["yardlineNumber"]))
    pl["ytg_b"] = pd.cut(pl["yardsToGo"], [0, 3, 6, 10, 15, 99], labels=["1-3", "4-6", "7-10", "11-15", "16+"]).astype(str)
    pl["ez_b"] = (np.clip(pl["yds_to_ez"], 1, 99) - 1) // 10  # 0..9
    ep = {}
    for (d, yb, eb), g in pl.groupby(["down", "ytg_b", "ez_b"]):
        if len(g) >= 8:
            ep[f"{int(d)}|{yb}|{int(eb)}"] = round(float(g["expectedPoints"].mean()), 3)
    # smooth fallback: by down and field bucket only
    for (d, eb), g in pl.groupby(["down", "ez_b"]):
        ep[f"{int(d)}|*|{int(eb)}"] = round(float(g["expectedPoints"].mean()), 3)
    model["ep"] = ep
    print("ep cells:", len(ep))

    # ---- teams: coverage mix and tightness shift ----
    # defensive team for each snap via plays
    snaps = snaps.merge(plays[["gameId", "playId", "defensiveTeam", "possessionTeam"]], on=["gameId", "playId"], how="left")
    teams = {}
    for t, g in snaps.groupby("defensiveTeam", observed=True):
        mix = g.drop_duplicates(["gameId", "playId"])["cov"].value_counts(normalize=True)
        gm = g[g["cov"].isin(MAN)]; gz = g[~g["cov"].isin(MAN)]
        teams[t] = {"n": int(len(g)), "mix": {c: round(float(mix.get(c, 0)), 4) for c in COVERAGES},
                    "shift_man": round(float(gm["resid"].mean()), 3) if len(gm) >= 100 else 0.0,
                    "shift_zone": round(float(gz["resid"].mean()), 3) if len(gz) >= 100 else 0.0}
    model["teams"] = teams

    # ---- receivers: shrunk separation shift ----
    snaps["recv_name"] = snaps["recv_name"].astype(str); snaps["recv_pos"] = snaps["recv_pos"].astype(str)
    g = snaps.groupby("recv_id", observed=True).agg(n=("resid", "size"), mean=("resid", "mean"), name=("recv_name", "first"),
                                                    pos=("recv_pos", "first"), team=("possessionTeam", "first"))
    g = g[g["n"] >= 60]
    noise = float(snaps["resid"].var())
    between = max(float(g["mean"].var() - (noise / g["n"]).mean()), 0.01)
    g["shift"] = g["mean"] * (between / (between + noise / g["n"]))
    g = g.sort_values("n", ascending=False)
    recs = [{"id": int(i), "name": r["name"], "pos": r["pos"], "team": r["team"], "n": int(r["n"]), "shift": round(float(r["shift"]), 3)}
            for i, r in g.iterrows() if r["pos"] in ("WR", "TE", "RB")]
    model["receivers"] = recs[:120]
    print("receivers kept:", len(model["receivers"]), "between-player sd", round(math.sqrt(between), 3))

    # ---- average paths from tracking ----
    print("building paths from tracking (this is the slow part)")
    recv_keys = snaps[["gameId", "playId", "recv_id", "def_id", "routeRan", "cov"]].copy()
    recv_keys["routeRan"] = recv_keys["routeRan"].astype(str)
    recv_keys["man"] = recv_keys["cov"].astype(str).isin(MAN)
    del snaps
    # receiver rows
    rk = recv_keys.rename(columns={"recv_id": "nflId"})[["gameId", "playId", "nflId", "routeRan", "man"]].copy()
    rk["role"] = "R"; rk["pair"] = rk["nflId"]
    dk = recv_keys.rename(columns={"def_id": "nflId"})[["gameId", "playId", "nflId", "routeRan", "man", "recv_id"]].copy()
    dk["role"] = "D"; dk = dk.rename(columns={"recv_id": "pair"})
    keys = pd.concat([rk, dk], ignore_index=True)
    keys["nflId"] = keys["nflId"].astype(float)
    keys["pair"] = keys["pair"].astype(float)
    key_index = keys.set_index(["gameId", "playId", "nflId"])

    sums = defaultdict(lambda: np.zeros((FRAMES + 1, 3)))  # (route, role, man) -> frame -> [sum dx, sum dy, n]
    cols = ["gameId", "playId", "nflId", "frameId", "frameType", "playDirection", "x", "y"]
    for wk in range(1, 10):
        path = os.path.join(RAW, f"tracking_week_{wk}.parquet")
        f = pq.ParquetFile(path)
        # pass 1: snap frames for players of interest and the receiver each defender is matched to
        snap_rows = []
        for batch in f.iter_batches(batch_size=150_000, columns=cols):
            t = batch.to_pandas()
            t = t[(t["frameType"] == "SNAP") & t["nflId"].notna()]
            if len(t):
                snap_rows.append(t)
        snapdf = pd.concat(snap_rows, ignore_index=True)
        del snap_rows
        snapdf = snapdf.merge(keys, on=["gameId", "playId", "nflId"], how="inner")
        # orientation: offense moves +x
        left = snapdf["playDirection"] == "left"
        snapdf["x0"] = np.where(left, 120 - snapdf["x"], snapdf["x"])
        snapdf["y0"] = np.where(left, 53.3 - snapdf["y"], snapdf["y"])
        snapdf["snapFrame"] = snapdf["frameId"]
        # mirror sign from the RECEIVER's side so defender paths share the receiver's frame
        recv_side = snapdf[snapdf["role"] == "R"][["gameId", "playId", "nflId", "x0", "y0"]].rename(
            columns={"nflId": "pair", "x0": "rx0", "y0": "ry0"})
        snapdf = snapdf.merge(recv_side, on=["gameId", "playId", "pair"], how="inner")
        snapdf["sign"] = np.where(snapdf["ry0"] < 26.65, 1.0, -1.0)
        origin = snapdf.set_index(["gameId", "playId", "nflId"])[["rx0", "ry0", "sign", "snapFrame", "routeRan", "role", "man"]]
        # pass 2: after-snap frames
        for batch in f.iter_batches(batch_size=150_000, columns=cols):
            t = batch.to_pandas()
            t = t[t["frameType"].isin(["SNAP", "AFTER_SNAP"]) & t["nflId"].notna()]
            t = t.join(origin, on=["gameId", "playId", "nflId"], how="inner")
            if t.empty:
                continue
            left = t["playDirection"] == "left"
            x = np.where(left, 120 - t["x"], t["x"]); y = np.where(left, 53.3 - t["y"], t["y"])
            k = (t["frameId"] - t["snapFrame"]).values
            dx = x - t["rx0"].values; dy = (y - t["ry0"].values) * t["sign"].values
            ok = (k >= 0) & (k <= FRAMES)
            sub = pd.DataFrame({"route": t["routeRan"].values[ok], "role": t["role"].values[ok], "man": t["man"].values[ok],
                                "k": k[ok], "dx": dx[ok], "dy": dy[ok]})
            agg = sub.groupby(["route", "role", "man", "k"]).agg(dx=("dx", "sum"), dy=("dy", "sum"), n=("dx", "size"))
            for (r, role, m, kk), row in agg.iterrows():
                sums[(r, role, bool(m))][int(kk)] += [row["dx"], row["dy"], row["n"]]
        print(f"  week {wk} done")

    paths = {}
    for (r, role, m), arr in sums.items():
        n = arr[:, 2]
        valid = n >= 30
        pts = [[round(float(arr[i, 0] / n[i]), 2), round(float(arr[i, 1] / n[i]), 2)] if valid[i] else None for i in range(FRAMES + 1)]
        # trim trailing frames with too few samples
        while pts and pts[-1] is None:
            pts.pop()
        paths[f"{r}|{role}|{'man' if m else 'zone'}"] = {"n": int(max(n[0], n[1])), "pts": pts}
    model["paths"] = paths
    print("paths:", len(paths))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(model, fh, separators=(",", ":"))
    print("wrote", OUT, f"{os.path.getsize(OUT)/1024:.0f} KB")


if __name__ == "__main__":
    main()
