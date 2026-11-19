// Saved views: named snapshots of every filter and display setting, kept in this browser's
// localStorage, plus URL-hash sync so the current view survives reloads and can be shared.

export interface FilterState {
  lo?: number;
  hi?: number;
  band?: string;
}

export interface ViewState {
  viz: string;
  showExcluded: boolean;
  imperial: boolean;
  opacity: number;
  layers: Record<string, boolean>;
  filters: Record<string, FilterState>;
  countries: string[];
  /** Selected categories per category layer (e.g. biome names), by layer id. */
  cats?: Record<string, string[]>;
  /** Towns whose cards are pinned (town ids). */
  pins?: string[];
  /** Legacy (before town filters): minimum town population. Read on load, no longer written. */
  townMinPop?: number;
  terrain3d?: boolean;
  exaggeration?: number;
}

interface SavedView {
  name: string;
  saved: string;
  state: ViewState;
}

const STORAGE_KEY = "sunflower.views.v1";

function loadSaved(): SavedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((v) => v && typeof v.name === "string" && v.state) : [];
  } catch {
    return [];
  }
}

function storeSaved(list: SavedView[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Stable key for comparing states (property order independent). */
export function stateKey(s: ViewState): string {
  const sortKeys = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : Array.isArray(v)
        ? [...v].sort()
        : v;
  return JSON.stringify(sortKeys(s));
}

export function encodeState(s: ViewState): string {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeState(text: string): Partial<ViewState> | null {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export interface ViewsPanel {
  /** Call after every state change to update the "current" marker. */
  refresh(current: ViewState): void;
}

export function viewsPanel(
  root: HTMLElement,
  api: { get(): ViewState; set(s: Partial<ViewState>): void; reset(): void },
): ViewsPanel {
  let saved = loadSaved();
  let currentKey = "";

  const form = el("form", "views-form");
  const input = el("input", "search");
  input.placeholder = "Name this view, e.g. “Mild & near a city”";
  input.maxLength = 60;
  const saveBtn = el("button", "btn", "Save");
  saveBtn.type = "submit";
  form.append(input, saveBtn);

  const list = el("div", "views-list");
  const status = el("p", "views-status");
  const tools = el("div", "views-tools");
  const copyBtn = el("button", "link", "Copy link to this view");
  const exportBtn = el("button", "link", "Export");
  const importBtn = el("button", "link", "Import");
  const resetBtn = el("button", "link", "Clear all filters");
  const file = el("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.hidden = true;
  tools.append(copyBtn, exportBtn, importBtn, resetBtn, file);
  root.append(
    el("p", "card-desc", "Save the current filters and map settings under a name, then switch between them. Views are stored in this browser."),
    form,
    list,
    tools,
    status,
  );

  const say = (msg: string) => {
    status.textContent = msg;
    clearTimeout((say as unknown as { t?: number }).t);
    (say as unknown as { t?: number }).t = window.setTimeout(() => (status.textContent = ""), 4000);
  };

  const persist = () => {
    if (!storeSaved(saved)) say("Couldn't save: this browser is blocking local storage.");
    draw();
  };

  function draw() {
    list.replaceChildren();
    if (saved.length === 0) {
      list.append(el("p", "views-empty", "No saved views yet."));
      return;
    }
    for (const v of saved) {
      const row = el("div", "view-row");
      const open = el("button", "view-name", v.name);
      open.title = `Saved ${new Date(v.saved).toLocaleString()}`;
      open.onclick = () => {
        api.set(v.state);
        say(`Switched to “${v.name}”.`);
      };
      const del = el("button", "view-del", "×");
      del.title = `Delete “${v.name}”`;
      del.setAttribute("aria-label", `Delete ${v.name}`);
      del.onclick = () => {
        if (!confirm(`Delete the saved view “${v.name}”?`)) return;
        saved = saved.filter((s) => s !== v);
        persist();
      };
      row.classList.toggle("current", stateKey(v.state) === currentKey);
      row.append(open, del);
      list.append(row);
    }
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    const state = api.get();
    const existing = saved.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.state = state;
      existing.saved = new Date().toISOString();
      say(`Updated “${existing.name}”.`);
    } else {
      saved.push({ name, saved: new Date().toISOString(), state });
      saved.sort((a, b) => a.name.localeCompare(b.name));
      say(`Saved “${name}”.`);
    }
    input.value = "";
    persist();
  };

  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      say("Link copied. Opening it restores these filters and settings.");
    } catch {
      say("Copy the address bar: it always holds the current view.");
    }
  };

  exportBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sunflower-views.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  importBtn.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    try {
      const incoming = JSON.parse(await f.text());
      if (!Array.isArray(incoming)) throw new Error("not a list");
      let added = 0;
      for (const v of incoming) {
        if (!v || typeof v.name !== "string" || typeof v.state !== "object") continue;
        saved = saved.filter((s) => s.name.toLowerCase() !== v.name.toLowerCase());
        saved.push({ name: v.name, saved: v.saved ?? new Date().toISOString(), state: v.state });
        added++;
      }
      saved.sort((a, b) => a.name.localeCompare(b.name));
      persist();
      say(`Imported ${added} view${added === 1 ? "" : "s"}.`);
    } catch {
      say("That file doesn't look like a Sunflower views export.");
    }
  };

  resetBtn.onclick = () => {
    api.reset();
    say("All filters cleared.");
  };

  draw();
  return {
    refresh(current) {
      const key = stateKey(current);
      if (key === currentKey) return;
      currentKey = key;
      draw();
    },
  };
}
