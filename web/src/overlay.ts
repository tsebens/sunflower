// Turns the lat/lon cell colours into a Web Mercator image and keeps it on the map.

import type * as maplibregl from "maplibre-gl";
import type { Grid } from "./data";

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y: number) => (Math.atan(Math.sinh(y)) * 180) / Math.PI;

export class GridOverlay {
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private rowMap: Int32Array;
  private url: string | null = null;
  private pending = false;
  private queued: Uint32Array | null = null;

  constructor(
    private map: maplibregl.Map,
    private grid: Grid,
    beforeId?: string,
  ) {
    const top = mercY(grid.north);
    const bottom = mercY(grid.south);
    const lonSpan = ((grid.east - grid.west) * Math.PI) / 180;
    // Square output pixels in Mercator space: no grid row is ever skipped (rows only stretch poleward).
    const height = Math.round(grid.cols * ((top - bottom) / lonSpan));
    this.canvas.width = grid.cols;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d")!;
    this.rowMap = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      const lat = invMercY(top - ((y + 0.5) / height) * (top - bottom));
      this.rowMap[y] = Math.min(grid.rows - 1, Math.max(0, Math.floor((grid.north - lat) / grid.res)));
    }

    map.addSource("grid", {
      type: "image",
      url: this.blankUrl(),
      coordinates: [
        [grid.west, grid.north],
        [grid.east, grid.north],
        [grid.east, grid.south],
        [grid.west, grid.south],
      ],
    });
    map.addLayer(
      {
        id: "grid",
        type: "raster",
        source: "grid",
        paint: { "raster-resampling": "nearest", "raster-opacity": 0.85, "raster-fade-duration": 0 },
      },
      beforeId,
    );
  }

  private blankUrl(): string {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.toDataURL();
  }

  setOpacity(o: number) {
    this.map.setPaintProperty("grid", "raster-opacity", o);
  }

  /** Draw new cell colours. Calls that arrive mid-upload are coalesced to the latest. */
  update(colors: Uint32Array) {
    if (this.pending) {
      this.queued = colors;
      return;
    }
    this.pending = true;
    const { cols } = this.grid;
    const img = this.ctx.createImageData(cols, this.canvas.height);
    const out = new Uint32Array(img.data.buffer);
    for (let y = 0; y < this.rowMap.length; y++) {
      const r = this.rowMap[y];
      out.set(colors.subarray(r * cols, (r + 1) * cols), y * cols);
    }
    this.ctx.putImageData(img, 0, 0);
    this.canvas.toBlob((blob) => {
      const prev = this.url;
      this.url = URL.createObjectURL(blob!);
      (this.map.getSource("grid") as maplibregl.ImageSource).updateImage({ url: this.url });
      if (prev) setTimeout(() => URL.revokeObjectURL(prev), 2000);
      this.pending = false;
      if (this.queued) {
        const next = this.queued;
        this.queued = null;
        this.update(next);
      }
    });
  }
}
