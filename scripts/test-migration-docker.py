#!/usr/bin/env python3
"""Exercise the real Fastify/Docker migration lifecycle on a native Linux host.

Prerequisites:
  docker build -t woc-panel-migration:test panel
  python3 scripts/test-migration-docker.py

Uses only Python's standard library and the Docker CLI. The Docker daemon must
run on this host, with /var/run/docker.sock and a bindable RFC1918 IPv4 address.
The default address is the default bridge's gateway. A temporary Node fixture
listens on 8015; this tests networking/lifecycle, NOT WeChat or phone migration.
No daemon configuration is changed. Each created resource is recorded and
removed precisely in finally; no prune, wildcard deletion, or shared-image
cleanup is performed. The caller's panel image and node:22-slim are retained.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid


OWNER_LABEL = 'com.wechatoncloud.migration-smoke'
SENTINEL = '/config/migration-smoke-sentinel'
PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))

FIXTURE_DOCKERFILE = '''\
ARG FIXTURE_BASE=node:22-slim
FROM ${FIXTURE_BASE}
ARG FIXTURE_REV=1
ARG FIXTURE_RUN
ENV FIXTURE_REV=${FIXTURE_REV} FIXTURE_RUN=${FIXTURE_RUN}
COPY fixture.cjs /fixture.cjs
EXPOSE 3000 3001 8015
CMD ["node", "/fixture.cjs"]
'''

FIXTURE_JS = r'''
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
fs.mkdirSync('/config', { recursive: true });
const banner = `woc-migration-fixture:${process.env.FIXTURE_RUN}:${process.env.FIXTURE_REV}\n`;
net.createServer(socket => { socket.on('error', () => {}); socket.end(banner); }).listen(8015, '0.0.0.0');
// These are deliberately available inside the container but must NEVER be published.
for (const port of [3000, 3001]) http.createServer((req, res) => res.end('fixture only')).listen(port, '0.0.0.0');
console.log(`migration fixture revision ${process.env.FIXTURE_REV} ready`);
'''


class SmokeFailure(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise SmokeFailure(message)


class Smoke:
    def __init__(self, args):
        self.args = args
        self.run_id = uuid.uuid4().hex
        self.prefix = 'woc-migration-smoke-' + self.run_id[:16]
        self.panel = self.prefix + '-panel'
        self.network = self.prefix + '-net'
        self.panel_volume = self.prefix + '-data'
        # Reuse a test-owned, pre-created volume so even a failed create has
        # an exact, known container/volume name; never scan all woc-* resources.
        self.instance_id = self.run_id[:10]
        self.instance = 'woc-wx-' + self.instance_id
        self.instance_volume = 'woc-data-' + self.instance_id
        self.fixture_ref = '127.0.0.1:1/woc-migration-fixture-' + self.run_id + ':dev'
        self.image_ids = []
        self.fixture_revision_refs = []
        self.fixture_build_started = False
        self.created_volumes = []
        self.created_network = False
        self.created_panel = False
        self.instance_expected = False
        self.password = secrets.token_urlsafe(32)
        self.username = 'smoke-' + self.run_id[:8]
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )
        self.base = ''
        self.used_ports = set()
        self.passed = []

    def redact(self, text):
        text = str(text).replace(self.password, '<redacted>')
        # Failure logs should not expose cookies, auth headers, or credentials.
        return re.sub(r'(?im)^.*(?:authorization|set-cookie|"cookie"|"password"|kasmPassword|passwordHash).*$','<credential-bearing log line omitted>', text)

    def log(self, message):
        print(self.redact(message), flush=True)

    def docker(self, *args, timeout=90, check=True, env=None):
        result = subprocess.run(['docker', *args], text=True, capture_output=True, timeout=timeout, env=env)
        if check and result.returncode:
            raise SmokeFailure(self.redact('docker ' + ' '.join(args[:5]) + ' failed: ' + (result.stderr or result.stdout)[-5000:]))
        return result

    def inspect(self, kind, name, missing_ok=False):
        result = self.docker(kind, 'inspect', name, check=False)
        if result.returncode:
            if missing_ok and re.search(r'No such|not found|does not exist', result.stderr, re.I):
                return None
            raise SmokeFailure(self.redact(f'Cannot inspect {kind} {name}: {result.stderr[-1200:]}'))
        return json.loads(result.stdout)[0]

    def request(self, method, path, body=None, expected=(200, 202), timeout=30):
        data = None if body is None else json.dumps(body).encode()
        headers = {'Content-Type': 'application/json'} if data is not None else {}
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as response:
                code, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            code, raw = error.code, error.read()
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise SmokeFailure(f'{method} {path}: HTTP {code}, response is not JSON')
        if code not in expected:
            raise SmokeFailure(self.redact(f'{method} {path}: unexpected HTTP {code}: {payload}'))
        return code, payload

    def wait(self, description, probe, timeout=None):
        deadline = time.monotonic() + (timeout or self.args.timeout)
        last = 'not ready'
        while time.monotonic() < deadline:
            try:
                value = probe()
                if value:
                    return value
            except (SmokeFailure, OSError, urllib.error.URLError) as error:
                last = self.redact(error)
            time.sleep(0.4)
        raise SmokeFailure(f'Timed out waiting for {description}: {last}')

    def ready(self):
        # Docker may allocate a different ephemeral host port after restart.
        # Always read the current binding before making any readiness/login request.
        binding = self.inspect('container', self.panel)['NetworkSettings']['Ports']['8080/tcp']
        require(len(binding) == 1 and binding[0]['HostIp'] == '127.0.0.1', 'Panel was not published exclusively on loopback')
        self.base = 'http://127.0.0.1:' + binding[0]['HostPort']
        self.wait('panel HTTP readiness', lambda: self.request('GET', '/api/auth/me', expected=(200, 401), timeout=3))
        _, response = self.request('POST', '/api/auth/login', {'username': self.username, 'password': self.password})
        require(response.get('user', {}).get('role') == 'admin', 'Login did not establish the test admin session')

    def migration(self):
        return self.request('GET', f'/api/admin/instances/{self.instance_id}/migration')[1]

    def settled(self):
        def probe():
            state = self.migration()
            return state if not state.get('applying') else None
        return self.wait('migration apply/rollback completion', probe)

    def configure(self, config, expected_applying):
        code, response = self.request('PUT', f'/api/admin/instances/{self.instance_id}/migration', config)
        require(code == (202 if expected_applying else 200), f'Unexpected apply HTTP status: {code}')
        require(response == {'ok': True, 'applying': expected_applying}, f'Unexpected apply result: {response}')
        return self.settled()

    def lifecycle(self, action):
        self.request('POST', f'/api/admin/instances/{self.instance_id}/{action}', timeout=self.args.timeout)
        if action in ('start', 'restart'):
            self.wait('instance running after ' + action, self.running_instance)

    def running_instance(self):
        info = self.inspect('container', self.instance, missing_ok=True)
        return info if info and info.get('State', {}).get('Running') else None

    def checkpoint(self, title):
        self.passed.append(title)
        self.log('PASS: ' + title)

    def fresh_port(self, address):
        for _ in range(50):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.bind((address, 0))
                port = listener.getsockname()[1]
            if port not in self.used_ports:
                self.used_ports.add(port)
                return port
        raise SmokeFailure('Could not allocate distinct temporary host ports')

    def host_listener(self):
        for _ in range(50):
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                listener.bind((self.address, 0))
                port = listener.getsockname()[1]
                if port in self.used_ports:
                    listener.close()
                    continue
                self.used_ports.add(port)
                listener.listen(8)
                return listener
            except Exception:
                listener.close()
                raise
        raise SmokeFailure('Could not reserve a distinct non-Docker host port')

    def build_fixture(self, directory, revision):
        self.log(f'Building temporary fixture revision {revision}…')
        iid_file = directory / f'image-{revision}.txt'
        # Preserve immutable revision tags, matching the deployment's versioned
        # images. Docker's containerd store can lose ID lookup for an untagged image.
        revision_ref = f'{self.fixture_ref}-revision-{revision}'
        self.fixture_revision_refs.append(revision_ref)
        self.fixture_build_started = True
        self.docker('build', '--pull=false', '--provenance=false', '--sbom=false', '--label', f'{OWNER_LABEL}={self.run_id}',
                    '--build-arg', f'FIXTURE_BASE={self.args.fixture_base}',
                    '--build-arg', f'FIXTURE_REV={revision}', '--build-arg', f'FIXTURE_RUN={self.run_id}',
                    '--iidfile', str(iid_file), '-t', self.fixture_ref, '-t', revision_ref, str(directory), timeout=600)
        image_id = iid_file.read_text().strip()
        self.image_ids.append(image_id)
        return image_id

    def identity(self):
        info = self.inspect('container', self.instance)
        endpoint = info['NetworkSettings']['Networks'].get(self.network, {})
        return {'image': info['Image'], 'hostname': info['Config']['Hostname'], 'mac': endpoint.get('MacAddress', '')}

    def assert_identity(self, original, image=None):
        current = self.identity()
        require(current == {**original, 'image': image or original['image']}, f'Image/hostname/MAC changed unexpectedly: {current}')
        require(bool(current['mac']), 'Docker did not report the instance MAC')

    def assert_sentinel(self):
        result = self.docker('exec', '--user', 'root', self.instance, 'node', '-e',
                             'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', SENTINEL)
        require(result.stdout == self.run_id, 'The persistent volume sentinel changed or disappeared')

    def assert_mapping(self, config, published=True):
        info = self.inspect('container', self.instance)
        require(info['State']['Running'] is published, 'Unexpected instance running state')
        declared = info['HostConfig'].get('PortBindings') or {}
        actual = info['NetworkSettings'].get('Ports') or {}
        for ports in (declared, actual):
            require(not ports.get('3000/tcp') and not ports.get('3001/tcp'), 'Remote desktop port 3000/3001 was published')
            require(not any(value for key, value in ports.items() if key != '8015/tcp'), 'An unexpected instance port was published')
        expected = [{'HostIp': config['bindAddress'], 'HostPort': str(config['hostPort'])}] if config['enabled'] else []
        require((declared.get('8015/tcp') or []) == expected, f'Wrong declared migration mapping: {declared}')
        if published:
            require((actual.get('8015/tcp') or []) == expected, f'Wrong actual migration mapping: {actual}')

    def assert_banner(self, address, port, revision):
        expected = f'woc-migration-fixture:{self.run_id}:{revision}\n'.encode()
        def probe():
            with socket.create_connection((address, port), timeout=2) as connection:
                data = b''
                while len(data) < len(expected):
                    part = connection.recv(256)
                    if not part:
                        break
                    data += part
                return data == expected
        self.wait('actual host-published TCP fixture banner', probe, timeout=15)

    def start_resources(self):
        require(Path('/var/run/docker.sock').is_socket(), 'A local /var/run/docker.sock is required; run on the native Linux Docker host')
        require(self.docker('info', '--format', '{{.OSType}}').stdout.strip() == 'linux', 'Linux Docker containers are required')
        self.inspect('image', self.args.panel_image)
        for kind, name in [('container', self.panel), ('container', self.instance), ('network', self.network),
                           ('volume', self.panel_volume), ('volume', self.instance_volume), ('image', self.fixture_ref)]:
            require(self.inspect(kind, name, missing_ok=True) is None, f'Test resource already exists; refusing to reuse {name}')
        address = self.args.bind_address
        if not address:
            bridge = self.inspect('network', 'bridge')
            address = next((entry.get('Gateway') for entry in bridge.get('IPAM', {}).get('Config', [])
                            if entry.get('Gateway') and ':' not in entry['Gateway']), None)
        require(bool(address), 'Cannot find a default bridge IPv4 gateway; pass --bind-address with a local RFC1918 address')
        parsed = ipaddress.ip_address(address)
        require(parsed.version == 4 and any(parsed in network for network in PRIVATE_NETS), 'The test bind address must be RFC1918 IPv4')
        # This also rejects remote daemons / Docker Desktop gateways not owned by this Python host.
        self.fresh_port(address)
        self.address = address
        self.created_network = True
        self.docker('network', 'create', '--driver', 'bridge', '--label', f'{OWNER_LABEL}={self.run_id}', self.network)
        for volume in (self.panel_volume, self.instance_volume):
            self.created_volumes.append(volume)
            self.docker('volume', 'create', '--label', f'{OWNER_LABEL}={self.run_id}', volume)

    def launch_panel(self):
        env = os.environ.copy()
        env['PANEL_ADMIN_PASSWORD'] = self.password
        args = ['run', '-d', '--name', self.panel, '--label', f'{OWNER_LABEL}={self.run_id}',
                '--network', self.network, '-p', '127.0.0.1::8080',
                '-v', f'{self.panel_volume}:/data', '-v', '/var/run/docker.sock:/var/run/docker.sock',
                '-e', 'PANEL_ADMIN_PASSWORD', '-e', f'PANEL_ADMIN_USER={self.username}',
                '-e', f'WOC_WECHAT_IMAGE={self.fixture_ref}', '-e', f'WOC_INSTANCE_NETWORK={self.network}',
                '-e', f'WOC_PANEL_CONTAINER={self.panel}', '-e', 'WOC_KEEP_OLD_IMAGES=1',
                '-e', 'WOC_INSTANCE_MEM_SOFT_MB=0', '-e', 'WOC_INSTANCE_MEM_HARD_MB=0',
                '-e', 'WOC_WATCHDOG_HEALTH_FAILS=0', '-e', 'WOC_ENABLE_GPU=0', self.args.panel_image]
        self.created_panel = True  # docker run can create a container even if start fails.
        self.docker(*args, env=env)
        self.ready()

    def exercise(self, directory):
        self.start_resources()
        old_image = self.build_fixture(directory, 1)
        self.launch_panel()
        self.instance_expected = True
        _, result = self.request('POST', '/api/admin/instances', {
            'name': 'migration-smoke', 'appType': 'wechat', 'reuseVolume': self.instance_volume,
        }, timeout=self.args.timeout)
        require(result.get('instance', {}).get('id') == self.instance_id, 'Creation did not reuse the precisely owned test volume')
        # Creation returns immediately while the upstream provisioning task runs.
        self.wait('asynchronous instance creation', self.running_instance)
        self.docker('exec', '--user', 'root', self.instance, 'node', '-e',
                    'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', SENTINEL, self.run_id)
        original = self.identity()
        require(original['image'] == old_image, 'The initial instance did not use fixture revision 1')
        disabled = {'enabled': False, 'bindAddress': '', 'hostPort': 8015}
        self.assert_mapping(disabled)
        self.checkpoint('real admin login and API instance creation, with no published desktop/migration ports')

        first = {'enabled': True, 'bindAddress': self.address, 'hostPort': self.fresh_port(self.address)}
        state = self.configure(first, True)
        require(state['config'] == first and not state['error'] and not state['pending'], f'Enable did not settle: {state}')
        self.assert_mapping(first)
        self.assert_identity(original)
        self.assert_sentinel()
        self.assert_banner(self.address, first['hostPort'], 1)
        def check_ready():
            _, check = self.request('POST', f'/api/admin/instances/{self.instance_id}/migration/check')
            return check if check.get('listening') is True and check.get('reachable') is True and not check.get('error') else None
        self.wait('real /proc listener check and panel-to-container TCP check', check_ready, timeout=20)
        self.checkpoint('PUT enables only TCP 8015; actual host path and authenticated check API reach fixture')

        newer_image = self.build_fixture(directory, 2) if not self.args.skip_upgrade else old_image
        if not self.args.skip_upgrade:
            require(newer_image != old_image, 'Fixture revision 2 must produce a distinct image ID')
        self.lifecycle('restart')
        self.assert_mapping(first)
        self.assert_identity(original)
        self.assert_sentinel()
        self.checkpoint('ordinary instance restart preserves mapping, original image, hostname, MAC and data')

        self.docker('restart', self.panel)
        self.ready()
        state = self.migration()
        require(state['config'] == first and not state['pending'], 'Panel restart lost persisted migration configuration')
        self.assert_mapping(first)
        self.assert_identity(original)
        self.assert_sentinel()
        self.checkpoint('panel restart retains instance configuration and data')

        self.lifecycle('stop')
        stopped_id = self.inspect('container', self.instance)['Id']
        second = {**first, 'hostPort': self.fresh_port(self.address)}
        state = self.configure(second, False)
        info = self.inspect('container', self.instance)
        require(state['config'] == second and state['pending'] and not state['actual']['running'], 'Stopped save did not remain pending/stopped')
        require(info['Id'] == stopped_id and info['State']['Running'] is False, 'Saving a stopped instance recreated or started it')
        self.lifecycle('start')
        state = self.migration()
        require(not state['pending'], 'Explicit start did not apply the saved mapping')
        self.assert_mapping(second)
        self.assert_identity(original)
        self.assert_sentinel()
        self.assert_banner(self.address, second['hostPort'], 1)
        self.checkpoint('saving while stopped does not start/recreate; explicit start applies changed host port')

        # Exercise the missing-container retry, not only live-apply rollback:
        # after a failed explicit start, no old container remains to supply Image.
        # The persisted original image must survive a subsequent config edit.
        self.lifecycle('stop')
        with self.host_listener() as occupied:
            blocked = {**second, 'hostPort': occupied.getsockname()[1]}
            state = self.configure(blocked, False)
            require(not state['actual']['running'], 'Saving a stopped conflict unexpectedly started the instance')
            _, failure = self.request('POST', f'/api/admin/instances/{self.instance_id}/start', expected=(500,), timeout=self.args.timeout)
            require(bool(failure.get('error')), 'Failed explicit start did not report an error')
            require(self.inspect('container', self.instance, missing_ok=True) is None, 'Start failure did not exercise missing-container recovery')
            # Read only this non-secret field, never print accounts.json or its credentials.
            saved_image = self.docker('exec', self.panel, 'node', '-e',
                'const s=JSON.parse(require("node:fs").readFileSync("/data/panel/accounts.json","utf8"));'
                'const i=s.instances.find(i=>i.id===process.argv[1]);'
                'process.stdout.write(i?.migrationState?.imageId||"");', self.instance_id).stdout
            require(saved_image == old_image, 'The failed start lost its persisted original image ID')
            self.configure(second, False)
            self.lifecycle('start')
            self.assert_mapping(second)
            self.assert_identity(original)
            self.assert_sentinel()
            self.assert_banner(self.address, second['hostPort'], 1)
        self.checkpoint('failed stopped-instance start preserves original image ID across config edit and missing-container retry')

        # Not a Docker container: Docker listContainers cannot catch this at preflight.
        # Docker's actual bind/start must fail, then the panel must roll back.
        with self.host_listener() as occupied:
            blocked = {**second, 'hostPort': occupied.getsockname()[1]}
            state = self.configure(blocked, True)
            require(bool(state['error']), 'A non-Docker host listener did not cause a surfaced apply/start failure (requires normal Docker host-port binding)')
            require(state['config'] == second and not state['pending'], f'Failed apply did not restore prior configuration: {state}')
            self.assert_mapping(second)
            self.assert_identity(original)
            self.assert_sentinel()
            self.assert_banner(self.address, second['hostPort'], 1)
        self.checkpoint('real non-Docker port conflict rolls back configuration, original image, identity and volume data')

        expected_image = old_image
        if not self.args.skip_upgrade:
            self.lifecycle('upgrade')
            def upgrade_done():
                _, status = self.request('GET', '/api/admin/instances/upgrade-status')
                return status if self.instance_id not in status.get('upgradingIds', []) else None
            self.wait('explicit image upgrade', upgrade_done)
            expected_image = newer_image
            self.assert_identity(original, expected_image)
            self.assert_mapping(second)
            self.assert_sentinel()
            self.assert_banner(self.address, second['hostPort'], 2)
            self.checkpoint('explicit upgrade changes to newer local image while preserving mapping, identity and data')

        off = {**second, 'enabled': False}
        state = self.configure(off, True)
        require(state['config'] == off and not state['pending'] and not state['error'], f'Disable failed: {state}')
        self.assert_mapping(off)
        self.assert_identity(original, expected_image)
        self.assert_sentinel()
        self.checkpoint('disabling removes the published migration port while the instance and data remain')

    def cleanup(self):
        failures = []
        def attempt(description, operation):
            try:
                operation()
            except Exception as error:
                failures.append(description + ': ' + self.redact(error))

        def remove_container(name, fixture=False):
            info = self.inspect('container', name, missing_ok=True)
            if not info:
                return
            if fixture:
                owned_volume = any(m.get('Name') == self.instance_volume and m.get('Destination') == '/config' for m in info.get('Mounts', []))
                require(owned_volume and info['HostConfig']['NetworkMode'] == self.network, 'Refusing to remove a container without the test-owned volume/network')
            else:
                require(info['Config'].get('Labels', {}).get(OWNER_LABEL) == self.run_id, 'Panel ownership label does not match')
            self.docker('container', 'rm', '-f', name)

        # Stop the panel first so an unfinished lifecycle task cannot recreate the fixture.
        if self.created_panel:
            attempt('remove panel', lambda: remove_container(self.panel))
        if self.instance_expected:
            attempt('remove fixture instance', lambda: remove_container(self.instance, fixture=True))
        for volume in reversed(self.created_volumes):
            def remove_volume(name=volume):
                info = self.inspect('volume', name, missing_ok=True)
                if info:
                    require(info.get('Labels', {}).get(OWNER_LABEL) == self.run_id, 'Volume ownership label does not match')
                    self.docker('volume', 'rm', name)
            attempt('remove volume ' + volume, remove_volume)
        if self.created_network:
            def remove_network():
                info = self.inspect('network', self.network, missing_ok=True)
                if info:
                    require(info.get('Labels', {}).get(OWNER_LABEL) == self.run_id, 'Network ownership label does not match')
                    self.docker('network', 'rm', self.network)
            attempt('remove test network', remove_network)
        # Remove the unique tag first, then exact built image IDs. Never force-remove
        # images that another container started using, and never remove the base image.
        owned_images = [self.fixture_ref, *reversed(self.fixture_revision_refs), *reversed(self.image_ids)] if self.fixture_build_started else []
        for image in owned_images:
            def remove_image(ref=image):
                info = self.inspect('image', ref, missing_ok=True)
                if info:
                    require(info.get('Config', {}).get('Labels', {}).get(OWNER_LABEL) == self.run_id, 'Image ownership label does not match')
                    self.docker('image', 'rm', ref)
            attempt('remove fixture image ' + image, remove_image)
        for failure in failures:
            self.log('CLEANUP ERROR: ' + failure)
        return not failures


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--panel-image', default='woc-panel-migration:test')
    parser.add_argument('--fixture-base', default='node:22-slim')
    parser.add_argument('--bind-address', help='RFC1918 IPv4 owned by this Docker host; defaults to the default bridge gateway')
    parser.add_argument('--timeout', type=int, default=120, help='Per lifecycle/readiness deadline in seconds (default: 120)')
    parser.add_argument('--skip-upgrade', action='store_true', help='Skip the second fixture image and explicit image upgrade check')
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    smoke = Smoke(args)
    result = 1
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        with tempfile.TemporaryDirectory(prefix='woc-migration-fixture-') as temporary:
            directory = Path(temporary)
            (directory / 'Dockerfile').write_text(FIXTURE_DOCKERFILE)
            (directory / 'fixture.cjs').write_text(FIXTURE_JS)
            smoke.exercise(directory)
        smoke.log(f'PASS: {len(smoke.passed)} real Docker/API checkpoints. This did not test WeChat or phone migration.')
        result = 0
    except KeyboardInterrupt:
        smoke.log('INTERRUPTED: cleaning up test-owned resources')
        result = 130
    except Exception as error:
        smoke.log('FAIL: ' + str(error))
        if smoke.created_panel:
            try:
                info = smoke.inspect('container', smoke.panel)
                smoke.log('Test panel inspect: ' + json.dumps({
                    'State': info.get('State'),
                    'actualPorts': info.get('NetworkSettings', {}).get('Ports'),
                    'Image': info.get('Image'),
                }, ensure_ascii=False))
            except Exception as inspect_error:
                smoke.log('Cannot inspect test panel: ' + str(inspect_error))
            try:
                logs = smoke.docker('logs', '--tail', '150', smoke.panel, check=False)
                smoke.log('Test panel logs:\n' + (logs.stdout + logs.stderr)[-24000:])
            except Exception as log_error:
                smoke.log('Cannot read test panel logs: ' + str(log_error))
    finally:
        if not smoke.cleanup() and result == 0:
            result = 1
    return result


if __name__ == '__main__':
    sys.exit(main())
