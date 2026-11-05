use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    phase: String,
    current_version: String,
    version: Option<String>,
    downloaded: usize,
    total: Option<u64>,
    error: Option<String>,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            current_version: env!("CARGO_PKG_VERSION").into(),
            version: None,
            downloaded: 0,
            total: None,
            error: None,
        }
    }
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<Status>,
    update: Mutex<Option<Update>>,
}

pub async fn check(app: AppHandle) {
    let state = app.state::<Updates>();
    {
        let mut status = state.status.lock().unwrap();
        if matches!(
            status.phase.as_str(),
            "checking" | "downloading" | "installing" | "available"
        ) {
            return;
        }
        status.phase = "checking".into();
        status.error = None;
    }
    let result = match app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let mut status = state.status.lock().unwrap();
    match result {
        Ok(mut update) => {
            if let Some(package) = update.as_mut() {
                package.timeout = Some(Duration::from_secs(600));
            }
            status.phase = if update.is_some() {
                "available"
            } else {
                "current"
            }
            .into();
            status.version = update.as_ref().map(|value| value.version.clone());
            *state.update.lock().unwrap() = update;
        }
        Err(error) => {
            status.phase = "error".into();
            status.error = Some(error.to_string());
        }
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let checking = app.clone();
            check(checking).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

#[tauri::command]
pub async fn desktop_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Updates>,
    action: String,
) -> Result<Status, String> {
    if window.label() != "main" {
        return Err("updates are available in the main window".into());
    }
    match action.as_str() {
        "status" => {}
        "check" => {
            check(app.clone()).await;
        }
        "install" => {
            let update = {
                let mut status = state.status.lock().unwrap();
                if status.phase != "available" {
                    return Err("no update ready".into());
                }
                let update = state
                    .update
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or("no update ready")?;
                status.phase = "downloading".into();
                status.downloaded = 0;
                status.total = None;
                update
            };
            let result = update
                .download_and_install(
                    |length, total| {
                        let mut status = state.status.lock().unwrap();
                        status.downloaded += length;
                        status.total = total;
                    },
                    || {
                        state.status.lock().unwrap().phase = "installing".into();
                    },
                )
                .await;
            if let Err(error) = result {
                let mut status = state.status.lock().unwrap();
                status.phase = "available".into();
                status.error = Some(error.to_string());
                *state.update.lock().unwrap() = Some(update);
                return Err(error.to_string());
            }
            app.restart();
        }
        _ => return Err("invalid update action".into()),
    }
    let status = state.status.lock().unwrap().clone();
    Ok(status)
}
