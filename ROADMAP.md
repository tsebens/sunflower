# Roadmap

Candidate layers and where their data might come from. The sources below are
leads, not verified picks: check each one's coverage, resolution and licence
before building it.

Preference order for any layer: **one consistent dataset covering every region**,
then per-region datasets stitched together. Stitched layers can't be compared
fairly across borders, so mark them clearly in the UI.

## Done

Humidity (summer dew point), sunshine hours, growing zone, elevation and home
internet speed. See the README for sources.

## Easy next steps (global, gridded, free)

- **Air quality.** Washington University (ACAG) satellite-derived yearly PM2.5,
  global, ~1 km. Downloads are behind a Box/Globus page, so they may have to be
  fetched by hand.
- **Mobile coverage/speed.** Ookla publishes mobile tiles alongside fixed ones.
- **Snow.** Days with snow on the ground (e.g. MODIS snow cover) as a separate
  filter from temperature.
- **Better sunshine data.** EarthEnv MODIS cloud frequency (1 km) would sharpen the
  18 km CRU sunshine layer.

## Natural hazards

- **Wildfire.** A consistent option across all regions is MODIS burned-area
  frequency (MCD64A1). For better detail per region: US = USFS *Wildfire Risk to
  Communities*, Canada = NRCan burn probability, Europe = JRC EFFIS.
- **Flood.** JRC global river flood hazard maps (100-year flood depth, global). US =
  FEMA flood maps.
- Later: earthquakes (GEM global hazard map), hurricanes and tornadoes (NOAA).

## Money (per-region data, coarser)

- **Cost of living.** US: BEA Regional Price Parities (states and metro areas) or
  the MIT Living Wage calculator (counties). Europe: Eurostat price level indices
  (by country). Canada/Mexico: national statistics, likely by province or state.
  No free worldwide fine-grained source is known; Numbeo has licensing limits.
- **Electricity price.** US: EIA average residential price (by state, or by
  utility via Form 861). Canada: by province. Europe: Eurostat household
  electricity prices (`nrg_pc_204`, by country).
- **Home prices + 5-year growth.** US: Zillow Home Value Index by county (monthly,
  so both the current level and the 5-year change are easy). Canada: CREA home
  price index by region. Europe: Eurostat's index only tracks *changes*, not price
  levels, so levels need national sources.

These come as polygons (county / province / country), not grids. The pipeline
will need a "rasterize polygons + attribute table" helper, much like the existing
country layer.

## Ambitious / later

- **Local sun shading from terrain.** Hours of direct sun per cell, from sun
  position and horizon angles computed on a fine elevation model (e.g. 90 m) and
  then averaged up to the grid. This is the Juneau problem. Worth doing once the
  basics are in place.
- **Go global.** Widen the grid bounds in `build.py`. The climate layers are already
  global, but the file sizes grow, so loading only the region in view may become
  worthwhile.
- **Soft preferences / scoring.** Beyond hard cut-offs: give each preference a
  weight and colour the map by how well each place fits overall.
- **County borders at every zoom.** The basemap tiles only include counties
  from about zoom 9. Showing them earlier would need our own simplified boundary
  file (US Census counties, Statistics Canada census divisions, Eurostat NUTS 3).
- **Saved views shared between devices.** Views currently live in each browser.
  A small backend (or a JSON file in the repo) could sync them.
- **Drive time** to cities instead of straight-line distance (needs a road
  network; heavy).
- **Fresher climate data.** WorldClim covers 1970–2000; CHELSA or TerraClimate
  offer more recent averages and future projections.
