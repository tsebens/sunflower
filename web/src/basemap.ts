// Custom basemap: OpenFreeMap vector tiles (OpenMapTiles schema) + AWS terrain tiles for hillshade.
// Layers are grouped so each reference layer can be toggled independently, and ordered so that
// the data overlay sits under water, roads, borders and labels.

import type * as maplibregl from "maplibre-gl";

type Layer = maplibregl.LayerSpecification;
type Expr = maplibregl.ExpressionSpecification;

export const GRID_BEFORE = "hillshade"; // the data overlay is inserted just below this layer

/** Population tiers for the towns layer: each tier appears from its own zoom level. */
export const TOWN_TIERS = [
  { minPop: 250_000, minzoom: 2.5, radius: 4 },
  { minPop: 50_000, minzoom: 5, radius: 3.2 },
  { minPop: 15_000, minzoom: 6.5, radius: 2.6 },
  { minPop: 5_000, minzoom: 7.5, radius: 2.2 },
  { minPop: 0, minzoom: 8.5, radius: 1.8 },
];
export const TOWN_DOT_IDS = TOWN_TIERS.map((_, t) => `town_dot_${t}`);
export const TOWN_LABEL_IDS = TOWN_TIERS.map((_, t) => `town_label_${t}`);

export interface ReferenceLayer {
  key: string;
  label: string;
  hint?: string;
  layers: string[];
  default: boolean;
}

export const REFERENCE_LAYERS: ReferenceLayer[] = [
  { key: "satellite", label: "Satellite imagery", hint: "Sentinel-2, 2023", layers: ["satellite"], default: false },
  { key: "hillshade", label: "Terrain shading", layers: ["hillshade"], default: true },
  { key: "states", label: "State / province borders", layers: ["boundary_state", "label_state"], default: true },
  { key: "counties", label: "County borders", hint: "appear when zoomed in", layers: ["boundary_county"], default: true },
  {
    key: "roads",
    label: "Roads",
    layers: ["road_minor", "road_secondary", "road_primary", "road_motorway_casing", "road_motorway"],
    default: true,
  },
  {
    key: "places",
    label: "Cities & towns",
    hint: "click a town for details",
    layers: [...TOWN_DOT_IDS, ...TOWN_LABEL_IDS],
    default: true,
  },
];

export const palettes = {
  light: {
    land: "#f3f1ec",
    water: "#c3d3dc",
    waterText: "#5d7a8c",
    river: "#a9c2d0",
    shadow: "rgba(60, 45, 30, 0.5)",
    highlight: "rgba(255, 255, 255, 0.18)",
    motorway: "#7d4f2c",
    casing: "rgba(255, 255, 255, 0.75)",
    primary: "#8f7c6b",
    minor: "#a8a096",
    country: "#3b3632",
    state: "#5e564f",
    county: "#857b72",
    text: "#26221e",
    halo: "rgba(255, 255, 255, 0.9)",
    dot: "#26221e",
  },
  dark: {
    land: "#1d1d21",
    water: "#2b3a45",
    waterText: "#7f9bb0",
    river: "#34495a",
    shadow: "rgba(0, 0, 0, 0.6)",
    highlight: "rgba(255, 255, 255, 0.08)",
    motorway: "#e0b483",
    casing: "rgba(0, 0, 0, 0.6)",
    primary: "#b5a594",
    minor: "#8a8279",
    country: "#d8d2c8",
    state: "#aaa298",
    county: "#857d74",
    text: "#f1ede6",
    halo: "rgba(20, 20, 24, 0.9)",
    dot: "#f1ede6",
  },
};

const lines: Expr = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const notMaritime: Expr = ["!=", ["get", "maritime"], 1];
const roadClass = (classes: string[]): Expr => ["all", lines, ["match", ["get", "class"], classes, true, false]];
const zoomWidth = (pairs: number[]): Expr => ["interpolate", ["exponential", 1.4], ["zoom"], ...pairs];
const name: Expr = ["coalesce", ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];

export function basemapStyle(dark: boolean): maplibregl.StyleSpecification {
  const c = dark ? palettes.dark : palettes.light;
  const layers: Layer[] = [
    { id: "background", type: "background", paint: { "background-color": c.land } },
    // Cloud-free satellite mosaic; sits under the data overlay, so lower the overlay opacity to see it.
    {
      id: "satellite",
      type: "raster",
      source: "satellite",
      layout: { visibility: "none" },
      paint: { "raster-fade-duration": 150 },
    },
    // (data overlay goes here)
    {
      id: "hillshade",
      type: "hillshade",
      source: "terrain",
      paint: {
        "hillshade-exaggeration": 0.55,
        "hillshade-shadow-color": c.shadow,
        "hillshade-highlight-color": c.highlight,
        "hillshade-accent-color": "rgba(0, 0, 0, 0)",
      },
    },
    {
      id: "water",
      type: "fill",
      source: "omt",
      "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: { "fill-color": c.water },
    },
    {
      id: "river",
      type: "line",
      source: "omt",
      "source-layer": "waterway",
      minzoom: 6,
      filter: ["==", ["get", "class"], "river"],
      paint: { "line-color": c.river, "line-width": zoomWidth([6, 0.5, 12, 2.5]) },
    },
    {
      id: "road_minor",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 11,
      filter: roadClass(["tertiary", "minor"]),
      paint: { "line-color": c.minor, "line-width": zoomWidth([11, 0.4, 16, 3]) },
    },
    {
      id: "road_secondary",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 8,
      filter: roadClass(["secondary"]),
      paint: { "line-color": c.primary, "line-width": zoomWidth([8, 0.4, 16, 4]) },
    },
    {
      id: "road_primary",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 6,
      filter: roadClass(["primary", "trunk"]),
      paint: { "line-color": c.primary, "line-width": zoomWidth([6, 0.5, 16, 6]) },
    },
    {
      id: "road_motorway_casing",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 5,
      filter: roadClass(["motorway"]),
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": c.casing, "line-width": zoomWidth([5, 1.6, 16, 10]) },
    },
    {
      id: "road_motorway",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 4,
      filter: roadClass(["motorway"]),
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": c.motorway, "line-width": zoomWidth([4, 0.6, 16, 7]) },
    },
    {
      id: "boundary_county",
      type: "line",
      source: "omt",
      "source-layer": "boundary",
      minzoom: 8,
      filter: ["all", ["==", ["get", "admin_level"], 6], notMaritime],
      paint: { "line-color": c.county, "line-width": 0.7, "line-dasharray": [1, 2] },
    },
    {
      id: "boundary_state",
      type: "line",
      source: "omt",
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 4], notMaritime],
      paint: {
        "line-color": c.state,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 8, 1.4],
        "line-dasharray": [4, 2],
      },
    },
    {
      id: "boundary_country",
      type: "line",
      source: "omt",
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], notMaritime, ["!=", ["get", "disputed"], 1]],
      layout: { "line-join": "round" },
      paint: { "line-color": c.country, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.8, 8, 2] },
    },
    {
      id: "water_label",
      type: "symbol",
      source: "omt",
      "source-layer": "water_name",
      filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      layout: { "text-field": name, "text-font": ["Noto Sans Italic"], "text-size": 12 },
      paint: { "text-color": c.waterText, "text-halo-color": c.halo, "text-halo-width": 1 },
    },
    {
      id: "label_state",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      minzoom: 4,
      maxzoom: 8,
      filter: ["==", ["get", "class"], "state"],
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Italic"],
        "text-size": 11,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
        "text-max-width": 8,
      },
      paint: { "text-color": c.state, "text-halo-color": c.halo, "text-halo-width": 1.2 },
    },
    {
      id: "label_country",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      maxzoom: 7,
      filter: ["==", ["get", "class"], "country"],
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 15],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.1,
        "text-max-width": 7,
      },
      paint: { "text-color": c.country, "text-halo-color": c.halo, "text-halo-width": 1.5 },
    },
  ];

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      omt: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution:
          '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
      // A separate copy of the elevation source for 3D terrain (recommended over sharing
      // one source between hillshade and terrain).
      satellite: {
        type: "raster",
        tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg"],
        tileSize: 256,
        maxzoom: 15,
        attribution:
          '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023)',
      },
      terrain3d: {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 13,
      },
      terrain: {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 13,
        attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / AWS Terrain Tiles</a>',
      },
    },
    layers,
  };
}

export function setReferenceVisible(map: maplibregl.Map, key: string, on: boolean) {
  const ref = REFERENCE_LAYERS.find((r) => r.key === key);
  for (const id of ref?.layers ?? []) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}
