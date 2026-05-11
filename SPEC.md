# CSV Editor — Spec (v1)

A minimal, single-window Linux CSV editor. Open a comma-separated file, see it as an Excel-shaped grid, edit cells in place, save. **The product is the calm** — the bar is "spreadsheet feel without the menu sprawl of LibreOffice Calc."

v1 reads + writes comma-separated files. v2 adds a raw text mode + dialect auto-detect.

## Naming (this app)

| Where        | Value                                       |
|--------------|---------------------------------------------|
| Slug         | `csv-editor`                                |
| Binary       | `krill-csv-editor`                          |
| Cargo lib    | `krill_csv_editor_lib`                      |
| productName  | `CSV Editor`                                |
| Identifier   | `software.krill.csv-editor`                 |
| Directory    | `krill-software/csv-editor/`                |
| Repo         | `krill-software/csv-editor`                 |
| State dir    | `$XDG_STATE_HOME/krill-csv-editor/`         |
| Lucide icon  | `table`                                     |

Convention lives in [STYLE.md](https://github.com/krill-software/.github/blob/main/STYLE.md) → Naming.

## Goals

- Open a CSV and start editing in under ~200 ms for files under 5 MB.
- **Excel-shaped grid**: sticky header row + sticky row-number column. Click a cell to edit, arrow keys to navigate, Tab/Enter to commit.
- Handle large files without freezing — virtualized row rendering, only the visible window is in the DOM.
- Round-trip CSV faithfully: quoted fields, embedded commas, embedded newlines, double-quote escapes — all preserved on save.
- Feel like a native Linux desktop app (`.desktop` entry, file association, XDG dirs).

## Non-goals (v1)

- **No formulas.** This isn't a calculator — just a tabular text editor.
- **No multi-sheet workbooks.** A CSV file is one table.
- **No charts, no pivot tables, no conditional formatting.**
- **No dialect auto-detect.** Comma only in v1. `;`-separated and tab-separated come in v2.
- **No raw / text view mode.** Single Excel-shaped grid in v1. Raw mode in v2.
- **No add / remove / reorder columns or rows from a UI.** v1 edits cell contents only. (Edits via raw mode arrive in v2.)
- **No sort, no filter.** Same — v2.
- **No multi-document tabs.** One window per file, krill rule.
- **No undo / redo across saves.** Per-session in-memory undo only.
- **No CSV-to-anything export.** It's a CSV editor; save as CSV.
- **No settings panel, no preferences, no theme switcher.**
- **No Windows / macOS builds.**

## Stack

- **Shell:** Tauri 2. Mirrors document-viewer.
- **Frontend:** TypeScript + Vite. No framework.
- **Chrome + palette:** [`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui).
- **Rust state + fs:** [`krill-desktop-core`](https://github.com/krill-software/desktop-core).
- **CSV parsing:** Rust's [`csv` crate](https://crates.io/crates/csv). Battle-tested; handles RFC-4180 quoted fields, embedded commas, embedded newlines, double-quote escapes.
- **Grid rendering:** plain DOM. Virtualized rows via absolute positioning + a scrollable container; render only the visible window + a small overscan buffer (~10 rows above/below).

## Architecture

```
[CLI arg / drag-drop / Open dialog]
        │
        ▼
  Rust: read file bytes, parse via `csv` crate → Vec<Vec<String>>
        │
        ▼
  Frontend: in-memory rows[][], dimensions stored
        │
        ▼
  Virtualized grid:
    - sticky header row (column letters: A, B, C, …)
    - sticky row-number column (1, 2, 3, …)
    - main area: only DOM nodes for visible rows + small overscan
    - on scroll: window slides, DOM nodes recycle
        │
        ▼
  Cell click → input overlay → Enter commits → mark dirty
        │
        ▼
  Save (Ctrl+S) / Save As (Ctrl+Shift+S):
    Rust serializes rows[][] via `csv` crate, writes to disk
```

- **All-rows-in-memory.** v1 loads the entire file into memory. A 100 MB CSV with mostly short cells fits in ~200 MB of RAM after JS string overhead. Streaming-edit is a future concern.
- **Virtualized rendering, not virtualized data.** All rows live in JS; only visible ones are DOM-mounted. Editing a non-visible row works fine; it just isn't rendered yet.
- **No incremental save.** A save writes the whole file. CSVs aren't usually huge enough to make this a problem.

## Features (v1)

### File I/O
- **Open**: drag-drop, CLI arg (`krill-csv-editor data.csv`), `Ctrl+O` dialog.
- **Save**: `Ctrl+S` — writes back to the opened path.
- **Save As**: `Ctrl+Shift+S` — pick a new path, becomes the new "current path."
- **Recent files**: last 10, persisted in XDG state, reachable via `Ctrl+R`.
- **Dirty marker**: `•` prefix on the centered filename in the titlebar.
- **Confirm-on-close-if-dirty**: standard `confirm()` dialog when closing with unsaved changes.

### Grid view (the "main view")
- **Sticky header row** — A, B, C, … AA, AB, … (Excel-style column letters).
- **Sticky row-number column** — 1, 2, 3, … on the left.
- **Default column width**: 120 px. (Per-column resize comes later.)
- **Default row height**: 24 px (matches the krill chrome scale).
- **Selection**: clicked cell gets the `--fm-accent` border. Single cell only in v1.
- **Cursor visible** — always know which cell is "active."

### Cell editing
- **Enter edit mode**: double-click, `F2`, `Enter`, or just start typing.
- **Edit overlay**: a `<textarea>` (1-line by default; grows to fit if the cell value contains newlines) appears on top of the cell, populated with the current value.
- **Commit**: `Enter` (single-line) or `Ctrl+Enter` (multi-line cells). Moves selection down one row.
- **Commit and move right**: `Tab`. Wraps at end-of-row to next row, first cell.
- **Cancel**: `Esc`. Cell reverts to pre-edit value.
- **Mark dirty**: any commit that changes the cell content sets `body[data-dirty="true"]`.

### Navigation (no edit mode)
- **Arrow keys**: move selection one cell.
- **Tab / Shift+Tab**: next / previous cell, row-wrapping.
- **Enter / Shift+Enter**: down / up one cell.
- **Home / End**: first / last cell in the current row.
- **Ctrl+Home / Ctrl+End**: first cell / last cell of the document.
- **PgUp / PgDn**: scroll a viewport-height worth of rows; selection follows.

### Virtualized scrolling
- All rows are tracked in JS; only the visible window (plus ~10 rows of overscan above + below) is in the DOM.
- Each row's vertical position is `row-index × 24px`, set via `transform` on the row element.
- The grid container has a tall placeholder div whose height = `totalRows × 24px` so the browser scrollbar sizes correctly.
- On scroll: compute the visible row range, recycle DOM nodes to new row indices. Same pattern as document-viewer's lazy page rendering.

### Status line
- **LEFT (info)**: `CSV · {size} · {rows} × {cols}` (e.g. "CSV · 2.4 MB · 12,043 × 8").
- **RIGHT (state)**: current cell address — `A12`, `BC4567` etc. Excel-style.

## UX principles

1. **One window, one CSV.** Opening a second file launches a second process.
2. **Two chrome surfaces only.** Custom titlebar + thin status line. No toolbar.
3. **Keyboard-first, mouse-honest.** Every navigation has a key; mouse-click selects.
4. **No modal dialogs.** Open / Save As are the only OS dialogs.
5. **The grid is the surface.** No floating panels, no overlay UI except the inline cell editor.

## Window chrome

- Custom titlebar (drag region + min / max / close, inline menu).
- Centered filename with `•` dirty prefix.
- Body uses the package's grid (titlebar / main / status).
- No aux pane.
- Default window: 1200 × 760, min 480 × 360.

## Keybindings (v1)

| Action | Key |
|---|---|
| Open | `Ctrl+O` |
| Save | `Ctrl+S` |
| Save As | `Ctrl+Shift+S` |
| Recent files | `Ctrl+R` |
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Shift+Z` |
| Enter edit mode | `F2` / `Enter` / double-click / typing |
| Commit edit | `Enter` (single-line) / `Ctrl+Enter` (multi-line) / `Tab` |
| Cancel edit | `Esc` |
| Move (no edit) | arrows, `Tab`, `Shift+Tab`, `Enter`, `Shift+Enter`, `Home`, `End` |
| Jump | `Ctrl+Home` / `Ctrl+End` / `PgUp` / `PgDn` |
| Fullscreen | `F` or `F11` |
| Close window | `Ctrl+W` |
| Quit | `Ctrl+Q` |

## File handling

- **Format in/out (v1)**: comma-separated only. RFC-4180-conformant quoting via the `csv` crate.
- **Encoding**: UTF-8 in, UTF-8 out. Files with BOM are tolerated on read; the BOM is preserved on save.
- **Line endings**: LF on save. Read tolerates CRLF and CR.
- **External changes**: not watched.
- **Symlinks**: followed.

## Linux integration

- Binary name: `krill-csv-editor`.
- `.desktop` file with MIME type: `text/csv`.
- Registered as a candidate handler, not the default.
- Config: `$XDG_CONFIG_HOME/krill-csv-editor/config.toml` (empty in v1).
- State: `$XDG_STATE_HOME/krill-csv-editor/` — window geometry, recent files.
- Distribution: AppImage primary; `.deb` secondary.

## v2 — sketched, not committed

- **Raw text mode**: toggle between grid and a CodeMirror-style text view, like markdown-editor's preview toggle. Same `Ctrl+E` shortcut.
- **Dialect auto-detect**: sniff the separator (`,`, `;`, `\t`) from the first 64 KB of the file.
- **Add / remove rows + columns** from the UI (right-click row/column header).
- **Multi-cell selection + copy / paste** (Excel-compatible TSV on the clipboard).
- **Sort + filter** column-by-column.
- **Per-column widths** persisted per-file (in state).

The v1 SPEC stays clean; v2 will get its own SPEC supplement when we get there.

## Out of scope / open questions

- **Formula bar.** Adds a whole expression engine — different shape of app.
- **Pivot tables / charts.** Different shape of app.
- **Encrypted / password-protected files.** Not a CSV concept; if anyone wants this, decrypt outside the app first.
- **Auto-save.** v1 only saves on explicit Ctrl+S. Auto-save risks silently overwriting; defer until the dirty-tracking + undo loop is solid.

## Milestones

1. **M1 — Skeleton + display.** Tauri app launches, opens a CSV via CLI arg / drag-drop / `Ctrl+O`, parses via the `csv` crate, renders the grid (sticky header + row numbers, virtualized rows). Cells are read-only at this milestone — display only.
2. **M2 — Navigation.** Arrow keys, `Tab` / `Shift+Tab`, `Enter`, `Home` / `End`, `Ctrl+Home` / `Ctrl+End`, `PgUp` / `PgDn`. Cell-address status indicator (`A12`, `BC4567`).
3. **M3 — Editing.** Inline cell editor (textarea overlay), commit / cancel keys, dirty tracking, in-memory edits.
4. **M4 — Save + recents.** `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+R`, confirm-on-close-if-dirty. Round-trip a non-trivial file (quotes, embedded commas, embedded newlines) and verify byte-equivalence where possible.
5. **M5 — Undo + polish + packaging.** In-memory undo stack (`Ctrl+Z` / `Ctrl+Shift+Z`), empty state, error state, AppImage + `.deb` build, GitHub release workflow, landing page.
