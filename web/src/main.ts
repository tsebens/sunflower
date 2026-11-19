import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";

import { lut, MATCH_COLOR, rampStops, solid } from "./colormaps";
import { loadBands, loadCatalog, loadUint8, type CategoricalLayerDef, type NumericLayerDef } from "./data";
import { band, BINS, Engine, type NumericLayer, type Result } from "./engine";
import { GridOverlay } from "./overlay";
import { categoryCard, group, numericCard, type Card } from "./ui";
import { fmt, settings } from "./units";

// Vite bundles MapLibre, so point it at its worker file explicitly.
maplibregl.setWorkerUrl(workerUrl);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const summary = $("summary");

function areaText(km2: number): string {
  const v = settings.imperial ? km2 / 2.589988 : km2;
  const unit = settings.imperial ? "sq mi" : "km²";
  const rounded = Number(v.toPrecision(2));
  return `about ${rounded.toLocaleString()} ${unit}`;
}

async function boot() {
  const catalog = await loadCatalog();
  const countryDef = catalog.layers.find((l) => l.type === "categorical") as CategoricalLayerDef;
  const numericDefs = catalog.layers.filter((l): l is NumericLayerDef => l.type === "numeric");

  summary.textContent = `Loading ${catalog.layers.length} layers…`;
  const [countryValues, ...bandSets] = await Promise.all([
    loadUint8(countryDef.file),
    ...numericDefs.map(loadBands),
  ]);

  const numeric: NumericLayer[] = numericDefs.map((def, i) => ({
    def,
    bands: bandSets[i],
    bandIndex: def.variants ? def.variants.findIndex((v) => v.key === "500000") : 0,
    lo: def.min,
    hi: def.max,
    fullHist: [],
    crossHist: new Uint32Array(BINS),
  }));
  for (const l of numeric) if (l.bandIndex < 0) l.bandIndex = 0;
  const engine = new Engine(catalog, { def: countryDef, values: countryValues, selected: new Set() }, numeric);

  // ---- map ---------------------------------------------------------------
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const map = new maplibregl.Map({
    container: "map",
    style: `https://basemaps.cartocdn.com/gl/${dark ? "dark-matter" : "positron"}-gl-style/style.json`,
    center: [-50, 45],
    zoom: 2,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  await new Promise<void>((r) => map.once("load", () => r()));
  const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  const overlay = new GridOverlay(map, catalog.grid, firstLabel);

  // ---- sidebar -------------------------------------------------------------
  const vizSelect = $<HTMLSelectElement>("viz-select");
  vizSelect.append(new Option("Just show matching areas", ""));
  for (const l of numeric) vizSelect.append(new Option(l.def.name, l.def.id));
  vizSelect.value = "temp_mean";
  const showExcluded = $<HTMLInputElement>("show-excluded");
  const imperial = $<HTMLInputElement>("imperial");

  const cards: Card[] = [];
  const filters = $("filters");
  const countryCard = categoryCard(engine.country, () => schedule());
  cards.push(countryCard);
  filters.append(group("Location", false, [countryCard]));
  const groups = [...new Set(numeric.map((l) => l.def.group))];
  for (const g of groups) {
    const gc = numeric.filter((l) => l.def.group === g).map((l) => numericCard(l, () => schedule()));
    cards.push(...gc);
    filters.append(group(g, true, gc));
  }

  const sources = [...new Set(catalog.layers.map((l) => l.source.replace(/ BIO\d+$/, "")))];
  $("sources").innerHTML = `<strong>Data:</strong> ${sources.join(" · ")}. Climate values are 1970–2000 averages. Basemap © CARTO, © OpenStreetMap contributors.`;

  // ---- update loop -----------------------------------------------------------
  let last: Result | null = null;
  let frame = 0;
  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }
  function currentViz(): NumericLayer | null {
    return numeric.find((l) => l.def.id === vizSelect.value) ?? null;
  }
  function render() {
    frame = 0;
    const viz = currentViz();
    const res = (last = engine.run(viz));
    const excluded = showExcluded.checked ? solid(dark ? "#555555" : "#9a9a9a", 110) : 0;
    overlay.update(engine.colorize(res, viz, lut(viz?.def.colormap ?? "distance"), solid(MATCH_COLOR, 220), excluded, solid(MATCH_COLOR, 70)));
    for (const c of cards) c.refresh();
    const pct = (100 * res.matchCount) / res.regionCount;
    summary.textContent =
      res.matchCount === 0
        ? "No areas match all your filters. Try loosening one."
        : `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}% of the mapped area matches (${areaText(engine.areaKm2(res.pass))}).`;
    drawLegend(viz, res);
  }

  function drawLegend(viz: NumericLayer | null, res: Result) {
    const legend = $("legend");
    legend.hidden = false;
    if (!viz) {
      legend.innerHTML = `<div class="legend-title">Matching areas</div><div class="swatch" style="background:${MATCH_COLOR}"></div>`;
      return;
    }
    const name = viz.def.variants ? `${viz.def.name} (${band(viz).label})` : viz.def.name;
    if (!Number.isFinite(res.vizMin)) {
      legend.innerHTML = `<div class="legend-title">${name}</div><div class="legend-note">Nothing to show</div>`;
      return;
    }
    const grad = `linear-gradient(to right, ${rampStops(viz.def.colormap).join(",")})`;
    legend.innerHTML = `<div class="legend-title">${name}</div>
      <div class="ramp" style="background:${grad}"></div>
      <div class="legend-ends"><span>${fmt(res.vizMin, viz.def.unit)}</span><span>${fmt(res.vizMax, viz.def.unit)}</span></div>
      <div class="legend-note">Colours stretch across the areas that match (extremes clipped).</div>
      ${res.vizNoData > 0.01 * res.matchCount ? `<div class="legend-nodata"><span class="swatch small" style="background:${MATCH_COLOR};opacity:.35"></span>Matches, but no data for this layer</div>` : ""}`;
  }

  vizSelect.onchange = schedule;
  showExcluded.onchange = schedule;
  imperial.onchange = () => {
    settings.imperial = imperial.checked;
    schedule();
  };
  addEventListener("resize", schedule);

  // ---- click to inspect -------------------------------------------------------
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" });
  map.on("click", (e) => {
    const i = engine.cellAt(e.lngLat.lng, e.lngLat.lat);
    if (i < 0 || engine.country.values[i] === 0) return;
    const cat = countryDef.categories.find((c) => c.id === engine.country.values[i]);
    const rows = [`<tr><th>Country</th><td>${cat?.name ?? "?"}</td></tr>`];
    for (const l of numeric) {
      const b = band(l);
      const label = l.def.variants ? `${l.def.name} (${b.label})` : l.def.name;
      rows.push(`<tr><th>${label}</th><td>${fmt(engine.valueAt(l, b, i), l.def.unit)}</td></tr>`);
    }
    const match = last?.pass[i] ? `<div class="pop-match yes">Matches your filters</div>` : `<div class="pop-match">Doesn't match your filters</div>`;
    const at = `${Math.abs(e.lngLat.lat).toFixed(2)}°${e.lngLat.lat >= 0 ? "N" : "S"}, ${Math.abs(e.lngLat.lng).toFixed(2)}°${e.lngLat.lng >= 0 ? "E" : "W"}`;
    popup.setLngLat(e.lngLat).setHTML(`${match}<table>${rows.join("")}</table><div class="pop-at">${at}</div>`).addTo(map);
  });

  render();
}

boot().catch((err) => {
  console.error(err);
  summary.textContent = `Failed to load: ${err.message}`;
});
