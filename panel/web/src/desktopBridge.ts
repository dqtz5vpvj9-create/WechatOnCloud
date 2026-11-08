const UNREAD_KEY = 'woc_desktop_unread';
let nativeUpdates: Promise<unknown> = Promise.resolve();
let notificationEpoch = 0;
let activated = false;
const newBackgroundTags = new Set<string>();
let nativeVisible = true;
let acknowledge: (() => Promise<unknown>) | undefined;
let acknowledging: Promise<void> | undefined;
let acknowledgmentPending = false;
let acknowledgedSequence = 0;
let acknowledgeAgain = false;
const deferredMessages: DesktopNotificationPayload[] = [];

function isForeground() {
  return nativeVisible && document.visibilityState === 'visible' && document.hasFocus();
}

function acknowledgeOnServer() {
  if (!acknowledge || acknowledging) return acknowledging;
  acknowledgmentPending = true;
  acknowledging = acknowledge().then(result => {
    const sequence = Number((result as { readSequence?: number })?.readSequence || 0);
    acknowledgedSequence = Math.max(acknowledgedSequence, sequence);
    acknowledgmentPending = false;
  }, () => {
    // The activation hook retries. Keep stale snapshots blocked while offline.
  }).finally(() => {
    acknowledging = undefined;
    if (acknowledgeAgain) {
      acknowledgeAgain = false;
      void acknowledgeOnServer();
    } else if (!acknowledgmentPending) {
      const messages = deferredMessages.splice(0);
      for (const message of messages) {
        if (message.sequence && message.sequence > acknowledgedSequence) void notifyTaskbar(message).catch(() => {});
      }
    }
  });
  return acknowledging;
}

function clearOnActivation() {
  activated = true;
  newBackgroundTags.clear();
  void resetTaskbarUnread().catch(() => {});
  if (acknowledging) acknowledgeAgain = true;
  void acknowledgeOnServer();
}

export function isDesktopApp() {
  return '__TAURI__' in window;
}

export interface DesktopNotificationPayload {
  sequence?: number;
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
  // Native commands can finish out of order. A delayed incoming notification
  // must finish before a later authoritative read snapshot clears it.
  const epoch = notificationEpoch;
  const update = nativeUpdates.catch(() => {}).then(() => epoch !== notificationEpoch ? undefined : invoke('set_desktop_notification', {
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
  }));
  nativeUpdates = update;
  await update;
}

function storedUnread() {
  const value = Number.parseInt(sessionStorage.getItem(UNREAD_KEY) || '0', 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function notifyTaskbar(payload: DesktopNotificationPayload) {
  if (!isDesktopApp()) return;
  if (!payload.snapshot && payload.sequence && payload.sequence <= acknowledgedSequence) return;
  if (isForeground()) {
    // Include snapshots: previously they bypassed the foreground check and
    // immediately restored blinking after the user had opened/read WeChat.
    if (Number(payload.count || 0) > 0) clearOnActivation();
    else await resetTaskbarUnread();
    return;
  }
  if (payload.snapshot) {
    const sessions = activated ? (payload.sessions || []).filter(item => newBackgroundTags.has(item.tag)) : payload.sessions;
    const count = Math.min(999, Math.max(0, activated
      ? (sessions || []).reduce((sum, item) => sum + item.count, 0) : Number(payload.count || 0)));
    sessionStorage.setItem(UNREAD_KEY, String(count));
    await setNativeUnread(count, false, { ...payload, count, sessions });
    return;
  }
  if (acknowledgmentPending) {
    deferredMessages.push(payload);
    if (deferredMessages.length > 100) deferredMessages.shift();
    return;
  }
  if (payload.tag) newBackgroundTags.add(payload.tag);
  const incoming = Number(payload.count || 1);
  const count = Math.min(999, storedUnread() + Math.max(1, incoming));
  sessionStorage.setItem(UNREAD_KEY, String(count));
  await setNativeUnread(count, true, payload);
}

export async function resetTaskbarUnread() {
  if (!isDesktopApp()) return;
  notificationEpoch++;
  sessionStorage.removeItem(UNREAD_KEY);
  await setNativeUnread(0, false);
}

export function installTaskbarUnreadReset(onAcknowledge?: () => Promise<unknown>) {
  if (!isDesktopApp()) return () => {};
  acknowledge = onAcknowledge;
  nativeVisible = true;
  let wasForeground = false;
  const resetWhenActive = () => {
    const foreground = isForeground();
    if (foreground && !wasForeground) clearOnActivation();
    wasForeground = foreground;
  };
  const onNativeVisibility = (event: Event) => {
    nativeVisible = (event as CustomEvent<{ visible?: boolean }>).detail?.visible !== false;
    if (nativeVisible) { clearOnActivation(); wasForeground = true; }
    else wasForeground = false;
  };
  // macOS can delay DOM focus around WKWebView/iframe activation. The native
  // show event clears immediately; the periodic check covers missed DOM events.
  const retry = window.setInterval(() => {
    resetWhenActive();
    if (acknowledgmentPending) void acknowledgeOnServer();
  }, 1000);
  window.addEventListener('focus', resetWhenActive);
  window.addEventListener('blur', resetWhenActive);
  window.addEventListener('pageshow', resetWhenActive);
  window.addEventListener('woc-native-visibility', onNativeVisibility);
  document.addEventListener('visibilitychange', resetWhenActive);
  resetWhenActive();
  return () => {
    window.clearInterval(retry);
    acknowledge = undefined;
    window.removeEventListener('focus', resetWhenActive);
    window.removeEventListener('blur', resetWhenActive);
    window.removeEventListener('pageshow', resetWhenActive);
    window.removeEventListener('woc-native-visibility', onNativeVisibility);
    document.removeEventListener('visibilitychange', resetWhenActive);
  };
}
