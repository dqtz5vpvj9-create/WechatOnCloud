(() => {
  // Safari and WKWebView share WebKit's macOS IME/tap-to-click event ordering.
  // https://bugs.webkit.org/show_bug.cgi?id=219670#c32
  // https://github.com/tauri-apps/tauri/issues/7219
  if (!/Mac/.test(navigator.platform) || !/AppleWebKit/.test(navigator.userAgent)
    || /Chrome|Chromium|Edg\//.test(navigator.userAgent)) return;

  function install(window) {
  const { document, location, navigator, performance, HTMLCanvasElement, MouseEvent, DOMException } = window;
  const route = /^\/desktop\/([^/]+)\/(?:weflow\/)?vnc\/(?:index|vnc)\.html$/.exec(location.pathname);
  if (!route || window.__wocWebkitInputInstalled) return;
  window.__wocWebkitInputInstalled = true;

  const pressed = new Map();
  const earlyReleases = new Map();
  let replaying = false;
  let mouseDownEvent;
  const trace = [];
  let reports = 0;
  let reportedClipboard = false;
  const report = reason => {
    if (reports++ >= 8) return;
    // Numeric event evidence only: no keys, clipboard data or chat contents.
    let ime = '?';
    try { ime = window.localStorage.getItem('enable_ime'); } catch { /* storage disabled */ }
    const evidence = trace.slice(-4).map(e => [e.type.slice(5), e.button, e.buttons, e.at]);
    const client = window.parent.__TAURI_INTERNALS__ ? 'tauri' : 'safari';
    const msg = `[webkit-input v1 ${client}] ${reason} ime=${ime} ${JSON.stringify(evidence)}`;
    void window.fetch(`/api/instances/${route[1]}/clientlog`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg }),
    }).catch(() => {});
  };
  const record = event => {
    trace.push({ type: event.type, button: event.button, buttons: event.buttons, at: Math.round(event.timeStamp * 10) / 10 });
    if (trace.length > 12) trace.shift();
  };
  const mask = button => button === 1 ? 4 : button === 2 ? 2 : 1 << button;
  const remoteCanvas = target => target instanceof HTMLCanvasElement && target.closest('#noVNC_container');
  const canvasFor = event => remoteCanvas(event.target) ? event.target
    : remoteCanvas(document.captureElement) ? document.captureElement : null;

  // KasmVNC reads the local clipboard synchronously on the first mousedown
  // after focus. WKWebView opens its native "Paste" permission menu, which
  // can consume mouseup. Explicit Cmd+V already uses the panel's paste bridge.
  // Wrap the prototype so the panel's clipboard guard can wrap/uninstall its
  // own instance methods without removing this restriction. Writes still work.
  const clipboardPrototype = navigator.clipboard && Object.getPrototypeOf(navigator.clipboard);
  for (const method of ['read', 'readText']) {
    const original = clipboardPrototype?.[method];
    if (typeof original !== 'function') continue;
    clipboardPrototype[method] = function (...args) {
      if (mouseDownEvent?.eventPhase) {
        if (!reportedClipboard) { reportedClipboard = true; report('blocked-pointer-clipboard-read'); }
        return Promise.reject(new DOMException('Use Command+V to paste into the remote desktop', 'NotAllowedError'));
      }
      return Reflect.apply(original, this, args);
    };
  }

  const swallow = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = (button, source) => {
    const press = pressed.get(button);
    if (!press) return;
    if (press.event.eventPhase) {
      press.deferredRelease = source ?? press.point;
      return;
    }
    pressed.delete(button);
    // Use the last position reached while physically pressed. Releasing at a
    // later hover position would itself move a remote window/selection first.
    const point = source ?? press.point;
    const remaining = [...pressed.keys()].reduce((bits, key) => bits | mask(key), 0);
    const overlay = document.getElementById('noVNC_mouse_capture_elem');
    const target = document.captureElement === press.canvas && overlay ? overlay : press.canvas;
    replaying = true;
    try {
      target.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window, button, buttons: remaining,
        clientX: point.clientX, clientY: point.clientY,
        ctrlKey: point.ctrlKey, shiftKey: point.shiftKey, altKey: point.altKey, metaKey: point.metaKey,
      }));
    } finally {
      replaying = false;
    }
  };
  const releaseAll = () => {
    for (const button of [...pressed.keys()]) release(button);
    earlyReleases.clear();
  };

  window.addEventListener('mousedown', event => {
    if (replaying) return;
    const canvas = canvasFor(event);
    if (!canvas || event.button < 0 || event.button > 4) return;
    record(event);
    mouseDownEvent = event;
    // A second physical press also proves that the previous press ended.
    release(event.button);
    const press = { canvas, event, point: event, deferredRelease: null };
    pressed.set(event.button, press);
    const early = earlyReleases.get(event.button);
    earlyReleases.delete(event.button);
    // WebKit #219670: IME completion can deliver mouseup before mousedown.
    // Native timestamps preserve their original order; a newer genuine press
    // must not be paired with an unrelated old release.
    if (early && early.canvas === canvas && performance.now() - early.received < 1000
      && event.timeStamp <= early.event.timeStamp && early.event.timeStamp - event.timeStamp < 1000
      && Math.hypot(event.clientX - early.event.clientX, event.clientY - early.event.clientY) <= 4) {
      press.deferredRelease = early.event;
      report('reordered-release-before-press');
    }
    // A task (not a microtask) runs after all native event listeners finish.
    window.setTimeout(() => {
      if (pressed.get(event.button) === press && press.deferredRelease) release(event.button, press.deferredRelease);
    }, 0);
  }, true);

  window.addEventListener('mouseup', event => {
    if (replaying) return;
    const press = pressed.get(event.button);
    if (press) {
      record(event);
      // Focusing the IME input during mousedown can re-enter event dispatch.
      // Let the original down reach VNC before delivering this release.
      if (press.event.eventPhase) {
        press.deferredRelease = event;
        report('deferred-reentrant-release');
        swallow(event);
      } else {
        pressed.delete(event.button);
      }
    } else {
      const canvas = canvasFor(event);
      if (!canvas) return;
      // noVNC forwards captured events by cloning them. Those copies are
      // already in order and must not become another early release.
      if (!event.isTrusted && document.captureElement === event.target) return;
      record(event);
      earlyReleases.set(event.button, { canvas, event, received: performance.now() });
      swallow(event);
    }
  }, true);

  const reconcile = (event, updatePosition) => {
    if (replaying) return;
    for (const [button, press] of [...pressed]) {
      if (!(event.buttons & mask(button))) {
        record(event);
        report('released-button-state-mismatch');
        release(button);
      }
      else if (updatePosition) press.point = event;
    }
  };
  window.addEventListener('mousemove', event => reconcile(event, true), true);
  window.addEventListener('pointercancel', releaseAll, true);
  const onBlur = () => window.setTimeout(() => {
    // Entering a same-origin iframe blurs the parent Window while the page
    // still has focus. Only an actual focus loss should end a remote drag.
    if (!document.hasFocus()) releaseAll();
  }, 0);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseAll();
  });

  // A release over the surrounding panel belongs to the active remote drag.
  // Parent coordinates are different, so retain the last frame coordinates.
  if (window.parent !== window) {
    const parentMove = event => reconcile(event, false);
    const parentUp = event => release(event.button);
    window.parent.addEventListener('mousemove', parentMove, true);
    window.parent.addEventListener('mouseup', parentUp, true);
    window.parent.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', () => {
      releaseAll();
      window.parent.removeEventListener('mousemove', parentMove, true);
      window.parent.removeEventListener('mouseup', parentUp, true);
      window.parent.removeEventListener('blur', onBlur);
    }, { once: true });
  }
  }

  install(window);
  // The shared web UI installs into each same-origin desktop document. The
  // macOS binary also embeds this script at document start for offline/cache
  // transitions. The per-document marker prevents duplicate listeners.
  if (window === window.top) {
    const attach = frame => {
      try { if (frame instanceof HTMLIFrameElement) install(frame.contentWindow); } catch { /* cross-origin frame */ }
    };
    document.addEventListener('load', event => attach(event.target), true);
    document.querySelectorAll('iframe').forEach(attach);
  }
})();
