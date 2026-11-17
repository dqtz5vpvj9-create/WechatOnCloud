use tauri::WebviewWindow;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDragItem {
    name: String,
    ticket: String,
    directory: bool,
}

#[tauri::command]
pub fn start_remote_file_drag(
    window: WebviewWindow,
    id: String,
    files: Vec<RemoteDragItem>,
) -> Result<(), String> {
    if window.label() != super::MAIN_WINDOW || !super::main_window_is_foreground(&window) {
        return Err("桌面窗口未激活".into());
    }
    if id.len() < 6
        || id.len() > 64
        || !id.bytes().all(|c| c.is_ascii_hexdigit())
        || files.is_empty()
        || files.len() > 50
    {
        return Err("无效的文件拖拽请求".into());
    }
    for file in &files {
        if file.name.is_empty()
            || file.name.len() > 240
            || file.name == "."
            || file.name == ".."
            || file
                .name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            || file.ticket.len() != 43
            || !file
                .ticket
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("无效的文件拖拽请求".into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::fs::OpenOptions;
        use std::time::Duration;
        use tauri_plugin_dragout::{DragItem, DragOptions};
        let url = format!("{}api/instances/{}/drag-download", super::APP_URL, id);
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(1800))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法创建下载连接")?;
        let items = files
            .into_iter()
            .map(|file| {
                let filename = if file.directory {
                    format!("{}.zip", file.name)
                } else {
                    file.name
                };
                let url = url.clone();
                let client = client.clone();
                DragItem::promise(filename, move |destination| {
                    let mut response = client
                        .get(&url)
                        .header("x-woc-file-ticket", &file.ticket)
                        .send()
                        .map_err(|_| "连接失败".to_string())?;
                    if !response.status().is_success() {
                        return Err("远程文件下载失败".into());
                    }
                    let mut output = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination)
                        .map_err(|_| "无法创建目标文件".to_string())?;
                    if std::io::copy(&mut response, &mut output).is_err() {
                        drop(output);
                        let _ = std::fs::remove_file(destination);
                        return Err("文件传输中断".into());
                    }
                    Ok(())
                })
            })
            .collect();
        tauri_plugin_dragout::start_drag(&window, items, DragOptions::default())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, id, files);
        Err("当前系统尚不支持拖出文件".into())
    }
}
