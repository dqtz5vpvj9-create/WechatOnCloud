import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('poll and WeFlow stream both honor mute settings and open WeChat', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'woc-notifications-'));
  process.env.PANEL_PUSH_DATA = join(temp, 'push.json');
  writeFileSync(process.env.PANEL_PUSH_DATA, JSON.stringify({ subscriptions: [], cursors: [['test-instance', [['legacy-ghost', {
    timestamp: 1, unread: 7, attention: 7, dismissedUnread: 0, idsAtTimestamp: [], idsSeeded: true, title: 'old official account',
  }]]]] }));
  process.env.WOC_NOTIFICATION_POLL_MS = '1000';
  process.env.WOC_NOTIFICATION_IDLE_POLL_MS = '1000';
  const muted = new Set(['muted@chatroom', 'muted-direct']);
  const ids = [...muted, 'allowed@chatroom', 'allowed-direct', 'gh_official', 'legacy-official'];
  let timestamp = 1;
  let unreadOverride: number | undefined;
  let onPush: ((event: any) => void) | undefined;
  const received: any[] = [];
  const streamMessages = new Map<string, any[]>();
  mock.module('../src/docker.js', {
    namedExports: {
      instanceRuntime: async () => 'running',
      weflowAvailable: async () => true,
      weflowMutedSessions: async () => new Set(muted),
      weflowApi: async (_inst: unknown, route: string) => route.startsWith('/api/v1/sessions')
        ? { sessions: ids.map(username => ({ username, lastTimestamp: timestamp, unreadCount: unreadOverride ?? timestamp })) }
        : route.startsWith('/api/v1/contacts')
          ? { contacts: [{ username: 'legacy-official', type: 'official' }, { username: 'legacy-ghost', type: 'official' }, { username: 'allowed-direct', type: 'friend' }] }
          : new URL(route, 'http://fixture').searchParams.has('start')
            ? { messages: streamMessages.get(new URL(route, 'http://fixture').searchParams.get('talker')!) || [{ createTime: 2, serverId: `stream-${new URL(route, 'http://fixture').searchParams.get('talker')}`, localType: 1, isSend: 0 }] }
            : { messages: [{ createTime: timestamp, localId: timestamp, localType: 1, isSend: 0, content: 'fixture' }] },
      consumeWeFlowMessagePush: async (_inst: unknown, callback: (event: any) => void) => {
        onPush = callback;
        await new Promise(() => {});
      },
      stopWeFlowMessagePush: async () => {},
      setWeFlowConsumer: async () => {},
    },
  });
  mock.module('../src/store.js', {
    namedExports: {
      findById: () => ({ id: 'test-user', disabled: false }),
      userCanAccess: () => true,
    },
  });
  const notifications = await import('../src/notifications.js');
  const remove = notifications.addLiveSubscriber('test-user', payload => received.push(payload));
  const secondDevice: any[] = [];
  const removeSecond = notifications.addLiveSubscriber('test-user', payload => secondDevice.push(payload));
  try {
    notifications.startNotificationWatcher(() => [{ id: 'test-instance' } as any]);
    for (let i = 0; !onPush && i < 100; i++) await delay(10);
    assert.ok(onPush, 'stream connected after initial mute snapshot');
    const snapshot = received.filter(item => item.snapshot).at(-1);
    assert.equal(snapshot?.count, 2);
    assert.equal(snapshot?.sessions?.length, 2);
    received.length = 0;
    onPush({ event: 'message.new', sessionId: 'allowed-direct', rawid: 'existing-at-startup', timestamp: 1 });
    await delay(20);
    assert.equal(received.filter(item => !item.snapshot).length, 0, 'a same-timestamp startup baseline never replays historical messages');
    for (const sessionId of ids) onPush({ event: 'message.new', sessionId, rawid: `stream-${sessionId}`, timestamp: 2, content: 'fixture' });
    onPush({ event: 'message.new', sessionId: 'allowed-direct', timestamp: 2, content: 'outgoing', isSend: 1, localType: 1 });
    onPush({ event: 'message.new', sessionId: 'allowed-direct', timestamp: 2, content: 'system', isSend: 0, localType: 10000 });
    await delay(20);
    assert.deepEqual(received.filter(item => !item.snapshot).map(item => item.tag).sort(), [
      'wechat-test-instance-allowed-direct', 'wechat-test-instance-allowed@chatroom',
    ]);
    assert.ok(received.filter(item => !item.snapshot).every(item => item.url === '/i/test-instance'));
    received.length = 0;
    // The actual WeFlow payload omits isSend/localType. Resolve its raw ID
    // against real message metadata before trusting it as an incoming message.
    streamMessages.set('allowed-direct', [
      { serverId: 'self-raw', createTime: 2, isSend: 1, localType: 1 },
      { serverId: 'system-raw', createTime: 2, isSend: 0, localType: 10000 },
    ]);
    onPush({ event: 'message.new', sessionId: 'allowed-direct', rawid: 'self-raw', timestamp: 2 });
    onPush({ event: 'message.new', sessionId: 'allowed-direct', rawid: 'system-raw', timestamp: 2 });
    onPush({ event: 'message.new', sessionId: 'allowed-direct', rawid: 'missing-raw', timestamp: 2 });
    onPush({ event: 'message.new', sessionId: 'allowed-direct', rawid: 'historical-raw', timestamp: 1 });
    onPush({ event: 'message.new', sessionId: 'allowed@chatroom', rawid: 'stream-allowed@chatroom', timestamp: 2 });
    onPush({ event: 'message.new', sessionId: 'allowed@chatroom', rawid: 'stream-allowed@chatroom', timestamp: 2 });
    await delay(30);
    assert.equal(received.filter(item => !item.snapshot).length, 0, 'outgoing, system, unresolved, historical and duplicate stream events never notify');
    streamMessages.set('allowed@chatroom', [{ serverId: 'second-incoming', createTime: 2, isSend: 0, localType: 1 }]);
    for (let i = 0; i < 2; i++) onPush({ event: 'message.new', sessionId: 'allowed@chatroom', rawid: 'second-incoming', timestamp: 2 });
    await delay(30);
    assert.equal(received.filter(item => !item.snapshot).length, 1, 'a distinct same-second incoming message notifies once even when concurrent stream copies arrive');
    notifications.markNotificationsRead({ id: 'test-user' } as any);
    assert.equal(received.filter(item => item.snapshot).at(-1)?.count, 0);
    assert.equal(secondDevice.filter(item => item.snapshot).at(-1)?.count, 0, 'dismiss synchronizes both devices');
    const stored = JSON.parse(readFileSync(process.env.PANEL_PUSH_DATA!, 'utf8'));
    assert.ok(stored.cursors[0][1].some(([, cursor]: any) => cursor.dismissedUnread === 1 && cursor.attention === 0));
    received.length = 0;
    timestamp = 3;
    for (let i = 0; received.filter(item => !item.snapshot).length < 2 && i < 200; i++) await delay(10);
    assert.deepEqual(received.filter(item => !item.snapshot).map(item => item.tag).sort(), [
      'wechat-test-instance-allowed-direct', 'wechat-test-instance-allowed@chatroom',
    ]);
    assert.ok(received.filter(item => !item.snapshot).every(item => item.url === '/i/test-instance'));
    received.length = 0;
    secondDevice.length = 0;
    unreadOverride = 0; // Phone reads the conversation; last message is unchanged.
    for (let i = 0; !received.some(item => item.snapshot && item.count === 0) && i < 200; i++) await delay(10);
    assert.equal(received.filter(item => item.snapshot).at(-1)?.count, 0, 'same-timestamp read clears attention');
    assert.equal(secondDevice.filter(item => item.snapshot).at(-1)?.count, 0, 'phone read reconciles both devices');
    received.length = 0;
    secondDevice.length = 0;
    notifications.markNotificationsRead({ id: 'test-user' } as any);
    assert.equal(received.at(-1)?.count, 0, 'repeated read acknowledgment resends authoritative state');
    assert.equal(secondDevice.at(-1)?.count, 0, 'repeated acknowledgment heals stale state on other devices');
    unreadOverride = undefined;
    timestamp = 4;
    for (let i = 0; !received.some(item => !item.snapshot) && i < 200; i++) await delay(10);
    notifications.markNotificationsRead({ id: 'test-user' } as any);
    const dismissed = JSON.parse(readFileSync(process.env.PANEL_PUSH_DATA!, 'utf8'));
    assert.equal(dismissed.cursors[0][1].find(([id]: any) => id === 'allowed-direct')[1].dismissedUnread, 4);
    remove();
    removeSecond();
    // Reload the module to simulate a fresh server process with the same disk.
    const restarted = await import('../src/notifications.js?restart');
    const afterRestart: any[] = [];
    const unsubscribe = restarted.addLiveSubscriber('test-user', payload => afterRestart.push(payload));
    try {
      assert.equal(afterRestart.at(-1)?.count, 0, 'restored state is withheld until current settings are checked');
      restarted.startNotificationWatcher(() => [{ id: 'test-instance' } as any]);
      for (let i = 0; afterRestart.length < 2 && i < 200; i++) await delay(10);
      assert.equal(afterRestart.filter(item => item.snapshot).at(-1)?.count, 0);
      assert.equal(afterRestart.filter(item => !item.snapshot).length, 0, 'restart never replays historical notifications');
      muted.add('allowed-direct');
      unreadOverride = 5;
      timestamp = 5;
      afterRestart.length = 0;
      for (let i = 0; !afterRestart.some(item => item.snapshot) && i < 200; i++) await delay(10);
      assert.ok(afterRestart.filter(item => item.snapshot).at(-1)?.sessions.every((session: any) => !session.tag.endsWith('allowed-direct')));
    } finally { unsubscribe(); }
  } finally {
    remove();
    removeSecond();
    mock.restoreAll();
    rmSync(temp, { recursive: true, force: true });
  }
});
