// Catalog types and binary layer loading.

export type Unit = "degC" | "mm" | "km";

export interface Grid {
  west: number;
  east: number;
  south: number;
  north: number;
  res: number;
  cols: number;
  rows: number;
  nodata: number;
}

export interface Category {
  id: number;
  code: string;
  name: string;
  group: string;
}

interface Quantized {
  file: string;
  scale: number;
  offset: number;
  min: number;
  max: number;
}

export interface VariantDef extends Quantized {
  key: string;
  label: string;
}

export interface NumericLayerDef extends Partial<Quantized> {
  id: string;
  name: string;
  description?: string;
  group: string;
  type: "numeric";
  unit: Unit;
  colormap: string;
  source: string;
  min: number;
  max: number;
  variantLabel?: string;
  variants?: VariantDef[];
}

export interface CategoricalLayerDef {
  id: string;
  name: string;
  group: string;
  type: "categorical";
  file: string;
  source: string;
  categories: Category[];
}

export type LayerDef = NumericLayerDef | CategoricalLayerDef;

export interface Catalog {
  grid: Grid;
  layers: LayerDef[];
}

/** One concrete band of values (a layer, or one variant of a layer). */
export interface Band {
  key: string;
  label: string;
  values: Int16Array;
  scale: number;
  offset: number;
}

const DATA_URL = `${import.meta.env.BASE_URL}data/`;

export async function loadCatalog(): Promise<Catalog> {
  const res = await fetch(`${DATA_URL}catalog.json`);
  if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status}`);
  return res.json();
}

async function loadBytes(file: string): Promise<ArrayBuffer> {
  const res = await fetch(`${DATA_URL}${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  // Some servers transparently decode .gz (Content-Encoding); only gunzip if still gzipped.
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export async function loadInt16(file: string): Promise<Int16Array> {
  return new Int16Array(await loadBytes(file));
}

export async function loadUint8(file: string): Promise<Uint8Array> {
  return new Uint8Array(await loadBytes(file));
}

export async function loadBands(def: NumericLayerDef): Promise<Band[]> {
  const specs: VariantDef[] = def.variants ?? [
    { key: "", label: "", file: def.file!, scale: def.scale!, offset: def.offset ?? 0, min: def.min, max: def.max },
  ];
  return Promise.all(
    specs.map(async (s) => ({
      key: s.key,
      label: s.label,
      scale: s.scale,
      offset: s.offset,
      values: await loadInt16(s.file),
    })),
  );
}
