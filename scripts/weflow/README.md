# Linux WeChat notification settings

Keep `weflow_linux_bridge.py`, `weflow_source_snapshot.py`, `weflow_incremental_snapshot.py`, and `weflow_notification_settings.py` together in `/config/weflow/work/`. The account and encryption credentials are read from the existing private configuration.

The bridge copies DB/WAL bytes and validates the snapshot before opening it with SQLCipher. Never open a running original WeChat database with SQLite, including read-only connections: SQLite can modify its SHM file.

Run the bridge in the separate worker declared by `compose.bridge.yml`. It uses
the pinned compatible instance image with 512 MiB memory, no swap, one CPU,
no network and a read-only root filesystem. The original `xwechat_files` mount
is read-only; only the private WeFlow directory is writable. Missing bind sources
fail startup. This keeps initialization and filesystem cache pressure outside the
native WeChat container's watchdog accounting.

Set `WOC_BRIDGE_IMAGE` to the existing compatible image ID,
`WOC_BRIDGE_CONFIG_ROOT` to the existing instance config directory on the Docker
host, and `WOC_BRIDGE_CONTAINER` to a unique worker name. Do not copy instance
runtime environment variables. Start the worker with:

```sh
docker compose --project-name woc-weflow-bridge --env-file bridge.env \
  -f compose.bridge.yml up -d
```

Create `/config/weflow/data/bridge-external` in the native instance before
enabling the worker, and make the native startup wrapper skip its internal
Python bridge when that marker exists. The bridge script also refuses native
maintenance launches while the marker is present. Run manual `--once` checks
inside the worker. A single writer lock coordinates checks and the worker.

The panel writes notification and desktop consumer markers to both `/tmp` and
`/config/weflow/data/consumers`. The installed native watchdog calls its WeFlow
startup wrapper every 20 seconds. That wrapper refreshes the shared marker for
each existing `/tmp/woc-weflow-consumer-{notifications,desktop}`, and removes the
shared marker when its native marker is absent. External workers expire shared
markers after 45 seconds and perform only a cheap marker check while idle.
This projection must be installed with the worker; otherwise active leases
expire. Stop the worker before rolling back the native startup wrapper.

The first synchronization builds complete encrypted mirrors. A private checkpoint
then records source generations and destination identities, so a bridge restart
does not recopy unchanged historical databases. Changed databases use a bounded
768 MiB LRU cache of immutable private base files. When the original base is
unchanged, only newly committed WAL bytes are read from the original; cached WAL
prefixes and the complete private WAL checksum chain are validated. Checkpoints,
database replacement, WAL resets and invalid caches rebuild safely. Private
snapshots use read-only SQL connections; original database inodes are rejected as
cache bases. Abandoned bridge scratch directories are recovered under a single
writer lock. Checkpoint files are capped at 1 MiB when loading and cache contents
are rebuildable.

Destination re-encryption still uses SQLCipher's transactional complete backup
for each changed database. This preserves old-row updates/deletions and mute/read
settings; this step is not a page-delta destination writer. Runtime status reports
`baseSnapshotsReused`, `sourceDbBytesRead`, and `sourceWalBytesRead` so the savings
can be measured without logging messages, keys or account names.

The panel's received-file listing separately indexes monthly directories in a
private, rebuildable cache at `/config/.woc-file-index/index.sqlite` (16 MiB cap).
Directory changes refresh affected months; growing/recent files are rechecked,
and a 60-second reconciliation detects in-place changes to old files. Busy or
invalid caches fall back to a complete bounded listing without dropping files.
Downloads always resolve and stream the current regular file. Images without
Python retain the previous bounded scan. No additional daemon is required.

Run `test_incremental_snapshot.py` with both standard SQLite and SQLCipher, and
`test_bridge_incremental.py` only inside an isolated container with a synthetic
`/config`. They cover appends, old-row updates/deletions, rollback, checkpoint/
WAL reset, replacement, concurrent writes, corrupt caches and process restart.

Notification semantics were verified with native Linux WeChat menu toggles on 2026-11-04. For `@chatroom` sessions, `chat_room_notify=0` means muted and `1` means allowed. For direct chats, `flag & 0x200` means muted. The previous group flag and room-type guesses have been removed. The panel requires the corrected source marker, so an older bridge cannot silently supply reversed settings.

Run `python scripts/weflow/test_notification_settings.py` for the recorded toggle regressions. From `panel/server`, run `node --experimental-test-module-mocks --import tsx --test tests/notification-delivery.integration.ts` (Node 24) to verify both polling and WeFlow SSE delivery and their WeChat destination.
