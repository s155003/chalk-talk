"""
Builds the college football simulator tables from cfbfastR play-by-play,
rosters and team info (sportsdataverse, ESPN-sourced) in data/cfb/.

Outputs:
  public/data/cfb/league.json           teams, league baselines, EP table, meta
  public/data/cfb/teams/<slug>.json     one file per FBS team per season:
                                        offensive play samples, defensive play
                                        samples (plays faced), players, tendencies

A "play sample" is a compact row: [yards, kind, down, dist_bucket, flags, player_id]
  kind:  0 rush (non-QB), 1 QB rush, 2 pass
  flags: bit 0 sack, bit 1 interception, bit 2 fumble lost, bit 3 touchdown, bit 4 completion, bit 5 stuffed
"""
import json, os, re, sys, unicodedata
from collections import defaultdict
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

D = os.path.join(os.path.dirname(__file__), "..", "data", "cfb")
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "cfb")
SEASONS = [2025, 2026]

FBS_CONFS = {"SEC", "Big Ten", "Big 12", "ACC", "Pac-12", "American Athletic", "Mountain West", "Sun Belt",
             "Mid-American", "Conference USA", "FBS Independents"}

COLS = ["season", "week", "game_id", "pos_team", "def_pos_team", "offense_conference", "defense_conference",
        "down", "distance", "yards_to_goal", "play_type", "play_text", "yards_gained", "EPA", "ep_before", "success",
        "rush", "pass", "completion", "pass_attempt", "sack", "int", "fumble_vec", "turnover", "td_play", "stuffed_run",
        "rush_player_id", "rush_player", "position_rush", "target_player_id", "target_player", "position_target",
        "completion_player_id", "completion_player", "incompletion_player_id", "incompletion_player",
        "reception_player_id", "reception_player", "reception_yds",
        "sack_player_id", "sack_player", "sack_taken_player_id", "sack_taken_player",
        "interception_player_id", "interception_player", "interception_thrown_player_id", "interception_thrown_player",
        "pass_breakup_player_id", "pass_breakup_player", "fumble_forced_player_id", "fumble_forced_player",
        "fumble_recovered_player_id", "fumble_recovered_player", "fumble_player_id", "fumble_player",
        "touchdown_player_id", "touchdown_player", "position_sack", "position_pass_breakup", "position_interception",
        "position_fumble_forced", "home_team_division", "penalty_flag", "period", "pos_score_diff_start"]


def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def dist_bucket(d):
    return 0 if d <= 3 else 1 if d <= 7 else 2


def load_pbp(season):
    f = pq.ParquetFile(os.path.join(D, f"play_by_play_{season}.parquet"))
    cols = [c for c in COLS if c in f.schema_arrow.names]
    df = f.read(columns=cols).to_pandas()
    df = df[df["penalty_flag"] != True]  # noqa: E712
    df = df[df["down"].between(1, 4) & df["distance"].notna() & df["yards_to_goal"].notna()]
    df = df[(df["rush"] == 1) | (df["pass"] == 1)]
    df = df[df["yards_gained"].notna()]
    df["kind"] = np.where(df["pass"] == 1, 2, np.where(df["position_rush"] == "QB", 1, 0))
    df["flags"] = (
        (df["sack"].fillna(0).astype(int) * 1)
        | (df["int"].fillna(0).astype(int) * 2)
        | (((df["fumble_vec"].fillna(0) == 1) & (df["turnover"].fillna(0) == 1)).astype(int) * 4)
        | (df["td_play"].fillna(0).astype(int) * 8)
        | (df["completion"].fillna(0).astype(int) * 16)
        | (df["stuffed_run"].fillna(0).astype(int) * 32)
    )
    df["db"] = df["distance"].clip(lower=1).apply(dist_bucket)
    # the player the play is "about": rusher, or target (fallback completion/incompletion thrower is the QB)
    # ESPN marks the target only on incompletions; completions carry the receiver instead.
    df["pid"] = np.where(df["kind"] == 2, df["reception_player_id"].fillna(df["target_player_id"]), df["rush_player_id"])
    df["pname"] = np.where(df["kind"] == 2, df["reception_player"].fillna(df["target_player"]), df["rush_player"])
    df["qbid"] = np.where(df["kind"] == 2, df["completion_player_id"].fillna(df["incompletion_player_id"]).fillna(df["sack_taken_player_id"]).fillna(df["interception_thrown_player_id"]), np.nan)
    df["qbname"] = np.where(df["kind"] == 2, df["completion_player"].fillna(df["incompletion_player"]).fillna(df["sack_taken_player"]).fillna(df["interception_thrown_player"]), None)
    return df


def rows_of(g):
    out = []
    for r in g.itertuples(index=False):
        pid = int(r.pid) if pd.notna(r.pid) else 0
        out.append([int(r.yards_gained), int(r.kind), int(r.down), int(r.db), int(r.flags), pid])
    return out


def summarize(g):
    n = len(g)
    if n == 0:
        return None
    return {"n": int(n), "ypp": round(float(g["yards_gained"].mean()), 2), "success": round(float(g["success"].fillna(0).mean()), 3),
            "epa": round(float(g["EPA"].fillna(0).mean()), 3), "explosive": round(float((g["yards_gained"] >= 15).mean()), 3)}


def tendencies(off, deff):
    """Scouting numbers for a team: what its offense does and what its defense allows."""
    t = {"offense": {}, "defense": {}}
    for side, g in (("offense", off), ("defense", deff)):
        s = {}
        rush = g[g["kind"] != 2]; pas = g[g["kind"] == 2]
        s["plays"] = int(len(g))
        s["run_rate"] = round(float((g["kind"] != 2).mean()), 3) if len(g) else 0
        s["rush"] = summarize(rush); s["pass"] = summarize(pas)
        s["qb_rush_rate"] = round(float((g["kind"] == 1).mean()), 3) if len(g) else 0
        s["sack_rate"] = round(float(pas["sack"].fillna(0).mean()), 3) if len(pas) else 0
        s["int_rate"] = round(float(pas["int"].fillna(0).mean()), 3) if len(pas) else 0
        s["stuff_rate"] = round(float(rush["stuffed_run"].fillna(0).mean()), 3) if len(rush) else 0
        s["completion"] = round(float(pas["completion"].fillna(0).mean()), 3) if len(pas) else 0
        third = g[g["down"].isin([3, 4])]
        s["third_conv"] = round(float((third["yards_gained"] >= third["distance"]).mean()), 3) if len(third) else 0
        s["havoc"] = round(float(((g["sack"].fillna(0) == 1) | (g["int"].fillna(0) == 1) | (g["pass_breakup_player_id"].notna()) | (g["fumble_forced_player_id"].notna())).mean()), 3) if len(g) else 0
        by_down = {}
        for d, gd in g.groupby("down"):
            by_down[int(d)] = {"n": int(len(gd)), "run_rate": round(float((gd["kind"] != 2).mean()), 3), "success": round(float(gd["success"].fillna(0).mean()), 3), "ypp": round(float(gd["yards_gained"].mean()), 2)}
        s["by_down"] = by_down
        rz = g[g["yards_to_goal"] <= 20]
        s["redzone_td"] = round(float(rz["td_play"].fillna(0).mean()), 3) if len(rz) else 0
        t[side] = s
    return t


def players_for(team, off, deff, roster):
    """Offensive skill players from usage; defenders from impact plays; join to roster for jersey/position."""
    ros = roster[roster["team"] == team].copy()
    ros_by_id = {int(r.athlete_id): r for r in ros.itertuples(index=False) if pd.notna(r.athlete_id)}

    def rmeta(pid, name=None):
        r = ros_by_id.get(int(pid)) if pid and not pd.isna(pid) else None
        if r is None:
            return {"id": int(pid) if pid and not pd.isna(pid) else 0, "name": name or "", "pos": "", "jersey": None, "year": None, "headshot": None}
        return {"id": int(r.athlete_id), "name": f"{r.first_name} {r.last_name}", "pos": r.position or "", "jersey": int(r.jersey) if pd.notna(r.jersey) else None,
                "year": int(r.year) if pd.notna(r.year) else None, "headshot": r.headshot_url if isinstance(r.headshot_url, str) else None}

    players = {"QB": [], "RB": [], "WR": [], "TE": [], "OL": [], "DL": [], "LB": [], "DB": []}
    # passers
    pas = off[off["kind"] == 2]
    for pid, g in pas.groupby("qbid"):
        if pd.isna(pid) or len(g) < 10:
            continue
        m = rmeta(pid, g["qbname"].iloc[0])
        m.update({"att": int(len(g)), "comp": round(float(g["completion"].fillna(0).mean()), 3), "ypa": round(float(g["yards_gained"].mean()), 2),
                  "td": int(g["td_play"].fillna(0).sum()), "int": int(g["int"].fillna(0).sum()), "sacks": int(g["sack"].fillna(0).sum()),
                  "epa": round(float(g["EPA"].fillna(0).mean()), 3), "success": round(float(g["success"].fillna(0).mean()), 3)})
        players["QB"].append(m)
    players["QB"].sort(key=lambda p: -p["att"])
    # rushers (non-QB)
    rush = off[off["kind"] == 0]
    for pid, g in rush.groupby("pid"):
        if pid == 0 or pd.isna(pid) or len(g) < 8:
            continue
        m = rmeta(pid, g["pname"].iloc[0])
        m.update({"carries": int(len(g)), "ypc": round(float(g["yards_gained"].mean()), 2), "success": round(float(g["success"].fillna(0).mean()), 3),
                  "explosive": round(float((g["yards_gained"] >= 10).mean()), 3), "td": int(g["td_play"].fillna(0).sum()), "epa": round(float(g["EPA"].fillna(0).mean()), 3),
                  "stuffed": round(float(g["stuffed_run"].fillna(0).mean()), 3)})
        bucket = "RB" if m["pos"] in ("RB", "FB", "") else ("WR" if m["pos"] == "WR" else "RB")
        players[bucket].append(m)
    players["RB"].sort(key=lambda p: -p["carries"])
    # QB rushing
    qrush = off[off["kind"] == 1]
    for pid, g in qrush.groupby("pid"):
        if pid == 0 or pd.isna(pid) or len(g) < 5:
            continue
        for q in players["QB"]:
            if q["id"] == int(pid):
                q.update({"carries": int(len(g)), "ypc": round(float(g["yards_gained"].mean()), 2), "rush_success": round(float(g["success"].fillna(0).mean()), 3), "rush_td": int(g["td_play"].fillna(0).sum())})
    # targets
    for pid, g in pas.groupby("pid"):
        if pid == 0 or pd.isna(pid) or len(g) < 6:
            continue
        m = rmeta(pid, g["pname"].iloc[0])
        m.update({"targets": int(len(g)), "catches": int(g["completion"].fillna(0).sum()), "yards": int(g["yards_gained"].sum()),
                  "ypt": round(float(g["yards_gained"].mean()), 2), "catch_rate": round(float(g["completion"].fillna(0).mean()), 3),
                  "td": int(g["td_play"].fillna(0).sum()), "epa": round(float(g["EPA"].fillna(0).mean()), 3), "success": round(float(g["success"].fillna(0).mean()), 3),
                  "explosive": round(float((g["yards_gained"] >= 15).mean()), 3)})
        pos = m["pos"] or "WR"
        bucket = "TE" if pos == "TE" else "RB" if pos in ("RB", "FB") else "WR"
        existing = next((p for p in players[bucket] if p["id"] == m["id"]), None)
        if existing:
            existing.update({k: v for k, v in m.items() if k not in ("pos", "name", "jersey", "year", "headshot", "epa", "success")})
            existing["recv_epa"] = m["epa"]
        else:
            players[bucket].append(m)
    players["WR"].sort(key=lambda p: -p.get("targets", 0))
    players["TE"].sort(key=lambda p: -p.get("targets", 0))
    players["RB"].sort(key=lambda p: -(p.get("carries", 0) * 1 + p.get("targets", 0) * 0.5))
    # offensive line from roster, no stats in this feed
    ol = ros[ros["position"] == "OL"].copy()
    ol["yr"] = ol["year"].fillna(0)
    for r in ol.sort_values(["yr", "weight"], ascending=False).head(5).itertuples(index=False):
        players["OL"].append(rmeta(r.athlete_id))
    # defenders: impact plays
    impact = defaultdict(lambda: {"sacks": 0, "pbu": 0, "int": 0, "ff": 0, "fr": 0, "name": ""})
    for col, key, namecol in (("sack_player_id", "sacks", "sack_player"), ("pass_breakup_player_id", "pbu", "pass_breakup_player"),
                              ("interception_player_id", "int", "interception_player"), ("fumble_forced_player_id", "ff", "fumble_forced_player"),
                              ("fumble_recovered_player_id", "fr", "fumble_recovered_player")):
        for pid, g in deff[deff[col].notna()].groupby(col):
            impact[int(pid)][key] += int(len(g)); impact[int(pid)]["name"] = g[namecol].iloc[0]
    for pid, st in impact.items():
        m = rmeta(pid, st["name"]); m.update({k: v for k, v in st.items() if k != "name"})
        m["havoc"] = st["sacks"] + st["pbu"] + st["int"] + st["ff"]
        pos = m["pos"]
        bucket = "DL" if pos in ("DL", "DE", "DT", "NT") else "LB" if pos in ("LB", "OLB", "ILB", "EDGE") else "DB" if pos in ("DB", "CB", "S") else None
        if bucket:
            players[bucket].append(m)
    # fill thin defensive groups from the roster by seniority
    need = {"DL": 4, "LB": 3, "DB": 4}
    for bucket, k in need.items():
        players[bucket].sort(key=lambda p: (-p.get("havoc", 0), -(p.get("year") or 0)))
        have = {p["id"] for p in players[bucket]}
        pool = ros[ros["position"].isin({"DL": ["DL", "DE", "DT", "NT"], "LB": ["LB", "OLB", "ILB", "EDGE"], "DB": ["DB", "CB", "S"]}[bucket])].copy()
        pool["yr"] = pool["year"].fillna(0)
        for r in pool.sort_values("yr", ascending=False).itertuples(index=False):
            if len(players[bucket]) >= max(k, 6):
                break
            if pd.notna(r.athlete_id) and int(r.athlete_id) not in have:
                m = rmeta(r.athlete_id); m.update({"sacks": 0, "pbu": 0, "int": 0, "ff": 0, "fr": 0, "havoc": 0}); players[bucket].append(m); have.add(m["id"])
    for b in players:
        players[b] = players[b][:12]
    return players


def ep_table(df):
    ep = {}
    d = df.copy()
    d["ytg_b"] = pd.cut(d["distance"], [0, 3, 6, 10, 15, 99], labels=["1-3", "4-6", "7-10", "11-15", "16+"]).astype(str)
    d["ez_b"] = ((d["yards_to_goal"].clip(1, 99) - 1) // 10).astype(int)
    for (dn, yb, eb), g in d.groupby(["down", "ytg_b", "ez_b"]):
        if len(g) >= 15:
            ep[f"{int(dn)}|{yb}|{eb}"] = round(float(g["ep_before"].mean()), 3)
    for (dn, eb), g in d.groupby(["down", "ez_b"]):
        ep[f"{int(dn)}|*|{eb}"] = round(float(g["ep_before"].mean()), 3)
    return ep


def main():
    os.makedirs(os.path.join(OUT, "teams"), exist_ok=True)
    info = pd.read_parquet(os.path.join(D, "teams_colors_logos.parquet"))
    info_by_school = {r.school: r for r in info.itertuples(index=False)}
    league = {"seasons": {}, "teams": {}, "meta": {"source": "cfbfastR play-by-play and rosters (sportsdataverse, ESPN data)", "built": pd.Timestamp.now().strftime("%Y-%m-%d")}}
    all_fbs = {}
    for season in SEASONS:
        print("season", season)
        df = load_pbp(season)
        roster = pd.read_parquet(os.path.join(D, f"rosters_{season}.parquet"))
        fbs = df[df["offense_conference"].isin(FBS_CONFS) & df["defense_conference"].isin(FBS_CONFS)]
        teams = sorted(set(fbs["pos_team"]) | set(fbs["def_pos_team"]))
        print("  plays", len(df), "fbs-vs-fbs", len(fbs), "teams", len(teams), "max week", int(df["week"].max()))
        league["seasons"][season] = {"plays": int(len(fbs)), "max_week": int(df["week"].max()),
                                     "ep": ep_table(df),
                                     "baseline": {"rush": summarize(fbs[fbs["kind"] == 0]), "qb_rush": summarize(fbs[fbs["kind"] == 1]), "pass": summarize(fbs[fbs["kind"] == 2]),
                                                  "sack_rate": round(float(fbs.loc[fbs["kind"] == 2, "sack"].fillna(0).mean()), 3),
                                                  "int_rate": round(float(fbs.loc[fbs["kind"] == 2, "int"].fillna(0).mean()), 3),
                                                  "stuff_rate": round(float(fbs.loc[fbs["kind"] != 2, "stuffed_run"].fillna(0).mean()), 3),
                                                  "run_rate": round(float((fbs["kind"] != 2).mean()), 3)}}
        for team in teams:
            off = df[df["pos_team"] == team]
            deff = df[df["def_pos_team"] == team]
            if len(off) < 150:
                continue
            meta = info_by_school.get(team)
            s = slug(team)
            all_fbs.setdefault(s, {"name": team, "slug": s, "seasons": []})["seasons"].append(season)
            if meta is not None:
                all_fbs[s].update({"abbr": meta.abbreviation, "mascot": meta.mascot, "conference": meta.conference, "color": meta.color, "alt_color": meta.alt_color, "logo": meta.logo})
            else:
                all_fbs[s].setdefault("conference", off["offense_conference"].iloc[0])
            # record: season file
            rec = {"team": team, "season": season, "games": int(off["game_id"].nunique()),
                   "offense": rows_of(off), "defense": rows_of(deff),
                   "tendencies": tendencies(off, deff), "players": players_for(team, off, deff, roster),
                   "opponents": sorted(set(off["def_pos_team"]))}
            with open(os.path.join(OUT, "teams", f"{s}-{season}.json"), "w", encoding="utf-8") as fh:
                json.dump(rec, fh, separators=(",", ":"))
        print("  wrote", len(teams), "team files")
    league["teams"] = sorted(all_fbs.values(), key=lambda t: t["name"])
    with open(os.path.join(OUT, "league.json"), "w", encoding="utf-8") as fh:
        json.dump(league, fh, separators=(",", ":"))
    print("league teams", len(league["teams"]))
    size = sum(os.path.getsize(os.path.join(OUT, "teams", f)) for f in os.listdir(os.path.join(OUT, "teams")))
    print(f"team files total {size/1e6:.1f} MB; league.json {os.path.getsize(os.path.join(OUT, 'league.json'))/1e3:.0f} KB")


if __name__ == "__main__":
    main()
