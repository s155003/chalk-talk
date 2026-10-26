import sys, pyarrow.parquet as pq, pandas as pd
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 200); pd.set_option("display.max_colwidth", 60)
D = r"C:\Users\aarav\chalk-talk\data\cfb"
for name in ["rosters_2026.parquet", "player_stats_2026.parquet", "teams_colors_logos.parquet"]:
    f = pq.ParquetFile(f"{D}/{name}")
    print(f"\n=== {name}: rows {f.metadata.num_rows}")
    print([c for c in f.schema_arrow.names])
    t = f.read_row_group(0).to_pandas().head(3)
    print(t)
import os
if os.path.exists(f"{D}/play_by_play_2026.parquet"):
    f = pq.ParquetFile(f"{D}/play_by_play_2026.parquet")
    print(f"\n=== pbp 2026: rows {f.metadata.num_rows}, row groups {f.num_row_groups}")
    names = f.schema_arrow.names
    print(len(names), "columns")
    print(names)
    cols = [c for c in ["game_id", "week", "pos_team", "def_pos_team", "down", "distance", "yards_to_goal", "play_type", "play_text", "yards_gained", "EPA", "success", "rush", "pass", "completion", "sack", "int", "fumble", "td_play", "rusher_player_name", "passer_player_name", "receiver_player_name", "yards_after_catch", "air_yards", "penalty_flag", "scramble", "pass_breakup", "fumble_lost", "offense_play", "defense_play"] if c in names]
    t = f.read_row_group(0, columns=cols).to_pandas()
    print(t.head(8))
    print("\nplay_type:\n", t["play_type"].value_counts().head(30))
    print("\nteams sample:", sorted(t["pos_team"].dropna().unique())[:15])
