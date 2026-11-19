"""Build the towns layer: points with stats for the town cards.

US: every Census place (city, town, CDP...) with at least MIN_POP people, with
American Community Survey 2020-2024 5-year estimates, 2010 Census population,
and Zillow home values. Canada, Mexico and Europe: GeoNames towns (population
only for now). Everyone: distance to the nearest airport with scheduled flights.

Usage (after build.py, which writes the country grid this script reads):
    python pipeline/towns.py

Output: web/public/data/towns.json.gz, column-oriented:
    {"national": {...US comparison values...},
     "columns": {"id": [...], "name": [...], ...}}   # null = no data
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "public" / "data"
MIN_POP = 1000
EARTH_RADIUS_KM = 6371.0

# ACS table -> the estimate columns we need (E = estimate).
ACS_COLUMNS = {
    "b01003": ["E001"],  # total population
    "b01002": ["E001"],  # median age
    "b19013": ["E001"],  # median household income
    "b25077": ["E001"],  # median home value (owner-occupied)
    "b25064": ["E001"],  # median gross rent
    "b23025": ["E003", "E005"],  # civilian labour force, unemployed
    "b17001": ["E001", "E002"],  # poverty universe, below poverty
    "b15003": ["E001", "E022", "E023", "E024", "E025"],  # age 25+, bachelor's .. doctorate
    "b25003": ["E001", "E002"],  # occupied homes, owner-occupied
    "b08301": ["E001", "E021"],  # workers, worked from home
}


def unit_vectors(lon, lat) -> np.ndarray:
    lon, lat = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def chord_km(chord: np.ndarray) -> np.ndarray:
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.clip(chord / 2, 0, 1))


def read_acs() -> pd.DataFrame:
    """US-level and place-level rows of all needed ACS estimates, indexed by GEO_ID."""
    frames = []
    for table, cols in ACS_COLUMNS.items():
        names = [f"{table.upper()}_{c}" for c in cols]
        df = pd.read_csv(RAW / "acs" / f"{table}.dat", sep="|", usecols=["GEO_ID", *names], dtype={"GEO_ID": str})
        df = df[(df.GEO_ID == "0100000US") | df.GEO_ID.str.startswith("1600000US")].set_index("GEO_ID")
        # Census uses large negative sentinels (e.g. -666666666) for "not available".
        frames.append(df.where(df >= 0))
    return pd.concat(frames, axis=1)


def derive(acs: pd.DataFrame) -> pd.DataFrame:
    def ratio(num, den):
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(acs[den] > 0, 100 * acs[num] / acs[den], np.nan)

    bach = acs[["B15003_E022", "B15003_E023", "B15003_E024", "B15003_E025"]].sum(axis=1, min_count=1)
    return pd.DataFrame(
        {
            "pop": acs.B01003_E001,
            "age": acs.B01002_E001,
            "income": acs.B19013_E001,
            "homeValue": acs.B25077_E001,
            "rent": acs.B25064_E001,
            "unemployment": ratio("B23025_E005", "B23025_E003"),
            "poverty": ratio("B17001_E002", "B17001_E001"),
            "bachelors": np.where(acs.B15003_E001 > 0, 100 * bach / acs.B15003_E001, np.nan),
            "owners": ratio("B25003_E002", "B25003_E001"),
            "wfh": ratio("B08301_E021", "B08301_E001"),
        },
        index=acs.index,
    )


def read_gazetteer(zip_name: str, cols: list[str]) -> pd.DataFrame:
    with zipfile.ZipFile(RAW / zip_name) as z:
        data = z.read(z.namelist()[0])
    try:
        raw = data.decode("utf-8")
    except UnicodeDecodeError:  # the 2010 file is Latin-1
        raw = data.decode("latin-1")
    df = pd.read_csv(io.StringIO(raw), sep="\t", dtype={"GEOID": str})
    df.columns = [c.strip() for c in df.columns]
    return df[cols]


def short_name(census_name: str) -> str:
    """'Juneau city and borough' -> 'Juneau'; 'Lake in the Hills village' -> 'Lake in the Hills'."""
    words = census_name.replace("(balance)", "").split()
    while len(words) > 1 and (words[-1].islower() or words[-1] in {"CDP", "-"}):
        words.pop()
    return " ".join(words)


def name_variants(name: str) -> list[str]:
    """Lower-case spellings to try when matching Census names to other sources, best first.

    'Nashville-Davidson' -> nashville-davidson, nashville; 'St. Louis' -> st. louis, saint louis;
    'Boise City' -> boise city, boise; 'San Buenaventura (Ventura)' -> ..., ventura.
    """
    out: list[str] = []

    def add(v: str) -> None:
        v = " ".join(v.lower().split())
        for w in (v, v.replace("st. ", "saint ").replace("ste. ", "sainte ")):
            if w and w not in out:
                out.append(w)

    add(name)
    if "(" in name:
        add(name.split("(")[0])
        add(name.split("(")[1].rstrip(")"))
    for sep in ("-", "/"):
        if sep in name:
            add(name.split(sep)[0])
    if name.startswith("Urban "):
        add(name[6:])
    if name.endswith(" City"):
        add(name[:-5])
    return out


def match_first(names: pd.Series, states: pd.Series, lookup: set[str]) -> list[str | None]:
    keys = []
    for n, st in zip(names, states):
        keys.append(next((f"{v}|{st}" for v in name_variants(n) if f"{v}|{st}" in lookup), None))
    return keys


def zillow_values() -> pd.DataFrame:
    """Current typical home value and 5-year % change, per (city name, state)."""
    z = pd.read_csv(RAW / "zillow_city_zhvi.csv")
    months = [c for c in z.columns if c[:2] in ("19", "20")]
    latest, five_ago = months[-1], months[-61]
    out = pd.DataFrame(
        {
            "key": z.RegionName.map(lambda n: name_variants(n)[-1] if n.lower().startswith("st") else n.lower()) + "|" + z.State,
            "zhvi": z[latest],
            "zhvi5y": 100 * (z[latest] / z[five_ago] - 1),
        }
    )
    print(f"  zillow: {len(out)} cities, latest month {latest}")
    return out.drop_duplicates("key").set_index("key")


def snap_to_town_centres(towns: pd.DataFrame) -> pd.DataFrame:
    """Census points are area centres, which for huge consolidated cities (Juneau, Anchorage,
    Jacksonville) land far from town. Use the GeoNames town centre when names match nearby."""
    cols = ["gid", "name", "ascii", "alt", "lat", "lon", "fclass", "fcode", "cc", "cc2",
            "a1", "a2", "a3", "a4", "pop", "elev", "dem", "tz", "mod"]
    with zipfile.ZipFile(RAW / "geonames_cities1000.zip") as zf:
        gn = pd.read_csv(zf.open("cities1000.txt"), sep="\t", names=cols, quoting=csv.QUOTE_NONE,
                         dtype=str, keep_default_na=False)
    gn = gn[(gn.cc == "US") & (gn.fclass == "P")]
    centres: dict[str, tuple[float, float]] = {}
    for n, st, la, lo in zip(gn.ascii, gn.a1, gn.lat.astype(float), gn.lon.astype(float)):
        for v in name_variants(n):
            centres.setdefault(f"{v}|{st}", (la, lo))
    keys = match_first(towns.name, towns.USPS, set(centres))
    lat, lon = towns.INTPTLAT.to_numpy(float).copy(), towns.INTPTLONG.to_numpy(float).copy()
    moved = 0
    for i, k in enumerate(keys):
        if k is None:
            continue
        la, lo = centres[k]
        d = chord_km(np.linalg.norm(unit_vectors([lon[i]], [lat[i]]) - unit_vectors([lo], [la]), axis=1))[0]
        if 0.5 < d < 60:
            lat[i], lon[i] = la, lo
            moved += 1
    print(f"  us: moved {moved} places from area centre to town centre")
    return towns.assign(INTPTLAT=lat, INTPTLONG=lon)


def us_towns() -> tuple[pd.DataFrame, dict]:
    acs = read_acs()
    stats = derive(acs)
    national = stats.loc["0100000US"].to_dict()
    places = stats.drop(index="0100000US")
    places = places[places["pop"] >= MIN_POP].copy()
    places["GEOID"] = places.index.str.replace("1600000US", "", regex=False)

    gaz = read_gazetteer("gaz_place_2024.zip", ["USPS", "GEOID", "NAME", "INTPTLAT", "INTPTLONG"])
    towns = places.merge(gaz, on="GEOID", how="inner")
    pop10 = read_gazetteer("gaz_place_2010.zip", ["GEOID", "POP10"])
    towns = towns.merge(pop10, on="GEOID", how="left")
    with np.errstate(divide="ignore", invalid="ignore"):
        towns["growth"] = np.where(towns.POP10 > 0, 100 * (towns["pop"] / towns.POP10 - 1), np.nan)
    national["growth"] = 100 * (national["pop"] / 308_745_538 - 1)  # 2010 Census US total

    towns = towns[towns.USPS != "PR"]  # Puerto Rico is outside the mapped region
    towns["name"] = towns.NAME.map(short_name)
    towns = snap_to_town_centres(towns)
    z = zillow_values()
    keys = pd.Series(match_first(towns.name, towns.USPS, set(z.index)), index=towns.index)
    # Only the most populous place of each (name, state) gets the Zillow match.
    towns = towns.assign(_key=keys).sort_values("pop", ascending=False)
    first = ~towns._key.duplicated()
    towns["zhvi"] = np.where(first, towns._key.map(z.zhvi), np.nan)
    towns["zhvi5y"] = np.where(first, towns._key.map(z.zhvi5y), np.nan)
    national["zhvi5y"] = float(np.nanmedian(towns.zhvi5y))
    matched = towns.zhvi.notna().sum()
    print(f"  us: {len(towns)} places with {MIN_POP}+ people, {matched} matched to Zillow")

    towns = towns.rename(columns={"INTPTLAT": "lat", "INTPTLONG": "lon", "USPS": "region"})
    towns["id"] = "us" + towns.GEOID
    towns["country"] = "US"
    return towns, national


def other_towns() -> pd.DataFrame:
    """GeoNames towns inside the app's region (outside the US), using the app's own country grid."""
    cat = json.loads((OUT / "catalog.json").read_text())
    g = cat["grid"]
    country_layer = next(l for l in cat["layers"] if l["id"] == "country")
    grid = np.frombuffer(gzip.open(OUT / country_layer["file"]).read(), dtype=np.uint8).reshape(g["rows"], g["cols"])
    us_id = next(c["id"] for c in country_layer["categories"] if c["code"] == "USA")

    cols = ["gid", "name", "ascii", "alt", "lat", "lon", "fclass", "fcode", "cc", "cc2",
            "a1", "a2", "a3", "a4", "pop", "elev", "dem", "tz", "mod"]
    with zipfile.ZipFile(RAW / "geonames_cities1000.zip") as zf:
        gn = pd.read_csv(zf.open("cities1000.txt"), sep="\t", names=cols, quoting=csv.QUOTE_NONE,
                         dtype={"a1": str, "cc": str, "a4": str}, keep_default_na=False, na_values=[""])
    gn = gn[(gn.fclass == "P") & ~gn.fcode.isin(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]) & (gn["pop"] >= MIN_POP)]
    col = np.floor((gn.lon - g["west"]) / g["res"]).astype(int)
    row = np.floor((g["north"] - gn.lat) / g["res"]).astype(int)
    ok = (col >= 0) & (col < g["cols"]) & (row >= 0) & (row < g["rows"])
    gn, col, row = gn[ok], col[ok], row[ok]
    cid = grid[row.to_numpy(), col.to_numpy()]
    gn = gn[(cid > 0) & (cid != us_id) & (gn.cc != "US")].copy()

    a1 = pd.read_csv(RAW / "geonames_admin1.txt", sep="\t", names=["code", "name", "ascii", "gid"],
                     quoting=csv.QUOTE_NONE, keep_default_na=False)
    a1_names = dict(zip(a1.code, a1.name))
    gn["region"] = (gn.cc + "." + gn.a1.fillna("")).map(a1_names)
    gn["id"] = "gn" + gn.gid.astype(str)
    gn["country"] = gn.cc
    print(f"  other: {len(gn)} GeoNames towns in Canada, Mexico and Europe")
    return gn[["id", "name", "region", "country", "lat", "lon", "pop"]]


def add_airports(towns: pd.DataFrame) -> pd.DataFrame:
    ap = pd.read_csv(RAW / "ourairports.csv", usecols=["type", "name", "latitude_deg", "longitude_deg",
                                                      "scheduled_service", "iata_code"], keep_default_na=False)
    ap = ap[ap.type.isin(["large_airport", "medium_airport"]) & (ap.scheduled_service == "yes")].reset_index(drop=True)
    tree = cKDTree(unit_vectors(ap.longitude_deg, ap.latitude_deg))
    chord, idx = tree.query(unit_vectors(towns.lon, towns.lat))
    towns["airportKm"] = chord_km(chord)
    near = ap.iloc[idx]
    towns["airport"] = np.where(near.iata_code.to_numpy() != "", near.iata_code.to_numpy(), near.name.to_numpy())
    print(f"  airports: {len(ap)} with scheduled service")
    return towns


def main() -> None:
    print("towns")
    us, national = us_towns()
    towns = pd.concat([us, other_towns()], ignore_index=True)
    towns = add_airports(towns).sort_values("pop", ascending=False)

    rounding = {
        "lat": 4, "lon": 4, "pop": 0, "growth": 1, "age": 1, "income": 0, "homeValue": 0, "rent": 0,
        "unemployment": 1, "poverty": 1, "bachelors": 1, "owners": 1, "wfh": 1, "zhvi": -3, "zhvi5y": 1,
        "airportKm": 0,
    }
    columns: dict[str, list] = {}
    for c in ["id", "name", "region", "country", "airport"]:
        columns[c] = [None if pd.isna(v) else str(v) for v in towns[c]]
    for c, d in rounding.items():
        vals = pd.to_numeric(towns[c], errors="coerce").round(d)
        columns[c] = [None if pd.isna(v) else (int(v) if d <= 0 else float(v)) for v in vals]

    nat = {k: round(float(v), 1) for k, v in national.items() if k in rounding and pd.notna(v)}
    payload = {"national": nat, "count": len(towns), "columns": columns}
    with gzip.GzipFile(OUT / "towns.json.gz", "wb", compresslevel=9, mtime=0) as f:
        f.write(json.dumps(payload, separators=(",", ":")).encode())
    size = (OUT / "towns.json.gz").stat().st_size
    print(f"wrote towns.json.gz: {len(towns)} towns, {size / 1e6:.1f} MB")
    print("  US national:", nat)


if __name__ == "__main__":
    main()
