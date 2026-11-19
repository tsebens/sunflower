import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";

import { basemapStyle, GRID_BEFORE, REFERENCE_LAYERS, setReferenceVisible } from "./basemap";
import { lut, MATCH_COLOR, rampStops, solid } from "./colormaps";
import { loadBands, loadCatalog, loadUint8, type CategoricalLayerDef, type NumericLayerDef } from "./data";
import { band, BINS, Engine, isActive, type NumericLayer, type Result } from "./engine";
import { GridOverlay } from "./overlay";
import { loadTowns, Towns } from "./towns";
import { categoryCard, group, numericCard, type Card } from "./ui";
import { fmt, settings } from "./units";
import { decodeState, encodeState, stateKey, viewsPanel, type FilterState, type ViewState } from "./views";

// Vite bundles MapLibre, so point it at its worker file explicitly.
maplibregl.setWorkerUrl(workerUrl);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const summary = $("summary");
const DEFAULT_CITY_SIZE = "500000";

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
  const townsPromise = loadTowns();
  const [countryValues, ...bandSets] = await Promise.all([
    loadUint8(countryDef.file),
    ...numericDefs.map(loadBands),
  ]);

  const defaultBand = (def: NumericLayerDef) =>
    Math.max(0, def.variants ? def.variants.findIndex((v) => v.key === DEFAULT_CITY_SIZE) : 0);
  const numeric: NumericLayer[] = numericDefs.map((def, i) => ({
    def,
    bands: bandSets[i],
    bandIndex: defaultBand(def),
    lo: def.min,
    hi: def.max,
    fullHist: [],
    crossHist: new Uint32Array(BINS),
  }));
  const engine = new Engine(catalog, { def: countryDef, values: countryValues, selected: new Set() }, numeric);

  // ---- map ---------------------------------------------------------------
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const map = new maplibregl.Map({
    container: "map",
    style: basemapStyle(dark),
    center: [-50, 45],
    zoom: 2,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  const scale = new maplibregl.ScaleControl({ unit: "imperial" });
  map.addControl(scale, "bottom-right");
  await new Promise<void>((r) => map.once("load", () => r()));
  // Exposed for debugging in the browser console and for automated UI tests.
  (window as unknown as { sunflowerMap: maplibregl.Map }).sunflowerMap = map;
  const overlay = new GridOverlay(map, catalog.grid, GRID_BEFORE);
  const layerById = (id: string) => numeric.find((l) => l.def.id === id);
  const towns = new Towns(map, await townsPromise, {
    dark,
    imperial: () => settings.imperial,
    onPinsChange: () => schedule(),
    climateRows(lon, lat) {
      const i = engine.cellAt(lon, lat);
      const ids = ["temp_max", "temp_min", "precip_annual", "dewpoint_summer", "sunshine_hours", "hardiness_zone", "elevation", "dist_coast"];
      return ids
        .map((id) => layerById(id))
        .filter((l): l is NumericLayer => !!l)
        .map((l) => `<tr><th>${l.def.name}</th><td>${i < 0 ? "n/a" : fmt(engine.valueAt(l, band(l), i), l.def.unit)}</td></tr>`)
        .join("");
    },
  });

  // ---- sidebar: display ------------------------------------------------------
  const vizSelect = $<HTMLSelectElement>("viz-select");
  vizSelect.append(new Option("Just show matching areas", ""));
  for (const l of numeric) vizSelect.append(new Option(l.def.name, l.def.id));
  vizSelect.value = "temp_mean";
  const showExcluded = $<HTMLInputElement>("show-excluded");
  const imperial = $<HTMLInputElement>("imperial");
  const opacity = $<HTMLInputElement>("opacity");
  const opacityValue = $("opacity-value");
  const terrain3d = $<HTMLInputElement>("terrain3d");
  const exaggeration = $<HTMLInputElement>("exaggeration");

  const refToggles = new Map<string, HTMLInputElement>();
  for (const ref of REFERENCE_LAYERS) {
    const label = document.createElement("label");
    label.className = "inline";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = ref.default;
    box.onchange = () => {
      setReferenceVisible(map, ref.key, box.checked);
      schedule();
    };
    refToggles.set(ref.key, box);
    label.append(box, ` ${ref.label}`);
    if (ref.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = ` (${ref.hint})`;
      label.append(hint);
    }
    $("ref-layers").append(label);
  }

  // ---- sidebar: filters ------------------------------------------------------
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
  // Town filters: decide which towns are drawn (separately from the area colouring).
  const townCards = towns.filters.map((l) => numericCard(l, () => schedule()));
  cards.push(...townCards);
  const townGroup = group("Town filters", true, townCards);
  const townCount = document.createElement("p");
  townCount.className = "card-desc group-note";
  townGroup.querySelector("summary")!.after(townCount);
  filters.append(townGroup);

  const sources = [...new Set(catalog.layers.map((l) => l.source.replace(/ BIO\d+$/, "")))];
  $("sources").innerHTML = `<strong>Data:</strong> ${sources.join(" · ")}. Basemap: OpenFreeMap / OpenMapTiles, © OpenStreetMap contributors. Terrain: Mapzen / AWS Terrain Tiles.`;

  // ---- view state (saved views + URL) ---------------------------------------------
  function getState(): ViewState {
    const f: Record<string, FilterState> = {};
    for (const l of numeric) {
      const s: FilterState = {};
      if (l.lo > l.def.min) s.lo = Number(l.lo.toPrecision(6));
      if (l.hi < l.def.max) s.hi = Number(l.hi.toPrecision(6));
      if (l.def.variants && l.bandIndex !== defaultBand(l.def)) s.band = band(l).key;
      if (Object.keys(s).length) f[l.def.id] = s;
    }
    for (const l of towns.filters) {
      const s: FilterState = {};
      if (l.lo !== (l.defaultLo ?? l.def.min)) s.lo = Number(l.lo.toPrecision(6));
      if (l.hi < l.def.max) s.hi = Number(l.hi.toPrecision(6));
      if (Object.keys(s).length) f[l.def.id] = s;
    }
    return {
      viz: vizSelect.value,
      showExcluded: showExcluded.checked,
      imperial: imperial.checked,
      opacity: Number(opacity.value),
      layers: Object.fromEntries([...refToggles].map(([k, b]) => [k, b.checked])),
      filters: f,
      countries: countryDef.categories.filter((c) => engine.country.selected.has(c.id)).map((c) => c.code),
      pins: towns.pinnedIds().sort(),
      terrain3d: terrain3d.checked,
      exaggeration: Number(exaggeration.value),
    };
  }

  function setState(s: Partial<ViewState>) {
    if (typeof s.viz === "string" && [...vizSelect.options].some((o) => o.value === s.viz)) vizSelect.value = s.viz;
    if (typeof s.showExcluded === "boolean") showExcluded.checked = s.showExcluded;
    if (typeof s.imperial === "boolean") imperial.checked = s.imperial;
    if (typeof s.opacity === "number") opacity.value = String(s.opacity);
    terrain3d.checked = s.terrain3d === true;
    if (typeof s.exaggeration === "number") exaggeration.value = String(s.exaggeration);
    towns.setPinned(Array.isArray(s.pins) ? s.pins : []);
    for (const [k, box] of refToggles) {
      const on = s.layers?.[k];
      if (typeof on === "boolean") box.checked = on;
    }
    for (const l of numeric) {
      const f = s.filters?.[l.def.id] ?? {};
      const clamp = (v: unknown, fallback: number) =>
        typeof v === "number" && Number.isFinite(v) ? Math.min(l.def.max, Math.max(l.def.min, v)) : fallback;
      l.lo = clamp(f.lo, l.def.min);
      l.hi = clamp(f.hi, l.def.max);
      const bi = l.bands.findIndex((b) => b.key === f.band);
      l.bandIndex = bi >= 0 ? bi : defaultBand(l.def);
    }
    for (const l of towns.filters) {
      const f = s.filters?.[l.def.id] ?? {};
      const clamp = (v: unknown, fallback: number) =>
        typeof v === "number" && Number.isFinite(v) ? Math.min(l.def.max, Math.max(l.def.min, v)) : fallback;
      // Views saved before town filters existed stored only a minimum population.
      const legacyLo = l.def.id === "town_pop" && typeof s.townMinPop === "number" ? s.townMinPop : undefined;
      l.lo = clamp(f.lo ?? legacyLo, l.defaultLo ?? l.def.min);
      l.hi = clamp(f.hi, l.def.max);
    }
    const codes = new Set(Array.isArray(s.countries) ? s.countries : []);
    engine.country.selected = new Set(countryDef.categories.filter((c) => codes.has(c.code)).map((c) => c.id));
    applyDisplay();
    schedule();
  }

  function clearFilters() {
    const s = getState();
    setState({ ...s, filters: {}, countries: [] });
  }

  let terrainOn = false;
  function applyTerrain() {
    const on = terrain3d.checked;
    const ex = Number(exaggeration.value);
    $("exaggeration-row").hidden = !on;
    $("exaggeration-value").textContent = `${ex}×`;
    if (on) map.setTerrain({ source: "terrain3d", exaggeration: ex });
    else if (terrainOn) map.setTerrain(null);
    // Tilt the camera when turning 3D on (and flatten when turning it off) so the change is visible.
    if (on && !terrainOn && map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 800 });
    if (!on && terrainOn) map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    terrainOn = on;
  }

  function applyDisplay() {
    settings.imperial = imperial.checked;
    scale.setUnit(imperial.checked ? "imperial" : "metric");
    overlay.setOpacity(Number(opacity.value) / 100);
    opacityValue.textContent = `${opacity.value}%`;
    for (const [k, box] of refToggles) setReferenceVisible(map, k, box.checked);
    applyTerrain();
  }

  const defaults = stateKey(getState());
  const views = viewsPanel($("views"), { get: getState, set: setState, reset: clearFilters });

  function syncUrl(state: ViewState) {
    const hash = stateKey(state) === defaults ? "" : `#v=${encodeState(state)}`;
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
  }

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
    overlay.update(
      engine.colorize(res, viz, lut(viz?.def.colormap ?? "distance"), solid(MATCH_COLOR, 220), excluded, solid(MATCH_COLOR, 70)),
    );
    towns.applyFilters();
    townCount.textContent = `${towns.shownCount.toLocaleString()} of ${towns.totalCount.toLocaleString()} towns pass these filters (pinned towns always stay).`;
    for (const c of cards) c.refresh();
    const pct = (100 * res.matchCount) / res.regionCount;
    summary.textContent =
      res.matchCount === 0
        ? "No areas match all your filters. Try loosening one."
        : `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}% of the mapped area matches (${areaText(engine.areaKm2(res.pass))}).`;
    drawLegend(viz, res);
    const state = getState();
    views.refresh(state);
    syncUrl(state);
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
    applyDisplay();
    towns.refreshCards();
    schedule();
  };
  terrain3d.onchange = exaggeration.oninput = () => {
    applyDisplay();
    schedule();
  };
  opacity.oninput = () => {
    applyDisplay();
    schedule();
  };
  addEventListener("resize", schedule);

  // ---- click to inspect -------------------------------------------------------
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" });
  // A single click inspects; wait briefly so a double-click (zoom) doesn't also open the popup.
  let clickTimer = 0;
  map.on("dblclick", () => clearTimeout(clickTimer));
  map.on("click", (e) => {
    clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => inspect(e), 250);
  });
  function inspect(e: maplibregl.MapMouseEvent) {
    // Clicking a town opens its card (and keeps it open) instead of the area details.
    const t = towns.townAt(e.point);
    if (t >= 0) {
      popup.remove();
      towns.showCard(t);
      return;
    }
    towns.closeCard();
    const i = engine.cellAt(e.lngLat.lng, e.lngLat.lat);
    if (i < 0 || engine.country.values[i] === 0) return;
    const fail = (bad: boolean, value: string, why: string) =>
      bad ? `<span class="fail" title="${why}">${value}</span>` : value;

    const cid = engine.country.values[i];
    const cat = countryDef.categories.find((c) => c.id === cid);
    const countryFails = engine.country.selected.size > 0 && !engine.country.selected.has(cid);
    const rows = [`<tr><th>Country</th><td>${fail(countryFails, cat?.name ?? "?", "Not one of your selected countries")}</td></tr>`];
    let failures = countryFails ? 1 : 0;
    for (const l of numeric) {
      const b = band(l);
      const v = engine.valueAt(l, b, i);
      const bad = isActive(l) && (!Number.isFinite(v) || v < l.lo || v > l.hi);
      if (bad) failures++;
      const label = l.def.variants ? `${l.def.name} (${b.label})` : l.def.name;
      const why = `Your filter: ${fmt(l.lo, l.def.unit)} – ${fmt(l.hi, l.def.unit)}`;
      rows.push(`<tr${bad ? ' class="fail-row"' : ""}><th>${label}</th><td>${fail(bad, fmt(v, l.def.unit), why)}</td></tr>`);
    }
    const match = last?.pass[i]
      ? `<div class="pop-match yes">Matches your filters</div>`
      : `<div class="pop-match">Doesn't match your filters${failures ? ` <span class="fail">(${failures} in red)</span>` : ""}</div>`;
    const at = `${Math.abs(e.lngLat.lat).toFixed(2)}°${e.lngLat.lat >= 0 ? "N" : "S"}, ${Math.abs(e.lngLat.lng).toFixed(2)}°${e.lngLat.lng >= 0 ? "E" : "W"}`;
    popup.setLngLat(e.lngLat).setHTML(`${match}<table>${rows.join("")}</table><div class="pop-at">${at}</div>`).addTo(map);
  }

  // Restore a view from the URL (shared link or page reload), else use defaults.
  const fromUrl = location.hash.startsWith("#v=") ? decodeState(location.hash.slice(3)) : null;
  if (fromUrl) setState(fromUrl);
  else applyDisplay();
  render();
}

boot().catch((err) => {
  console.error(err);
  summary.textContent = `Failed to load: ${err.message}`;
});
