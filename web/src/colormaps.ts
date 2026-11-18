// Colour ramps, expanded into 256-entry lookup tables of packed ABGR (little-endian RGBA) ints.

const RAMPS: Record<string, string[]> = {
  // ColorBrewer RdYlBu, reversed: cold = blue, hot = red.
  temperature: ["#313695", "#4575b4", "#74add1", "#abd9e9", "#e0f3f8", "#ffffbf", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"],
  // ColorBrewer YlGnBu: dry = pale, wet = deep blue.
  precipitation: ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#253494", "#081d58"],
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
