# CSV Editor

A minimal, single-window CSV editor for Linux. Open a comma-separated file, edit cells in an Excel-shaped grid, save.

Built on Tauri 2 (Rust + system webview) with a TypeScript frontend. CSV parsing via Rust's [`csv` crate](https://crates.io/crates/csv) (RFC-4180 quoted fields, embedded commas + newlines, escapes). See [SPEC.md](SPEC.md) for the design rationale.

v1 reads + writes comma-separated files. v2 adds a raw text mode and dialect auto-detect.

## Features

- **Open** — drag-drop, CLI arg, `Ctrl+O`. Format (v1): comma-separated `.csv`.
- **Virtualized grid** — handles large files; only visible rows are in the DOM.
- **Sticky header row + row-number column** — Excel-shaped.
- **Fullscreen** — `F` or `F11`, `Esc` to exit.
- **Quiet by design** — no settings panel, no toolbar, no theme switcher.

(Editing + save + undo land per the milestones in [SPEC.md](SPEC.md). M1 ships display-only.)

## Keybindings (M1)

| Action          | Key            |
|-----------------|----------------|
| Open            | `Ctrl+O`       |
| Fullscreen      | `F` or `F11`   |
| Exit fullscreen | `Esc`          |
| Close window    | `Ctrl+W`       |
| Quit            | `Ctrl+Q`       |

## Run from CLI

```sh
krill-csv-editor path/to/data.csv
```

Without an arg, the app starts empty — drag-drop or `Ctrl+O` to load.

## Build from source

Requires Rust 1.77+, Node 20+, pnpm, and Tauri 2's Linux build deps.

```sh
pnpm install
pnpm tauri dev      # development with hot reload
pnpm tauri build    # release artifacts in src-tauri/target/release/bundle/
```

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` (all three must match), then:

```sh
pnpm release
```

This runs `tauri build` and gathers AppImage + .deb under `release/v<version>/` with SHA256 checksums. Tag and push to trigger the GitHub Release workflow.

## License

MIT.
