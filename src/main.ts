import "@krill-software/desktop-ui/styles";
import "./styles.css";

import {
  mountChrome,
  buildEmptyState,
  buildErrorState,
  showBootError,
  type ErrorStateRefs,
} from "@krill-software/desktop-ui";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

interface CsvRead {
  path: string;
  rows: string[][];
  byte_size: number;
}

interface AppState {
  window?: { width: number; height: number; x: number; y: number };
  recent?: string[];
}

// ---- DOM refs (assigned in initChrome) -------------------------------

let titleEl: HTMLElement;
let infoEl: HTMLElement;      // status-info (file identity)
let stateEl: HTMLElement;     // status-state (cell address)
let viewportEl: HTMLElement;
let gridEl: HTMLElement;
let headerRowEl: HTMLElement;
let contentEl: HTMLElement;
let emptyEl: HTMLElement;
let errorState: ErrorStateRefs;

// ---- Doc state -------------------------------------------------------

interface DocState {
  path: string;
  rows: string[][];
  cols: number;
  byteSize: number;
}
let doc: DocState | null = null;

// Visible-row windowing.
const ROW_HEIGHT = 24;       // matches the krill chrome scale
const COL_WIDTH = 120;       // default cell width
const ROW_HEADER_WIDTH = 56; // gutter for row numbers
const OVERSCAN = 10;
const visibleRows = new Map<number, HTMLElement>();

// ---- Helpers ---------------------------------------------------------

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Excel-style column label: 0→A, 25→Z, 26→AA, 701→ZZ, 702→AAA. */
function colLabel(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ---- Display state ---------------------------------------------------

type Display = "empty" | "loaded" | "error";
function setDisplay(s: Display) {
  document.body.dataset.state = s;
  emptyEl.hidden = s !== "empty";
  errorState.element.hidden = s !== "error";
  if (s !== "loaded") {
    titleEl.textContent = "";
    infoEl.textContent = "";
    stateEl.textContent = "";
    teardownGrid();
  }
}

// ---- Grid rendering (virtualized) ------------------------------------

function teardownGrid() {
  doc = null;
  visibleRows.clear();
  if (headerRowEl) headerRowEl.replaceChildren();
  if (contentEl) {
    contentEl.style.height = "0px";
    contentEl.replaceChildren();
  }
}

function buildHeader() {
  if (!doc) return;
  headerRowEl.replaceChildren();
  headerRowEl.style.gridTemplateColumns =
    `${ROW_HEADER_WIDTH}px repeat(${doc.cols}, ${COL_WIDTH}px)`;

  const corner = document.createElement("div");
  corner.className = "cell corner";
  headerRowEl.appendChild(corner);

  for (let c = 0; c < doc.cols; c++) {
    const cell = document.createElement("div");
    cell.className = "cell col-header";
    cell.textContent = colLabel(c);
    headerRowEl.appendChild(cell);
  }
}

function renderVisibleRows() {
  if (!doc) return;
  const scrollTop = viewportEl.scrollTop;
  const viewportH = viewportEl.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportH) / ROW_HEIGHT);
  const start = Math.max(0, firstVisible - OVERSCAN);
  const end = Math.min(doc.rows.length, lastVisible + OVERSCAN);

  // Recycle out-of-window rows.
  for (const [idx, el] of visibleRows) {
    if (idx < start || idx >= end) {
      el.remove();
      visibleRows.delete(idx);
    }
  }

  // Mount rows that entered the window.
  for (let i = start; i < end; i++) {
    if (!visibleRows.has(i)) {
      const row = buildRow(i);
      contentEl.appendChild(row);
      visibleRows.set(i, row);
    }
  }
}

function buildRow(idx: number): HTMLElement {
  if (!doc) throw new Error("buildRow without doc");
  const row = document.createElement("div");
  row.className = "grid-row";
  row.style.top = `${idx * ROW_HEIGHT}px`;
  row.style.gridTemplateColumns =
    `${ROW_HEADER_WIDTH}px repeat(${doc.cols}, ${COL_WIDTH}px)`;

  const rh = document.createElement("div");
  rh.className = "cell row-header";
  rh.textContent = String(idx + 1);
  row.appendChild(rh);

  const cells = doc.rows[idx] ?? [];
  for (let c = 0; c < doc.cols; c++) {
    const cell = document.createElement("div");
    cell.className = "cell data";
    cell.textContent = cells[c] ?? "";
    row.appendChild(cell);
  }
  return row;
}

function mountGrid(loaded: CsvRead) {
  const cols = loaded.rows.reduce((m, r) => Math.max(m, r.length), 0);
  doc = {
    path: loaded.path,
    rows: loaded.rows,
    cols,
    byteSize: loaded.byte_size,
  };

  buildHeader();
  contentEl.style.height = `${doc.rows.length * ROW_HEIGHT}px`;
  visibleRows.clear();
  contentEl.replaceChildren();
  renderVisibleRows();
}

// ---- Title + status --------------------------------------------------

function updateChromeFor(name: string) {
  titleEl.textContent = name;
  if (doc) {
    const rows = doc.rows.length.toLocaleString();
    const cols = doc.cols.toLocaleString();
    infoEl.textContent = `CSV · ${formatBytes(doc.byteSize)} · ${rows} × ${cols}`;
    stateEl.textContent = "—";
  }
  const title = `${name} — CSV Editor`;
  document.title = title;
  getCurrentWindow().setTitle(title).catch(() => {});
}

function showError(path: string) {
  errorState.setFilename(basename(path));
  setDisplay("error");
}

// ---- File open -------------------------------------------------------

async function openPath(path: string): Promise<void> {
  let res: CsvRead;
  try {
    res = await invoke<CsvRead>("read_csv", { path });
  } catch (e) {
    console.error("read_csv failed:", e);
    showError(path);
    return;
  }

  setDisplay("loaded");
  mountGrid(res);
  updateChromeFor(basename(res.path));
}

async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (typeof selected === "string") await openPath(selected);
}

// ---- Chrome ----------------------------------------------------------

function initChrome() {
  const chrome = mountChrome({
    productName: "CSV Editor",
    actions: {
      "open":       openViaDialog,
      "fullscreen": toggleFullscreen,
    },
    showStatusLine: true,
  });
  titleEl = chrome.title;
  viewportEl = chrome.viewport;
  infoEl = chrome.statusInfo!;
  stateEl = chrome.statusState!;

  // Build the grid scaffold inside the viewport.
  gridEl = document.createElement("div");
  gridEl.id = "grid";
  viewportEl.appendChild(gridEl);

  headerRowEl = document.createElement("div");
  headerRowEl.id = "grid-header";
  headerRowEl.className = "grid-header";
  gridEl.appendChild(headerRowEl);

  contentEl = document.createElement("div");
  contentEl.id = "grid-content";
  contentEl.className = "grid-content";
  contentEl.style.height = "0px";
  gridEl.appendChild(contentEl);

  emptyEl = buildEmptyState();
  viewportEl.appendChild(emptyEl);

  errorState = buildErrorState({ message: "Can't parse this CSV." });
  errorState.element.hidden = true;
  viewportEl.appendChild(errorState.element);

  // Rebuild the visible window as the user scrolls (rAF-throttled).
  let scrollRaf = 0;
  viewportEl.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      renderVisibleRows();
    });
  }, { passive: true });

  document.body.dataset.state = "empty";
}

async function toggleFullscreen(): Promise<void> {
  const w = getCurrentWindow();
  const isFs = await w.isFullscreen().catch(() => false);
  await w.setFullscreen(!isFs).catch(() => {});
  document.body.dataset.fullscreen = isFs ? "false" : "true";
}

function installFullscreenEscape() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.dataset.fullscreen === "true") {
      e.preventDefault();
      void toggleFullscreen();
    }
  }, { capture: true });
}

async function installFileDrop() {
  const wv = getCurrentWebview();
  await wv.onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      const path = e.payload.paths[0];
      if (path) await openPath(path);
    }
  });
}

let resizeRaf = 0;
window.addEventListener("resize", () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (doc) renderVisibleRows();
  });
});

async function boot() {
  initChrome();
  installFullscreenEscape();
  await installFileDrop();

  // Keep the load_state round-trip warm — window-geometry restore + save-on
  // -resize get wired in alongside undo/redo in M5.
  try { await invoke<AppState | null>("load_state"); } catch { /* ignore */ }

  let opened = false;
  try {
    const matches = await getMatches();
    const arg = matches.args.file?.value;
    if (typeof arg === "string" && arg.length > 0) {
      await openPath(arg);
      opened = true;
    }
  } catch { /* cli plugin unavailable */ }

  if (!opened && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) await openPath(dev);
    } catch { /* no test file */ }
  }
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
