// Sidebar widgets: numeric range filter (with histogram) and category checklist.

import { BINS, isActive, type CategoricalLayer, type NumericLayer } from "./engine";
import { fmt } from "./units";

const STEPS = 400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export interface Card {
  el: HTMLElement;
  refresh(): void;
}

export function numericCard(layer: NumericLayer, onChange: (kind: "range" | "variant") => void): Card {
  const { def } = layer;
  const card = el("div", "card");
  const head = el("div", "card-head");
  const title = el("span", "card-title", def.name);
  const value = el("span", "card-value");
  const reset = el("button", "link", "Reset");
  head.append(title, value, reset);
  card.append(head);
  if (def.description) card.append(el("p", "card-desc", def.description));

  if (def.variants) {
    const row = el("div", "segmented");
    row.append(el("span", "seg-label", `${def.variantLabel ?? "Variant"}:`));
    layer.bands.forEach((b, idx) => {
      const btn = el("button", "seg", b.label);
      btn.onclick = () => {
        layer.bandIndex = idx;
        row.querySelectorAll(".seg").forEach((s, j) => s.classList.toggle("on", j === idx));
        onChange("variant");
      };
      if (idx === layer.bandIndex) btn.classList.add("on");
      row.append(btn);
    });
    card.append(row);
  }

  const range = el("div", "range");
  const canvas = el("canvas", "hist");
  const loIn = el("input");
  const hiIn = el("input");
  for (const inp of [loIn, hiIn]) {
    inp.type = "range";
    inp.min = "0";
    inp.max = String(STEPS);
    inp.step = "1";
  }
  range.append(canvas, loIn, hiIn);
  const ends = el("div", "range-ends");
  const minLbl = el("span");
  const maxLbl = el("span");
  ends.append(minLbl, maxLbl);
  card.append(range, ends);

  const toValue = (pos: number) => def.min + ((def.max - def.min) * pos) / STEPS;
  const toPos = (v: number) => Math.round(((v - def.min) / (def.max - def.min)) * STEPS);

  const sync = () => {
    let lo = Number(loIn.value);
    let hi = Number(hiIn.value);
    if (lo > hi) [lo, hi] = [hi, lo];
    layer.lo = lo === 0 ? def.min : toValue(lo);
    layer.hi = hi === STEPS ? def.max : toValue(hi);
    onChange("range");
  };
  loIn.oninput = sync;
  hiIn.oninput = sync;
  reset.onclick = () => {
    loIn.value = "0";
    hiIn.value = String(STEPS);
    sync();
  };

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 260;
    const h = canvas.clientHeight || 44;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const full = layer.fullHist[layer.bandIndex];
    const cross = layer.crossHist;
    // sqrt scale keeps small-but-real bins visible next to dominant ones.
    const peak = Math.sqrt(Math.max(1, ...full));
    const bw = w / BINS;
    const style = getComputedStyle(card);
    const ghost = style.getPropertyValue("--hist-ghost").trim();
    const on = style.getPropertyValue("--hist-on").trim();
    const off = style.getPropertyValue("--hist-off").trim();
    for (let k = 0; k < BINS; k++) {
      const binLo = def.min + ((def.max - def.min) * k) / BINS;
      const binHi = def.min + ((def.max - def.min) * (k + 1)) / BINS;
      const inside = binHi > layer.lo && binLo < layer.hi;
      const fh = (Math.sqrt(full[k]) / peak) * (h - 2);
      const ch = cross ? (Math.sqrt(cross[k]) / peak) * (h - 2) : 0;
      ctx.fillStyle = ghost;
      ctx.fillRect(k * bw + 0.5, h - fh, bw - 1, fh);
      ctx.fillStyle = inside ? on : off;
      ctx.fillRect(k * bw + 0.5, h - ch, bw - 1, ch);
    }
  };

  return {
    el: card,
    refresh() {
      loIn.value = String(toPos(layer.lo));
      hiIn.value = String(toPos(layer.hi));
      const active = isActive(layer);
      card.classList.toggle("active", active);
      value.textContent = active ? `${fmt(layer.lo, def.unit)} – ${fmt(layer.hi, def.unit)}` : "Any";
      reset.hidden = !active;
      minLbl.textContent = fmt(def.min, def.unit);
      maxLbl.textContent = fmt(def.max, def.unit);
      draw();
    },
  };
}

export function categoryCard(layer: CategoricalLayer, onChange: () => void): Card {
  const card = el("div", "card");
  const head = el("div", "card-head");
  const value = el("span", "card-value");
  const reset = el("button", "link", "Reset");
  head.append(el("span", "card-title", layer.def.name), value, reset);
  const search = el("input", "search");
  search.type = "search";
  search.placeholder = "Search countries…";
  card.append(head, el("p", "card-desc", "Tick countries to limit results to them. None ticked means anywhere."), search);

  const boxes = new Map<number, HTMLInputElement>();
  const rows: { row: HTMLElement; name: string }[] = [];
  const groups = [...new Set(layer.def.categories.map((c) => c.group))];
  const list = el("div", "cat-list");
  for (const g of groups) {
    const cats = layer.def.categories.filter((c) => c.group === g).sort((a, b) => a.name.localeCompare(b.name));
    const gh = el("div", "cat-group");
    const all = el("button", "link", "all");
    const none = el("button", "link", "none");
    gh.append(el("strong", undefined, g), all, none);
    list.append(gh);
    const setAll = (on: boolean) => {
      for (const c of cats) on ? layer.selected.add(c.id) : layer.selected.delete(c.id);
      onChange();
    };
    all.onclick = () => setAll(true);
    none.onclick = () => setAll(false);
    for (const c of cats) {
      const row = el("label", "cat");
      const box = el("input");
      box.type = "checkbox";
      box.onchange = () => {
        box.checked ? layer.selected.add(c.id) : layer.selected.delete(c.id);
        onChange();
      };
      boxes.set(c.id, box);
      row.append(box, document.createTextNode(c.name));
      rows.push({ row, name: c.name.toLowerCase() });
      list.append(row);
    }
  }
  card.append(list);
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.row.hidden = q !== "" && !r.name.includes(q);
  };
  reset.onclick = () => {
    layer.selected.clear();
    onChange();
  };

  return {
    el: card,
    refresh() {
      for (const [id, box] of boxes) box.checked = layer.selected.has(id);
      const n = layer.selected.size;
      card.classList.toggle("active", n > 0);
      value.textContent = n === 0 ? "Any" : `${n} selected`;
      reset.hidden = n === 0;
    },
  };
}

export function group(title: string, open: boolean, cards: Card[]): HTMLElement {
  const d = el("details", "group");
  d.open = open;
  d.append(el("summary", undefined, title), ...cards.map((c) => c.el));
  return d;
}
