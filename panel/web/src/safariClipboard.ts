// KasmVNC deliberately disables seamless clipboard writes on Safari. Reserve
// a native write during the remote click/copy key, then supply its text when
// KasmVNC's clipboardrx arrives. Starting write after the network response loses
// the gesture in WebKit: https://bugs.webkit.org/show_bug.cgi?id=222262
export function installSafariClipboard(
  win: Window,
  nativeWrite: (items: ClipboardItem[]) => Promise<void>,
  accept: (text: string) => boolean,
  completed: (text: string, error?: unknown) => void,
): () => void {
  const realm = win as Window & typeof globalThis;
  if (!/AppleWebKit/.test(win.navigator.userAgent) || /Chrome|Chromium|Edg\//.test(win.navigator.userAgent)
    || !realm.ClipboardItem || !win.navigator.clipboard) return () => {};
  const parent = win.parent;
  const doc = win.document;
  let active = true;
  let sequence = 0;
  let pending: { resolve: (text: string) => void; reject: (e: Error) => void; timer: number } | undefined;
  const cancel = () => {
    sequence++;
    if (!pending) return;
    win.clearTimeout(pending.timer);
    pending.reject(new realm.DOMException('No remote copy for this gesture', 'AbortError'));
    pending = undefined;
  };
  const remoteTarget = (target: EventTarget | null) => target instanceof realm.Element
    && (!!target.closest('#noVNC_container') || target.id === 'noVNC_keyboardinput'
      || target.id === 'noVNC_mouse_capture_elem');
  const arm = () => {
    cancel();
    const ticket = sequence;
    let copied: string | undefined;
    const value = new Promise<Blob>((resolve, reject) => {
      pending = {
        resolve: text => { copied = text; resolve(new realm.Blob([text], { type: 'text/plain' })); }, reject,
        timer: win.setTimeout(cancel, 5000),
      };
    });
    // Also consume rejections if the platform denies write before reading the
    // item. A normal click with no copy must preserve the existing clipboard.
    void value.catch(() => {});
    try {
      void nativeWrite([new realm.ClipboardItem({ 'text/plain': value })]).then(
        () => { if (active && ticket === sequence && copied !== undefined) completed(copied); },
        error => { if (active && ticket === sequence && copied !== undefined) completed(copied, error); },
      );
    } catch { cancel(); }
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.isTrusted && remoteTarget(event.target) && !doc.hidden) arm();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.isTrusted || !remoteTarget(event.target)) return;
    const copy = ((event.metaKey || event.ctrlKey) && !event.altKey && /^[cx]$/i.test(event.key))
      || (event.ctrlKey && event.key === 'Insert');
    if (copy && !event.repeat) arm();
    else if (!['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) cancel();
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== win || event.origin !== win.location.origin || event.data?.action !== 'clipboardrx'
      || typeof event.data.value !== 'string' || !event.data.value || !pending || doc.hidden || !doc.hasFocus()) return;
    const text = event.data.value;
    if (!accept(text)) return;
    const current = pending;
    pending = undefined;
    win.clearTimeout(current.timer);
    current.resolve(text);
  };
  const onBlur = () => { if (!doc.hasFocus()) cancel(); };
  const onVisibility = () => { if (doc.hidden) cancel(); };
  win.addEventListener('mousedown', onMouseDown, true);
  win.addEventListener('keydown', onKeyDown, true);
  parent.addEventListener('message', onMessage);
  parent.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', cancel);
  return () => {
    active = false;
    cancel();
    win.removeEventListener('mousedown', onMouseDown, true);
    win.removeEventListener('keydown', onKeyDown, true);
    parent.removeEventListener('message', onMessage);
    parent.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', cancel);
  };
}
