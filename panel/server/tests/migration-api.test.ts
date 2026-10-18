import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const serverDir = dirname(dirname(fileURLToPath(import.meta.url)));

// 真实 Fastify + 真实账号会话；Docker 明确指向不存在的临时 socket。
// 此测试验证鉴权/协议/写入前校验，不模拟微信或声称 Docker 端口已生效。
test('migration HTTP API requires admin and rejects invalid configuration before Docker or store writes', { timeout: 65_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'woc-migration-api-'));
  const dataPath = join(dir, 'accounts.json');
  const password = randomBytes(24).toString('hex');
  const hash = bcrypt.hashSync(password, 4);
  const createdAt = new Date().toISOString();
  const makeUser = (id: string, role: 'admin' | 'sub') => ({
    id, username: id, role, passwordHash: hash, disabled: false, createdAt, allowedInstances: ['1111111111'], mustChangePassword: false,
  });
  const makeInstance = (id: string, appType = 'wechat') => ({
    id, name: id, appType, containerName: 'woc-wx-' + id, volumeName: 'woc-data-' + id,
    kasmUser: 'woc', kasmPassword: randomBytes(24).toString('hex'), createdAt, createdBy: 'test-admin',
  });
  await writeFile(dataPath, JSON.stringify({
    users: [makeUser('test-admin', 'admin'), makeUser('test-sub', 'sub')],
    instances: [makeInstance('1111111111'), makeInstance('2222222222', 'chromium')],
  }), { mode: 0o600 });
  await mkdir(join(dir, 'static'));
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PANEL_DATA: dataPath,
      PANEL_ADMIN_PASSWORD: password,
      STATIC_DIR: join(dir, 'static'),
      PORT: String(port), HOST: '127.0.0.1',
      DOCKER_HOST: 'unix://' + join(dir, 'absent-docker.sock'),
      WOC_VERSION: 'dev-migration-test',
      WOC_WECHAT_IMAGE: 'migration-test-local:latest',
      WOC_WATCHDOG_INTERVAL_SEC: '0',
      WOC_DOCKER_NETWORK: '', WOC_INSTANCE_NETWORK: 'migration-test-network',
      PANEL_ALLOWED_HOSTS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 不向测试输出打印账号密码、Cookie 或请求正文。
  child.stdout.resume();
  child.stderr.resume();
  try {
    const deadline = Date.now() + 50_000; // 上游 waitForDocker 在明确不可用时等待 30s。
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`panel exited before readiness (${child.exitCode})`);
      try {
        const response = await fetch(base + '/api/auth/me', { signal: AbortSignal.timeout(500) });
        if (response.status === 401) { ready = true; break; }
      } catch { /* 启动尚未完成 */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(ready, true, 'panel should start even when Docker is unavailable');
    const request = async (method: string, path: string, cookie?: string, body?: unknown) => {
      const headers: Record<string, string> = {};
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      return fetch(base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
    };
    const route = '/api/admin/instances/1111111111/migration';
    for (const [method, path, body] of [
      ['GET', route, undefined], ['PUT', route, { enabled: false }], ['POST', route + '/check', undefined],
    ] as const) {
      assert.equal((await request(method, path, undefined, body)).status, 401);
    }
    const login = async (username: string) => {
      const response = await request('POST', '/api/auth/login', undefined, { username, password });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie, 'login should issue a session cookie');
      return cookie;
    };
    const subCookie = await login('test-sub');
    for (const [method, path, body] of [
      ['GET', route, undefined], ['PUT', route, { enabled: false }], ['POST', route + '/check', undefined],
    ] as const) {
      assert.equal((await request(method, path, subCookie, body)).status, 403);
    }
    const adminCookie = await login('test-admin');
    assert.equal((await request('GET', '/api/admin/instances/missing/migration', adminCookie)).status, 404);
    assert.equal((await request('GET', '/api/admin/instances/2222222222/migration', adminCookie)).status, 400);
    for (const body of [
      { enabled: true, bindAddress: '0.0.0.0', hostPort: 8015 },
      { enabled: true, bindAddress: '192.168.1.20', hostPort: '8015' },
      { enabled: false, containerPort: 3000 },
      { enabled: 'false' },
    ]) {
      assert.equal((await request('PUT', route, adminCookie, body)).status, 400);
    }
    assert.equal((await request('POST', route + '/check', adminCookie, { host: '192.168.1.1', port: 22 })).status, 400);
    assert.equal((await request('PUT', route, adminCookie, { enabled: false, excess: 'x'.repeat(3000) })).status, 413);
    assert.equal((await request('POST', '/api/admin/instances', adminCookie, {
      name: 'rejected', migration: { enabled: true, bindAddress: '127.0.0.1', hostPort: 8015 },
    })).status, 400);
    assert.equal((await request('GET', route, adminCookie)).status, 503, 'unavailable Docker must not be reported as a valid missing container');
    const saved = JSON.parse(await readFile(dataPath, 'utf8'));
    assert.equal(saved.instances.length, 2);
    assert.equal(saved.instances[0].migration, undefined, 'all rejected requests must leave config untouched');
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      kill.unref();
      await closed;
      clearTimeout(kill);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
