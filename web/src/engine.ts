// Filtering, cross-filtered histograms and colouring. Pure computation, no DOM.

import type { Band, Catalog, CategoricalLayerDef, Grid, NumericLayerDef } from "./data";

export const BINS = 48;

export interface NumericLayer {
  def: NumericLayerDef;
  bands: Band[];
  bandIndex: number;
  /** Filter bounds in base units. The filter is inactive when it spans [def.min, def.max]. */
  lo: number;
  hi: number;
  /** Where "Reset" returns the lower bound (defaults to def.min). */
  defaultLo?: number;
  /** Histogram of all in-region cells, per band (computed once). */
  fullHist: Uint32Array[];
  /** Histogram of cells passing every *other* filter (recomputed on change). */
  crossHist: Uint32Array;
}

export interface CategoricalLayer {
  def: CategoricalLayerDef;
  values: Uint8Array;
  /** Selected category ids; empty = no restriction. */
  selected: Set<number>;
}

export interface Result {
  pass: Uint8Array;
  matchCount: number;
  regionCount: number;
  /** Min/max of the visualised layer among matching cells (base units). */
  vizMin: number;
  vizMax: number;
  /** Matching cells with no value for the visualised layer. */
  vizNoData: number;
}

export const band = (l: NumericLayer): Band => l.bands[l.bandIndex];
export const isActive = (l: NumericLayer): boolean => l.lo > l.def.min || l.hi < l.def.max;

export class Engine {
  readonly grid: Grid;
  readonly n: number;
  readonly nodata: number;
  readonly country: CategoricalLayer;
  readonly numeric: NumericLayer[];
  readonly regionCount: number;

  constructor(catalog: Catalog, country: CategoricalLayer, numeric: NumericLayer[]) {
    this.grid = catalog.grid;
    this.n = catalog.grid.cols * catalog.grid.rows;
    this.nodata = catalog.grid.nodata;
    this.country = country;
    this.numeric = numeric;
    let c = 0;
    for (let i = 0; i < this.n; i++) if (country.values[i] !== 0) c++;
    this.regionCount = c;
    for (const l of numeric) l.fullHist = l.bands.map((b) => this.histogram(l, b));
  }

  private binOf(l: NumericLayer, b: Band, raw: number): number {
    const v = raw * b.scale + b.offset;
    const k = Math.floor(((v - l.def.min) / (l.def.max - l.def.min)) * BINS);
    return k < 0 ? 0 : k >= BINS ? BINS - 1 : k;
  }

  private histogram(l: NumericLayer, b: Band): Uint32Array {
    const h = new Uint32Array(BINS);
    const cv = this.country.values;
    for (let i = 0; i < this.n; i++) {
      const raw = b.values[i];
      if (cv[i] !== 0 && raw !== this.nodata) h[this.binOf(l, b, raw)]++;
    }
    return h;
  }

  /** Recompute matches. Also fills each layer's cross-filter histogram in the same pass. */
  run(viz: NumericLayer | null): Result {
    const { n, nodata } = this;
    const cv = this.country.values;
    const catActive = this.country.selected.size > 0;
    const allowed = new Uint8Array(256);
    for (const id of this.country.selected) allowed[id] = 1;

    const L = this.numeric.length;
    const arrs = this.numeric.map((l) => band(l).values);
    const active = this.numeric.map(isActive);
    // Convert bounds to raw int16 space so the hot loop compares integers.
    const loRaw = this.numeric.map((l) => Math.ceil((l.lo - band(l).offset) / band(l).scale));
    const hiRaw = this.numeric.map((l) => Math.floor((l.hi - band(l).offset) / band(l).scale));
    for (const l of this.numeric) l.crossHist = new Uint32Array(BINS);

    const vizIdx = viz ? this.numeric.indexOf(viz) : -1;
    // Fine histogram of the visualised layer over matching cells, for a percentile colour stretch.
    const VB = 1024;
    let vizNoData = 0;
    const vizHist = new Uint32Array(VB);
    const vizLayer = viz;
    const vizBand = viz ? band(viz) : null;
    const vizBin = (raw: number) => {
      const v = raw * vizBand!.scale + vizBand!.offset;
      const k = Math.floor(((v - vizLayer!.def.min) / (vizLayer!.def.max - vizLayer!.def.min)) * VB);
      return k < 0 ? 0 : k >= VB ? VB - 1 : k;
    };

    const pass = new Uint8Array(n);
    let matchCount = 0;
    for (let i = 0; i < n; i++) {
      const c = cv[i];
      if (c === 0) continue;
      let fails = 0;
      let failIdx = -1;
      if (catActive && allowed[c] === 0) {
        fails++;
        failIdx = -2;
      }
      for (let k = 0; k < L && fails < 2; k++) {
        if (!active[k]) continue;
        const v = arrs[k][i];
        if (v === nodata || v < loRaw[k] || v > hiRaw[k]) {
          fails++;
          failIdx = k;
        }
      }
      if (fails === 0) {
        pass[i] = 1;
        matchCount++;
        for (let k = 0; k < L; k++) {
          const v = arrs[k][i];
          if (v !== nodata) this.numeric[k].crossHist[this.binOf(this.numeric[k], band(this.numeric[k]), v)]++;
        }
        if (vizIdx >= 0) {
          const v = arrs[vizIdx][i];
          if (v !== nodata) vizHist[vizBin(v)]++;
          else vizNoData++;
        }
      } else if (fails === 1 && failIdx >= 0) {
        // Fails only this layer's own filter: counts toward that layer's cross-filter histogram.
        const v = arrs[failIdx][i];
        if (v !== nodata) this.numeric[failIdx].crossHist[this.binOf(this.numeric[failIdx], band(this.numeric[failIdx]), v)]++;
      }
    }

    // Clip the colour scale to the 2nd–98th percentile so a few outliers don't wash it out.
    let vizMin = NaN;
    let vizMax = NaN;
    const total = vizHist.reduce((a, b) => a + b, 0);
    if (viz && total > 0) {
      const binValue = (k: number) => viz.def.min + ((viz.def.max - viz.def.min) * k) / VB;
      let acc = 0;
      for (let k = 0; k < VB; k++) {
        acc += vizHist[k];
        if (Number.isNaN(vizMin) && acc >= total * 0.02) vizMin = binValue(k);
        if (acc >= total * 0.98) {
          vizMax = binValue(k + 1);
          break;
        }
      }
    }
    return { pass, matchCount, regionCount: this.regionCount, vizMin, vizMax, vizNoData };
  }

  /** Colour every grid cell (row-major, north-up, lat/lon grid) into packed RGBA ints. */
  colorize(
    res: Result,
    viz: NumericLayer | null,
    lut: Uint32Array,
    matchColor: number,
    excludedColor: number,
    noDataColor: number,
  ): Uint32Array {
    const { n, nodata } = this;
    const cv = this.country.values;
    const out = new Uint32Array(n);
    const vb = viz ? band(viz) : null;
    const span = res.vizMax - res.vizMin || 1;
    for (let i = 0; i < n; i++) {
      if (cv[i] === 0) continue;
      if (!res.pass[i]) {
        out[i] = excludedColor;
      } else if (vb) {
        const raw = vb.values[i];
        if (raw === nodata) {
          out[i] = noDataColor;
        } else {
          const t = (raw * vb.scale + vb.offset - res.vizMin) / span;
          out[i] = lut[Math.max(0, Math.min(255, Math.round(t * 255)))];
        }
      } else {
        out[i] = matchColor;
      }
    }
    return out;
  }

  /** Total land area (km²) of the matching cells. Cells shrink toward the poles. */
  areaKm2(pass: Uint8Array): number {
    const { cols, rows, res, north } = this.grid;
    const side = (res * Math.PI * 6371) / 180;
    let total = 0;
    for (let r = 0; r < rows; r++) {
      let count = 0;
      for (let i = r * cols, end = i + cols; i < end; i++) count += pass[i];
      if (count) total += count * side * side * Math.cos(((north - (r + 0.5) * res) * Math.PI) / 180);
    }
    return total;
  }

  /** Index of the cell containing a lon/lat, or -1 if outside the grid. */
  cellAt(lon: number, lat: number): number {
    const g = this.grid;
    const col = Math.floor((lon - g.west) / g.res);
    const row = Math.floor((g.north - lat) / g.res);
    if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) return -1;
    return row * g.cols + col;
  }

  valueAt(l: NumericLayer, b: Band, i: number): number {
    const raw = b.values[i];
    return raw === this.nodata ? NaN : raw * b.scale + b.offset;
  }
}
