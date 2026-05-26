"""
Download GridMET climate variables for fire season 2024 and aggregate to
0.5-degree weekly bins matching the NOAA fire data grid.

Outputs (in ./data/):
  climate_weekly_2024.csv   – per 0.5° cell × week with all climate vars
  state_climate_2024.csv    – per CONUS state, season-aggregate averages
  correlations_2024.csv     – Pearson r of each variable vs fire_power_MW
"""

import os, json, urllib.request
import numpy as np
import pandas as pd
import xarray as xr
import geopandas as gpd
import topojson as tp
from shapely.geometry import Point

DATA_DIR      = os.path.join(os.path.dirname(__file__), "data")
BASE_URL      = "https://www.northwestknowledge.net/metdata/data"
FIRE_CSV      = os.path.join(DATA_DIR, "fires_weekly_2024.csv")
TOPO_JSON     = os.path.join(DATA_DIR, "us-states.topo.json")
SEASON_START  = "2024-05-27"   # first Monday in fire dataset
SEASON_END    = "2024-10-28"   # last Monday

LAT_MIN, LAT_MAX =  24.0,  50.0
LON_MIN, LON_MAX = -125.0, -65.0

VARS = {
    "vpd":  {"label": "Vapor Pressure Deficit (kPa)",  "agg": "mean"},
    "tmmx": {"label": "Max Temperature (°F)",           "agg": "mean"},
    "pr":   {"label": "Precipitation (mm)",             "agg": "sum"},
    "vs":   {"label": "Wind Speed (m/s)",               "agg": "mean"},
    "rmin": {"label": "Min Relative Humidity (%)",      "agg": "mean"},
    "bi":   {"label": "Burning Index",                  "agg": "mean"},
    "erc":  {"label": "Energy Release Component",       "agg": "mean"},
}

os.makedirs(DATA_DIR, exist_ok=True)


# ── helpers ──────────────────────────────────────────────────────────────────

def download_nc(var: str) -> str:
    dest = os.path.join(DATA_DIR, f"{var}_2024.nc")
    if os.path.exists(dest):
        print(f"  {var}: already cached ({os.path.getsize(dest)/1e6:.0f} MB)")
        return dest
    url = f"{BASE_URL}/{var}_2024.nc"
    print(f"  {var}: downloading {url} …", end="", flush=True)
    urllib.request.urlretrieve(url, dest)
    print(f" done ({os.path.getsize(dest)/1e6:.0f} MB)")
    return dest


def week_label(ts: pd.Timestamp) -> str:
    """Monday of the week containing ts, as YYYY-MM-DD string."""
    monday = ts - pd.Timedelta(days=ts.weekday())
    return str(monday.date())


def load_var(var: str, nc_path: str) -> pd.DataFrame:
    """
    Load a GridMET NetCDF, subset to CONUS fire season, coarsen to 0.5°
    weekly bins, return DataFrame [week, lat_bin, lon_bin, <var>].
    """
    info = VARS[var]
    ds   = xr.open_dataset(nc_path, engine="netcdf4")

    # find the actual data variable (skip coordinates)
    coord_names = set(ds.coords) | {"crs", "day"}
    dv = [v for v in ds.data_vars if v not in coord_names][0]
    da = ds[dv]

    # normalise dimension names
    rename = {}
    for d in list(da.dims):
        dl = d.lower()
        if "lat" in dl:  rename[d] = "lat"
        elif "lon" in dl: rename[d] = "lon"
        elif "time" in dl or "day" in dl: rename[d] = "time"
    if rename:
        da = da.rename(rename)

    # spatial + temporal subset
    t0 = np.datetime64(SEASON_START)
    t1 = np.datetime64(SEASON_END) + np.timedelta64(6, "D")
    da = da.sel(
        lat=slice(LAT_MAX, LAT_MIN),   # descending lat
        lon=slice(LON_MIN, LON_MAX),
        time=slice(t0, t1),
    )

    # tmmx: Kelvin → Fahrenheit
    if var == "tmmx":
        da = (da - 273.15) * 9/5 + 32

    lat_vals = da.lat.values   # shape (nLat,)
    lon_vals = da.lon.values   # shape (nLon,)
    time_idx = pd.DatetimeIndex(da.time.values)

    # group days into fire-season weeks
    wk_labels = np.array([week_label(t) for t in time_idx])
    valid_weeks = sorted({week_label(pd.Timestamp(SEASON_START)
                          + pd.Timedelta(weeks=i))
                          for i in range(27)})  # up to 27 weeks
    # keep only weeks that appear in the fire dataset
    fire_weeks = set(pd.read_csv(FIRE_CSV)["week"].unique())
    wk_labels_masked = np.where(np.isin(wk_labels, list(fire_weeks)),
                                wk_labels, "")

    # define 0.5° bin edges
    lat_bins = np.arange(np.floor(LAT_MIN*2)/2, np.ceil(LAT_MAX*2)/2+0.5, 0.5)
    lon_bins = np.arange(np.floor(LON_MIN*2)/2, np.ceil(LON_MAX*2)/2+0.5, 0.5)

    # load data into memory once
    arr = da.values  # shape: (time, lat, lon)

    records = []
    for wk in sorted(fire_weeks):
        mask = wk_labels_masked == wk
        if not mask.any():
            continue
        slice_days = arr[mask]  # (n_days, nLat, nLon)
        if info["agg"] == "mean":
            agg2d = np.nanmean(slice_days, axis=0)
        else:
            agg2d = np.nansum(slice_days, axis=0)

        for lb in lat_bins:
            lat_m = (lat_vals >= lb) & (lat_vals < lb + 0.5)
            if not lat_m.any():
                continue
            sub_lat = agg2d[lat_m, :]           # (n_lat_cells, nLon)
            for lob in lon_bins:
                lon_m = (lon_vals >= lob) & (lon_vals < lob + 0.5)
                if not lon_m.any():
                    continue
                block = sub_lat[:, lon_m].ravel()
                block = block[np.isfinite(block)]
                if block.size == 0:
                    continue
                val = float(np.mean(block)) if info["agg"] == "mean" \
                      else float(np.sum(block))
                records.append({
                    "week":    wk,
                    "lat_bin": round(lb, 1),
                    "lon_bin": round(lob, 1),
                    var:       round(val, 4),
                })

    ds.close()
    return pd.DataFrame(records)


# ── main ─────────────────────────────────────────────────────────────────────

print("=== Step 1: load fire data ===")
fires = pd.read_csv(FIRE_CSV)
fires.columns = [c.strip() for c in fires.columns]
print(f"  {len(fires)} fire cell-weeks, weeks: {fires.week.nunique()}")

print("\n=== Step 2: download & process GridMET variables ===")
frames = {}
for var in VARS:
    nc = download_nc(var)
    print(f"  processing {var} …", flush=True)
    df = load_var(var, nc)
    frames[var] = df
    print(f"    → {len(df):,} cell-week records")

print("\n=== Step 3: merge climate variables ===")
base = frames["vpd"].copy()
for var, df in frames.items():
    if var == "vpd":
        continue
    base = base.merge(df, on=["week","lat_bin","lon_bin"], how="outer")
base["lat_bin"] = base["lat_bin"].round(1)
base["lon_bin"] = base["lon_bin"].round(1)
print(f"  merged climate frame: {len(base):,} rows, {list(base.columns)}")

print("\n=== Step 4: attach fire data ===")
fires["lat_bin"] = fires["lat_bin"].astype(float).round(1)
fires["lon_bin"] = fires["lon_bin"].astype(float).round(1)
merged = base.merge(
    fires[["week","lat_bin","lon_bin","fire_count","fire_power_MW",
           "max_power_MW","prior_lightning_count"]],
    on=["week","lat_bin","lon_bin"],
    how="left"
)
merged["fire_power_MW"]        = merged["fire_power_MW"].fillna(0)
merged["fire_count"]           = merged["fire_count"].fillna(0).astype(int)
merged["max_power_MW"]         = merged["max_power_MW"].fillna(0)
merged["prior_lightning_count"]= merged["prior_lightning_count"].fillna(0)

out1 = os.path.join(DATA_DIR, "climate_weekly_2024.csv")
merged.to_csv(out1, index=False)
print(f"  saved {out1} ({len(merged):,} rows)")

print("\n=== Step 5: assign cells to states ===")
with open(TOPO_JSON) as f:
    topo_raw = json.load(f)
states_gdf = tp.Topology(topo_raw, object_name="states").to_gdf()
states_gdf = states_gdf.set_crs("EPSG:4326", allow_override=True)
print(f"  {len(states_gdf)} states loaded")

# build cell → state map (use cell center + 0.25 offset)
unique_cells = merged[["lat_bin","lon_bin"]].drop_duplicates().copy()
unique_cells["geometry"] = [
    Point(row.lon_bin + 0.25, row.lat_bin + 0.25)
    for row in unique_cells.itertuples()
]
cells_gdf = gpd.GeoDataFrame(unique_cells, crs="EPSG:4326")
joined = gpd.sjoin(cells_gdf, states_gdf[["geometry","name"]],
                   how="left", predicate="within")
# drop duplicate cells (cells touching multiple states – keep first)
joined = joined.drop_duplicates(subset=["lat_bin","lon_bin"])
cell_state = dict(zip(
    zip(joined["lat_bin"], joined["lon_bin"]),
    joined["name"]
))
merged["state"] = [cell_state.get((r.lat_bin, r.lon_bin)) for r in merged.itertuples()]
n_assigned = merged["state"].notna().sum()
print(f"  {n_assigned:,} of {len(merged):,} cell-weeks assigned to a state")

print("\n=== Step 6: state-level summaries ===")
grp = merged.dropna(subset=["state"])
state_summary = grp.groupby("state").agg(
    total_fire_power_MW =("fire_power_MW",         "sum"),
    fire_count          =("fire_count",            "sum"),
    mean_vpd_kPa        =("vpd",                   "mean"),
    mean_tmax_F         =("tmmx",                  "mean"),
    total_precip_mm     =("pr",                    "sum"),
    mean_wind_ms        =("vs",                    "mean"),
    mean_rmin_pct       =("rmin",                  "mean"),
    mean_bi             =("bi",                    "mean"),
    mean_erc            =("erc",                   "mean"),
    mean_lightning      =("prior_lightning_count",  "mean"),
).reset_index().round(3)

out2 = os.path.join(DATA_DIR, "state_climate_2024.csv")
state_summary.to_csv(out2, index=False)
print(f"  saved {out2} ({len(state_summary)} states)")
print(state_summary[["state","total_fire_power_MW","mean_vpd_kPa","mean_tmax_F"]].to_string(index=False))

print("\n=== Step 7: correlation analysis ===")
fire_cells = merged[merged["fire_power_MW"] > 0].copy()
clim_vars = list(VARS.keys()) + ["prior_lightning_count"]
clim_labels = {**{v: VARS[v]["label"] for v in VARS},
               "prior_lightning_count": "Prior-Day Lightning Flashes"}

corr_records = []
for v in clim_vars:
    if v not in fire_cells.columns:
        continue
    sub = fire_cells[["fire_power_MW", v]].dropna()
    if len(sub) < 20:
        continue
    r = sub["fire_power_MW"].corr(sub[v])
    corr_records.append({
        "variable": v,
        "label":    clim_labels[v],
        "pearson_r": round(r, 4),
    })

corr_df = pd.DataFrame(corr_records).sort_values("pearson_r", ascending=False)
out3 = os.path.join(DATA_DIR, "correlations_2024.csv")
corr_df.to_csv(out3, index=False)
print(corr_df.to_string(index=False))
print(f"\n  saved {out3}")
print("\n=== All done! ===")
