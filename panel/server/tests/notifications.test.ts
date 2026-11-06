import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotificationCandidate, selectNotificationCandidates, shouldInspectSameSecond } from '../src/notifications.js';

test('rejects outgoing messages', () => {
  assert.equal(isNotificationCandidate({ isSend: 1, localType: 1 }), false);
  assert.equal(isNotificationCandidate({ isSend: true, localType: 1 }), false);
  assert.equal(isNotificationCandidate({ isSend: '1', localType: 1 }), false);
  assert.equal(isNotificationCandidate({ localType: 1 }), false);
  assert.equal(isNotificationCandidate({ isSend: 0 }), false);
});

test('accepts incoming messages', () => {
  assert.equal(isNotificationCandidate({ isSend: 0, localType: 1 }), true);
  assert.equal(isNotificationCandidate({ isSend: '0', localType: 1 }), true);
  assert.equal(isNotificationCandidate({ isSend: false, localType: 1 }), true);
});

test('rejects system messages', () => {
  assert.equal(isNotificationCandidate({ isSend: 0, localType: 10000 }), false);
  assert.equal(isNotificationCandidate({ isSend: 0, localType: 10002 }), false);
});

test('same-second messages in an open chat use message IDs instead of unread count', () => {
  const messages = [{ localId: 2 }, { localId: 3 }];
  assert.deepEqual(selectNotificationCandidates(messages, 10, 10, 0, true), messages);
  assert.deepEqual(selectNotificationCandidates(messages, 10, 10, 0, false), []);
  assert.deepEqual(selectNotificationCandidates(messages, 10, 10, 1, false), [{ localId: 3 }]);
});

test('same-second open chat bypasses the unread-count short circuit only inside the ID window', () => {
  assert.equal(shouldInspectSameSecond(100, 100, 0, 0, true, 104), true);
  assert.equal(shouldInspectSameSecond(100, 100, 0, 0, false, 104), false);
  assert.equal(shouldInspectSameSecond(100, 100, 0, 0, true, 106), false);
  assert.equal(shouldInspectSameSecond(101, 100, 0, 0, true, 104), false);
});
