import type { Unit } from "./data";

export const settings = { imperial: true };

interface UnitSpec {
  label: string;
  conv: (v: number) => number;
  digits: number;
}
const same = (label: string, digits = 0): UnitSpec => ({ label, conv: (v) => v, digits });

type Plain = Exclude<Unit, "zone" | "people" | "usd" | "pct">;

/** Round to 2 significant figures for slider labels: 2,000 / 25,000 / 1,300,000. */
function nice(v: number): number {
  if (v === 0) return 0;
  const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) - 1);
  return Math.round(v / p) * p;
}

const imperial: Record<Plain, UnitSpec> = {
  degC: { label: "°F", conv: (c) => (c * 9) / 5 + 32, digits: 0 },
  mm: { label: "in", conv: (mm) => mm / 25.4, digits: 0 },
  km: { label: "mi", conv: (km) => km / 1.609344, digits: 0 },
  m: { label: "ft", conv: (m) => m * 3.28084, digits: 0 },
  hours: same("h"),
  Mbps: same("Mbps"),
};

const metric: Record<Plain, UnitSpec> = {
  degC: same("°C"),
  mm: same("mm"),
  km: same("km"),
  m: same("m"),
  hours: same("h"),
  Mbps: same("Mbps"),
};

/** Hardiness zones are stored continuously: 7.0–7.5 is 7a, 7.5–8.0 is 7b. */
function zoneLabel(v: number): string {
  const n = Math.floor(v);
  return `${n}${v - n >= 0.5 ? "b" : "a"}`;
}

/** Format a value stored in base (metric) units for display. */
export function fmt(value: number, unit: Unit, digits?: number): string {
  if (!Number.isFinite(value)) return "no data";
  if (unit === "zone") return zoneLabel(value);
  if (unit === "people") return nice(value).toLocaleString();
  if (unit === "usd") {
    const v = nice(value);
    return v >= 1e6 ? `$${(v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}M` : `$${Math.round(v / 1e3)}k`;
  }
  if (unit === "pct") return `${value > 0 ? "+" : ""}${Math.round(value)}%`;
  const u = (settings.imperial ? imperial : metric)[unit];
  const v = u.conv(value);
  const d = digits ?? u.digits;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })} ${u.label}`;
}
