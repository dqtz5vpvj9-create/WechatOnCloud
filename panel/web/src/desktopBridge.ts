const UNREAD_KEY = 'woc_desktop_unread';

export function isDesktopApp() {
  return '__TAURI__' in window;
}

export interface DesktopNotificationPayload {
  title?: string;
  body?: string;
  count?: number;
  url?: string;
  tag?: string;
  avatarUrl?: string;
  snapshot?: boolean;
  sessions?: Array<{
    tag: string;
    title: string;
    body: string;
    url: string;
    count: number;
    avatarUrl?: string;
  }>;
}

async function setNativeUnread(count: number, notify: boolean, payload?: DesktopNotificationPayload) {
  if (!isDesktopApp()) return;
  const invoke = (window as any).__TAURI__.core.invoke as (command: string, args?: object) => Promise<unknown>;
  await invoke('set_desktop_notification', {
    payload: {
      count,
      notify,
      messageCount: payload?.count,
      title: payload?.title,
      body: payload?.body,
      url: payload?.url,
      tag: payload?.tag,
      avatarUrl: payload?.avatarUrl,
      snapshot: payload?.snapshot,
      sessions: payload?.sessions,
    },
  });
}

function storedUnread() {
  const value = Number.parseInt(sessionStorage.getItem(UNREAD_KEY) || '0', 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function notifyTaskbar(payload: DesktopNotificationPayload) {
  if (!isDesktopApp()) return;
  if (payload.snapshot) {
    const count = Math.min(999, Math.max(0, Number(payload.count || 0)));
    sessionStorage.setItem(UNREAD_KEY, String(count));
    await setNativeUnread(count, false, payload);
    return;
  }
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const incoming = Number(payload.count || 1);
  const count = Math.min(999, storedUnread() + Math.max(1, incoming));
  sessionStorage.setItem(UNREAD_KEY, String(count));
  await setNativeUnread(count, true, payload);
}

export async function resetTaskbarUnread() {
  if (!isDesktopApp()) return;
  sessionStorage.removeItem(UNREAD_KEY);
  await setNativeUnread(0, false);
}

export function installTaskbarUnreadReset() {
  if (!isDesktopApp()) return () => {};
  const resetWhenActive = () => {
    if (document.visibilityState === 'visible' && document.hasFocus()) void resetTaskbarUnread();
  };
  window.addEventListener('focus', resetWhenActive);
  document.addEventListener('visibilitychange', resetWhenActive);
  resetWhenActive();
  return () => {
    window.removeEventListener('focus', resetWhenActive);
    document.removeEventListener('visibilitychange', resetWhenActive);
  };
}
