use std::borrow::Cow;
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::{State, WebviewWindow};

#[derive(Default)]
pub struct CopyState {
    next: AtomicU64,
    finished: AtomicU64,
    pending: Mutex<Option<(u64, u64, Instant)>>,
}

struct Finished<'a> {
    state: &'a CopyState,
    token: u64,
}
impl Drop for Finished<'_> {
    fn drop(&mut self) {
        self.state.finished.fetch_max(self.token, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn remote_copy_test_state(state: State<'_, CopyState>) -> Result<serde_json::Value, String> {
    if super::automation_port().is_none() {
        return Err("automation is disabled".into());
    }
    Ok(serde_json::json!({
        "generation": state.next.load(Ordering::Relaxed),
        "finished": state.finished.load(Ordering::Relaxed),
        "pending": state.pending.lock().map_err(|_| "clipboard state unavailable")?.is_some(),
    }))
}

#[cfg(target_os = "windows")]
fn clipboard_sequence() -> Result<u64, String> {
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    let value = unsafe { GetClipboardSequenceNumber() };
    if value == 0 {
        Err("clipboard sequence unavailable".into())
    } else {
        Ok(value as u64)
    }
}

#[cfg(target_os = "macos")]
fn clipboard_sequence() -> Result<u64, String> {
    use std::ffi::{c_char, c_void};
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe {
        let class = objc_getClass(c"NSPasteboard".as_ptr());
        if class.is_null() {
            return Err("pasteboard unavailable".into());
        }
        let object_send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let count_send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> isize =
            std::mem::transmute(objc_msgSend as *const ());
        let board = object_send(class, sel_registerName(c"generalPasteboard".as_ptr()));
        if board.is_null() {
            return Err("pasteboard unavailable".into());
        }
        Ok(count_send(board, sel_registerName(c"changeCount".as_ptr())) as u64)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn clipboard_sequence() -> Result<u64, String> {
    Err("unsupported platform".into())
}

#[tauri::command]
pub fn begin_remote_image_copy(
    window: WebviewWindow,
    state: State<'_, CopyState>,
) -> Result<u64, String> {
    if window.label() != super::MAIN_WINDOW || !super::main_window_is_foreground(&window) {
        return Err("desktop is not active".into());
    }
    let sequence = clipboard_sequence()?;
    let token = state.next.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    *state
        .pending
        .lock()
        .map_err(|_| "clipboard state unavailable")? = Some((token, sequence, Instant::now()));
    Ok(token)
}

#[tauri::command]
pub async fn finish_remote_image_copy(
    window: WebviewWindow,
    state: State<'_, CopyState>,
    token: u64,
    png: String,
) -> Result<(), String> {
    if window.label() != super::MAIN_WINDOW {
        return Err("invalid desktop window".into());
    }
    let (sequence, started) = {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "clipboard state unavailable")?;
        let (expected, sequence, started) =
            pending.as_ref().copied().ok_or("copy gesture expired")?;
        if token != expected || started.elapsed() > Duration::from_secs(120) {
            return Err("copy gesture expired".into());
        }
        *pending = None;
        (sequence, started)
    };
    let _finished = Finished {
        state: &state,
        token,
    };
    if png.len() > 90 * 1024 * 1024 {
        return Err("image too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png)
        .map_err(|_| "invalid image")?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("image too large".into());
    }
    let reader = || image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png);
    let (width, height) = reader().into_dimensions().map_err(|_| "invalid PNG")?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 32 * 1024 * 1024 {
        return Err("image dimensions too large".into());
    }
    let pixels = reader()
        .decode()
        .map_err(|_| "invalid PNG")?
        .to_rgba8()
        .into_raw();
    if started.elapsed() > Duration::from_secs(120) || state.next.load(Ordering::Relaxed) != token {
        return Err("copy gesture expired".into());
    }
    if clipboard_sequence()? != sequence {
        return Err("local clipboard changed during copy".into());
    }
    arboard::Clipboard::new()
        .and_then(|mut clipboard| {
            clipboard.set_image(arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::Owned(pixels),
            })
        })
        .map_err(|error| format!("clipboard write failed: {error}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn system_clipboard_image_roundtrip_when_explicitly_enabled() {
        if std::env::var_os("WOC_NATIVE_CLIPBOARD_TEST").is_none() {
            return;
        }
        let before = super::clipboard_sequence().expect("clipboard sequence");
        let mut clipboard = arboard::Clipboard::new().expect("open OS clipboard");
        let pixel = [255, 0, 0, 255];
        clipboard
            .set_image(arboard::ImageData {
                width: 2,
                height: 2,
                bytes: std::borrow::Cow::Owned(pixel.repeat(4)),
            })
            .expect("write PNG pixels");
        let after = super::clipboard_sequence().expect("updated clipboard sequence");
        assert_ne!(before, after);
        let actual = clipboard.get_image().expect("read OS clipboard image");
        assert_eq!((actual.width, actual.height), (2, 2));
        assert_eq!(&actual.bytes[..4], &pixel);
    }
}
