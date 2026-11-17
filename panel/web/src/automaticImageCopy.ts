import { api } from './api';

export type ImageCopyStatus = { phase: 'reading' | 'transferring' | 'writing' | 'done' | 'error'; percent?: number; message?: string } | null;
type Invoke = (command: string, args?: object) => Promise<any>;

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.readAsDataURL(blob);
  });
}

// Only recent, trusted remote Copy gestures arm a native write. Clipboard
// changes from typing, background applications and other viewers do not.
export function installAutomaticImageCopy(win: Window, id: string, update: (status: ImageCopyStatus) => void): () => void {
  const invoke = (window as any).__TAURI__?.core?.invoke as Invoke | undefined;
  if (!invoke) return () => {};
  const realm = win as Window & typeof globalThis;
  const controller = new AbortController();
  let active = true, generation = 0, rightClickAt = 0, inflight = false;
  let armed: { at: number; generation: number; token: Promise<number | null> } | undefined;
  let statusTimer = 0, clearTimer = 0;
  const cancelStatus = () => { window.clearTimeout(statusTimer); window.clearTimeout(clearTimer); };
  const remoteTarget = (target: EventTarget | null) => target instanceof realm.Element
    && (!!target.closest('#noVNC_container') || target.id === 'noVNC_keyboardinput' || target.id === 'noVNC_mouse_capture_elem');
  const arm = () => {
    const ticket = ++generation;
    cancelStatus(); update(null);
    const token = invoke('begin_remote_image_copy').then(Number, () => null);
    armed = { at: Date.now(), generation: ticket, token };
  };
  const mouse = (event: MouseEvent) => {
    if (!event.isTrusted || !remoteTarget(event.target) || win.document.hidden) return;
    if (event.button === 2) rightClickAt = Date.now();
    else if (event.button === 0 && Date.now() - rightClickAt < 6000) { rightClickAt = 0; arm(); }
  };
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.repeat || !remoteTarget(event.target) || win.document.hidden) return;
    if (((event.metaKey || event.ctrlKey) && !event.altKey && /^[cx]$/i.test(event.key)) || (event.ctrlKey && event.key === 'Insert')) arm();
  };
  const changed = () => {
    const current = armed;
    if (!current || Date.now() - current.at > 5000) {
      armed = undefined;
      if (inflight) { generation++; inflight = false; cancelStatus(); update(null); }
      return;
    }
    armed = undefined;
    inflight = true;
    statusTimer = window.setTimeout(() => { if (active && generation === current.generation) update({ phase: 'reading' }); }, 600);
    const readingTimer = statusTimer;
    void (async () => {
      const token = await current.token;
      if (!active || generation !== current.generation) return;
      if (token === null) { cancelStatus(); update(null); return; }
      const blob = await api.clipboardImage(id, (received, total) => {
        if (active && generation === current.generation) update({ phase: 'transferring', percent: total ? Math.floor(received * 100 / total) : undefined });
      });
      if (!active || generation !== current.generation) return;
      update({ phase: 'writing' });
      const png = await base64(blob);
      if (!active || generation !== current.generation) return;
      await invoke('finish_remote_image_copy', { token, png });
      if (active && generation === current.generation) {
        cancelStatus(); update({ phase: 'done' });
        clearTimer = window.setTimeout(() => update(null), 1800);
      }
    })().catch((error: unknown) => {
      if (!active || generation !== current.generation) return;
      cancelStatus();
      const message = error instanceof Error ? error.message : String(error);
      if (/没有图片|clipboard changed|gesture expired|desktop is not active/i.test(message)) { update(null); return; }
      update({ phase: 'error', message: message || '复制图片失败' });
      clearTimer = window.setTimeout(() => update(null), 5000);
    }).finally(() => {
      window.clearTimeout(readingTimer);
      if (generation === current.generation) inflight = false;
    });
  };
  const watch = async () => {
    let retry = 1500;
    while (active) {
      let connected = false;
      try { await api.clipboardEvents(id, controller.signal, changed, () => { connected = true; }); } catch { /* reconnect while this desktop is open */ }
      if (!active) break;
      retry = connected ? 1500 : Math.min(retry * 2, 30_000);
      await new Promise<void>(resolve => {
        const done = () => { window.clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = window.setTimeout(done, retry);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    }
  };
  win.addEventListener('mousedown', mouse, true);
  win.addEventListener('keydown', key, true);
  void watch();
  return () => {
    active = false; generation++; armed = undefined; controller.abort(); cancelStatus();
    win.removeEventListener('mousedown', mouse, true);
    win.removeEventListener('keydown', key, true);
    update(null);
  };
}
