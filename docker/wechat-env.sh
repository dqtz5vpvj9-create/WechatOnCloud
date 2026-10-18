#!/bin/bash -p
# Keep desktop/session settings, but do not pass container management metadata or
# remote-desktop credentials to the WeChat application. This is environment
# minimization, not process/filesystem isolation or a promise of undetectability.
# -p prevents this wrapper from sourcing an inherited BASH_ENV or shell function.
# The final exec preserves argv, PID, exit status and the application's signals.
set -euo pipefail

if [ "$#" -eq 0 ]; then
    printf 'Usage: %s PROGRAM [ARG ...]\n' "$0" >&2
    exit 64
fi

wechat_env_remove=()
# Read NUL-delimited entries so unusual values/names cannot become shell code or
# extra arguments. Only names are retained; values are never logged or written.
while IFS= read -r -d '' wechat_env_entry; do
    wechat_env_name=${wechat_env_entry%%=*}
    # linuxserver's FILE__ prefix names a secret file for the same setting.
    # Filter references only when their target setting is a control-plane item.
    wechat_env_setting=${wechat_env_name#FILE__}
    case "$wechat_env_setting" in
        WOC_* | VNC_* | KASM_* | KASMVNC_* | REMOTE_DESKTOP_* | LSIO_* | \
        S6_* | S6RC_* | DOCKER_* | \
        CUSTOM_USER | CUSTOM_PASSWORD | PASSWORD | \
        CUSTOM_PORT | CUSTOM_HTTPS_PORT | SUBFOLDER | TITLE | \
        PUID | PGID | UMASK | DISABLE_DRI | DRINODE | DISABLE_IPV6 | \
        NO_DECOR | NO_FULL | DEBIAN_FRONTEND | VERSION | BUILD_DATE)
            wechat_env_remove+=(-u "$wechat_env_name")
            ;;
    esac
done < <(/usr/bin/env -0)

# In particular, preserve HOME, DISPLAY, XAUTHORITY, DBUS_*, XDG_*, locale,
# Qt/GTK, audio, GPU/GL library settings and user-configured network proxies.
exec /usr/bin/env "${wechat_env_remove[@]}" -- "$@"
