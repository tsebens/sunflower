// Towns layer: dots + labels (with stats when zoomed in), click-to-open cards, and pinned cards.

import * as maplibregl from "maplibre-gl";
import { palettes, TOWN_DOT_IDS, TOWN_LABEL_IDS, TOWN_TIERS } from "./basemap";
import { loadBytes, type NumericLayerDef, type Unit } from "./data";
import { BINS, type NumericLayer } from "./engine";
import { sliderScale } from "./ui";

/** Labels gain a stats line from this zoom level on. */
export const STATS_ZOOM = 8;

type Num = (number | null)[];
type Str = (string | null)[];

export interface TownData {
  national: Record<string, number>;
  count: number;
  columns: {
    id: string[];
    name: string[];
    region: Str;
    country: string[];
    airport: Str;
    lat: number[];
    lon: number[];
    pop: number[];
    growth: Num;
    age: Num;
    income: Num;
    homeValue: Num;
    rent: Num;
    unemployment: Num;
    poverty: Num;
    bachelors: Num;
    owners: Num;
    wfh: Num;
    zhvi: Num;
    zhvi5y: Num;
    airportKm: Num;
  };
}

export async function loadTowns(): Promise<TownData> {
  const buf = await loadBytes("towns.json.gz");
  return JSON.parse(new TextDecoder().decode(buf));
}

// ---- formatting ----------------------------------------------------------------

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
const NA = `<span class="na">n/a</span>`;

function short(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
const money = (n: number | null) => (n == null ? NA : `$${n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n).toLocaleString()}`);
const moneyShort = (n: number) => `$${short(n)}`;
const pct = (n: number | null, d = 1) => (n == null ? NA : `${n.toFixed(d)}%`);
const signed = (n: number | null) => (n == null ? NA : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Compare with the national figure. `good` says which direction is healthier ("up"/"down"),
 * or omit it for neutral facts (e.g. median age).
 */
function vs(value: number | null, national: number | undefined, fmt: (n: number) => string, good?: "up" | "down"): string {
  if (value == null || national == null) return "";
  let cls = "";
  if (good) {
    const better = good === "up" ? value > national : value < national;
    const close = Math.abs(value - national) <= Math.abs(national) * 0.05;
    cls = close ? "" : better ? "good" : "bad";
  }
  return `<span class="vs ${cls}">US ${fmt(national)}</span>`;
}

// ---- Wikipedia ---------------------------------------------------------------------

interface Wiki {
  title: string;
  extract: string;
  url: string;
  thumb?: string;
}
const wikiCache = new Map<string, Promise<Wiki | null>>();

function normalise(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bst\.?\s/g, "saint ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find the English Wikipedia article for a town: nearby articles whose title is the town's name. */
function wikipedia(name: string, lat: number, lon: number): Promise<Wiki | null> {
  const key = `${name}|${lat}|${lon}`;
  let p = wikiCache.get(key);
  if (!p) {
    p = (async () => {
      const api = "https://en.wikipedia.org/w/api.php";
      const q = new URLSearchParams({
        action: "query",
        list: "geosearch",
        gscoord: `${lat}|${lon}`,
        gsradius: "10000",
        gslimit: "50",
        format: "json",
        origin: "*",
      });
      const res = await fetch(`${api}?${q}`);
      const hits: { title: string; dist: number }[] = (await res.json())?.query?.geosearch ?? [];
      const wanted = [name, name.split(/[-/(]/)[0]].map(normalise);
      const hit = hits.find((h) => wanted.includes(normalise(h.title.split(",")[0].replace(/\s*\(.*\)$/, ""))));
      if (!hit) return null;
      const sres = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`);
      if (!sres.ok) return null;
      const s = await sres.json();
      return {
        title: s.title,
        extract: s.extract ?? "",
        url: s.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
        thumb: s.thumbnail?.source,
      };
    })().catch(() => null);
    wikiCache.set(key, p);
  }
  return p;
}

// ---- town filters ---------------------------------------------------------------------

interface TownFilterSpec {
  id: string;
  prop: string;
  name: string;
  description: string;
  unit: Unit;
  min: number;
  max: number;
  axis: "linear" | "log";
  defaultLo?: number;
  values(c: TownData["columns"]): (number | null)[];
}

const US_ONLY = "US towns only for now: setting this hides towns without this data.";

export const TOWN_FILTERS: TownFilterSpec[] = [
  {
    id: "town_pop",
    prop: "pop",
    name: "Population",
    description: "Smaller towns also only appear as you zoom in.",
    unit: "people",
    min: 1000,
    max: 5_000_000,
    axis: "log",
    defaultLo: 2000,
    values: (c) => c.pop,
  },
  {
    id: "town_growth",
    prop: "growth",
    name: "Population change since 2010",
    description: US_ONLY,
    unit: "pct",
    min: -30,
    max: 100,
    axis: "linear",
    values: (c) => c.growth,
  },
  {
    id: "town_home",
    prop: "home",
    name: "Home value",
    description: `Typical home value (Zillow, or the Census median where Zillow has none). ${US_ONLY}`,
    unit: "usd",
    min: 50_000,
    max: 3_000_000,
    axis: "log",
    values: (c) => c.zhvi.map((z, i) => z ?? c.homeValue[i]),
  },
  {
    id: "town_income",
    prop: "income",
    name: "Median household income",
    description: US_ONLY,
    unit: "usd",
    min: 20_000,
    max: 250_000,
    axis: "log",
    values: (c) => c.income,
  },
];

// ---- the layer ------------------------------------------------------------------------

export interface TownsOptions {
  dark: boolean;
  /** HTML rows (<tr>…</tr>) describing the climate at a point, from the app's own layers. */
  climateRows(lon: number, lat: number): string;
  imperial(): boolean;
  onPinsChange(): void;
}

export class Towns {
  private byId = new Map<string, number>();
  private card: maplibregl.Popup;
  private cardIdx = -1;
  private pinned = new Map<number, maplibregl.Popup>();
  /** Town filters, shaped like map-layer filters so the same slider cards can drive them. */
  readonly filters: NumericLayer[];
  private filterValues: Float64Array[];
  private filterExpr = "";
  /** Number of towns passing the town filters. */
  shownCount = 0;

  /** Total number of towns loaded. */
  get totalCount(): number {
    return this.data.count;
  }

  constructor(
    private map: maplibregl.Map,
    private data: TownData,
    private opts: TownsOptions,
  ) {
    const c = data.columns;
    c.id.forEach((id, i) => this.byId.set(id, i));
    this.filters = TOWN_FILTERS.map((f) => ({
      def: {
        id: f.id,
        name: f.name,
        description: f.description,
        group: "Towns",
        type: "numeric",
        unit: f.unit,
        colormap: "",
        source: "",
        min: f.min,
        max: f.max,
        axis: f.axis,
      } satisfies NumericLayerDef,
      bands: [{ key: "", label: "", values: new Int16Array(0), scale: 1, offset: 0 }],
      bandIndex: 0,
      lo: f.defaultLo ?? f.min,
      hi: f.max,
      defaultLo: f.defaultLo,
      fullHist: [],
      crossHist: new Uint32Array(BINS),
    }));
    this.filterValues = TOWN_FILTERS.map((f) => Float64Array.from(f.values(c), (v) => (v == null ? NaN : v)));
    this.filters.forEach((l, k) => (l.fullHist = [this.histogram(k, () => true)]));
    this.addLayers();
    this.applyFilters();
    this.card = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "340px", className: "town-popup", offset: 8 });
    this.card.on("close", () => (this.cardIdx = -1));
    this.wireEvents();
  }

  // -- layers --

  private addLayers() {
    const c = this.data.columns;
    const features: { type: "Feature"; geometry: { type: "Point"; coordinates: number[] }; properties: Record<string, unknown> }[] = [];
    for (let i = 0; i < this.data.count; i++) {
      const pop = c.pop[i];
      const tier = TOWN_TIERS.findIndex((t) => pop >= t.minPop);
      const home = c.zhvi[i] ?? c.homeValue[i];
      const parts = [`${short(pop)} people`];
      if (c.growth[i] != null) parts[0] += ` ${c.growth[i]! >= 0 ? "▲" : "▼"}${Math.abs(c.growth[i]!).toFixed(0)}%`;
      if (home != null) parts.push(`${moneyShort(home)} homes`);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon[i], c.lat[i]] },
        properties: {
          i,
          name: c.name[i],
          tier,
          stats: parts.join("\n"),
          // Filterable values; omitted when unknown so filters can drop towns without data.
          ...Object.fromEntries(TOWN_FILTERS.map((f, k) => [f.prop, this.filterValues[k][i]]).filter(([, v]) => !Number.isNaN(v))),
        },
      });
    }
    this.map.addSource("towns", { type: "geojson", data: { type: "FeatureCollection", features } });

    const pal = this.opts.dark ? palettes.dark : palettes.light;
    TOWN_TIERS.forEach((t, k) => {
      this.map.addLayer({
        id: TOWN_DOT_IDS[k],
        type: "circle",
        source: "towns",
        minzoom: t.minzoom,
        filter: this.tierFilter(k),
        paint: {
          "circle-color": pal.dot,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, t.radius, 10, t.radius + 1.5],
          "circle-stroke-color": pal.halo,
          "circle-stroke-width": 1,
        },
      });
    });
    // Labels after all dots so no dot covers a label; biggest towns win label collisions.
    TOWN_TIERS.forEach((t, k) => {
      this.map.addLayer({
        id: TOWN_LABEL_IDS[k],
        type: "symbol",
        source: "towns",
        minzoom: t.minzoom,
        filter: this.tierFilter(k),
        layout: {
          "text-field": [
            "step",
            ["zoom"],
            ["get", "name"],
            STATS_ZOOM,
            ["format", ["get", "name"], {}, "\n", {}, ["get", "stats"], { "font-scale": 0.82, "text-font": ["literal", ["Noto Sans Regular"]] }],
          ],
          "text-font": [k <= 1 ? "Noto Sans Bold" : "Noto Sans Regular"],
          "text-size": k === 0 ? 14 : k === 1 ? 13 : 12,
          "text-anchor": "bottom",
          "text-offset": [0, -0.4],
          "text-max-width": 14,
          "symbol-sort-key": ["-", 0, ["get", "pop"]],
        },
        paint: { "text-color": pal.text, "text-halo-color": pal.halo, "text-halo-width": 1.6 },
      });
    });
  }

  /** Active bounds of each town filter: an end left at the slider's edge is open-ended. */
  private bounds() {
    return this.filters.map((l) => ({
      lo: l.lo > l.def.min ? l.lo : -Infinity,
      hi: l.hi < l.def.max ? l.hi : Infinity,
      active: l.lo > l.def.min || l.hi < l.def.max,
    }));
  }

  private tierFilter(k: number): maplibregl.FilterSpecification {
    const conds: unknown[] = [["==", ["get", "tier"], k]];
    this.bounds().forEach((b, f) => {
      if (!b.active) return;
      const prop = TOWN_FILTERS[f].prop;
      conds.push(["has", prop]); // no data -> hidden when this filter is set
      if (b.lo > -Infinity) conds.push([">=", ["get", prop], b.lo]);
      if (b.hi < Infinity) conds.push(["<=", ["get", prop], b.hi]);
    });
    return ["all", ...conds] as maplibregl.FilterSpecification;
  }

  private histogram(k: number, include: (i: number) => boolean): Uint32Array {
    const h = new Uint32Array(BINS);
    const sc = sliderScale(this.filters[k].def);
    const vals = this.filterValues[k];
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (Number.isNaN(v) || !include(i)) continue;
      h[Math.min(BINS - 1, Math.max(0, Math.floor(sc.toFrac(v) * BINS)))]++;
    }
    return h;
  }

  /** Apply the town filters to the map, and refresh counts and cross-filter histograms. */
  applyFilters() {
    const b = this.bounds();
    const n = this.data.count;
    const fails = new Uint8Array(n);
    const failIdx = new Int8Array(n);
    b.forEach((bk, k) => {
      if (!bk.active) return;
      const vals = this.filterValues[k];
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (Number.isNaN(v) || v < bk.lo || v > bk.hi) {
          fails[i]++;
          failIdx[i] = k;
        }
      }
    });
    let shown = 0;
    for (let i = 0; i < n; i++) if (fails[i] === 0) shown++;
    this.shownCount = shown;
    // Each slider's coloured bars: towns passing every *other* town filter.
    this.filters.forEach((l, k) => {
      l.crossHist = this.histogram(k, (i) => fails[i] === 0 || (fails[i] === 1 && failIdx[i] === k));
    });

    const expr = JSON.stringify(b);
    if (expr === this.filterExpr || !this.map.getLayer(TOWN_DOT_IDS[0])) return;
    this.filterExpr = expr;
    TOWN_TIERS.forEach((_, k) => {
      this.map.setFilter(TOWN_DOT_IDS[k], this.tierFilter(k));
      this.map.setFilter(TOWN_LABEL_IDS[k], this.tierFilter(k));
    });
  }

  // -- events --

  /** Town index under a screen point, or -1. */
  townAt(point: maplibregl.PointLike): number {
    const visible = (ids: string[]) =>
      ids.filter((id) => this.map.getLayer(id) && this.map.getLayoutProperty(id, "visibility") !== "none");
    const p = maplibregl.Point.convert(point);
    const box = (r: number): [maplibregl.PointLike, maplibregl.PointLike] => [
      [p.x - r, p.y - r],
      [p.x + r, p.y + r],
    ];
    // Dots win over labels: a neighbour's tall label can overlap a town's dot.
    for (const [ids, r] of [[TOWN_DOT_IDS, 6], [TOWN_LABEL_IDS, 2]] as const) {
      const layers = visible([...ids]);
      if (!layers.length) continue;
      const hits = this.map.queryRenderedFeatures(box(r), { layers });
      if (hits.length) {
        // Nearest dot to the pointer.
        let best = hits[0];
        let bestD = Infinity;
        for (const h of hits) {
          const [lon, lat] = (h.geometry as unknown as { coordinates: [number, number] }).coordinates;
          const q = this.map.project([lon, lat]);
          const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
          if (d < bestD) [best, bestD] = [h, d];
        }
        return best.properties!.i as number;
      }
    }
    return -1;
  }

  /** Hovering only changes the cursor; cards open on click (see main.ts). */
  private wireEvents() {
    let raf = 0;
    this.map.on("mousemove", (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.map.getCanvas().style.cursor = this.townAt(e.point) >= 0 ? "pointer" : "";
      });
    });
  }

  /** Open a town's card; it stays until closed, another town is clicked, or the map is clicked. */
  showCard(i: number) {
    if (this.pinned.has(i)) return;
    this.cardIdx = i;
    this.card.setDOMContent(this.cardElement(i, false)).setLngLat([this.data.columns.lon[i], this.data.columns.lat[i]]).addTo(this.map);
  }

  closeCard() {
    this.card.remove();
  }

  // -- pins --

  pinnedIds(): string[] {
    return [...this.pinned.keys()].map((i) => this.data.columns.id[i]);
  }

  setPinned(ids: string[]) {
    const want = new Set(ids.map((id) => this.byId.get(id)).filter((i): i is number => i != null));
    for (const [i, popup] of this.pinned) if (!want.has(i)) popup.remove();
    for (const i of want) if (!this.pinned.has(i)) this.pin(i, false);
  }

  private pin(i: number, notify = true) {
    if (this.cardIdx === i) this.card.remove();
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "340px",
      className: "town-popup pinned",
      offset: 8,
    });
    popup.setDOMContent(this.cardElement(i, true)).setLngLat([this.data.columns.lon[i], this.data.columns.lat[i]]).addTo(this.map);
    this.pinned.set(i, popup);
    if (notify) this.opts.onPinsChange();
  }

  private unpin(i: number) {
    this.pinned.get(i)?.remove();
    this.pinned.delete(i);
    this.opts.onPinsChange();
  }

  /** Re-render open cards (e.g. after a units change). */
  refreshCards() {
    for (const [i, popup] of this.pinned) {
      const collapsed = popup.getElement()?.querySelector(".town-card")?.classList.contains("collapsed") ?? true;
      popup.setDOMContent(this.cardElement(i, true, collapsed));
    }
    if (this.cardIdx >= 0 && this.card.isOpen()) this.showCard(this.cardIdx);
  }

  // -- card --

  private cardElement(i: number, pinned: boolean, collapsed = pinned): HTMLElement {
    const c = this.data.columns;
    const n = this.data.national;
    const us = c.country[i] === "US";
    const imperial = this.opts.imperial();
    const km = c.airportKm[i];
    const dist = km == null ? NA : imperial ? `${Math.round(km / 1.609)} mi` : `${Math.round(km)} km`;
    const where = [c.region[i], us ? null : COUNTRY_NAMES.of(c.country[i])].filter(Boolean).join(", ");
    const row = (label: string, value: string, extra = "") => `<tr><th>${label}</th><td>${value}${extra}</td></tr>`;
    const home = c.zhvi[i];
    const priceToIncome = (home ?? c.homeValue[i]) != null && c.income[i] ? (home ?? c.homeValue[i])! / c.income[i]! : null;
    const nationalP2I = n.homeValue && n.income ? n.homeValue / n.income : undefined;

    const usSections = us
      ? `
      <h4>Cost of living</h4>
      <table>
        ${row("Typical home value", money(home), vs(home, undefined, moneyShort))}
        ${row("Change over 5 years", signed(c.zhvi5y[i]), vs(c.zhvi5y[i], n.zhvi5y, (v) => `${v.toFixed(0)}%`))}
        ${row("Median home value (Census)", money(c.homeValue[i]), vs(c.homeValue[i], n.homeValue, moneyShort))}
        ${row("Median rent", c.rent[i] == null ? NA : `${money(c.rent[i])}/mo`, vs(c.rent[i], n.rent, (v) => `$${v.toLocaleString()}`))}
        ${row("Home price ÷ income", priceToIncome == null ? NA : `${priceToIncome.toFixed(1)}×`, vs(priceToIncome, nationalP2I, (v) => `${v.toFixed(1)}×`, "down"))}
      </table>
      <h4>Economy</h4>
      <table>
        ${row("Median household income", money(c.income[i]), vs(c.income[i], n.income, moneyShort, "up"))}
        ${row("Population change since 2010", signed(c.growth[i]), vs(c.growth[i], n.growth, (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`, "up"))}
        ${row("Unemployment", pct(c.unemployment[i]), vs(c.unemployment[i], n.unemployment, (v) => `${v}%`, "down"))}
        ${row("Below poverty line", pct(c.poverty[i]), vs(c.poverty[i], n.poverty, (v) => `${v}%`, "down"))}
      </table>
      <h4>People</h4>
      <table>
        ${row("Median age", c.age[i] == null ? NA : `${c.age[i]}`, vs(c.age[i], n.age, (v) => `${v}`))}
        ${row("Bachelor's degree or higher", pct(c.bachelors[i], 0), vs(c.bachelors[i], n.bachelors, (v) => `${v.toFixed(0)}%`))}
        ${row("Homeowners", pct(c.owners[i], 0), vs(c.owners[i], n.owners, (v) => `${v.toFixed(0)}%`))}
        ${row("Work from home", pct(c.wfh[i], 0), vs(c.wfh[i], n.wfh, (v) => `${v.toFixed(0)}%`))}
      </table>`
      : `<p class="card-note">Detailed statistics are only available for US towns so far.</p>`;

    const el = document.createElement("div");
    el.className = `town-card${collapsed ? " collapsed" : ""}`;
    el.innerHTML = `
      <div class="tc-head">
        <div>
          <div class="tc-name">${esc(c.name[i])}</div>
          <div class="tc-where">${esc(where)}</div>
        </div>
        <div class="tc-actions">
          ${pinned ? `<button class="tc-btn tc-toggle" title="Show or hide details">${collapsed ? "▸" : "▾"}</button>` : ""}
          <button class="tc-btn tc-pin${pinned ? " on" : ""}" title="${pinned ? "Unpin" : "Pin this card to the map"}">📌</button>
          <button class="tc-btn tc-close" title="${pinned ? "Unpin and close" : "Close"}">×</button>
        </div>
      </div>
      <div class="tc-summary">${short(c.pop[i])} people${c.growth[i] != null ? ` (${signed(c.growth[i])} since 2010)` : ""}${home != null || c.homeValue[i] != null ? ` · ${moneyShort((home ?? c.homeValue[i])!)} homes` : ""}</div>
      <div class="tc-body">
        ${usSections}
        <h4>Getting around</h4>
        <table>${row("Nearest airport with scheduled flights", c.airport[i] ? `${esc(c.airport[i]!)}, ${dist}` : NA)}</table>
        <h4>Climate here</h4>
        <table>${this.opts.climateRows(c.lon[i], c.lat[i])}</table>
        <h4>About</h4>
        <div class="tc-wiki">Looking up Wikipedia…</div>
        <div class="tc-links">
          <a href="https://www.google.com/maps/search/?api=1&query=${c.lat[i]},${c.lon[i]}" target="_blank" rel="noopener">Google Maps</a>
          ${us ? `<a href="https://www.zillow.com/homes/${encodeURIComponent(`${c.name[i]}, ${c.region[i]}`)}_rb/" target="_blank" rel="noopener">Zillow</a>` : ""}
        </div>
        ${us ? `<p class="card-note">Census: American Community Survey 2020–24. Home values: Zillow. Small towns have wide margins of error.</p>` : `<p class="card-note">Population: GeoNames.</p>`}
      </div>`;

    el.querySelector(".tc-pin")!.addEventListener("click", () => (pinned ? this.unpin(i) : this.pin(i)));
    el.querySelector(".tc-close")!.addEventListener("click", () => (pinned ? this.unpin(i) : this.closeCard()));
    el.querySelector(".tc-toggle")?.addEventListener("click", (ev) => {
      const collapsedNow = el.classList.toggle("collapsed");
      (ev.currentTarget as HTMLElement).textContent = collapsedNow ? "▸" : "▾";
      if (!collapsedNow) this.loadWiki(el, i);
    });
    if (!collapsed) this.loadWiki(el, i);
    return el;
  }

  private loadWiki(el: HTMLElement, i: number) {
    const box = el.querySelector(".tc-wiki") as HTMLElement;
    if (box.dataset.loaded) return;
    box.dataset.loaded = "1";
    const c = this.data.columns;
    wikipedia(c.name[i], c.lat[i], c.lon[i]).then((w) => {
      if (!w) {
        const q = encodeURIComponent(`${c.name[i]} ${c.region[i] ?? ""}`);
        box.innerHTML = `No matching Wikipedia article found. <a href="https://en.wikipedia.org/w/index.php?search=${q}" target="_blank" rel="noopener">Search Wikipedia</a>`;
        return;
      }
      box.innerHTML = `${w.thumb ? `<img src="${esc(w.thumb)}" alt="" loading="lazy" />` : ""}<p>${esc(w.extract)}</p><a href="${esc(w.url)}" target="_blank" rel="noopener">Read more on Wikipedia</a>`;
    });
  }
}
