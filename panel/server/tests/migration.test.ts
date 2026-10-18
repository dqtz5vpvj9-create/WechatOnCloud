import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MigrationError,
  assertMigrationNatNetwork,
  assertMigrationPortUnreserved,
  defaultMigrationConfig,
  describeMigrationContainer,
  instanceMigrationConfig,
  migrationContainerPorts,
  migrationErrorMessage,
  migrationMappingMatches,
  migrationRecoveryImage,
  parseMigrationConfig,
  procHasMigrationListener,
  publishedPortConflicts,
} from '../src/migration.js';

const enabled = { enabled: true, bindAddress: '192.168.1.20', hostPort: 8015 };
const disabled = defaultMigrationConfig();

test('migration is opt-in, accepts explicit private IPv4, and never coerces input', () => {
  assert.deepEqual(instanceMigrationConfig({}), disabled);
  assert.deepEqual(parseMigrationConfig({ enabled: false }), disabled);
  assert.deepEqual(parseMigrationConfig({ enabled: true, bindAddress: '10.2.3.4' }), {
    enabled: true, bindAddress: '10.2.3.4', hostPort: 8015,
  });
  for (const bindAddress of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.0.2']) {
    assert.equal(parseMigrationConfig({ ...enabled, bindAddress }).bindAddress, bindAddress);
  }
  for (const bindAddress of ['', '0.0.0.0', '127.0.0.1', '8.8.8.8', '100.64.0.1', '169.254.1.1',
    '172.15.1.1', '172.32.1.1', '::', '::ffff:192.168.1.20', 'nas.local', '192.168.01.20',
    '192.168.1.20 ', '192.168.1.20;id', '192.168.1.20/24']) {
    assert.throws(() => parseMigrationConfig({ ...enabled, bindAddress }), MigrationError, bindAddress);
  }
  for (const hostPort of [0, -1, 65536, 1.5, '8015', null, false, NaN, Infinity]) {
    assert.throws(() => parseMigrationConfig({ ...enabled, hostPort }), MigrationError);
  }
  for (const raw of [null, [], 'yes', {}, { ...enabled, enabled: 'true' },
    { ...enabled, containerPort: 3000 }, { ...disabled, bindAddress: '0.0.0.0' }]) {
    assert.throws(() => parseMigrationConfig(raw), MigrationError);
  }
});

test('port reservations include stopped instances and the old binding until rollback finishes', () => {
  const reservations = [{
    id: 'a', name: '微信 A', migration: { ...enabled, hostPort: 9015 },
    migrationState: { applying: true, error: null, previousConfig: enabled },
  }];
  assert.throws(() => assertMigrationPortUnreserved(enabled, reservations, 'b'), { statusCode: 409 });
  assert.throws(() => assertMigrationPortUnreserved({ ...enabled, hostPort: 9015 }, reservations, 'b'), { statusCode: 409 });
  assert.doesNotThrow(() => assertMigrationPortUnreserved(enabled, reservations, 'a'));
  assert.doesNotThrow(() => assertMigrationPortUnreserved({ ...enabled, bindAddress: '192.168.1.21' }, reservations, 'b'));
  assert.doesNotThrow(() => assertMigrationPortUnreserved(disabled, reservations, 'b'));
  reservations[0].migrationState.applying = false;
  assert.doesNotThrow(() => assertMigrationPortUnreserved(enabled, reservations, 'b'));
});

test('published Docker TCP ports conflict for exact and wildcard IPv4 bindings', () => {
  for (const IP of [undefined, '', '0.0.0.0', '::', enabled.bindAddress]) {
    assert.equal(publishedPortConflicts(enabled, { IP, PublicPort: 8015, Type: 'tcp' }), true);
  }
  assert.equal(publishedPortConflicts(enabled, { IP: '192.168.1.21', PublicPort: 8015, Type: 'tcp' }), false);
  assert.equal(publishedPortConflicts(enabled, { IP: '0.0.0.0', PublicPort: 8015, Type: 'udp' }), false);
  assert.equal(publishedPortConflicts(enabled, { IP: '0.0.0.0', PublicPort: 9015, Type: 'tcp' }), false);
  assert.equal(publishedPortConflicts(disabled, { IP: '0.0.0.0', PublicPort: 8015, Type: 'tcp' }), false);
});

test('serialized configuration always regenerates only TCP 8015 and never publishes VNC', () => {
  const expected = {
    exposedPorts: { '8015/tcp': {} },
    portBindings: { '8015/tcp': [{ HostIp: '192.168.1.20', HostPort: '8015' }] },
  };
  let saved = { migration: enabled };
  for (let rebuild = 0; rebuild < 3; rebuild++) {
    saved = JSON.parse(JSON.stringify(saved));
    assert.deepEqual(migrationContainerPorts(instanceMigrationConfig(saved)), expected);
  }
  assert.deepEqual(migrationContainerPorts(disabled), { exposedPorts: {}, portBindings: {} });
  assert.equal(Object.hasOwn(expected.portBindings, '3000/tcp'), false);
  assert.equal(Object.hasOwn(expected.portBindings, '3001/tcp'), false);
});

test('actual mappings and pending declarations stay distinct while stopped or incompletely published', () => {
  const ports = migrationContainerPorts(enabled).portBindings;
  const info: any = {
    State: { Running: true },
    HostConfig: { PortBindings: ports },
    NetworkSettings: {
      Ports: ports,
      Networks: { 'woc-instances': { IPAddress: '172.19.4.11', IPPrefixLen: 22 } },
    },
  };
  assert.equal(migrationMappingMatches(enabled, info), true);
  assert.equal(migrationMappingMatches(enabled, info, true), true);
  assert.deepEqual(describeMigrationContainer(info, 'woc-instances'), {
    bindings: [{ hostIp: '192.168.1.20', hostPort: 8015, containerPort: 8015, protocol: 'tcp' }],
    containerIp: '172.19.4.11', subnet: '172.19.4.0/22', running: true,
  });
  info.NetworkSettings.Ports = {};
  assert.equal(migrationMappingMatches(enabled, info), true);
  assert.equal(migrationMappingMatches(enabled, info, true), false);
  assert.deepEqual(describeMigrationContainer(info).bindings, []);
  info.State.Running = false;
  info.NetworkSettings.Networks['woc-instances'].IPAddress = '';
  assert.equal(migrationMappingMatches(enabled, info), true);
  assert.equal(migrationMappingMatches({ ...enabled, hostPort: 9015 }, info), false);
  assert.deepEqual(describeMigrationContainer(info), { bindings: [], containerIp: null, subnet: null, running: false });
  assert.equal(migrationMappingMatches(disabled, null), true);
  assert.equal(migrationMappingMatches(enabled, null), false);
  const broad = { HostConfig: { PortBindings: { '8015/tcp': [{ HostIp: '0.0.0.0', HostPort: '8015' }] } } };
  assert.equal(migrationMappingMatches(enabled, broad), false);
});

test('host publishing rejects routed, internal, IPv6-only and non-bridge networks', () => {
  assert.doesNotThrow(() => assertMigrationNatNetwork({ Driver: 'bridge' }));
  assert.doesNotThrow(() => assertMigrationNatNetwork({ Driver: 'bridge', Internal: false, EnableIPv4: true,
    Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'nat' } }));
  for (const Driver of ['host', 'macvlan', 'ipvlan', 'overlay']) {
    assert.throws(() => assertMigrationNatNetwork({ Driver }), MigrationError);
  }
  for (const mode of ['routed', 'nat-unprotected', 'isolated']) {
    assert.throws(() => assertMigrationNatNetwork({ Driver: 'bridge', Options: { 'com.docker.network.bridge.gateway_mode_ipv4': mode } }), MigrationError);
  }
  assert.throws(() => assertMigrationNatNetwork({ Driver: 'bridge', Internal: true }), MigrationError);
  assert.throws(() => assertMigrationNatNetwork({ Driver: 'bridge', EnableIPv4: false }), MigrationError);
});

test('listener parser accepts only listening TCP 8015; persistent errors are bounded', () => {
  assert.equal(procHasMigrationListener('  0: 00000000:1F4F 00000000:0000 0A 00000000:00000000'), true);
  assert.equal(procHasMigrationListener('  0: 00000000000000000000000000000000:1F4F 00000000000000000000000000000000:0000 0A'), true);
  assert.equal(procHasMigrationListener('  0: 00000000:1F4F 00000000:0000 01'), false);
  assert.equal(procHasMigrationListener('  0: 00000000:0BB8 00000000:0000 0A'), false);
  assert.equal(procHasMigrationListener(''), false);
  const message = migrationErrorMessage(new Error('<html>bad\n' + 'x'.repeat(1000) + '</html>'));
  assert.equal(message.length, 500);
  assert.equal(message.includes('<html>'), false);
  assert.equal(message.includes('\n'), false);
});

test('store persists migration config, reserves ports, and reports interrupted apply with original image retained', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'woc-migration-store-'));
  const previousData = process.env.PANEL_DATA;
  const previousPassword = process.env.PANEL_ADMIN_PASSWORD;
  process.env.PANEL_DATA = join(dir, 'accounts.json');
  process.env.PANEL_ADMIN_PASSWORD = 'local-test-only-' + Date.now();
  try {
    const store = await import('../src/store.js');
    store.initStore();
    const a = store.createInstance('A', 'test');
    const b = store.createInstance('B', 'test');
    assert.deepEqual(instanceMigrationConfig(a), disabled);
    store.setInstanceMigration(a.id, enabled);
    assert.throws(() => store.setInstanceMigration(b.id, enabled), { statusCode: 409 });
    store.setInstanceMigration(a.id, { ...enabled, hostPort: 9015 }, {
      applying: true, error: null, previousConfig: enabled, imageId: 'sha256:original',
    });
    assert.throws(() => store.setInstanceMigration(b.id, enabled), { statusCode: 409 });
    store.initStore();
    const restored = store.findInstance(a.id)!;
    assert.deepEqual(instanceMigrationConfig(restored), enabled);
    assert.equal(restored.migrationState?.applying, false);
    assert.equal(restored.migrationState?.imageId, 'sha256:original');
    assert.match(restored.migrationState?.error || '', /中断/);
    const onDisk = JSON.parse(await readFile(process.env.PANEL_DATA, 'utf8'));
    assert.deepEqual(onDisk.instances.find((i: any) => i.id === a.id).migration, enabled);
    assert.equal(onDisk.instances.find((i: any) => i.id === b.id).migration, undefined);
    // 延后应用：先保存停止容器的 v1；模拟 start 失败后容器缺失，再编辑配置仍保留 v1。
    store.setInstanceMigration(a.id, { ...enabled, hostPort: 9015 }, {
      applying: false, error: null, imageId: migrationRecoveryImage({ Image: 'sha256:v1' }, restored.migrationState),
    });
    store.setInstanceMigrationState(a.id, { applying: false, error: 'bind failed', imageId: 'sha256:v1' });
    store.setInstanceMigration(a.id, { ...enabled, hostPort: 9016 }, {
      applying: false, error: null, imageId: migrationRecoveryImage(null, store.findInstance(a.id)!.migrationState),
    });
    store.initStore();
    assert.equal(store.findInstance(a.id)!.migrationState?.imageId, 'sha256:v1');
    // 显式升级成功后应采用 inspect 的 v2；后续丢容器不能再恢复到过时的 v1。
    store.setInstanceMigrationState(a.id, {
      applying: false, error: null,
      imageId: migrationRecoveryImage({ Image: 'sha256:v2' }, store.findInstance(a.id)!.migrationState),
    });
    store.initStore();
    assert.equal(migrationRecoveryImage(null, store.findInstance(a.id)!.migrationState), 'sha256:v2');
    const imageSaved = JSON.parse(await readFile(process.env.PANEL_DATA, 'utf8'));
    assert.equal(imageSaved.instances.find((i: any) => i.id === a.id).migrationState.imageId, 'sha256:v2');
    assert.throws(() => store.createInstance('Browser', 'test', [], undefined, 'chromium', enabled), /仅支持微信/);
  } finally {
    if (previousData === undefined) delete process.env.PANEL_DATA; else process.env.PANEL_DATA = previousData;
    if (previousPassword === undefined) delete process.env.PANEL_ADMIN_PASSWORD; else process.env.PANEL_ADMIN_PASSWORD = previousPassword;
    await rm(dir, { recursive: true, force: true });
  }
});
