use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{webview::DownloadEvent, Manager, Webview};

#[derive(Default)]
pub struct Downloads {
    pending: Mutex<HashMap<String, VecDeque<PathBuf>>>,
}

fn available_destination(directory: &Path, suggested: &Path, active: &HashSet<PathBuf>) -> PathBuf {
    let raw = suggested.file_name().unwrap_or_default().to_string_lossy();
    let clean: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = clean.trim_end_matches(['.', ' ']);
    let name = if name.is_empty() { "download" } else { name };
    let name_path = Path::new(name);
    let stem = name_path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = name_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for number in 0_u64.. {
        let filename = if number == 0 {
            name.to_owned()
        } else {
            format!("{stem} ({number}){extension}")
        };
        let candidate = directory.join(filename);
        if !candidate.exists() && !active.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn report(webview: &Webview, status: &str, path: Option<&Path>) {
    let payload = serde_json::json!({
        "status": status,
        "name": path.and_then(Path::file_name).map(|n| n.to_string_lossy()),
        "path": path.map(|p| p.to_string_lossy()),
    });
    let _ = webview.eval(format!("window.__yunweiDownloadStatus?.({payload})"));
}

pub fn handle(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let state = webview.state::<Downloads>();
    match event {
        DownloadEvent::Requested { url, destination } => {
            let directory = if super::automation_port().is_some() {
                std::env::var_os("WOC_E2E_DOWNLOAD_DIR")
                    .map(PathBuf::from)
                    .or_else(|| webview.path().download_dir().ok())
            } else {
                webview.path().download_dir().ok()
            };
            let Some(directory) = directory.filter(|p| p.is_absolute()) else {
                report(&webview, "failed", None);
                return false;
            };
            if std::fs::create_dir_all(&directory).is_err() {
                report(&webview, "failed", None);
                return false;
            }
            let Ok(mut pending) = state.pending.lock() else {
                return false;
            };
            let active = pending.values().flatten().cloned().collect();
            *destination = available_destination(&directory, destination, &active);
            pending
                .entry(url.to_string())
                .or_default()
                .push_back(destination.clone());
            report(&webview, "started", Some(destination));
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            // WKWebView omits the completed path; retain the destination selected above.
            let tracked = state.pending.lock().ok().and_then(|mut pending| {
                let queue = pending.get_mut(url.as_str())?;
                let index = path
                    .as_ref()
                    .and_then(|p| queue.iter().position(|entry| entry == p))
                    .unwrap_or(0);
                let selected = queue.remove(index);
                if queue.is_empty() {
                    pending.remove(url.as_str());
                }
                selected
            });
            report(
                &webview,
                if success { "finished" } else { "failed" },
                path.as_deref().or(tracked.as_deref()),
            );
            true
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_unicode_names_and_avoids_existing_or_active_downloads() {
        let directory =
            std::env::temp_dir().join(format!("yunwei-download-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let original = directory.join("聊天记录.txt");
        std::fs::write(&original, b"original").unwrap();
        let active = HashSet::from([directory.join("聊天记录 (1).txt")]);
        let chosen = available_destination(&directory, Path::new("聊天记录.txt"), &active);
        assert_eq!(chosen, directory.join("聊天记录 (2).txt"));
        assert_eq!(std::fs::read(&original).unwrap(), b"original");
        std::fs::remove_file(original).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
