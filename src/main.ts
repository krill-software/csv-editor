import "@krill-software/desktop-ui/styles";
import "./styles.css";

import {
  mountChrome,
  buildErrorState,
  showBootError,
  type ErrorStateRefs,
} from "@krill-software/desktop-ui";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

interface CsvRead {
  path: string;
  rows: string[][];
  byte_size: number;
}

// ---- Doc state -------------------------------------------------------

interface DocState {
  /** Absolute file path; null for the unsaved blank scratch sheet. */
  path: string | null;
  rows: string[][];
  cols: number;
  byteSize: number;
  dirty: boolean;
}
let doc: DocState | null = null;

/** A fresh empty grid. CSV editors traditionally open to a blank sheet
 *  (Excel "Book1", Sheets "Untitled spreadsheet"), so we do the same:
 *  50 rows × 10 cols of empty strings, no file path, not dirty. The user
 *  can start typing immediately, Save As to give it a real path. */
function blankDoc(): DocState {
  const ROWS = 50;
  const COLS = 10;
  const rows = Array.from({ length: ROWS }, () => Array(COLS).fill(""));
  return { path: null, rows, cols: COLS, byteSize: 0, dirty: false };
}

// ---- DOM refs (assigned in initChrome) -------------------------------

let titleEl: HTMLElement;
let infoEl: HTMLElement;
let stateEl: HTMLElement;
let viewportEl: HTMLElement;
let gridEl: HTMLElement;
let headerRowEl: HTMLElement;
let contentEl: HTMLElement;
let errorState: ErrorStateRefs;

// Visible-row windowing.
const ROW_HEIGHT = 24;
const COL_WIDTH = 120;
const ROW_HEADER_WIDTH = 56;
const OVERSCAN = 10;
const visibleRows = new Map<number, HTMLElement>();

// Active cell editor (the input element overlaid on a cell while editing).
interface Editing {
  row: number;
  col: number;
  input: HTMLInputElement;
  cellEl: HTMLElement;
  originalText: string;
}
let editing: Editing | null = null;

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

function cellAddress(row: number, col: number): string {
  return `${colLabel(col)}${row + 1}`;
}

// ---- Title + status --------------------------------------------------

function untitledName(): string {
  return "untitled.csv";
}

function refreshChrome() {
  if (!doc) return;
  const name = doc.path ? basename(doc.path) : untitledName();
  titleEl.textContent = name;

  const dim = `${doc.rows.length.toLocaleString()} × ${doc.cols.toLocaleString()}`;
  infoEl.textContent = doc.byteSize > 0
    ? `CSV · ${formatBytes(doc.byteSize)} · ${dim}`
    : `CSV · ${dim}`;
  if (!editing) stateEl.textContent = "—";

  document.body.dataset.dirty = String(doc.dirty);

  const winTitle = `${doc.dirty ? "• " : ""}${name} — CSV Editor`;
  document.title = winTitle;
  getCurrentWindow().setTitle(winTitle).catch(() => {});
}

// ---- Grid rendering (virtualized) ------------------------------------

function teardownGrid() {
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

  for (const [idx, el] of visibleRows) {
    if (idx < start || idx >= end) {
      el.remove();
      visibleRows.delete(idx);
    }
  }

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
    cell.dataset.row = String(idx);
    cell.dataset.col = String(c);
    cell.textContent = cells[c] ?? "";
    cell.addEventListener("mousedown", (e) => {
      // mousedown (not click) so the input gets focus before any blur fires.
      e.preventDefault();
      void startEdit(idx, c);
    });
    row.appendChild(cell);
  }
  return row;
}

function mountGrid() {
  if (!doc) return;
  buildHeader();
  contentEl.style.height = `${doc.rows.length * ROW_HEIGHT}px`;
  visibleRows.clear();
  contentEl.replaceChildren();
  viewportEl.scrollTop = 0;
  renderVisibleRows();
}

function findCellEl(row: number, col: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.cell.data[data-row="${row}"][data-col="${col}"]`,
  );
}

// ---- Cell editing ----------------------------------------------------

function startEdit(row: number, col: number) {
  if (!doc) return;
  if (editing && editing.row === row && editing.col === col) return;
  if (editing) commitEdit();

  const cellEl = findCellEl(row, col);
  if (!cellEl) return;

  const value = doc.rows[row]?.[col] ?? "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cell-input";
  input.value = value;
  cellEl.replaceChildren(input);
  cellEl.classList.add("editing");
  input.focus();
  input.select();

  editing = { row, col, input, cellEl, originalText: value };
  stateEl.textContent = cellAddress(row, col);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const next = commitEdit();
      if (next && doc && row + 1 < doc.rows.length) startEdit(row + 1, col);
      void next;
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      commitEdit();
      if (!doc) return;
      if (e.shiftKey) {
        if (col > 0) startEdit(row, col - 1);
        else if (row > 0) startEdit(row - 1, doc.cols - 1);
      } else {
        if (col + 1 < doc.cols) startEdit(row, col + 1);
        else if (row + 1 < doc.rows.length) startEdit(row + 1, 0);
      }
    }
  });

  input.addEventListener("blur", () => {
    // Blur can fire when we're already mid-commit/cancel; the null guard
    // makes the second pass a no-op.
    if (editing && editing.input === input) commitEdit();
  });
}

function commitEdit(): { changed: boolean } | null {
  if (!editing || !doc) return null;
  const { row, col, input, cellEl, originalText } = editing;
  const newValue = input.value;

  // Grow doc.rows / doc.rows[r] if a write reaches beyond current bounds
  // (defensive — current navigation can't get there, but cheap to allow).
  while (doc.rows.length <= row) doc.rows.push(Array(doc.cols).fill(""));
  while (doc.rows[row].length <= col) doc.rows[row].push("");

  const changed = doc.rows[row][col] !== newValue;
  doc.rows[row][col] = newValue;

  cellEl.replaceChildren();
  cellEl.textContent = newValue;
  cellEl.classList.remove("editing");
  editing = null;

  if (changed && !doc.dirty) {
    doc.dirty = true;
    refreshChrome();
  }
  // If unchanged we don't need refreshChrome (dirty state didn't change).
  stateEl.textContent = "—";
  // Suppress unused-var: originalText is kept for symmetry with cancelEdit
  void originalText;

  return { changed };
}

function cancelEdit() {
  if (!editing) return;
  const { cellEl, originalText } = editing;
  cellEl.replaceChildren();
  cellEl.textContent = originalText;
  cellEl.classList.remove("editing");
  editing = null;
  stateEl.textContent = "—";
}

// ---- Doc lifecycle ---------------------------------------------------

function setBlankDoc() {
  doc = blankDoc();
  document.body.dataset.state = "loaded";
  errorState.element.hidden = true;
  mountGrid();
  refreshChrome();
}

async function openPath(path: string): Promise<void> {
  let res: CsvRead;
  try {
    res = await invoke<CsvRead>("read_csv", { path });
  } catch (e) {
    console.error("read_csv failed:", e);
    errorState.setFilename(basename(path));
    document.body.dataset.state = "error";
    errorState.element.hidden = false;
    return;
  }

  const cols = res.rows.reduce((m, r) => Math.max(m, r.length), 0);
  doc = {
    path: res.path,
    rows: res.rows,
    cols,
    byteSize: res.byte_size,
    dirty: false,
  };
  document.body.dataset.state = "loaded";
  errorState.element.hidden = true;
  mountGrid();
  refreshChrome();
}

async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (typeof selected === "string") await openPath(selected);
}

async function save(): Promise<void> {
  if (!doc) return;
  if (editing) commitEdit();
  if (!doc.path) return saveAs();
  try {
    const written = await invoke<string>("write_csv", {
      path: doc.path,
      rows: doc.rows,
    });
    doc.path = written;
    doc.dirty = false;
    refreshChrome();
  } catch (e) {
    console.error("write_csv failed:", e);
  }
}

async function saveAs(): Promise<void> {
  if (!doc) return;
  if (editing) commitEdit();
  const target = await saveDialog({
    defaultPath: doc.path ?? untitledName(),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (typeof target !== "string") return;
  try {
    const written = await invoke<string>("write_csv", {
      path: target,
      rows: doc.rows,
    });
    doc.path = written;
    doc.dirty = false;
    refreshChrome();
  } catch (e) {
    console.error("write_csv failed:", e);
  }
}

// ---- Chrome ----------------------------------------------------------

function initChrome() {
  const chrome = mountChrome({
    productName: "CSV Editor",
    actions: {
      "new":        setBlankDoc,
      "open":       openViaDialog,
      "save":       save,
      "save-as":    saveAs,
      "fullscreen": toggleFullscreen,
    },
    showStatusLine: true,
  });
  titleEl = chrome.title;
  viewportEl = chrome.viewport;
  infoEl = chrome.statusInfo!;
  stateEl = chrome.statusState!;

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

  // Error placeholder lives over the grid — shown only when read_csv fails.
  // The empty placeholder is intentionally absent: the app boots straight
  // into a blank scratch sheet so the user can start editing immediately.
  errorState = buildErrorState({ message: "Can't parse this CSV." });
  errorState.element.hidden = true;
  viewportEl.appendChild(errorState.element);

  let scrollRaf = 0;
  viewportEl.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      renderVisibleRows();
    });
  }, { passive: true });

  document.body.dataset.state = "loaded";
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
      if (dev) { await openPath(dev); opened = true; }
    } catch { /* no test file */ }
  }

  if (!opened) setBlankDoc();
}

// teardownGrid is wired here so an unused-symbol warning doesn't get
// emitted while the function is reserved for future state transitions.
void teardownGrid;

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
