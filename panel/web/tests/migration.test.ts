import assert from 'node:assert/strict';
import test from 'node:test';
import { api, type MigrationStatus } from '../src/api.ts';
import { isPrivateIPv4, migrationCheckSummary, migrationStatusSummary, parseMigrationForm } from '../src/migration.ts';

const status: MigrationStatus = {
  config: { enabled: true, bindAddress: '192.168.1.20', hostPort: 8015 },
  actual: {
    bindings: [{ hostIp: '192.168.1.20', hostPort: 8015, containerPort: 8015, protocol: 'tcp' }],
    containerIp: '172.19.0.2', subnet: '172.19.0.0/16', running: true,
  },
  applying: false, error: null, pending: false,
};

test('启用必须选择具体 RFC1918 IPv4，不能退化为全网卡/回环/公网/主机名绑定', () => {
  for (const address of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.1.20']) {
    assert.equal(isPrivateIPv4(address), true, address);
    assert.equal(parseMigrationForm(true, ` ${address} `, '').hostPort, 8015);
  }
  for (const address of ['', '0.0.0.0', '127.0.0.1', '8.8.8.8', '100.64.0.1', '172.15.0.1', '172.32.0.1',
    '192.169.1.1', '192.168.256.1', '192.168.01.1', '192.168.1', 'localhost', '::1', '::ffff:192.168.1.20']) {
    assert.throws(() => parseMigrationForm(true, address, '8015'), /局域网 IPv4/, address);
  }
});

test('关闭未配置实例无需填地址，关闭已配置实例保留原地址和端口', () => {
  assert.deepEqual(parseMigrationForm(false, '', ''), { enabled: false, bindAddress: '', hostPort: 8015 });
  assert.deepEqual(parseMigrationForm(false, '192.168.1.20', '18015'), { enabled: false, bindAddress: '192.168.1.20', hostPort: 18015 });
  assert.throws(() => parseMigrationForm(false, '0.0.0.0', '8015'), /局域网 IPv4/);
});

test('宿主端口只接受 1–65535 的十进制整数，不截断非法输入', () => {
  assert.equal(parseMigrationForm(true, '10.0.0.1', '1').hostPort, 1);
  assert.equal(parseMigrationForm(true, '10.0.0.1', '65535').hostPort, 65535);
  for (const port of ['0', '-1', '65536', '8015.5', '1e3', '0x1f4f', '8015/tcp', 'NaN']) {
    assert.throws(() => parseMigrationForm(true, '10.0.0.1', port), /1–65535/, port);
  }
});

test('保存、应用、回滚失败、迁移成功不能混为一个状态', () => {
  assert.match(migrationStatusSummary({ ...status, applying: true }), /正在应用/);
  assert.match(migrationStatusSummary({ ...status, pending: true, actual: { ...status.actual, running: false } }), /等待下次启动/);
  assert.match(migrationStatusSummary({ ...status, pending: true }), /尚未应用/);
  assert.match(migrationStatusSummary({ ...status, actual: { ...status.actual, running: false, bindings: [] } }), /启动后才发布/);
  assert.match(migrationStatusSummary({ ...status, error: '回滚失败', pending: true }), /上次应用未完成/);
  assert.match(migrationStatusSummary(status), /不代表微信聊天记录迁移已成功/);
  assert.match(migrationStatusSummary({ ...status, config: { ...status.config, enabled: false } }), /已关闭/);
});

test('探测结果明确区分容器监听、面板连通和手机路径，不将未监听判成网络故障', () => {
  const stopped = migrationCheckSummary({ listening: null, reachable: null, error: '实例未运行' });
  assert.match(stopped.listening, /尚未确认/);
  const idle = migrationCheckSummary({ listening: false, reachable: false, error: null });
  assert.match(idle.listening, /先在微信中进入聊天记录迁移页面/);
  assert.match(idle.reachable, /不能单独判断手机/);
  const ready = migrationCheckSummary({ listening: true, reachable: true, error: null });
  assert.match(ready.listening, /正在监听/);
  assert.match(ready.reachable, /面板可连接容器/);
  assert.match(ready.reachable, /不能证明宿主端口映射路径或手机可达/);
});

test('迁移 API 使用已有同源会话；检测不接受任意目标，不触及输入服务', async () => {
  const previousFetch = globalThis.fetch;
  const calls: { path: string; options: RequestInit }[] = [];
  globalThis.fetch = async (input, options = {}) => {
    calls.push({ path: String(input), options });
    const response = calls.length === 1 ? status
      : calls.length === 2 ? { ok: true, applying: true }
        : { listening: false, reachable: false, error: null };
    return new Response(JSON.stringify(response), { status: calls.length === 2 ? 202 : 200 });
  };
  try {
    assert.deepEqual(await api.getInstanceMigration('wx-1'), status);
    await api.setInstanceMigration('wx-1', status.config);
    await api.checkInstanceMigration('wx-1');
    assert.deepEqual(calls.map((c) => [c.path, c.options.method || 'GET']), [
      ['/api/admin/instances/wx-1/migration', 'GET'],
      ['/api/admin/instances/wx-1/migration', 'PUT'],
      ['/api/admin/instances/wx-1/migration/check', 'POST'],
    ]);
    for (const call of calls) {
      assert.equal(call.options.credentials, 'same-origin');
      assert.equal(call.options.redirect, 'manual');
    }
    assert.deepEqual(JSON.parse(calls[1].options.body as string), status.config);
    assert.equal(calls[2].options.body, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('PUT 被拒绝时保留后端错误，API 层不自动重试应用', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: '宿主地址与端口已被其他实例占用' }), { status: 409 });
  };
  try {
    await assert.rejects(api.setInstanceMigration('wx-1', status.config), /端口已被其他实例占用/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
