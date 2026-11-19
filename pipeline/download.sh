#!/usr/bin/env bash
# Fetch the raw source datasets into data/raw (about 10 GB, mostly daily temperatures
# for growing zones; data/raw/cpc can be deleted once build.py has cached its result).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw/cpc && cd data/raw

get() {  # get URL [output-path]
  local out=${2:-$(basename "$1")}
  if [[ -f "$out" ]]; then echo "have $out"; else echo "get  $out"; curl -fL --retry 3 -o "$out.part" "$1" && mv "$out.part" "$out"; fi
}

WC=https://geodata.ucdavis.edu/climate/worldclim/2_1/base
NE=https://naciscdn.org/naturalearth/10m
get $WC/wc2.1_5m_bio.zip
get $WC/wc2.1_5m_vapr.zip
get $WC/wc2.1_5m_elev.zip
get $NE/cultural/ne_10m_admin_0_countries.zip
get $NE/cultural/ne_10m_populated_places.zip
get $NE/physical/ne_10m_coastline.zip
get $NE/physical/ne_10m_lakes.zip
# CRU CL 2.0 monthly sunshine percentage (1961-90 normals, 10').
get https://crudata.uea.ac.uk/cru/data/hrg/tmc/grid_10min_sunp.dat.gz
# Ookla Open Data: fixed broadband speed tiles for one quarter.
get "https://ookla-open-data.s3.amazonaws.com/parquet/performance/type=fixed/year=2026/quarter=3/2026-07-01_performance_fixed_tiles.parquet" ookla_fixed_2026q3.parquet
# Landscape: RESOLVE Ecoregions 2017, ~1 km elevation (ruggedness), Copernicus tree cover
# (100 m, 5.6 GB; once build.py has run it can be deleted).
get https://storage.googleapis.com/teow2016/Ecoregions2017.zip ecoregions2017.zip
get https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_30s_elev.zip
get "https://zenodo.org/api/records/3939050/files/PROBAV_LC100_global_v3.0.1_2019-nrt_Tree-CoverFraction-layer_EPSG-4326.tif/content" copernicus_tree_cover_2019.tif
# Towns: US Census places (ACS 2020-24 5-year tables, gazetteers), Zillow home values,
# GeoNames towns, OurAirports.
ACS=https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData
mkdir -p acs
for t in b01002 b01003 b19013 b25077 b25064 b23025 b17001 b15003 b25003 b08301; do
  get "$ACS/acsdt5y2024-$t.dat" "acs/$t.dat"
done
get https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip gaz_place_2024.zip
get https://www2.census.gov/geo/docs/maps-data/data/gazetteer/Gaz_places_national.zip gaz_place_2010.zip
get https://files.zillowstatic.com/research/public_csvs/zhvi/City_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv zillow_city_zhvi.csv
get https://download.geonames.org/export/dump/cities1000.zip geonames_cities1000.zip
get https://download.geonames.org/export/dump/admin1CodesASCII.txt geonames_admin1.txt
get https://davidmegginson.github.io/ourairports-data/airports.csv ourairports.csv
# NOAA CPC global daily minimum temperature, 0.5 deg, 1991-2020 (USDA zone normal period).
export -f get
seq 1991 2020 | xargs -P 4 -I{} bash -c 'get https://downloads.psl.noaa.gov/Datasets/cpc_global_temp/tmin.{}.nc cpc/tmin.{}.nc'
