use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::{thread, time::Duration};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalSize, Manager, PhysicalPosition, Position, Rect, RunEvent, Size, State,
    UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

mod downloads;

const MAIN_WINDOW: &str = "main";
const TRAY_PREVIEW_WINDOW: &str = "tray-preview";
const APP_URL: &str = "https://wechat.tail.lixinrui000.cn/";
const PREVIEW_WIDTH: f64 = 304.0;
const PREVIEW_CHROME_HEIGHT: f64 = 46.0; // 6px padding x2, 1px border x2, 32px header.
const PREVIEW_ROW_HEIGHT: f64 = 60.0;

#[derive(Default)]
struct TaskbarState {
    unread: AtomicU32,
    attention_requests: AtomicU32,
    tray_icon_updates: AtomicU32,
    tray_blinking: AtomicBool,
    latest_url: Mutex<Option<String>>,
    default_url: Mutex<Option<String>>,
    tray_messages: Mutex<Vec<TrayMessage>>,
    tray_preview_hovered: AtomicBool,
    tray_rect: Mutex<Option<Rect>>,
    shortcut_down: AtomicBool,
    shortcut_registered: AtomicBool,
    shortcut_events: AtomicU32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayMessage {
    tag: String,
    title: String,
    body: String,
    url: String,
    count: u32,
    avatar_url: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopNotification {
    count: u32,
    notify: bool,
    title: Option<String>,
    body: Option<String>,
    url: Option<String>,
    message_count: Option<u32>,
    tag: Option<String>,
    avatar_url: Option<String>,
}

fn merge_tray_message(messages: &mut Vec<TrayMessage>, mut incoming: TrayMessage) -> u32 {
    if let Some(index) = messages
        .iter()
        .position(|message| message.tag == incoming.tag)
    {
        let previous = messages.remove(index);
        incoming.count = previous.count.saturating_add(incoming.count);
        incoming.avatar_url = incoming.avatar_url.or(previous.avatar_url);
    }
    messages.push(incoming);
    messages
        .iter()
        .fold(0_u32, |total, message| total.saturating_add(message.count))
}

#[cfg(target_os = "windows")]
fn glyph(character: char) -> [&'static str; 5] {
    match character {
        '0' => ["111", "101", "101", "101", "111"],
        '1' => ["010", "110", "010", "010", "111"],
        '2' => ["111", "001", "111", "100", "111"],
        '3' => ["111", "001", "111", "001", "111"],
        '4' => ["101", "101", "111", "001", "001"],
        '5' => ["111", "100", "111", "001", "111"],
        '6' => ["111", "100", "111", "101", "111"],
        '7' => ["111", "001", "010", "010", "010"],
        '8' => ["111", "101", "111", "101", "111"],
        '9' => ["111", "101", "111", "001", "111"],
        '+' => ["000", "010", "111", "010", "000"],
        _ => ["000", "000", "000", "000", "000"],
    }
}

#[cfg(target_os = "windows")]
fn unread_overlay(count: u32) -> Image<'static> {
    const SIZE: usize = 32;
    let mut rgba = vec![0_u8; SIZE * SIZE * 4];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let distance = dx * dx + dy * dy;
            let color = if distance <= 15.5_f32.powi(2) {
                if distance > 14.0_f32.powi(2) {
                    [255, 255, 255, 255]
                } else {
                    [250, 81, 81, 255]
                }
            } else {
                [0, 0, 0, 0]
            };
            rgba[(y * SIZE + x) * 4..(y * SIZE + x) * 4 + 4].copy_from_slice(&color);
        }
    }

    let label = if count > 99 {
        "99+".to_owned()
    } else {
        count.to_string()
    };
    let scale = match label.len() {
        1 => 4,
        2 => 3,
        _ => 2,
    };
    let glyph_width = 3 * scale;
    let total_width = glyph_width * label.len() + scale * label.len().saturating_sub(1);
    let start_x = (SIZE - total_width) / 2;
    let start_y = (SIZE - 5 * scale) / 2;

    for (index, character) in label.chars().enumerate() {
        for (row, pixels) in glyph(character).iter().enumerate() {
            for (column, pixel) in pixels.bytes().enumerate() {
                if pixel != b'1' {
                    continue;
                }
                for offset_y in 0..scale {
                    for offset_x in 0..scale {
                        let x = start_x + index * (glyph_width + scale) + column * scale + offset_x;
                        let y = start_y + row * scale + offset_y;
                        rgba[(y * SIZE + x) * 4..(y * SIZE + x) * 4 + 4]
                            .copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }

    Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

fn update_tray_tooltip(app: &AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("yunwei") {
        let _ = tray.set_tooltip((count == 0).then_some("云微"));
    }
}

fn set_unread_badge(window: &tauri::Window, count: u32) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    return window.set_overlay_icon((count > 0).then(|| unread_overlay(count)));
    #[cfg(not(target_os = "windows"))]
    return window.set_badge_count((count > 0).then_some(i64::from(count)));
}

fn clear_taskbar_unread(window: &tauri::Window, state: &TaskbarState) {
    let _ = set_unread_badge(window, 0);
    let _ = window.request_user_attention(None);
    state.unread.store(0, Ordering::Relaxed);
    state.tray_blinking.store(false, Ordering::Relaxed);
    if let Ok(mut messages) = state.tray_messages.lock() {
        messages.clear();
    }
    if let Some(preview) = window.app_handle().get_webview_window(TRAY_PREVIEW_WINDOW) {
        let _ = preview.hide();
    }
    update_tray_tooltip(window.app_handle(), 0);
}

#[tauri::command]
fn set_taskbar_unread(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, TaskbarState>,
    count: u32,
    notify: bool,
) -> Result<(), String> {
    apply_desktop_notification(
        &app,
        &window,
        &state,
        DesktopNotification {
            count,
            notify,
            title: None,
            body: None,
            url: None,
            message_count: None,
            tag: None,
            avatar_url: None,
        },
    )
}

#[tauri::command]
fn set_desktop_notification(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, TaskbarState>,
    payload: DesktopNotification,
) -> Result<(), String> {
    apply_desktop_notification(&app, &window, &state, payload)
}

#[tauri::command]
fn set_desktop_default_route(state: State<'_, TaskbarState>, url: String) -> Result<(), String> {
    if !url.starts_with("/i/") || url.starts_with("//") {
        return Err("invalid desktop route".to_owned());
    }
    *state
        .default_url
        .lock()
        .map_err(|error| error.to_string())? = Some(url);
    Ok(())
}

fn apply_desktop_notification(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &TaskbarState,
    payload: DesktopNotification,
) -> Result<(), String> {
    let DesktopNotification {
        mut count,
        notify,
        title,
        body,
        url,
        message_count,
        tag,
        avatar_url,
    } = payload;
    if count == 0 {
        set_unread_badge(&window.as_ref().window(), 0).map_err(|error| error.to_string())?;
        window
            .request_user_attention(None)
            .map_err(|error| error.to_string())?;
        state
            .tray_messages
            .lock()
            .map_err(|error| error.to_string())?
            .clear();
        if let Some(preview) = app.get_webview_window(TRAY_PREVIEW_WINDOW) {
            let _ = preview.hide();
        }
    } else {
        set_unread_badge(&window.as_ref().window(), count).map_err(|error| error.to_string())?;
        if notify {
            window
                .request_user_attention(Some(UserAttentionType::Informational))
                .map_err(|error| error.to_string())?;
            state.attention_requests.fetch_add(1, Ordering::Relaxed);

            let route = url.filter(|value| value.starts_with('/') && !value.starts_with("//"));
            if let Some(route) = route.as_ref() {
                *state.latest_url.lock().map_err(|error| error.to_string())? = Some(route.clone());
            }
            let notification_title = title.unwrap_or_else(|| "微信新消息".to_owned());
            let notification_body = body.unwrap_or_else(|| "你有一条新消息".to_owned());
            {
                let mut messages = state
                    .tray_messages
                    .lock()
                    .map_err(|error| error.to_string())?;
                count = merge_tray_message(
                    &mut messages,
                    TrayMessage {
                        tag: tag.filter(|value| !value.is_empty()).unwrap_or_else(|| {
                            format!("{}:{}", route.as_deref().unwrap_or("/"), notification_title)
                        }),
                        title: notification_title.clone(),
                        body: notification_body.clone(),
                        url: route.clone().unwrap_or_else(|| "/".to_owned()),
                        count: message_count.unwrap_or(1).max(1),
                        avatar_url: avatar_url.filter(|value| value.starts_with("https://")),
                    },
                );
            }
            set_unread_badge(&window.as_ref().window(), count)
                .map_err(|error| error.to_string())?;
            let mut notification = app
                .notification()
                .builder()
                .title(notification_title)
                .body(notification_body);
            if let Some(route) = route {
                notification = notification.extra("url", route);
            }
            notification.show().map_err(|error| error.to_string())?;
        }
    }
    state.unread.store(count, Ordering::Relaxed);
    state.tray_blinking.store(count > 0, Ordering::Relaxed);
    update_tray_tooltip(app, count);
    if app
        .get_webview_window(TRAY_PREVIEW_WINDOW)
        .is_some_and(|window| window.is_visible().unwrap_or(false))
    {
        let rect = state.tray_rect.lock().ok().and_then(|rect| *rect);
        if let Some(rect) = rect {
            show_tray_preview(app, rect);
        }
    }
    Ok(())
}

#[tauri::command]
fn get_taskbar_unread_state(state: State<'_, TaskbarState>) -> [u32; 4] {
    [
        state.unread.load(Ordering::Relaxed),
        state.attention_requests.load(Ordering::Relaxed),
        state.tray_icon_updates.load(Ordering::Relaxed),
        u32::from(state.tray_blinking.load(Ordering::Relaxed)),
    ]
}

fn automation_port() -> Option<u16> {
    let argument = std::env::args().find(|argument| argument.starts_with("--automation-port="))?;
    let value = argument
        .strip_prefix("--automation-port=")
        .expect("automation argument prefix was checked");
    let port = value
        .parse::<u16>()
        .expect("--automation-port must contain a valid TCP port");
    assert!(port != 0, "--automation-port must be greater than zero");
    Some(port)
}

fn configure_automation() -> bool {
    let Some(port) = automation_port() else {
        return false;
    };

    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        format!("--remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"),
    );
    true
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.as_ref().set_focus();
}

fn main_window_is_foreground(window: &WebviewWindow) -> bool {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetForegroundWindow() -> *mut std::ffi::c_void;
        }
        // WebView2 can retain keyboard focus in a child HWND; compare the real
        // top-level foreground window instead of Tao's cached focus events.
        window
            .hwnd()
            .is_ok_and(|handle| handle.0 == unsafe { GetForegroundWindow() })
    }
    #[cfg(not(target_os = "windows"))]
    window.is_focused().unwrap_or(false)
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(preview) = app.get_webview_window(TRAY_PREVIEW_WINDOW) {
        let _ = preview.hide();
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if window.is_visible().unwrap_or(false) && main_window_is_foreground(&window) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[tauri::command]
fn get_desktop_runtime_state(app: AppHandle) -> Result<serde_json::Value, String> {
    if automation_port().is_none() {
        return Err("automation is disabled".to_owned());
    }
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("main window unavailable")?;
    Ok(serde_json::json!({
        "visible": window.is_visible().unwrap_or(false),
        "focused": main_window_is_foreground(&window),
        "minimized": window.is_minimized().unwrap_or(false),
        "shortcutRegistered": app.state::<TaskbarState>().shortcut_registered.load(Ordering::Relaxed),
        "shortcutEvents": app.state::<TaskbarState>().shortcut_events.load(Ordering::Relaxed),
        "shortcutDown": app.state::<TaskbarState>().shortcut_down.load(Ordering::Relaxed),
    }))
}

// Notifications always open the instance's WeChat desktop, including URLs
// retained in native notifications from versions that linked to WeFlow.
fn wechat_message_route(route: &str) -> Option<String> {
    let path = route.split(['?', '#']).next()?;
    let instance_id = path.strip_prefix("/i/")?;
    if instance_id.is_empty()
        || instance_id.contains(['/', '\\'])
        || matches!(instance_id, "." | "..")
    {
        return None;
    }
    Some(path.to_owned())
}

fn open_latest_message(app: &AppHandle, route: Option<String>) {
    show_main_window(app);
    let route = route
        .or_else(|| {
            app.state::<TaskbarState>()
                .latest_url
                .lock()
                .ok()
                .and_then(|value| value.clone())
        })
        .and_then(|route| wechat_message_route(&route));
    if let (Some(window), Some(route)) = (app.get_webview_window(MAIN_WINDOW), route) {
        if let Ok(route) = serde_json::to_string(&route) {
            let _ = window.eval(format!(
                "if (window.location.pathname + window.location.search !== {route}) window.location.assign({route})"
            ));
        }
    }
}

fn open_default_app(app: &AppHandle) {
    show_main_window(app);
    let route = app
        .state::<TaskbarState>()
        .default_url
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if let (Some(window), Some(route)) = (app.get_webview_window(MAIN_WINDOW), route) {
        if let Ok(route) = serde_json::to_string(&route) {
            let _ = window.eval(format!(
                "if (window.location.pathname + window.location.search !== {route}) window.location.assign({route})"
            ));
        }
    }
}

fn rect_in_physical_pixels(rect: Rect, scale_factor: f64) -> (f64, f64, f64, f64) {
    let (x, y) = match rect.position {
        Position::Physical(position) => (position.x as f64, position.y as f64),
        Position::Logical(position) => (position.x * scale_factor, position.y * scale_factor),
    };
    let (width, height) = match rect.size {
        Size::Physical(size) => (size.width as f64, size.height as f64),
        Size::Logical(size) => (size.width * scale_factor, size.height * scale_factor),
    };
    (x, y, width, height)
}

fn show_tray_preview(app: &AppHandle, rect: Rect) {
    let state = app.state::<TaskbarState>();
    if let Ok(mut last_rect) = state.tray_rect.lock() {
        *last_rect = Some(rect);
    }
    let count = state.unread.load(Ordering::Relaxed);
    let messages = match state.tray_messages.lock() {
        Ok(messages) if count > 0 && !messages.is_empty() => messages.clone(),
        _ => return,
    };
    let Some(window) = app.get_webview_window(TRAY_PREVIEW_WINDOW) else {
        return;
    };

    let rows = messages.len().min(5);
    let height = PREVIEW_CHROME_HEIGHT + rows as f64 * PREVIEW_ROW_HEIGHT;
    let _ = window.set_size(LogicalSize::new(PREVIEW_WIDTH, height));
    let payload = serde_json::json!({ "count": count, "messages": messages });
    let _ = window.eval(format!("window.renderTrayPreview({payload})"));

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let (icon_x, icon_y, icon_width, _icon_height) = rect_in_physical_pixels(rect, scale_factor);
    let window_size = window.outer_size().unwrap_or_default();
    let mut x = icon_x + icon_width / 2.0 - window_size.width as f64 / 2.0;
    #[cfg(target_os = "macos")]
    let mut y = icon_y + _icon_height + 8.0 * scale_factor;
    #[cfg(not(target_os = "macos"))]
    let mut y = icon_y - window_size.height as f64 - 8.0 * scale_factor;

    if let Ok(monitors) = window.available_monitors() {
        if let Some(monitor) = monitors.into_iter().find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            icon_x >= position.x as f64
                && icon_x < (position.x + size.width as i32) as f64
                && icon_y >= position.y as f64
                && icon_y < (position.y + size.height as i32) as f64
        }) {
            let position = monitor.position();
            let size = monitor.size();
            let margin = 8.0 * scale_factor;
            let min_x = position.x as f64 + margin;
            let max_x = (position.x + size.width as i32) as f64 - window_size.width as f64 - margin;
            x = x.clamp(min_x, max_x.max(min_x));
            y = y.max(position.y as f64 + margin);
        }
    }

    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = window.show();
}

// Runs the real hover path in an isolated WebView2 test instance.
#[tauri::command]
fn show_tray_preview_for_test(app: AppHandle) -> Result<(), String> {
    if automation_port().is_none() {
        return Err("automation is disabled".to_owned());
    }
    let rect = app
        .tray_by_id("yunwei")
        .and_then(|tray| tray.rect().ok().flatten())
        .ok_or_else(|| "tray icon rectangle unavailable".to_owned())?;
    show_tray_preview(&app, rect);
    Ok(())
}

fn hide_tray_preview_later(app: AppHandle, delay_ms: u64) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(delay_ms));
        if !app
            .state::<TaskbarState>()
            .tray_preview_hovered
            .load(Ordering::Relaxed)
        {
            if let Some(window) = app.get_webview_window(TRAY_PREVIEW_WINDOW) {
                let _ = window.hide();
            }
        }
    });
}

#[tauri::command]
fn set_tray_preview_hovered(app: AppHandle, state: State<'_, TaskbarState>, hovered: bool) {
    state.tray_preview_hovered.store(hovered, Ordering::Relaxed);
    if !hovered {
        hide_tray_preview_later(app, 120);
    }
}

#[tauri::command]
fn open_tray_message(app: AppHandle, url: String) -> Result<(), String> {
    let route = wechat_message_route(&url).ok_or_else(|| "invalid message route".to_owned())?;
    if let Some(window) = app.get_webview_window(TRAY_PREVIEW_WINDOW) {
        let _ = window.hide();
    }
    open_latest_message(&app, Some(route));
    Ok(())
}

fn start_tray_blinker(app: AppHandle, icon: Image<'static>) {
    thread::spawn(move || {
        let mut hidden_rgba = icon.rgba().to_vec();
        for pixel in hidden_rgba.chunks_exact_mut(4) {
            if pixel[3] > 0 {
                pixel[3] = 1;
            }
        }
        let hidden = Image::new_owned(hidden_rgba, icon.width(), icon.height());
        let mut visible = true;
        let mut was_blinking = false;
        loop {
            let state = app.state::<TaskbarState>();
            let blinking = state.tray_blinking.load(Ordering::Relaxed);
            if let Some(tray) = app.tray_by_id("yunwei") {
                if blinking {
                    visible = !visible;
                    let next = if visible {
                        icon.clone()
                    } else {
                        hidden.clone()
                    };
                    if tray.set_icon(Some(next)).is_ok() {
                        state.tray_icon_updates.fetch_add(1, Ordering::Relaxed);
                    }
                    was_blinking = true;
                } else if was_blinking {
                    let _ = tray.set_icon(Some(icon.clone()));
                    visible = true;
                    was_blinking = false;
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn start_backend_recovery(app: AppHandle) {
    thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };
        let mut saw_failure = false;

        // WSL and Docker can need several minutes after Windows sign-in. Reload
        // the remote UI once its entry point recovers from an initial failure.
        for _ in 0..200 {
            let healthy = client
                .get(APP_URL)
                .header(reqwest::header::CACHE_CONTROL, "no-cache")
                .send()
                .is_ok_and(|response| response.status().is_success());

            if healthy {
                if saw_failure {
                    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                        let _ = window.eval("window.location.reload()");
                    }
                }
                return;
            }

            saw_failure = true;
            thread::sleep(Duration::from_secs(3));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let automation_enabled = configure_automation();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    let builder = if automation_enabled {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                show_main_window(app);
            },
        ))
    };

    let app = builder
        .manage(TaskbarState::default())
        .manage(downloads::Downloads::default())
        .invoke_handler(tauri::generate_handler![
            set_taskbar_unread,
            set_desktop_notification,
            set_desktop_default_route,
            set_tray_preview_hovered,
            open_tray_message,
            get_taskbar_unread_state,
            show_tray_preview_for_test,
            get_desktop_runtime_state
        ])
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == MAIN_WINDOW)
                .expect("main window config must exist");
            let main = WebviewWindowBuilder::from_config(app, config)?
                .initialization_script(include_str!("download-status.js"))
                .on_download(downloads::handle);
            #[cfg(target_os = "macos")]
            let main = main.initialization_script_for_all_frames(include_str!(
                "../../../panel/web/public/webkit-input.js"
            ));
            main.build()?;

            let result = app.global_shortcut().on_shortcut("Alt+W", |app, _, event| {
                let state = app.state::<TaskbarState>();
                match event.state {
                    ShortcutState::Pressed => {
                        state.shortcut_events.fetch_add(1, Ordering::Relaxed);
                        if !state.shortcut_down.swap(true, Ordering::Relaxed) {
                            toggle_main_window(app);
                        }
                    }
                    ShortcutState::Released => state.shortcut_down.store(false, Ordering::Relaxed),
                }
            });
            app.state::<TaskbarState>()
                .shortcut_registered
                .store(result.is_ok(), Ordering::Relaxed);
            if let Err(error) = result {
                eprintln!("Could not register Alt/Option+W: {error}");
            }

            WebviewWindowBuilder::new(
                app,
                TRAY_PREVIEW_WINDOW,
                WebviewUrl::App("tray-preview.html".into()),
            )
            .title("微信未读消息")
            .inner_size(PREVIEW_WIDTH, PREVIEW_CHROME_HEIGHT + PREVIEW_ROW_HEIGHT)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .focusable(false)
            .transparent(cfg!(target_os = "windows"))
            .visible(false)
            .build()?;

            let open = MenuItem::with_id(app, "open", "打开云微", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            let configured_icon = app
                .default_window_icon()
                .expect("the desktop bundle must provide an application icon");
            let tray_icon = Image::new_owned(
                configured_icon.rgba().to_vec(),
                configured_icon.width(),
                configured_icon.height(),
            );
            TrayIconBuilder::with_id("yunwei")
                .icon(tray_icon.clone())
                .tooltip("云微")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_default_app(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        if let Some(preview) =
                            tray.app_handle().get_webview_window(TRAY_PREVIEW_WINDOW)
                        {
                            let _ = preview.hide();
                        }
                        open_default_app(tray.app_handle());
                    }
                    TrayIconEvent::Enter { rect, .. } => {
                        tray.app_handle()
                            .state::<TaskbarState>()
                            .tray_preview_hovered
                            .store(true, Ordering::Relaxed);
                        show_tray_preview(tray.app_handle(), rect);
                    }
                    TrayIconEvent::Leave { .. } => {
                        tray.app_handle()
                            .state::<TaskbarState>()
                            .tray_preview_hovered
                            .store(false, Ordering::Relaxed);
                        hide_tray_preview_later(tray.app_handle().clone(), 240);
                    }
                    _ => {}
                })
                .build(app)?;

            let notification_app = app.handle().clone();
            app.notification().on_action(move |action| {
                if action.action_id() != "tap" {
                    return;
                }
                let route = action
                    .notification()
                    .and_then(|notification| notification.extra().get("url"))
                    .and_then(|value| value.as_str())
                    .map(str::to_owned);
                open_latest_message(&notification_app, route);
            })?;

            start_tray_blinker(app.handle().clone(), tray_icon);

            start_backend_recovery(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    WindowEvent::Focused(true) => {
                        clear_taskbar_unread(window, &window.state::<TaskbarState>());
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build 云微 desktop application");

    app.run(|_app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(_app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{merge_tray_message, wechat_message_route, TrayMessage};

    #[test]
    fn notification_routes_open_wechat_including_legacy_weflow_links() {
        for route in [
            "/i/example",
            "/i/example?screen=weflow",
            "/i/example?screen=weflow#messages",
        ] {
            assert_eq!(wechat_message_route(route).as_deref(), Some("/i/example"));
        }
        for route in [
            "/",
            "/i/",
            "//external.test/i/example",
            "https://external.test/i/example",
            "/i/../login",
        ] {
            assert_eq!(wechat_message_route(route), None);
        }
    }

    fn message(tag: &str, count: u32) -> TrayMessage {
        TrayMessage {
            tag: tag.to_owned(),
            title: "同名会话".to_owned(),
            body: "hello".to_owned(),
            url: "/i/example?screen=weflow".to_owned(),
            count,
            avatar_url: None,
        }
    }

    #[test]
    fn messages_accumulate_by_session_even_with_identical_display_names() {
        let mut messages = Vec::new();
        assert_eq!(
            merge_tray_message(&mut messages, message("session-a", 1)),
            1
        );
        assert_eq!(
            merge_tray_message(&mut messages, message("session-b", 2)),
            3
        );
        assert_eq!(
            merge_tray_message(&mut messages, message("session-a", 1)),
            4
        );
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].tag, "session-b");
        assert_eq!(messages[1].count, 2);
    }

    #[test]
    fn polling_without_an_avatar_preserves_the_previous_avatar() {
        let mut messages = vec![message("session-a", 1)];
        messages[0].avatar_url = Some("https://example.test/avatar.png".to_owned());
        merge_tray_message(&mut messages, message("session-a", 2));
        assert_eq!(
            messages[0].avatar_url.as_deref(),
            Some("https://example.test/avatar.png")
        );
        assert_eq!(messages[0].count, 3);
    }

    #[test]
    fn tray_message_serializes_for_the_preview_window() {
        let message = TrayMessage {
            tag: "wechat-example-session".to_owned(),
            title: "文件传输助手".to_owned(),
            body: "hello".to_owned(),
            url: "/i/example?screen=weflow".to_owned(),
            count: 2,
            avatar_url: Some("https://example.test/avatar.png".to_owned()),
        };
        let value = serde_json::to_value(message).unwrap();

        assert_eq!(value["title"], "文件传输助手");
        assert_eq!(value["body"], "hello");
        assert_eq!(value["url"], "/i/example?screen=weflow");
        assert_eq!(value["count"], 2);
        assert_eq!(value["avatarUrl"], "https://example.test/avatar.png");
    }
}
