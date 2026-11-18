#!/usr/bin/env bash
# Fetch the raw source datasets into data/raw (about 200 MB, mostly WorldClim).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw && cd data/raw
urls=(
  https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_5m_bio.zip
  https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip
  https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places.zip
  https://naciscdn.org/naturalearth/10m/physical/ne_10m_coastline.zip
  https://naciscdn.org/naturalearth/10m/physical/ne_10m_lakes.zip
)
for u in "${urls[@]}"; do
  f=$(basename "$u")
  if [[ -f "$f" ]]; then echo "have $f"; else echo "get  $f"; curl -fL --retry 3 -o "$f" "$u"; fi
done
