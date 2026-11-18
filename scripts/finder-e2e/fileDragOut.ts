import { api } from './api';

type Item = { name: string; ticket: string; directory: boolean };

// Native dragging begins only after a remote file drag crosses the outer app
// boundary. Dragging between folders inside Thunar stays entirely on X11.
export function installFileDragOut(frame: HTMLIFrameElement, id: string, failed: (message: string) => void): () => void {
  const child = frame.contentWindow;
  const parent = frame.ownerDocument.defaultView;
  if (!child || !parent || !('__TAURI__' in parent) || !/Mac/.test(parent.navigator.platform)) return () => {};
  const controller = new AbortController();
  let stopped = false;
  let held = false;
  let outside = false;
  let starting = false;
  let items: Item[] = [];
  let point = { x: 0, y: 0 };
  const start = () => {
    if (stopped || !held || !outside || starting || !items.length) return;
    starting = true;
    const selected = items.map(({ name, ticket, directory }) => ({ name, ticket, directory }));
    items = [];
    const invoke = (parent as any).__TAURI__.core.invoke as (name: string, args: object) => Promise<unknown>;
    void invoke('start_remote_file_drag', { id, files: selected }).catch(() => {
      failed('拖出文件失败，请检查云微客户端版本和网络连接');
    }).finally(() => {
      void api.releaseFileDrag(id).then(() => {
        // Also release noVNC's button state; the native drop may happen outside
        // the WebView, so it will not deliver a physical mouseup to the canvas.
        const doc = child.document as Document & { captureElement?: Element };
        const target = doc.captureElement || doc.querySelector('#noVNC_container canvas');
        target?.dispatchEvent(new (child as any).MouseEvent('mouseup', {
          bubbles: true, cancelable: true, view: child, button: 0, buttons: 0, clientX: point.x, clientY: point.y,
        }));
      }).catch(() => {});
      starting = false; held = false; outside = false;
    });
  };
  const down = (e: MouseEvent) => { if (e.button === 0) { held = true; outside = false; items = []; } };
  const up = (e: MouseEvent) => { if (e.button === 0) { held = false; outside = false; items = []; } };
  const move = (e: MouseEvent) => { point = { x: e.clientX, y: e.clientY }; };
  const leave = (e: MouseEvent) => {
    const rect = frame.getBoundingClientRect();
    const x = e.view === child ? rect.left + e.clientX : e.clientX;
    const y = e.view === child ? rect.top + e.clientY : e.clientY;
    if (x <= 0 || y <= 0 || x >= parent.innerWidth - 1 || y >= parent.innerHeight - 1) { outside = true; start(); }
  };
  child.addEventListener('mousedown', down, true);
  child.addEventListener('mouseup', up, true);
  child.addEventListener('mousemove', move, true);
  child.addEventListener('mouseout', leave, true);
  parent.addEventListener('mouseup', up, true);
  parent.addEventListener('mouseout', leave, true);
  const listen = async () => {
    while (!stopped) {
      try {
        await api.fileDragEvents(id, controller.signal, event => {
          if (event.type === 'files') { items = event.paths || []; start(); }
          if (event.type === 'end') items = [];
        });
      } catch { /* reconnect while the file screen remains open */ }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };
  void listen();
  return () => {
    stopped = true; controller.abort();
    child.removeEventListener('mousedown', down, true);
    child.removeEventListener('mouseup', up, true);
    child.removeEventListener('mousemove', move, true);
    child.removeEventListener('mouseout', leave, true);
    parent.removeEventListener('mouseup', up, true);
    parent.removeEventListener('mouseout', leave, true);
  };
}

