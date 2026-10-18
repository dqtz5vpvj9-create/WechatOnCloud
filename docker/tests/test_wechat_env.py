"""Run without Docker: python3 -m unittest discover -s docker/tests -v."""

import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest


DOCKER_DIR = Path(__file__).resolve().parents[1]
WRAPPER = DOCKER_DIR / "wechat-env.sh"


class WeChatEnvironmentTests(unittest.TestCase):
    def run_wrapper(self, *args, env=None):
        return subprocess.run(
            [str(WRAPPER), *args], env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
        )

    def test_filters_control_environment_and_preserves_session(self):
        removed = {
            "WOC_APP_TYPE": "wechat", "WOC_CUSTOM_LAUNCH": "not executed",
            "WOC_BAD-NAME": "newlines\nand=equals", "VNC_PASSWORD": "private",
            "KASM_TOKEN": "private", "KASMVNC_PASSWORD": "private",
            "REMOTE_DESKTOP_PASSWORD": "private", "PASSWORD": "private",
            "S6_CMD_WAIT_FOR_SERVICES_MAXTIME": "5000", "S6RC_VERBOSE": "1",
            "DOCKER_HOST": "unix:/var/run/docker.sock", "DOCKER_AUTH_CONFIG": "private",
            "CUSTOM_PASSWORD": "private", "CUSTOM_USER": "remote-user",
            "FILE__PASSWORD": "/run/secrets/remote-password",
            "FILE__CUSTOM_PASSWORD": "/run/secrets/custom-password",
            "FILE__CUSTOM_USER": "/run/secrets/remote-user",
            "FILE__WOC_ADMIN_PASSWORD": "/run/secrets/panel-password",
            "FILE__VNC_PASSWORD": "/run/secrets/vnc-password",
            "FILE__KASM_TOKEN": "/run/secrets/kasm-token",
            "FILE__KASMVNC_PASSWORD": "/run/secrets/kasmvnc-password",
            "FILE__REMOTE_DESKTOP_PASSWORD": "/run/secrets/desktop-password",
            "FILE__LSIO_FIRST_PARTY": "/run/secrets/image-setting",
            "FILE__S6_CMD_WAIT_FOR_SERVICES_MAXTIME": "/run/secrets/service-timeout",
            "FILE__S6RC_VERBOSE": "/run/secrets/service-verbosity",
            "FILE__DOCKER_AUTH_CONFIG": "/run/secrets/registry-password",
            "FILE__VERSION": "/run/secrets/image-version",
            "LSIO_FIRST_PARTY": "true", "VERSION": "upstream-image-version",
            "BUILD_DATE": "2026-10-18", "TITLE": "WechatOnCloud",
            "PUID": "1000", "PGID": "1000", "UMASK": "022",
            "CUSTOM_PORT": "3000", "CUSTOM_HTTPS_PORT": "3001",
            "SUBFOLDER": "/desktop", "DISABLE_DRI": "1", "DRINODE": "/dev/dri/renderD128",
            "DISABLE_IPV6": "1", "NO_DECOR": "1", "NO_FULL": "1",
            "DEBIAN_FRONTEND": "noninteractive",
        }
        kept = {
            "HOME": "/config", "USER": "abc", "LOGNAME": "abc",
            "DISPLAY": ":1", "XAUTHORITY": "/config/.Xauthority",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
            "XDG_RUNTIME_DIR": "/config/.XDG", "XDG_DATA_DIRS": "/usr/local/share:/usr/share",
            "LANG": "C.UTF-8", "LANGUAGE": "zh_CN", "LC_ALL": "C.UTF-8",
            "TZ": "Asia/Shanghai", "QT_QPA_PLATFORM": "xcb", "QT_IM_MODULE": "ibus",
            "QT_PLUGIN_PATH": "/opt/wechat/plugins", "GTK_IM_MODULE": "ibus",
            "XMODIFIERS": "@im=ibus", "PULSE_SERVER": "unix:/run/pulse/native",
            "PULSE_COOKIE": "/config/.config/pulse/cookie", "PULSE_SINK": "default",
            "PIPEWIRE_REMOTE": "pipewire-0", "ALSA_CONFIG_PATH": "/config/.asoundrc",
            "LIBGL_ALWAYS_SOFTWARE": "1", "LD_LIBRARY_PATH": "/usr/lib",
            "http_proxy": "http://proxy.example:8080", "HTTPS_PROXY": "http://proxy.example:8080",
            "ALL_PROXY": "socks5://proxy.example:1080", "NO_PROXY": "localhost,127.0.0.1",
            "UNRELATED_APP_SETTING": "spaces\nand=equals; $(not-executed)",
            "FILE__UNRELATED_APP_SETTING": "/run/secrets/application-setting",
            "name": "user-setting", "entry": "user-entry", "remove": "user-value",
        }
        env = {**os.environ, **removed, **kept}
        result = self.run_wrapper(sys.executable, "-c", "import json, os; print(json.dumps(dict(os.environ)))", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout)
        for name in removed:
            with self.subTest(removed=name):
                self.assertNotIn(name, actual)
        for name, value in kept.items():
            with self.subTest(preserved=name):
                self.assertEqual(actual.get(name), value)

    def test_preserves_argv_without_shell_expansion(self):
        args = ["", "two words", "中文\nnext line", "*", "$(not-executed)", "--flag=value", "a'b\"c"]
        with tempfile.TemporaryDirectory() as tmp:
            executable = Path(tmp) / "program with spaces"
            executable.symlink_to(sys.executable)
            result = self.run_wrapper(str(executable), "-c", "import json, sys; print(json.dumps(sys.argv[1:]))", *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), args)

    def test_does_not_source_inherited_bash_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            startup = Path(tmp) / "startup.sh"
            startup.write_text("exit 93\n")
            result = self.run_wrapper("/bin/true", env={**os.environ, "BASH_ENV": str(startup)})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_preserves_exit_codes_and_exec_failure(self):
        for code in (0, 7, 126, 255):
            with self.subTest(code=code):
                result = self.run_wrapper(sys.executable, "-c", f"raise SystemExit({code})")
                self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(self.run_wrapper("/no-such-wechat-environment-test-binary").returncode, 127)

    def test_missing_program_is_an_error(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 64)
        self.assertIn("Usage:", result.stderr)

    def test_exec_preserves_pid_and_signal_termination(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=sig):
                code = (
                    "import os, signal; "
                    f"signal.signal({int(sig)}, signal.SIG_DFL); "
                    "print(os.getpid(), flush=True); signal.pause()"
                )
                with subprocess.Popen(
                    [str(WRAPPER), sys.executable, "-c", code], text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                ) as process:
                    try:
                        with selectors.DefaultSelector() as poll:
                            poll.register(process.stdout, selectors.EVENT_READ)
                            self.assertTrue(poll.select(5), "application did not become ready")
                        self.assertEqual(int(process.stdout.readline()), process.pid)
                        process.send_signal(sig)
                        self.assertEqual(process.wait(timeout=5), -sig)
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.wait(timeout=5)

    def test_app_definitions_filter_only_wechat(self):
        for app in ("wechat", "unknown", "qq", "chromium", "telegram", "custom"):
            with self.subTest(app=app):
                result = subprocess.run(
                    ["/bin/bash", "-c", '. "$1"; woc_app_def "$2"; printf "%s\\n%s\\n" "$APP_BIN" "$APP_LAUNCH"',
                     "test-app-definition", str(DOCKER_DIR / "app-defs.sh"), app],
                    env={**os.environ, "WOC_CUSTOM_BIN": "/test/custom", "WOC_CUSTOM_LAUNCH": "/test/custom --flag"},
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                binary, launch = result.stdout.splitlines()
                if app in ("wechat", "unknown"):
                    self.assertEqual(binary, "/config/wechat/opt/wechat/wechat")
                    self.assertEqual(launch, f"/woc/wechat-env.sh {binary}")
                else:
                    self.assertNotIn("wechat-env.sh", launch)
                    self.assertTrue(launch.startswith(binary))


if __name__ == "__main__":
    unittest.main()
