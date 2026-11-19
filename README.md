# 🌻 Sunflower

A small map dashboard for answering "where could we live?". Set hard filters on
climate, geography and services (temperature, winter lows, rainfall, humidity,
sunshine, growing zone, elevation, distance to the ocean or a big city, internet
speed, country…), and the map shows which places pass, coloured by any variable
you choose.

![Sunflower screenshot](docs/screenshot.png)

Currently covers the **US, Canada, Mexico and Europe** on a ~9 km grid.

## How it works

```
raw datasets ──► pipeline/build.py ──► web/public/data/*.bin.gz + catalog.json ──► web app (static)
 (WorldClim,      resample everything      one compact array per layer,             filters + colours
  Natural Earth)  onto ONE shared grid     all cells aligned                         in the browser
```

* **One grid for everything.** Every layer is resampled to the same 5-arc-minute
  lat/lon grid (≈9 km cells, aligned with WorldClim). A layer is then just an
  array with one value per cell, so filtering is a fast loop over a few arrays
  and adding a layer never touches the app's core logic.
* **Filters** are ranges: a cell matches if it passes every filter that's set.
  A filter left at its full range ("Any") does nothing.
* **Histograms** on each slider show how values are spread. The pale bars cover the
  whole region. The coloured bars count only places that pass *all the other*
  filters, so you can see what loosening this one would gain.
* **"Distance to a major city"** is computed four times, for cities of 100k, 300k,
  500k and 1M+ people. The buttons on that filter switch between them instantly.
* **Missing values** (e.g. internet speed where few speed tests were run) fail an
  active filter for that layer. When colouring by such a layer, matching cells
  with no value are drawn in faint gold.
* **No server.** The app is static files, about 7 MB of data in total, so it runs from
  `npm run dev` locally or from GitHub Pages.

## Using the map

* **Map display** (sidebar): choose what colours the map, set the overlay opacity, and
  switch individual reference layers on or off: terrain shading, state/province
  borders, county borders (these appear once you zoom in to roughly metro level),
  roads, and cities & towns.
* **Click** anywhere to see all values for that spot. If the spot doesn't match,
  the values that break your filters are shown in red.
* **Towns.** Click a town to see its card: population and growth,
  cost of living, economy, people, nearest airport, the climate there, and a short
  Wikipedia summary. From zoom 8 on, town labels also show population, growth since
  2010 and typical home value. Use **📌** to pin a card: pinned cards stay at every
  zoom and are saved with saved views and in the URL. **Towns: minimum population**
  (default 2,000) hides smaller places; smaller towns also only appear as you zoom in.
  Detailed statistics are US-only for now; elsewhere cards show population, airport,
  climate and Wikipedia, and missing values show as *n/a*.
* **3D terrain** (Map display): tilts the map and raises the terrain, with an
  exaggeration slider. Right-drag (or Ctrl-drag, or two fingers) to tilt and rotate.
  Off by default because it is heavier on the graphics card.
* **Saved views** (sidebar): name and save the current filters and display
  settings, then switch between them with one click. Views are stored in your
  browser (`localStorage`), so they are per-browser and per-address, e.g.
  `localhost:8080` and the GitHub Pages site keep separate lists. Use **Export** /
  **Import** to move them between browsers or as a backup.
* **The address bar always holds the current view**, so reloading keeps your
  filters and a copied link reopens the same view.

The basemap is built from [OpenFreeMap](https://openfreemap.org) vector tiles
(OpenStreetMap data) and [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
for the hillshade. Both are free and need no API key. The style is defined in
`web/src/basemap.ts`.

## Running locally with Docker

Only Docker is needed:

```bash
docker compose up --build -d     # then open http://localhost:8080
```

This builds the site in a Node container and serves it with nginx. Stop it with
`docker compose down`. To use a different port, change `8080:80` in `compose.yaml`.

The processed data is committed in `web/public/data/` and baked into the image,
so the data pipeline is only needed when adding or changing layers.

### Rebuilding the data with Docker

```bash
docker compose run --rm pipeline   # downloads ~3 GB into data/raw the first time
docker compose up --build -d       # bake the new data into the app
```

## Running without Docker

```bash
cd web
npm install
npm run dev        # open the printed URL
```

Rebuilding the data:

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
pipeline/download.sh             # ~3 GB into data/raw (git-ignored)
.venv/bin/python pipeline/build.py   # map layers
.venv/bin/python pipeline/towns.py   # towns and their statistics
```

To add a layer: get its source onto the grid in `build.py` (`read_worldclim`
shows how for any raster; `distance_to_points_km` shows how for point data),
then pass it through `numeric_layer(...)` and add an entry to `layers`. The app
picks it up from `catalog.json` automatically.

To change the region, edit `WEST/EAST/SOUTH/NORTH` and the country lists at the
top of `build.py`.

## Publishing on GitHub Pages

GitHub Pages hosts static sites straight from a repo, which suits this app. The
workflow in `.github/workflows/pages.yml` builds the app and publishes it on every
push to `main`.

One-time setup:

1. Merge this work into `main`.
2. In the repo on GitHub go to **Settings → Pages → Build and deployment** and set
   **Source** to **GitHub Actions**.
3. Push (or run the workflow by hand from the **Actions** tab). The site appears at
   `https://<your-user>.github.io/sunflower/`.

Notes: Pages on a **private** repo needs a paid GitHub plan; on a public repo
it's free. The site is public even if you never share the link. The data is
derived from open datasets, so that's harmless here.

## Data sources

| Layer | Source | Notes |
|---|---|---|
| Country | [Natural Earth](https://www.naturalearthdata.com/) 1:10m Admin 0 | Large lakes removed |
| Average temperature, Summer highs, Winter lows, Yearly rain & snow | [WorldClim 2.1](https://www.worldclim.org/data/worldclim21.html) BIO1/5/6/12, 5′ | 1970–2000 averages |
| Summer mugginess | WorldClim 2.1 monthly water vapour pressure | Dew point of the 3 most humid months (Magnus formula) |
| Sunshine | [CRU CL 2.0](https://crudata.uea.ac.uk/cru/data/hrg/tmc/) monthly sunshine % | Converted to hours using day length. 1961–90 averages, ~18 km |
| Growing zone | [NOAA CPC](https://psl.noaa.gov/data/gridded/data.cpc.globaltemp.html) daily lows 1991–2020 + WorldClim BIO6 | Estimate of the USDA zone, see below |
| Elevation | WorldClim 2.1 elevation (from SRTM) | Average over the cell |
| Distance to the ocean | Natural Earth 1:10m coastline | Straight-line (great-circle) distance |
| Distance to a major city | Natural Earth 1:10m populated places (`POP_MAX`, ≈ metro population) | Straight-line distance. Natural Earth misses some smaller cities, so the 100k+ option is the least complete. |

| Home internet speed | [Ookla Open Data](https://github.com/teamookla/ookla-open-data) fixed broadband, Q3 2026 | Test-weighted geometric mean download speed; cells with fewer than 10 tests are left empty |

### Towns

| Data | Source | Notes |
|---|---|---|
| US towns and statistics | US Census Bureau, [American Community Survey](https://www.census.gov/programs-surveys/acs) 2020–2024 5-year estimates (bulk table files), 2024 and 2010 Gazetteer files | Every Census place (cities, towns, CDPs) with 1,000+ people. Small places have wide margins of error |
| Home values | [Zillow Home Value Index](https://www.zillow.com/research/data/) (city level) | Typical home value and 5-year change; matched by name and state |
| Towns outside the US | [GeoNames](https://www.geonames.org/) cities1000 | Population only |
| Nearest airport | [OurAirports](https://ourairports.com/data/) | Large and medium airports with scheduled service |
| Summaries | Wikipedia (fetched live by your browser when a card opens) | Matched by name among articles within 10 km |

"Economy" comparisons on the cards are coloured green/red against the US figure
where one direction is clearly healthier (income, growth, unemployment, poverty,
price-to-income); other figures are shown for comparison without colour.

**About the growing-zone estimate.** USDA zones are defined by the average
coldest night of the year. A daily dataset covering every region (NOAA CPC) only
exists at ~50 km, too coarse for mountains and coasts. So the pipeline works out
how much colder the coldest night is than WorldClim's average coldest-month low,
does that at 50 km, and adds the difference to the ~9 km WorldClim value. Checked
against the official USDA 2023 map for 12 US cities: 7 match exactly, and the
other 5 are half a zone off, mostly on the cold side.

See [ROADMAP.md](ROADMAP.md) for planned layers.
