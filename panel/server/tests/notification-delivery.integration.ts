import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('poll and WeFlow stream both honor mute settings and open WeChat', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'woc-notifications-'));
  process.env.PANEL_PUSH_DATA = join(temp, 'push.json');
  process.env.WOC_NOTIFICATION_POLL_MS = '1000';
  process.env.WOC_NOTIFICATION_IDLE_POLL_MS = '1000';
  const muted = new Set(['muted@chatroom', 'muted-direct']);
  const ids = [...muted, 'allowed@chatroom', 'allowed-direct'];
  let timestamp = 1;
  let onPush: ((event: any) => void) | undefined;
  const received: any[] = [];
  mock.module('../src/docker.js', {
    namedExports: {
      instanceRuntime: async () => 'running',
      weflowAvailable: async () => true,
      weflowMutedSessions: async () => new Set(muted),
      weflowApi: async (_inst: unknown, route: string) => route.startsWith('/api/v1/sessions')
        ? { sessions: ids.map(username => ({ username, lastTimestamp: timestamp, unreadCount: timestamp })) }
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
  try {
    notifications.startNotificationWatcher(() => [{ id: 'test-instance' } as any]);
    for (let i = 0; !onPush && i < 100; i++) await delay(10);
    assert.ok(onPush, 'stream connected after initial mute snapshot');
    const snapshot = received.find(item => item.snapshot);
    assert.equal(snapshot?.count, 2);
    assert.equal(snapshot?.sessions?.length, 2);
    received.length = 0;
    for (const sessionId of ids) onPush({ event: 'message.new', sessionId, timestamp: 2, content: 'fixture' });
    onPush({ event: 'message.new', sessionId: 'allowed-direct', timestamp: 2, content: 'outgoing', isSend: 1, localType: 1 });
    onPush({ event: 'message.new', sessionId: 'allowed-direct', timestamp: 2, content: 'system', isSend: 0, localType: 10000 });
    await delay(20);
    assert.deepEqual(received.filter(item => !item.snapshot).map(item => item.tag).sort(), [
      'wechat-test-instance-allowed-direct', 'wechat-test-instance-allowed@chatroom',
    ]);
    assert.ok(received.filter(item => !item.snapshot).every(item => item.url === '/i/test-instance'));
    notifications.markNotificationsRead({ id: 'test-user' } as any);
    assert.equal(received.filter(item => item.snapshot).at(-1)?.count, 0);
    received.length = 0;
    timestamp = 3;
    for (let i = 0; received.filter(item => !item.snapshot).length < 2 && i < 200; i++) await delay(10);
    assert.deepEqual(received.filter(item => !item.snapshot).map(item => item.tag).sort(), [
      'wechat-test-instance-allowed-direct', 'wechat-test-instance-allowed@chatroom',
    ]);
    assert.ok(received.filter(item => !item.snapshot).every(item => item.url === '/i/test-instance'));
  } finally {
    remove();
    mock.restoreAll();
    rmSync(temp, { recursive: true, force: true });
  }
});
