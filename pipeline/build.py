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
    with gzip.open(OUT / fname, "wb", compresslevel=9) as f:
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


def read_worldclim(var: int) -> np.ndarray:
    path = f"/vsizip/{RAW / 'wc2.1_5m_bio.zip'}/wc2.1_5m_bio_{var}.tif"
    dst = np.full((ROWS, COLS), np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            dst_transform=TRANSFORM,
            dst_crs=CRS,
            dst_nodata=np.nan,
            resampling=Resampling.average,
        )
    return dst


def distance_to_points_km(pts_lon: np.ndarray, pts_lat: np.ndarray, mask: np.ndarray) -> np.ndarray:
    tree = cKDTree(to_unit_vectors(pts_lon, pts_lat))
    lon, lat = cell_centers()
    out = np.full((ROWS, COLS), np.nan, dtype="float32")
    chord, _ = tree.query(to_unit_vectors(lon[mask], lat[mask]))
    out[mask] = chord_to_km(chord)
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

    print("geography")
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
