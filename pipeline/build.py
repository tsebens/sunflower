"""Sunflower data pipeline.

Resamples raw source datasets onto one shared lat/lon grid and writes compact
gzipped binary layers + a catalog.json that the web app reads.

Usage:
    python pipeline/build.py            # expects raw files in data/raw (see download.sh)

Every output layer is a row-major array of `rows * cols` cells, north-to-south,
west-to-east, matching the grid definition in catalog.json.
  - numeric layers: int16, value = raw * scale + offset, NODATA = -32768
  - categorical layers: uint8, 0 = outside the region of interest
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import reproject
from scipy import ndimage
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "public" / "data"

# ---------------------------------------------------------------------------
# Grid: 5 arc-minutes (~9 km), aligned with WorldClim's 5m product.
# Covers North America + Europe. Widen the bounds to go global later.
# ---------------------------------------------------------------------------
RES = 1 / 12
WEST, EAST, SOUTH, NORTH = -180.0, 40.0, 14.0, 84.0
COLS = round((EAST - WEST) / RES)
ROWS = round((NORTH - SOUTH) / RES)
TRANSFORM = from_origin(WEST, NORTH, RES, RES)
CRS = "EPSG:4326"
NODATA = -32768
EARTH_RADIUS_KM = 6371.0

# Region of interest, by Natural Earth ADM0_A3 code.
NORTH_AMERICA = ["USA", "CAN", "MEX"]
EUROPE_EXCLUDE = {"RUS", "BLR"}

CITY_THRESHOLDS = [100_000, 300_000, 500_000, 1_000_000]


def cell_centers() -> tuple[np.ndarray, np.ndarray]:
    lons = WEST + (np.arange(COLS) + 0.5) * RES
    lats = NORTH - (np.arange(ROWS) + 0.5) * RES
    return np.meshgrid(lons, lats)


def to_unit_vectors(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    lon, lat = np.radians(lon), np.radians(lat)
    return np.column_stack(
        [np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)]
    )


def chord_to_km(chord: np.ndarray) -> np.ndarray:
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.clip(chord / 2, 0, 1))


def write_gz(name: str, arr: np.ndarray) -> str:
    fname = f"{name}.bin.gz"
    # mtime=0 keeps the output byte-identical when the data has not changed.
    with gzip.GzipFile(OUT / fname, "wb", compresslevel=9, mtime=0) as f:
        f.write(np.ascontiguousarray(arr).tobytes())
    return fname


def numeric_layer(
    layer_id: str, values: np.ndarray, mask: np.ndarray, scale: float, offset: float = 0.0
) -> dict:
    """Quantize float values (NaN = nodata) to int16 and write them."""
    v = np.where(mask, values, np.nan)
    q = np.full(v.shape, NODATA, dtype="<i2")
    ok = np.isfinite(v)
    q[ok] = np.clip(np.round((v[ok] - offset) / scale), -32767, 32767)
    fname = write_gz(layer_id, q)
    real = v[ok]
    print(f"  {layer_id:28s} {ok.sum():>8d} cells  [{real.min():.1f} .. {real.max():.1f}]")
    return {
        "file": fname,
        "scale": scale,
        "offset": offset,
        "min": float(np.floor(real.min())),
        "max": float(np.ceil(real.max())),
    }


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------


def build_countries() -> tuple[np.ndarray, list[dict]]:
    countries = gpd.read_file(f"zip://{RAW / 'ne_10m_admin_0_countries.zip'}")
    europe = countries[
        (countries.REGION_UN == "Europe") & ~countries.ADM0_A3.isin(EUROPE_EXCLUDE)
    ]
    na = countries[countries.ADM0_A3.isin(NORTH_AMERICA)]
    chosen = (
        [(r, "North America") for r in na.itertuples()]
        + [(r, "Europe") for r in europe.sort_values("NAME").itertuples()]
    )
    cats, shapes = [], []
    for i, (r, region) in enumerate(chosen, start=1):
        cats.append({"id": i, "code": r.ADM0_A3, "name": r.NAME, "group": region})
        shapes.append((r.geometry, i))
    grid = rasterize(shapes, out_shape=(ROWS, COLS), transform=TRANSFORM, fill=0, dtype="uint8")

    # Carve out large lakes (country polygons include e.g. the Great Lakes).
    lakes = gpd.read_file(f"zip://{RAW / 'ne_10m_lakes.zip'}")
    lake_mask = rasterize(
        ((g, 1) for g in lakes.geometry), out_shape=(ROWS, COLS), transform=TRANSFORM, fill=0, dtype="uint8"
    )
    grid[lake_mask == 1] = 0

    # Drop categories that ended up with zero cells (micro-states smaller than a cell).
    present = set(np.unique(grid)) - {0}
    cats = [c for c in cats if c["id"] in present]
    print(f"  country: {len(cats)} countries, {(grid > 0).sum()} cells")
    return grid, cats


def read_raster(path: str, resampling: Resampling = Resampling.average) -> np.ndarray:
    """Read band 1 of any georeferenced raster onto the grid (NaN = no data)."""
    dst = np.full((ROWS, COLS), np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            dst_transform=TRANSFORM,
            dst_crs=CRS,
            dst_nodata=np.nan,
            resampling=resampling,
        )
    return dst


def read_worldclim(var: int) -> np.ndarray:
    return read_raster(f"/vsizip/{RAW / 'wc2.1_5m_bio.zip'}/wc2.1_5m_bio_{var}.tif")


def nearest_points(pts_lon: np.ndarray, pts_lat: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For each masked cell: great-circle km to, and index of, the nearest point."""
    tree = cKDTree(to_unit_vectors(pts_lon, pts_lat))
    lon, lat = cell_centers()
    chord, idx = tree.query(to_unit_vectors(lon[mask], lat[mask]))
    return chord_to_km(chord), idx


def distance_to_points_km(pts_lon: np.ndarray, pts_lat: np.ndarray, mask: np.ndarray) -> np.ndarray:
    out = np.full((ROWS, COLS), np.nan, dtype="float32")
    out[mask], _ = nearest_points(pts_lon, pts_lat, mask)
    return out


def build_coast_distance(mask: np.ndarray) -> np.ndarray:
    coast = gpd.read_file(f"zip://{RAW / 'ne_10m_coastline.zip'}")
    # Densify so vertex spacing is well under a grid cell, then use vertices as points.
    dense = coast.geometry.segmentize(0.02)
    coords = np.vstack([np.asarray(g.coords) for g in dense.explode(index_parts=False)])
    return distance_to_points_km(coords[:, 0], coords[:, 1], mask)


def build_city_distances(mask: np.ndarray) -> dict[int, np.ndarray]:
    places = gpd.read_file(f"zip://{RAW / 'ne_10m_populated_places.zip'}")
    out = {}
    for t in CITY_THRESHOLDS:
        big = places[places.POP_MAX >= t]
        out[t] = distance_to_points_km(big.LONGITUDE.values, big.LATITUDE.values, mask)
    return out


def build_elevation() -> np.ndarray:
    return read_raster(f"/vsizip/{RAW / 'wc2.1_5m_elev.zip'}/wc2.1_5m_elev.tif")


def build_summer_dewpoint() -> np.ndarray:
    """Dew point (degC) from the average water vapour pressure of the 3 most humid months."""
    vapr = np.stack(
        [read_raster(f"/vsizip/{RAW / 'wc2.1_5m_vapr.zip'}/wc2.1_5m_vapr_{m:02d}.tif") for m in range(1, 13)]
    )  # kPa
    top3 = np.sort(vapr, axis=0)[-3:].mean(axis=0)  # NaNs sort last, so no-data stays NaN
    g = np.log(np.maximum(top3 * 10, 0.01) / 6.112)  # Magnus formula, vapour pressure in hPa
    return (243.04 * g / (17.625 - g)).astype("float32")


MONTH_DAYS = np.array([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])


def day_length_hours(lat_deg: np.ndarray, doy: float) -> np.ndarray:
    decl = np.radians(23.44) * np.sin(2 * np.pi * (284 + doy) / 365)
    cos_h = np.clip(-np.tan(np.radians(lat_deg)) * np.tan(decl), -1, 1)
    return 2 * np.degrees(np.arccos(cos_h)) / 15


def build_sunshine_hours(mask: np.ndarray) -> np.ndarray:
    """Yearly bright-sunshine hours from CRU CL2.0 monthly % of possible sunshine (10' points)."""
    import pandas as pd

    a = pd.read_csv(RAW / "grid_10min_sunp.dat.gz", sep=r"\s+", header=None).to_numpy()
    lat, lon, pct = a[:, 0], a[:, 1], a[:, 2:14]
    mid_doy = np.cumsum(MONTH_DAYS) - MONTH_DAYS / 2
    hours = sum(pct[:, m] / 100 * day_length_hours(lat, mid_doy[m]) * MONTH_DAYS[m] for m in range(12))
    dist, idx = nearest_points(lon, lat, mask)
    out = np.full((ROWS, COLS), np.nan, dtype="float32")
    out[mask] = np.where(dist < 25, hours[idx], np.nan)  # leave far-from-data cells empty
    return out


def cpc_extreme_min() -> np.ndarray:
    """Mean yearly lowest temperature (degC), 1991-2020, NOAA CPC 0.5 deg, on a -180..180 grid."""
    cache = RAW / "cpc_extreme_min_1991_2020.npy"
    if cache.exists():
        return np.load(cache)
    import netCDF4

    yearly = []
    for year in range(1991, 2021):
        with netCDF4.Dataset(RAW / "cpc" / f"tmin.{year}.nc") as ds:
            t = ds["tmin"][:]  # masked (day, lat 89.75..-89.75, lon 0.25..359.75)
            yearly.append(np.ma.filled(t.min(axis=0).astype("float32"), np.nan))
        print(f"    cpc {year}", end="\r")
    stack = np.stack(yearly)
    valid = np.isfinite(stack).sum(axis=0)
    with np.errstate(invalid="ignore"):
        emt = np.where(valid >= 25, np.nanmean(stack, axis=0), np.nan)
    emt = np.roll(emt, 360, axis=1).astype("float32")  # lon 0..360 -> -180..180
    np.save(cache, emt)
    return emt


def build_hardiness_zone() -> np.ndarray:
    """USDA plant hardiness zone as a continuous number (7.0 = start of 7a, 7.5 = 7b).

    Zones are defined by the average yearly lowest temperature. Daily data only exists
    at 0.5 deg (~50 km), too coarse for mountains, so it is downscaled: the gap between
    the yearly extreme and WorldClim's coldest-month average low (BIO6) varies smoothly,
    so we compute that gap at 0.5 deg, interpolate it, and add it to the 5' BIO6.
    """
    coarse = from_origin(-180, 90, 0.5, 0.5)
    emt = cpc_extreme_min()
    bio6_coarse = np.full((360, 720), np.nan, dtype="float32")
    with rasterio.open(f"/vsizip/{RAW / 'wc2.1_5m_bio.zip'}/wc2.1_5m_bio_6.tif") as src:
        reproject(rasterio.band(src, 1), bio6_coarse, dst_transform=coarse, dst_crs=CRS,
                  dst_nodata=np.nan, resampling=Resampling.average)
    gap = emt - bio6_coarse
    holes = ~np.isfinite(gap)
    nearest = ndimage.distance_transform_edt(holes, return_distances=False, return_indices=True)
    gap = gap[tuple(nearest)]  # fill sea/no-data with the nearest land value
    gap_fine = np.full((ROWS, COLS), np.nan, dtype="float32")
    reproject(gap, gap_fine, src_transform=coarse, src_crs=CRS, dst_transform=TRANSFORM,
              dst_crs=CRS, resampling=Resampling.bilinear)
    emt_f = (read_worldclim(6) + gap_fine) * 9 / 5 + 32
    return ((emt_f + 60) / 10 + 1).astype("float32")


def build_internet_speed() -> np.ndarray:
    """Typical fixed-broadband download speed (Mbps) per cell from Ookla speed-test tiles.

    Test-weighted geometric mean of the tile averages (robust to a few gigabit outliers).
    Cells with fewer than 10 tests are left empty.
    """
    import pyarrow.parquet as pq

    t = pq.read_table(RAW / "ookla_fixed_2026q3.parquet", columns=["tile_x", "tile_y", "avg_d_kbps", "tests"])
    x, y = t["tile_x"].to_numpy(), t["tile_y"].to_numpy()
    d, w = t["avg_d_kbps"].to_numpy(), t["tests"].to_numpy().astype("float64")
    col = np.floor((x - WEST) / RES).astype(int)
    row = np.floor((NORTH - y) / RES).astype(int)
    ok = (col >= 0) & (col < COLS) & (row >= 0) & (row < ROWS)
    cell = row[ok] * COLS + col[ok]
    lg = np.log(np.maximum(d[ok], 1) / 1000)
    n = ROWS * COLS
    sw = np.bincount(cell, w[ok], n)
    slg = np.bincount(cell, w[ok] * lg, n)
    out = np.full(n, np.nan, dtype="float32")
    good = sw >= 10
    out[good] = np.minimum(np.exp(slg[good] / sw[good]), 2000)
    return out.reshape(ROWS, COLS)


# ---------------------------------------------------------------------------


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    layers = []

    print("countries")
    country, cats = build_countries()
    mask = country > 0
    layers.append(
        {
            "id": "country",
            "name": "Country",
            "group": "Location",
            "type": "categorical",
            "file": write_gz("country", country),
            "categories": cats,
            "source": "Natural Earth 1:10m Admin 0 Countries",
        }
    )

    print("climate (WorldClim 2.1, 1970-2000 normals)")
    climate = [
        (1, "temp_mean", "Average temperature", "Yearly average air temperature.", "temperature"),
        (5, "temp_max", "Summer highs", "Average daily high in the warmest month.", "temperature"),
        (6, "temp_min", "Winter lows", "Average nightly low in the coldest month.", "temperature"),
    ]
    for var, lid, name, desc, cmap in climate:
        layers.append(
            {
                "id": lid, "name": name, "description": desc, "group": "Climate",
                "type": "numeric", "unit": "degC", "colormap": cmap,
                "source": f"WorldClim 2.1 BIO{var}",
                **numeric_layer(lid, read_worldclim(var), mask, scale=0.1),
            }
        )
    layers.append(
        {
            "id": "precip_annual", "name": "Yearly rain & snow",
            "description": "Total yearly precipitation (rain plus snow, as water).",
            "group": "Climate", "type": "numeric", "unit": "mm", "colormap": "precipitation",
            "source": "WorldClim 2.1 BIO12",
            **numeric_layer("precip_annual", read_worldclim(12), mask, scale=1),
        }
    )

    layers.append(
        {
            "id": "dewpoint_summer", "name": "Summer mugginess",
            "description": "Dew point in the 3 most humid months. Under ~55 °F (13 °C) feels comfortable; over ~65 °F (18 °C) feels muggy.",
            "group": "Climate", "type": "numeric", "unit": "degC", "colormap": "humidity",
            "source": "WorldClim 2.1 water vapour pressure",
            **numeric_layer("dewpoint_summer", build_summer_dewpoint(), mask, scale=0.1),
        }
    )
    layers.append(
        {
            "id": "sunshine_hours", "name": "Sunshine",
            "description": "Hours of bright sunshine per year (1961–1990 averages, ~18 km detail).",
            "group": "Climate", "type": "numeric", "unit": "hours", "colormap": "sunshine",
            "source": "CRU CL 2.0 sunshine",
            **numeric_layer("sunshine_hours", build_sunshine_hours(mask), mask, scale=1),
        }
    )
    print("  hardiness zones (reads 30 years of daily data the first time)")
    layers.append(
        {
            "id": "hardiness_zone", "name": "Growing zone",
            "description": "USDA plant hardiness zone, from the average coldest night of the year (1991–2020). Estimated, not the official USDA map.",
            "group": "Climate", "type": "numeric", "unit": "zone", "colormap": "zones",
            "source": "NOAA CPC daily temperature + WorldClim 2.1 (downscaled)",
            **numeric_layer("hardiness_zone", build_hardiness_zone(), mask, scale=0.01),
        }
    )

    print("geography")
    layers.append(
        {
            "id": "elevation", "name": "Elevation",
            "description": "Average height above sea level.",
            "group": "Geography", "type": "numeric", "unit": "m", "colormap": "elevation",
            "source": "WorldClim 2.1 elevation (SRTM)",
            **numeric_layer("elevation", build_elevation(), mask, scale=1),
        }
    )
    layers.append(
        {
            "id": "dist_coast", "name": "Distance to the ocean",
            "description": "Straight-line distance to the nearest ocean coastline.",
            "group": "Geography", "type": "numeric", "unit": "km", "colormap": "distance",
            "source": "Natural Earth 1:10m Coastline",
            **numeric_layer("dist_coast", build_coast_distance(mask), mask, scale=1),
        }
    )

    city = build_city_distances(mask)
    variants = []
    for t in CITY_THRESHOLDS:
        label = f"{t // 1_000_000}M+" if t >= 1_000_000 else f"{t // 1000}k+"
        variants.append(
            {"key": str(t), "label": label, **numeric_layer(f"dist_city_{t}", city[t], mask, scale=1)}
        )
    # Shared slider range across variants so switching keeps the bounds sensible.
    layers.append(
        {
            "id": "dist_city", "name": "Distance to a major city",
            "description": "Straight-line distance to the nearest city whose metro population is at least the chosen size.",
            "group": "Geography", "type": "numeric", "unit": "km", "colormap": "distance",
            "source": "Natural Earth 1:10m Populated Places (POP_MAX)",
            "variantLabel": "City size",
            "variants": variants,
            "min": min(v["min"] for v in variants),
            "max": max(v["max"] for v in variants),
        }
    )

    print("services")
    layers.append(
        {
            "id": "internet_down", "name": "Home internet speed",
            "description": "Typical fixed-broadband download speed from Ookla speed tests (Jul–Sep 2026). Blank where too few tests were run, so rural areas often have no data.",
            "group": "Services", "type": "numeric", "unit": "Mbps", "colormap": "speed",
            "source": "Ookla Open Data (fixed broadband)",
            **numeric_layer("internet_down", build_internet_speed(), mask, scale=1),
        }
    )

    catalog = {
        "grid": {"west": WEST, "east": EAST, "south": SOUTH, "north": NORTH,
                 "res": RES, "cols": COLS, "rows": ROWS, "nodata": NODATA},
        "layers": layers,
    }
    (OUT / "catalog.json").write_text(json.dumps(catalog, indent=1))
    total = sum(p.stat().st_size for p in OUT.glob("*.gz"))
    print(f"wrote {OUT} ({total / 1e6:.1f} MB of layers)")


if __name__ == "__main__":
    main()
