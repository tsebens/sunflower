// Colour ramps, expanded into 256-entry lookup tables of packed ABGR (little-endian RGBA) ints.

const RAMPS: Record<string, string[]> = {
  // ColorBrewer RdYlBu, reversed: cold = blue, hot = red.
  temperature: ["#313695", "#4575b4", "#74add1", "#abd9e9", "#e0f3f8", "#ffffbf", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"],
  // ColorBrewer YlGnBu: dry = pale, wet = deep blue.
  precipitation: ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#253494", "#081d58"],
  // ColorBrewer BrBG: dry = brown, muggy = teal.
  humidity: ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#c7eae5", "#80cdc1", "#35978f", "#01665e"],
  // Overcast slate to bright gold.
  sunshine: ["#3d4a5c", "#5f6b78", "#8b8d86", "#b9a77a", "#ddbf5a", "#f5d33a", "#ffe873"],
  // Hardiness-map style: cold purple/blue through green to hot orange/red.
  zones: ["#7b3fa0", "#4a5fcf", "#2f9fd0", "#3dba8f", "#8fcf55", "#e6d84a", "#f4a43c", "#e6612f", "#b8232f"],
  // Lowland green, upland tan, high brown.
  elevation: ["#3f7f4f", "#8db86a", "#e3dc96", "#d1ab70", "#a87a55", "#7b5a4a"],
  // Magma: slow = dark, fast = bright.
  speed: ["#1c1044", "#4f127b", "#812581", "#b5367a", "#e55064", "#fb8761", "#fec287", "#fcfdbf"],
  // Bare to dense forest.
  trees: ["#f1ead0", "#d6e2a8", "#a9cd7f", "#72b05b", "#3f8c45", "#1d6634", "#0b3f23"],
  // Viridis.
  distance: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"],
};

export const MATCH_COLOR = "#e8a317";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function pack(r: number, g: number, b: number, a: number): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function rampStops(name: string): string[] {
  return RAMPS[name] ?? RAMPS.distance;
}

const cache = new Map<string, Uint32Array>();

export function lut(name: string, alpha = 220): Uint32Array {
  const key = `${name}:${alpha}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const stops = rampStops(name).map(hexToRgb);
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    const f = t - k;
    const [r0, g0, b0] = stops[k];
    const [r1, g1, b1] = stops[k + 1];
    out[i] = pack(
      Math.round(r0 + (r1 - r0) * f),
      Math.round(g0 + (g1 - g0) * f),
      Math.round(b0 + (b1 - b0) * f),
      alpha,
    );
  }
  cache.set(key, out);
  return out;
}

export function solid(hex: string, alpha: number): number {
  const [r, g, b] = hexToRgb(hex);
  return pack(r, g, b, alpha);
}
