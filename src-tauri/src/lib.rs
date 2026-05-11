use std::path::Path;

use serde::{Deserialize, Serialize};

use krill_desktop_core::{fs as kfs, state as kstate, dev as kdev};

const SLUG: &str = "krill-csv-editor";

#[derive(Debug, Serialize)]
struct CsvRead {
    path: String,
    rows: Vec<Vec<String>>,
    byte_size: u64,
}

/// Read + parse a comma-separated file. Uses the `csv` crate which handles
/// RFC-4180 quoted fields, embedded commas, embedded newlines, and double-
/// quote escapes.
#[tauri::command]
fn read_csv(path: String) -> Result<CsvRead, String> {
    let p = Path::new(&path);
    let bytes = kfs::read_bytes(p)?;
    let byte_size = bytes.len() as u64;

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(bytes.as_slice());

    let mut rows: Vec<Vec<String>> = Vec::new();
    for result in reader.records() {
        let rec = result.map_err(|e| format!("{path}: {e}"))?;
        rows.push(rec.iter().map(|s| s.to_string()).collect());
    }

    Ok(CsvRead {
        path: kfs::absolute_path(p),
        rows,
        byte_size,
    })
}

/// Write a 2-D array of strings back out as a CSV file. Round-trips
/// quoting + escaping via the `csv` crate.
#[tauri::command]
fn write_csv(path: String, rows: Vec<Vec<String>>) -> Result<String, String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| kfs::format_io_err(&path, e))?;
        }
    }
    let file = std::fs::File::create(p).map_err(|e| kfs::format_io_err(&path, e))?;
    let mut writer = csv::WriterBuilder::new().from_writer(file);
    for row in rows {
        writer.write_record(&row).map_err(|e| format!("{path}: {e}"))?;
    }
    writer.flush().map_err(|e| kfs::format_io_err(&path, e))?;
    Ok(kfs::absolute_path(p))
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    window: Option<kstate::WindowGeometry>,
    recent: Option<Vec<String>>,
}

#[tauri::command]
fn load_state() -> Option<AppState> {
    kstate::load(SLUG, "state.json")
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    kstate::save(SLUG, "state.json", &state)
}

#[tauri::command]
fn dev_test_file() -> Option<String> {
    kdev::test_file(env!("CARGO_MANIFEST_DIR"), &["test.csv", "sample.csv"])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_csv,
            write_csv,
            load_state,
            save_state,
            dev_test_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
