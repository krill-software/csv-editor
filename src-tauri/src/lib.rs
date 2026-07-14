use std::path::Path;

use serde::{Deserialize, Serialize};

use krill_desktop_core::{fs as kfs, state as kstate, dev as kdev, updater::BuilderExt};

const SLUG: &str = "krill-csv-editor";

#[derive(Debug, Serialize)]
struct CsvRead {
    path: String,
    rows: Vec<Vec<String>>,
    byte_size: u64,
    /// The delimiter the file was parsed with, as a one-character string
    /// (`","`, `";"`, `"\t"`, `"|"`). The frontend round-trips it on save so
    /// a semicolon file stays a semicolon file.
    delimiter: String,
}

/// Delimiters we sniff for, in preference order. Comma is first so it wins
/// exact ties (the RFC-4180 default).
const DELIMITERS: [u8; 4] = [b',', b';', b'\t', b'|'];

/// Field counts for the first `max_records` rows when the sample is parsed
/// with `delim`. Uses the real csv parser so quoted fields containing the
/// delimiter are counted correctly, not naively split.
fn field_counts(sample: &[u8], delim: u8, max_records: usize) -> Vec<usize> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delim)
        .from_reader(sample);
    rdr.records()
        .take(max_records)
        .filter_map(|r| r.ok().map(|rec| rec.len()))
        .collect()
}

/// The most common value in `counts`; ties break toward the larger count.
fn mode_of(counts: &[usize]) -> usize {
    use std::collections::HashMap;
    let mut freq: HashMap<usize, usize> = HashMap::new();
    for &c in counts {
        *freq.entry(c).or_insert(0) += 1;
    }
    freq.into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)))
        .map(|(count, _)| count)
        .unwrap_or(0)
}

/// Auto-detect the field delimiter from a sample of the file. For each
/// candidate we look at how the sampled rows split: a delimiter that actually
/// structures the file produces a stable, multi-column row shape, while one
/// that's absent leaves every row as a single field. We pick the delimiter
/// whose modal (most common) column count is >= 2 and matches the most rows.
///
/// Preamble / metadata lines with an odd field count — a leading `VER ...`
/// line, a scattered `TEXT ...` row — are simply outvoted by the bulk of the
/// data rows, so they don't derail detection. Falls back to comma when no
/// delimiter yields more than one column (a genuinely single-column file).
fn detect_delimiter(bytes: &[u8]) -> u8 {
    // Sniff the first 64 KB, trimmed back to the last complete line so we
    // never score a half-parsed final row.
    let cap = bytes.len().min(64 * 1024);
    let mut sample = &bytes[..cap];
    if cap < bytes.len() {
        if let Some(nl) = sample.iter().rposition(|&b| b == b'\n') {
            sample = &sample[..=nl];
        }
    }

    let mut best: Option<(u8, f64)> = None; // (delimiter, consistency ratio)
    for &delim in &DELIMITERS {
        let counts = field_counts(sample, delim, 1000);
        if counts.is_empty() {
            continue;
        }
        let mode = mode_of(&counts);
        if mode < 2 {
            continue; // delimiter never actually appears — skip it
        }
        let matching = counts.iter().filter(|&&c| c == mode).count();
        let ratio = matching as f64 / counts.len() as f64;
        // Higher consistency wins; strict `>` keeps the earlier (more
        // conventional) candidate on an exact tie.
        if best.map_or(true, |(_, r)| ratio > r) {
            best = Some((delim, ratio));
        }
    }
    best.map(|(d, _)| d).unwrap_or(b',')
}

/// Parse a `delimiter` string from the frontend into a single byte, defaulting
/// to comma for an empty / missing value.
fn delimiter_byte(delimiter: Option<String>) -> u8 {
    delimiter
        .and_then(|s| s.as_bytes().first().copied())
        .unwrap_or(b',')
}

/// Read + parse a delimited text file. The delimiter (`,`, `;`, tab, or `|`)
/// is auto-detected from the file's contents, so semicolon- and tab-separated
/// files — and files with a metadata header line — open as real grids rather
/// than a single wall-of-text column. Uses the `csv` crate, which handles
/// RFC-4180 quoted fields, embedded delimiters, embedded newlines, and
/// double-quote escapes for whichever delimiter was detected.
#[tauri::command]
fn read_csv(path: String) -> Result<CsvRead, String> {
    let p = Path::new(&path);
    let bytes = kfs::read_bytes(p)?;
    let byte_size = bytes.len() as u64;

    let delim = detect_delimiter(&bytes);

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delim)
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
        delimiter: (delim as char).to_string(),
    })
}

/// Write a 2-D array of strings back out as a delimited file. Round-trips
/// quoting + escaping via the `csv` crate, and preserves the `delimiter` the
/// file was opened with (comma for new / blank sheets).
#[tauri::command]
fn write_csv(path: String, rows: Vec<Vec<String>>, delimiter: Option<String>) -> Result<String, String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| kfs::format_io_err(&path, e))?;
        }
    }
    let delim = delimiter_byte(delimiter);
    let file = std::fs::File::create(p).map_err(|e| kfs::format_io_err(&path, e))?;
    let mut writer = csv::WriterBuilder::new().delimiter(delim).from_writer(file);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_comma() {
        let s = b"a,b,c\n1,2,3\n4,5,6\n";
        assert_eq!(detect_delimiter(s), b',');
    }

    #[test]
    fn detects_semicolon() {
        let s = b"a;b;c\n1;2;3\n4;5;6\n";
        assert_eq!(detect_delimiter(s), b';');
    }

    #[test]
    fn detects_tab() {
        let s = b"a\tb\tc\n1\t2\t3\n";
        assert_eq!(detect_delimiter(s), b'\t');
    }

    #[test]
    fn single_column_falls_back_to_comma() {
        let s = b"alpha\nbeta\ngamma\n";
        assert_eq!(detect_delimiter(s), b',');
    }

    #[test]
    fn metadata_header_line_does_not_derail_detection() {
        // A 2-field preamble line atop many tab-separated data rows: the data
        // rows outvote the header, so tab still wins.
        let mut s = String::from("VER\tsome version string = x\n");
        for i in 0..50 {
            s.push_str(&format!("POS\t{i}\ta\tb\tc\td\n"));
        }
        assert_eq!(detect_delimiter(s.as_bytes()), b'\t');
    }

    #[test]
    fn comma_data_with_stray_semicolons_stays_comma() {
        // Consistent comma structure beats an inconsistent semicolon split.
        let s = b"name,note\nalice,hi; there\nbob,a;b;c\ncarol,ok\n";
        assert_eq!(detect_delimiter(s), b',');
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .with_updater()
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
