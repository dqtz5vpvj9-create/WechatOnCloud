"""Apply display density without opening application databases."""
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

quality = sys.argv[1]
assert quality in ('standard', 'hd')
dpi = 192 if quality == 'hd' else 96
base = pathlib.Path('/config')
marker = base / '.woc-display-quality'
previous = marker.read_text().strip() if marker.exists() else 'standard'
conf = base / '.xsettingsd'
existing = conf.read_text() if conf.exists() else ''
old_dpi = re.search(r'^Xft/DPI (\d+)', existing, flags=re.M)
old_dpi = int(old_dpi.group(1)) if old_dpi else 98304
restart = sys.argv[2] == '1' or (sys.argv[2] == '2' and (previous != quality or old_dpi != dpi * 1024))
uid, gid = base.stat().st_uid, base.stat().st_gid

def atomic(path, text):
    temporary = path.with_name(path.name + '.quality-tmp')
    temporary.write_text(text)
    os.chmod(temporary, 0o644)
    os.chown(temporary, uid, gid)
    temporary.replace(path)

# Old instance images need this small compatibility patch before their next
# application launch. Only the exact known DPI stanza is changed.
for path in [pathlib.Path('/defaults/autostart'), base / '.config/openbox/autostart']:
    if not path.exists():
        continue
    text = path.read_text()
    if 'WOC_XFT_DPI' in text:
        continue
    if 'Xft/DPI 98304\n' not in text or 'XSETTINGS_CONF=' not in text:
        raise RuntimeError('实例的缩放启动脚本不兼容，请升级实例后重试')
    text = text.replace('XSETTINGS_CONF=', 'WOC_XFT_DPI=98304\n[ "$(cat /config/.woc-display-quality 2>/dev/null)" = hd ] && WOC_XFT_DPI=196608\nXSETTINGS_CONF=', 1)
    text = text.replace('Xft/DPI 98304\n', 'Xft/DPI ${WOC_XFT_DPI}\n')
    original = path.stat()
    mode = original.st_mode & 0o777
    atomic(path, text)
    os.chmod(path, mode)
    os.chown(path, original.st_uid, original.st_gid)

atomic(base / '.woc-display-quality', quality + '\n')
text = existing or 'Xft/Antialias 1\nGtk/FontName "WenQuanYi Micro Hei 10"\n'
text = re.sub(r'^Xft/DPI .*\n?', '', text, flags=re.M) + f'\nXft/DPI {dpi * 1024}\n'
atomic(conf, text)

def processes(executable):
    result = []
    for proc in pathlib.Path('/proc').glob('[0-9]*'):
        try:
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            if args and args[0].decode() == executable and not any(arg.startswith(b'--type=') for arg in args[1:]):
                result.append(int(proc.name))
        except (OSError, UnicodeError):
            pass
    return result

for executable in ['/usr/bin/xsettingsd', 'xsettingsd']:
    for pid in processes(executable):
        os.kill(pid, signal.SIGHUP)

def command(display, args, **kwargs):
    return subprocess.run(['runuser', '-u', 'abc', '--', 'env', f'DISPLAY={display}', *args],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=4, **kwargs)

for display in [':1', ':2']:
    if command(display, ['xdpyinfo']).returncode:
        continue
    command(display, ['xrdb', '-merge'], input=f'Xft.dpi: {dpi}\n'.encode())
    observed = command(display, ['dump_xsettings'])
    if f'Xft/DPI {dpi * 1024}'.encode() not in observed.stdout:
        # A secondary Openbox session may not have an XSETTINGS owner yet.
        subprocess.Popen(['runuser', '-u', 'abc', '--', 'env', f'DISPLAY={display}',
                          'xsettingsd', f'--config={conf}'], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for attempt in range(30):
        if f'Xft/DPI {dpi * 1024}'.encode() in command(display, ['dump_xsettings']).stdout:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError(f'{display} 显示缩放设置未生效')

if restart:
    wechat = processes('/config/wechat/opt/wechat/wechat')
    weflow = processes('/config/weflow/WeFlow-6.3.1-Setup/weflow')
    for pid in wechat + weflow:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for attempt in range(40):
        if not any(pathlib.Path(f'/proc/{pid}').exists() for pid in wechat + weflow):
            break
        time.sleep(0.25)
    else:
        raise RuntimeError('应用正在退出，请稍后重试')
    if weflow:
        subprocess.Popen(['runuser', '-u', 'abc', '--', '/config/weflow/start-weflow-desktop.sh'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    # The existing autostart supervisor reopens WeChat with its original profile.
    for was_running, executable in [(wechat, '/config/wechat/opt/wechat/wechat'),
                                    (weflow, '/config/weflow/WeFlow-6.3.1-Setup/weflow')]:
        if not was_running:
            continue
        for attempt in range(80):
            running = processes(executable)
            if running:
                time.sleep(0.5)
                if processes(executable):
                    break
            time.sleep(0.25)
        else:
            raise RuntimeError('应用未能重新启动，请恢复标准画质后检查实例')
print('display density applied')
