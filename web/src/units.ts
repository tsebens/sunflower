import type { Unit } from "./data";

export const settings = { imperial: true };

const imperial: Record<Unit, { label: string; conv: (v: number) => number; digits: number }> = {
  degC: { label: "°F", conv: (c) => (c * 9) / 5 + 32, digits: 0 },
  mm: { label: "in", conv: (mm) => mm / 25.4, digits: 0 },
  km: { label: "mi", conv: (km) => km / 1.609344, digits: 0 },
};

const metric: Record<Unit, { label: string; conv: (v: number) => number; digits: number }> = {
  degC: { label: "°C", conv: (c) => c, digits: 0 },
  mm: { label: "mm", conv: (mm) => mm, digits: 0 },
  km: { label: "km", conv: (km) => km, digits: 0 },
};

/** Format a value stored in base (metric) units for display. */
export function fmt(value: number, unit: Unit, digits?: number): string {
  if (!Number.isFinite(value)) return "no data";
  const u = (settings.imperial ? imperial : metric)[unit];
  const v = u.conv(value);
  const d = digits ?? u.digits;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })} ${u.label}`;
}
