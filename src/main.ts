import "@krill-software/desktop-ui/styles";
import "./styles.css";

import {
  mountChrome,
  buildErrorState,
  showBootError,
  buildTextSearch,
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
  /** Delimiter the file was parsed with, as a one-char string (auto-detected
   *  in Rust). Round-tripped on save so a `;`- or tab-separated file stays in
   *  its original dialect. */
  delimiter: string;
}

// ---- Doc state -------------------------------------------------------

interface DocState {
  /** Absolute file path; null for the unsaved blank scratch sheet. */
  path: string | null;
  rows: string[][];
  cols: number;
  byteSize: number;
  dirty: boolean;
  /** Delimiter to write with — the one the file was opened with, or "," for a
   *  fresh scratch sheet. Keeps saves in the file's original dialect. */
  delimiter: string;
  /** Per-column pixel widths, session-only (not persisted). Starts at
   *  COL_WIDTH for every column; the header's drag handle changes it. */
  colWidths: number[];
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
  return {
    path: null,
    rows,
    cols: COLS,
    byteSize: 0,
    dirty: false,
    delimiter: ",",
    colWidths: Array(COLS).fill(COL_WIDTH),
  };
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
const MIN_COL_WIDTH = 32;
const CELL_PADDING = 8; // must match .cell padding in styles.css
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

// The highlighted cell — persists after an edit ends, drives the status
// line's right half. Spreadsheets always have one cell selected; we open
// on A1 and follow the cursor from there.
let active: { row: number; col: number } | null = null;

// Search state
let searchQuery = "";
const searchMatches = new Set<string>();

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function updateSearchHighlights() {
  searchMatches.clear();
  if (!doc || !searchQuery) {
    visibleRows.forEach((row) => {
      row.querySelectorAll(".cell.match").forEach((el) => el.classList.remove("match"));
    });
    return;
  }

  const query = searchQuery.toLowerCase();
  for (let r = 0; r < doc.rows.length; r++) {
    for (let c = 0; c < doc.cols; c++) {
      const cell = doc.rows[r]?.[c] ?? "";
      if (cell.toLowerCase().includes(query)) {
        searchMatches.add(cellKey(r, c));
      }
    }
  }

  visibleRows.forEach((row) => {
    row.querySelectorAll(".cell.data").forEach((el) => {
      const r = el.getAttribute("data-row");
      const c = el.getAttribute("data-col");
      if (r !== null && c !== null && searchMatches.has(cellKey(Number(r), Number(c)))) {
        el.classList.add("match");
      } else {
        el.classList.remove("match");
      }
    });
  });

  if (searchMatches.size > 0) {
    const firstMatch = Array.from(searchMatches)[0].split(",").map(Number);
    const firstMatchEl = findCellEl(firstMatch[0], firstMatch[1]);
    if (firstMatchEl) {
      firstMatchEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

// ---- Helpers ---------------------------------------------------------

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
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

  refreshState();

  document.body.dataset.dirty = String(doc.dirty);

  const winTitle = `${doc.dirty ? "• " : ""}${name} — CSV Editor`;
  document.title = winTitle;
  getCurrentWindow()
    .setTitle(winTitle)
    .catch(() => {});
}

/** Right half of the status line: highlighted cell │ width × height. */
function refreshState() {
  if (!doc) return;
  const cell = active ? cellAddress(active.row, active.col) : "—";
  const dims = `${doc.cols.toLocaleString()} × ${doc.rows.length.toLocaleString()}`;
  stateEl.textContent = `${cell} │ ${dims}`;
}

/** Move the highlight, repainting the old and new cells if they're mounted. */
function setActive(row: number, col: number) {
  if (active) findCellEl(active.row, active.col)?.classList.remove("active");
  active = { row, col };
  findCellEl(row, col)?.classList.add("active");
  refreshState();
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

/** `grid-template-columns` for the header and every row: the row-number
 *  gutter followed by one track per column at its current width. */
function gridTemplate(): string {
  if (!doc) return "";
  return `${ROW_HEADER_WIDTH}px ${doc.colWidths.map((w) => `${w}px`).join(" ")}`;
}

/** Push the current column widths to the header and all mounted rows. */
function applyColWidths() {
  const tpl = gridTemplate();
  headerRowEl.style.gridTemplateColumns = tpl;
  visibleRows.forEach((row) => {
    row.style.gridTemplateColumns = tpl;
  });
}

function setColWidth(col: number, width: number) {
  if (!doc) return;
  doc.colWidths[col] = Math.max(MIN_COL_WIDTH, Math.round(width));
  applyColWidths();
}

/** Width that fits the column's widest value (or its letter label) exactly.
 *  The grid is monospace, so the longest string by character count is the
 *  widest one; measure just that one instead of every cell. */
function fitColWidth(col: number): number {
  if (!doc) return COL_WIDTH;
  let longest = colLabel(col);
  for (const row of doc.rows) {
    const v = row[col];
    if (v && v.length > longest.length) longest = v;
  }
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return COL_WIDTH;
  ctx.font = getComputedStyle(gridEl).font;
  // +1 for the cell's right border.
  return Math.ceil(ctx.measureText(longest).width) + CELL_PADDING * 2 + 1;
}

function buildHeader() {
  if (!doc) return;
  headerRowEl.replaceChildren();
  headerRowEl.style.gridTemplateColumns = gridTemplate();

  const corner = document.createElement("div");
  corner.className = "cell corner";
  headerRowEl.appendChild(corner);

  for (let c = 0; c < doc.cols; c++) {
    const cell = document.createElement("div");
    cell.className = "cell col-header";
    cell.textContent = colLabel(c);
    cell.appendChild(buildColResizeHandle(c));
    headerRowEl.appendChild(cell);
  }
}

/** Drag handle on a column header's right edge: drag to resize, double-click
 *  to snap the column to its content width. */
function buildColResizeHandle(col: number): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "col-resize";
  let dragged = false;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !doc) return;
    e.preventDefault();
    if (editing) commitEdit();
    const startX = e.clientX;
    const startW = doc.colWidths[col];
    dragged = false;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.dataset.resizing = "true";

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) dragged = true;
      setColWidth(col, startW + dx);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.classList.remove("dragging");
      delete document.body.dataset.resizing;
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });

  handle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    // A drag ends with a click; don't let a quick second click after a
    // drag be read as "fit to content".
    if (dragged) {
      dragged = false;
      return;
    }
    setColWidth(col, fitColWidth(col));
  });

  return handle;
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

      // Apply search highlights to newly rendered row
      if (searchQuery) {
        row.querySelectorAll(".cell.data").forEach((el) => {
          const r = el.getAttribute("data-row");
          const c = el.getAttribute("data-col");
          if (r !== null && c !== null && searchMatches.has(cellKey(Number(r), Number(c)))) {
            el.classList.add("match");
          }
        });
      }
    }
  }
}

function buildRow(idx: number): HTMLElement {
  if (!doc) throw new Error("buildRow without doc");
  const row = document.createElement("div");
  row.className = "grid-row";
  row.style.top = `${idx * ROW_HEIGHT}px`;
  row.style.gridTemplateColumns = gridTemplate();

  const rh = document.createElement("div");
  rh.className = "cell row-header";
  rh.textContent = String(idx + 1);
  row.appendChild(rh);

  const cells = doc.rows[idx] ?? [];
  for (let c = 0; c < doc.cols; c++) {
    const cell = document.createElement("div");
    cell.className = "cell data";
    if (active && active.row === idx && active.col === c) {
      cell.classList.add("active");
    }
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
  active = { row: 0, col: 0 };
  buildHeader();
  contentEl.style.height = `${doc.rows.length * ROW_HEIGHT}px`;
  visibleRows.clear();
  contentEl.replaceChildren();
  viewportEl.scrollTop = 0;
  renderVisibleRows();
}

function findCellEl(row: number, col: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.cell.data[data-row="${row}"][data-col="${col}"]`);
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
  setActive(row, col);

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

  // Clear `editing` before touching the DOM: removing the input fires its
  // blur handler, which would otherwise re-enter commitEdit mid-removal.
  editing = null;
  cellEl.replaceChildren();
  cellEl.textContent = newValue;
  cellEl.classList.remove("editing");

  if (changed && !doc.dirty) {
    doc.dirty = true;
    refreshChrome();
  }
  // Rows may have grown above; keep the dimensions readout in sync.
  refreshState();
  // Suppress unused-var: originalText is kept for symmetry with cancelEdit
  void originalText;

  return { changed };
}

function cancelEdit() {
  if (!editing) return;
  const { cellEl, originalText } = editing;
  editing = null; // see commitEdit
  cellEl.replaceChildren();
  cellEl.textContent = originalText;
  cellEl.classList.remove("editing");
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
    delimiter: res.delimiter || ",",
    colWidths: Array(cols).fill(COL_WIDTH),
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
    // The delimiter is auto-detected on read, so the picker isn't limited to
    // `.csv` — semicolon / tab files often carry other extensions (.tsv, .txt,
    // .kmm2, …). "All files" lets any delimited text through.
    filters: [
      { name: "Delimited text", extensions: ["csv", "tsv", "tab", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
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
      delimiter: doc.delimiter,
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
      delimiter: doc.delimiter,
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
      new: setBlankDoc,
      open: openViaDialog,
      save: save,
      "save-as": saveAs,
      fullscreen: toggleFullscreen,
    },
    showStatusLine: true,
    updater: true,
  });
  titleEl = chrome.title;
  viewportEl = chrome.viewport;
  infoEl = chrome.statusInfo!;
  stateEl = chrome.statusState!;
  // Left half is the static app version (vX.Y.Z), set once at boot.
  infoEl.textContent = `v${__APP_VERSION__}`;

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
  viewportEl.addEventListener(
    "scroll",
    () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        renderVisibleRows();
      });
    },
    { passive: true },
  );

  document.body.dataset.state = "loaded";

  // Setup text search box.
  const search = buildTextSearch({
    onChange: (value: string) => {
      searchQuery = value;
      updateSearchHighlights();
    },
    onClose: () => {
      gridEl.focus();
    },
  });
  search.element.style.position = "absolute";
  gridEl.appendChild(search.element);

  // Ctrl+F to toggle search.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      search.open();
    }
  });
}

async function toggleFullscreen(): Promise<void> {
  const w = getCurrentWindow();
  const isFs = await w.isFullscreen().catch(() => false);
  await w.setFullscreen(!isFs).catch(() => {});
  document.body.dataset.fullscreen = isFs ? "false" : "true";
}

function installFullscreenEscape() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && document.body.dataset.fullscreen === "true") {
        e.preventDefault();
        void toggleFullscreen();
      }
    },
    { capture: true },
  );
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
  } catch {
    /* cli plugin unavailable */
  }

  if (!opened && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) {
        await openPath(dev);
        opened = true;
      }
    } catch {
      /* no test file */
    }
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
