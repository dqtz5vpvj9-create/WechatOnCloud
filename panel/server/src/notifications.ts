import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { findById, userCanAccess, type Instance, type User } from './store.js';
import { consumeWeFlowMessagePush, instanceRuntime, setWeFlowConsumer, stopWeFlowMessagePush, weflowApi, weflowAvailable, weflowMutedSessions } from './docker.js';

interface StoredSubscription {
  userId: string;
  subscription: PushSubscription;
  createdAt: string;
  updatedAt: string;
}
interface PushData {
  vapid?: { publicKey: string; privateKey: string };
  subscriptions: StoredSubscription[];
  cursors?: Array<[string, Array<[string, Omit<Cursor, 'idsAtTimestamp'> & { idsAtTimestamp: string[] }]>]>;
}
interface Cursor {
  timestamp: number;
  unread: number;
  idsAtTimestamp: Set<string>;
  idsSeeded: boolean;
  title: string;
  avatarUrl?: string;
  attention: number;
  dismissedUnread: number;
}

interface SnapshotPayload {
  snapshot: true;
  count: number;
  sessions: Array<{
    tag: string;
    title: string;
    body: string;
    url: string;
    count: number;
    avatarUrl?: string;
  }>;
}

const FILE = process.env.PANEL_PUSH_DATA || '/data/panel/push.json';
const ACTIVE_POLL_MS = Math.max(1_000, Number(process.env.WOC_NOTIFICATION_POLL_MS || 1_500));
const IDLE_POLL_MS = Math.max(ACTIVE_POLL_MS, Number(process.env.WOC_NOTIFICATION_IDLE_POLL_MS || 15_000));
let data: PushData | null = null;
const cursors = new Map<string, Map<string, Cursor>>();
// Restored cursors must be reconciled with current mute/read settings before delivery.
const reconciledInstances = new Set<string>();
let lastPersisted = '';
const liveSubscribers = new Map<string, Set<(payload: object) => void>>();
const mutedByInstance = new Map<string, Set<string>>();
const pushWatchers = new Set<string>();
const pushReady = new Set<string>();
const watcherInstances = new Map<string, Instance>();
const weflowAvailability = new Map<string, { checkedAt: number; available: boolean }>();
const officialAccounts = new Map<string, { checkedAt: number; official: boolean }>();
let polling = false;

async function isOfficialAccount(inst: Instance, id: string): Promise<boolean> {
  if (id.endsWith('@chatroom')) return false;
  if (id === 'brandsessionholder' || id.startsWith('gh_')) return true;
  const key = `${inst.id}/${id}`;
  const cached = officialAccounts.get(key);
  if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached.official;
  const result = await weflowApi(inst, `/api/v1/contacts?keyword=${encodeURIComponent(id)}&limit=20`);
  const contact = Array.isArray(result?.contacts)
    ? result.contacts.find((item: any) => item.username === id) : undefined;
  const official = contact?.type === 'official';
  if (officialAccounts.size >= 5_000) officialAccounts.delete(officialAccounts.keys().next().value!);
  officialAccounts.set(key, { checkedAt: Date.now(), official });
  return official;
}

function unreadSnapshotFor(userId: string): SnapshotPayload {
  const user = findById(userId);
  if (!user || user.disabled) return { snapshot: true, count: 0, sessions: [] };
  let count = 0;
  const sessions: SnapshotPayload['sessions'] = [];
  for (const [instanceId, sessionCursors] of cursors) {
    if (!reconciledInstances.has(instanceId)) continue;
    if (!userCanAccess(user, instanceId)) continue;
    for (const [sessionId, cursor] of sessionCursors) {
      if (mutedByInstance.get(instanceId)?.has(sessionId)) continue;
      const unread = Math.max(0, cursor.unread - cursor.dismissedUnread, cursor.attention);
      count += unread;
      if (!unread) continue;
      sessions.push({
        tag: `wechat-${instanceId}-${sessionId}`,
        title: cursor.title || '微信未读消息',
        body: `${unread} 条未读消息`,
        url: `/i/${encodeURIComponent(instanceId)}`,
        count: unread,
        avatarUrl: cursor.avatarUrl,
      });
    }
  }
  return { snapshot: true, count: Math.min(999, count), sessions };
}

function broadcastUnreadSnapshots() {
  persist();
  for (const [userId, subscribers] of liveSubscribers) {
    const payload = unreadSnapshotFor(userId);
    for (const send of subscribers) {
      try { send(payload); } catch { /* stream cleanup removes stale clients */ }
    }
  }
}

export function isNotificationCandidate(message: any) {
  if (Number(message?.localType) === 10000) return false;
  return !message?.isSend;
}

export function markNotificationsRead(user: User, tag?: string) {
  let changed = false;
  for (const [instanceId, sessionCursors] of cursors) {
    if (!userCanAccess(user, instanceId)) continue;
    for (const [sessionId, cursor] of sessionCursors) {
      if (tag && tag !== `wechat-${instanceId}-${sessionId}`) continue;
      if (cursor.attention > 0) {
        cursor.attention = 0;
        changed = true;
      }
      if (cursor.dismissedUnread !== cursor.unread) {
        cursor.dismissedUnread = cursor.unread;
        changed = true;
      }
    }
  }
  if (changed) broadcastUnreadSnapshots();
}

export function selectNotificationCandidates(
  candidates: any[], timestamp: number, oldTimestamp: number, unreadIncrease: number, hasIdBaseline: boolean,
) {
  if (timestamp !== oldTimestamp || hasIdBaseline) return candidates;
  return unreadIncrease > 0 ? candidates.slice(-unreadIncrease) : [];
}

export function shouldInspectSameSecond(
  timestamp: number, oldTimestamp: number, unread: number, oldUnread: number, idsSeeded: boolean, nowSeconds: number,
) {
  return timestamp === oldTimestamp && unread <= oldUnread && idsSeeded && timestamp >= nowSeconds - 5;
}

async function instanceSupportsWeFlow(inst: Instance) {
  const cached = weflowAvailability.get(inst.id);
  if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached.available;
  const available = await weflowAvailable(inst);
  weflowAvailability.set(inst.id, { checkedAt: Date.now(), available });
  return available;
}

async function seedCurrentMessageIds(inst: Instance, sessions: any[], state: Map<string, Cursor>) {
  // Only a message received in the exact same second as startup needs this
  // baseline. Recent read/open sessions are the relevant set; older sessions
  // advance lastTimestamp and are detected without a baseline.
  const now = Math.floor(Date.now() / 1000);
  const recentReadSessions = sessions.slice(0, 100).filter((session: any) =>
    Number(session.unreadCount || 0) === 0 && Number(session.lastTimestamp || 0) >= now - 5);
  for (let offset = 0; offset < recentReadSessions.length; offset += 10) {
    await Promise.all(recentReadSessions.slice(offset, offset + 10).map(async (session: any) => {
      const id = String(session.username || '');
      const cursor = state.get(id);
      if (!id || !cursor) return;
      try {
        const result = await weflowApi(inst, `/api/v1/messages?talker=${encodeURIComponent(id)}&limit=20`);
        const messages = Array.isArray(result?.messages) ? result.messages : [];
        cursor.idsAtTimestamp = new Set(messages
          .filter((message: any) => Number(message.createTime || 0) === cursor.timestamp)
          .map((message: any) => String(message.serverId || message.localId)));
        cursor.idsSeeded = true;
      } catch { /* Polling still falls back to unread deltas when seeding fails. */ }
    }));
  }
}

function persist() {
  if (!data) return;
  // Match the sessions API bound; retain IDs only for the latest message second.
  data.cursors = [...cursors].slice(0, 500).map(([id, sessions]) => [id,
    [...sessions].slice(0, 500).map(([sessionId, cursor]) => [sessionId,
      { ...cursor, idsAtTimestamp: [...cursor.idsAtTimestamp].slice(-100) }]),
  ]);
  const serialized = JSON.stringify(data);
  if (serialized === lastPersisted) return;
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, serialized, { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
  lastPersisted = serialized;
}

function load(): PushData {
  if (data) return data;
  try {
    data = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { subscriptions: [] };
  } catch {
    data = { subscriptions: [] };
  }
  if (!Array.isArray(data!.subscriptions)) data!.subscriptions = [];
  for (const [instanceId, sessions] of data!.cursors || []) {
    const restored = new Map<string, Cursor>();
    for (const [sessionId, cursor] of sessions.slice(0, 500)) {
      if (![cursor.timestamp, cursor.unread, cursor.attention, cursor.dismissedUnread].every(Number.isFinite)) continue;
      restored.set(sessionId, { ...cursor, idsAtTimestamp: new Set(cursor.idsAtTimestamp.slice(-100)) });
    }
    cursors.set(instanceId, restored);
  }
  if (!data!.vapid?.publicKey || !data!.vapid?.privateKey) {
    data!.vapid = webpush.generateVAPIDKeys();
    persist();
  }
  webpush.setVapidDetails(process.env.WOC_PUSH_SUBJECT || 'mailto:admin@localhost.local', data!.vapid.publicKey, data!.vapid.privateKey);
  return data!;
}

export function pushPublicKey() {
  return load().vapid!.publicKey;
}

export function userHasPush(userId: string) {
  return load().subscriptions.some((s) => s.userId === userId);
}

function validSubscription(s: any): s is PushSubscription {
  return !!s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') &&
    typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string' &&
    s.endpoint.length <= 4096 && s.keys.p256dh.length <= 1024 && s.keys.auth.length <= 256;
}

export function savePushSubscription(userId: string, subscription: unknown) {
  if (!validSubscription(subscription)) throw new Error('推送订阅格式无效');
  const d = load();
  const now = new Date().toISOString();
  const existing = d.subscriptions.find((s) => s.subscription.endpoint === subscription.endpoint);
  if (existing) {
    existing.userId = userId;
    existing.subscription = subscription;
    existing.updatedAt = now;
  } else {
    d.subscriptions.push({ userId, subscription, createdAt: now, updatedAt: now });
  }
  persist();
}

function hasNotificationConsumers() {
  return liveSubscribers.size > 0 || load().subscriptions.length > 0;
}

function stopUnusedPushWatchers() {
  if (hasNotificationConsumers()) return;
  for (const inst of watcherInstances.values()) void stopWeFlowMessagePush(inst);
}

export function removePushSubscription(userId: string, endpoint?: string) {
  const d = load();
  d.subscriptions = d.subscriptions.filter((s) => s.userId !== userId || (!!endpoint && s.subscription.endpoint !== endpoint));
  persist();
  stopUnusedPushWatchers();
}

export function addLiveSubscriber(userId: string, send: (payload: object) => void) {
  load();
  let subscribers = liveSubscribers.get(userId);
  if (!subscribers) {
    subscribers = new Set();
    liveSubscribers.set(userId, subscribers);
  }
  subscribers.add(send);
  if (cursors.size) send(unreadSnapshotFor(userId));
  return () => {
    subscribers!.delete(send);
    if (!subscribers!.size) liveSubscribers.delete(userId);
    stopUnusedPushWatchers();
  };
}

async function sendStored(record: StoredSubscription, payload: object) {
  try {
    await webpush.sendNotification(record.subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) {
      const d = load();
      d.subscriptions = d.subscriptions.filter((s) => s !== record);
      persist();
      return false;
    }
    throw e;
  }
}

export async function sendTestPush(user: User) {
  const records = load().subscriptions.filter((s) => s.userId === user.id);
  const live = [...(liveSubscribers.get(user.id) || [])];
  if (!records.length && !live.length) throw new Error('当前设备尚未连接通知服务');
  const payload = {
    title: '云微通知已开启',
    body: 'WeFlow 新消息会通过这里提醒你。',
    count: 1,
    tag: 'woc-push-test',
    url: '/',
    icon: '/icon-192.png',
    timestamp: Date.now(),
  };
  for (const send of live) send(payload);
  await Promise.all(records.map((s) => sendStored(s, payload)));
}

function preview(message: any): string {
  const type = Number(message?.localType);
  if (type === 3) return '[图片]';
  if (type === 34) return '[语音]';
  if (type === 43) return '[视频]';
  if (type === 47) return '[表情]';
  if (type === 49 || type === 244813135921) return '[链接或文件]';
  const text = String(message?.parsedContent || message?.content || '').replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<')) return '[新消息]';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

async function deliverToUsers(inst: Instance, payload: object) {
  const records = load().subscriptions.filter((s) => {
    const user = findById(s.userId);
    return !!user && !user.disabled && userCanAccess(user, inst.id);
  });
  const live = [...liveSubscribers.entries()].flatMap(([userId, subscribers]) => {
    const user = findById(userId);
    return user && !user.disabled && userCanAccess(user, inst.id) ? [...subscribers] : [];
  });
  if (!records.length && !live.length) return;
  for (const send of live) {
    try { send(payload); } catch { /* The stream close handler removes stale clients. */ }
  }
  await Promise.allSettled(records.map((s) => sendStored(s, payload)));
}

async function notifyUsers(inst: Instance, session: any, incoming: any[]) {
  const latest = incoming[incoming.length - 1];
  const text = preview(latest);
  const body = incoming.length > 1 ? `${incoming.length} 条新消息 · ${text}` : text;
  const payload = {
    title: String(session.displayName || '微信新消息').slice(0, 80),
    body,
    count: incoming.length,
    tag: `wechat-${inst.id}-${session.username}`,
    avatarUrl: session.avatarUrl,
    url: `/i/${encodeURIComponent(inst.id)}`,
    icon: '/icon-192.png',
    timestamp: Number(latest.createTime || 0) * 1000,
  };
  await deliverToUsers(inst, payload);
}

async function handleWeFlowPush(inst: Instance, event: any) {
  if (event?.event !== 'message.new') return;
  const id = String(event.sessionId || '').trim();
  if (!id) return;
  const cursor = cursors.get(inst.id)?.get(id);
  if (Number(event?.localType) === 10000) return;
  if (event?.isSend) {
    if (cursor && (cursor.attention || cursor.dismissedUnread !== cursor.unread)) {
      cursor.attention = 0;
      cursor.dismissedUnread = cursor.unread;
      broadcastUnreadSnapshots();
    }
    return;
  }
  if (mutedByInstance.get(inst.id)?.has(id)) return;
  if (await isOfficialAccount(inst, id)) {
    const blocked = mutedByInstance.get(inst.id) || new Set<string>();
    blocked.add(id);
    mutedByInstance.set(inst.id, blocked);
    broadcastUnreadSnapshots();
    return;
  }
  const timestamp = Number(event.timestamp || 0);
  const state = cursors.get(inst.id);
  const current = state?.get(id);
  if (current && timestamp >= current.timestamp) {
    if (timestamp > current.timestamp) current.idsAtTimestamp.clear();
    current.timestamp = timestamp;
    current.idsAtTimestamp.add(String(event.rawid || ''));
    current.idsSeeded = true;
    current.attention = Math.min(999, current.attention + 1);
  }

  const group = String(event.groupName || '').trim();
  const source = String(event.sourceName || '').trim();
  const content = String(event.content || '[新消息]').replace(/\s+/g, ' ').trim() || '[新消息]';
  const payload = {
    title: (group || source || '微信新消息').slice(0, 80),
    body: group && source ? `${source}：${content}` : content,
    count: 1,
    tag: `wechat-${inst.id}-${id}`,
    avatarUrl: event.avatarUrl,
    url: `/i/${encodeURIComponent(inst.id)}`,
    icon: '/icon-192.png',
    timestamp: timestamp * 1000 || Date.now(),
  };
  await deliverToUsers(inst, payload);
  broadcastUnreadSnapshots();
  const latency = timestamp > 0 ? Date.now() - timestamp * 1000 : -1;
  console.log(`[notifications] WeFlow push · ${inst.id}/${id} · latency=${latency}ms`);
}

function ensurePushWatcher(inst: Instance) {
  if (pushWatchers.has(inst.id)) return;
  pushWatchers.add(inst.id);
  watcherInstances.set(inst.id, inst);
  void (async () => {
    await setWeFlowConsumer(inst, 'notifications', true);
    while (hasNotificationConsumers()) {
      try {
        await consumeWeFlowMessagePush(inst, (event) => {
          if (event?.success === true && event?.stream) {
            pushReady.add(inst.id);
            return;
          }
          void handleWeFlowPush(inst, event).catch(() => { /* Retry classification via the sessions poll. */ });
        });
      } catch { /* WeFlow restarts and disabled streams reconnect below. */ }
      pushReady.delete(inst.id);
      if (!hasNotificationConsumers()) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await setWeFlowConsumer(inst, 'notifications', false);
    pushReady.delete(inst.id);
    pushWatchers.delete(inst.id);
    watcherInstances.delete(inst.id);
  })();
}

async function pollInstance(inst: Instance) {
  if ((await instanceRuntime(inst)) !== 'running') return;
  const [result, nativeMuted] = await Promise.all([
    weflowApi(inst, '/api/v1/sessions?limit=500'),
    weflowMutedSessions(inst),
  ]);
  const mutedSessions = new Set(nativeMuted);
  const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  const relevant = sessions.filter((session: any) => Number(session.unreadCount || 0) > 0
    || (cursors.get(inst.id)?.get(String(session.username))?.attention || 0) > 0);
  const presentIds = new Set(relevant.map((session: any) => String(session.username)));
  for (const [id, cursor] of cursors.get(inst.id) || []) {
    if ((cursor.unread > 0 || cursor.attention > 0) && !presentIds.has(id)) {
      relevant.push({ username: id });
    }
  }
  for (let offset = 0; offset < relevant.length; offset += 10) {
    await Promise.all(relevant.slice(offset, offset + 10).map(async (session: any) => {
      const id = String(session.username || '');
      if (id && !mutedSessions.has(id) && await isOfficialAccount(inst, id)) mutedSessions.add(id);
    }));
  }
  const previousMuted = mutedByInstance.get(inst.id);
  const muteChanged = !previousMuted || previousMuted.size !== mutedSessions.size
    || [...mutedSessions].some(id => !previousMuted.has(id));
  mutedByInstance.set(inst.id, mutedSessions);
  const firstReconciliation = !reconciledInstances.has(inst.id);
  reconciledInstances.add(inst.id);
  let state = cursors.get(inst.id);
  if (!state) {
    state = new Map(sessions.map((s: any) => [String(s.username), {
      timestamp: Number(s.lastTimestamp || 0), unread: Number(s.unreadCount || 0), idsAtTimestamp: new Set<string>(), idsSeeded: false,
      title: String(s.displayName || ''), avatarUrl: typeof s.avatarUrl === 'string' ? s.avatarUrl : undefined,
      attention: 0,
      dismissedUnread: 0,
    }]));
    cursors.set(inst.id, state);
    await seedCurrentMessageIds(inst, sessions, state);
    broadcastUnreadSnapshots();
    return;
  }
  let unreadChanged = firstReconciliation || muteChanged;
  for (const session of sessions) {
    const id = String(session.username || '');
    if (!id) continue;
    const timestamp = Number(session.lastTimestamp || 0);
    const unread = Number(session.unreadCount || 0);
    const old = state.get(id);
    if (!old) {
      state.set(id, {
        timestamp, unread, idsAtTimestamp: new Set(), idsSeeded: false,
        title: String(session.displayName || ''), avatarUrl: typeof session.avatarUrl === 'string' ? session.avatarUrl : undefined,
        attention: 0, dismissedUnread: 0,
      });
      unreadChanged ||= unread > 0;
      continue;
    }
    // Read state changes independently of last-message timestamps. Do this
    // before the unchanged-message fast path, while ignoring stale DB snapshots.
    if (timestamp >= old.timestamp && unread === 0 && old.unread > 0) {
      old.attention = 0;
      old.dismissedUnread = 0;
      unreadChanged = true;
    }
    const inspectSameSecond = shouldInspectSameSecond(
      timestamp, old.timestamp, unread, old.unread, old.idsSeeded, Math.floor(Date.now() / 1000),
    );
    if (timestamp < old.timestamp || (timestamp === old.timestamp && unread <= old.unread && !inspectSameSecond)) {
      if (timestamp === old.timestamp && unread !== old.unread) {
        old.unread = unread;
        unreadChanged = true;
      }
      continue;
    }
    const messagesResult = await weflowApi(inst, `/api/v1/messages?talker=${encodeURIComponent(id)}&limit=50`);
    const messages = Array.isArray(messagesResult?.messages) ? messagesResult.messages : [];
    const candidates = messages
      .filter((m: any) => isNotificationCandidate(m) && (
        Number(m.createTime || 0) > old.timestamp ||
        (Number(m.createTime || 0) === old.timestamp && !old.idsAtTimestamp.has(String(m.serverId || m.localId)))
      ))
      .sort((a: any, b: any) => Number(a.sortSeq || a.createTime) - Number(b.sortSeq || b.createTime));
    // Several messages can share a one-second timestamp. On the first poll after
    // subscribing, the baseline has no IDs for that second, so cap the result to
    // the unread increase instead of replaying older messages from the same second.
    const unreadIncrease = Math.max(0, unread - old.unread);
    // An open chat keeps unreadCount at zero. IDs, rather than unreadCount,
    // distinguish several incoming messages that share WeChat's one-second
    // timestamp. On the first observation with no ID baseline, retain the old
    // unread cap to avoid replaying pre-existing messages from that second.
    const incoming = selectNotificationCandidates(
      candidates, timestamp, old.timestamp, unreadIncrease, old.idsSeeded,
    );
    const newest = Math.max(timestamp, ...messages.map((m: any) => Number(m.createTime || 0)));
    const idsAtTimestamp = new Set<string>(messages
      .filter((m: any) => Number(m.createTime || 0) === newest)
      .map((m: any) => String(m.serverId || m.localId)));
    if (unread === 0 && old.unread > 0) {
      old.attention = 0;
      old.dismissedUnread = 0;
    }
    unreadChanged ||= unread !== old.unread;
    state.set(id, {
      timestamp: newest, unread, idsAtTimestamp, idsSeeded: true,
      title: String(session.displayName || old.title || ''),
      avatarUrl: typeof session.avatarUrl === 'string' ? session.avatarUrl : old.avatarUrl,
      attention: old.attention,
      dismissedUnread: old.dismissedUnread,
    });
    if (incoming.length && !mutedSessions.has(id)) {
      const cursor = state.get(id)!;
      cursor.attention = Math.min(999, cursor.attention + incoming.length);
      await notifyUsers(inst, session, incoming);
    }
  }
  if (unreadChanged) broadcastUnreadSnapshots();
  else persist();
}

export function startNotificationWatcher(instances: () => Instance[]) {
  load();
  const tick = async () => {
    if (polling || (!load().subscriptions.length && !liveSubscribers.size)) return;
    polling = true;
    try {
      for (const inst of instances()) {
        try {
          if (!(await instanceSupportsWeFlow(inst))) continue;
          await pollInstance(inst);
          ensurePushWatcher(inst);
        } catch { /* WeFlow may be starting or absent on this instance. */ }
      }
    } finally {
      polling = false;
    }
  };
  const schedule = () => {
    // The push stream carries new messages, while read state lives in the
    // sessions snapshot. Keep the lightweight sessions poll active whenever a
    // desktop/PWA client is connected so reading on one device clears every
    // other device promptly.
    const delay = liveSubscribers.size ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    setTimeout(() => void tick().finally(schedule), delay).unref();
  };
  void tick().finally(schedule);
}
