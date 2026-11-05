# Linux WeChat notification settings

The installed bridge runs from `/config/weflow/work/` inside the WeChat container. Keep all three `weflow_*.py` modules together when updating it. Restart only the bridge process after replacing them; the WeChat process and its original databases remain running. The account and encryption credentials are read from the existing private configuration.

The bridge copies DB/WAL bytes and validates the snapshot before opening it with SQLCipher. Never open a running original WeChat database with SQLite, including read-only connections: SQLite can modify its SHM file.

Notification semantics were verified with native Linux WeChat menu toggles on 2026-11-04. For `@chatroom` sessions, `chat_room_notify=0` means muted and `1` means allowed. For direct chats, `flag & 0x200` means muted. The previous group flag and room-type guesses have been removed. The panel requires the corrected source marker, so an older bridge cannot silently supply reversed settings.

Run `python scripts/weflow/test_notification_settings.py` for the recorded toggle regressions. From `panel/server`, run `node --experimental-test-module-mocks --import tsx --test tests/notification-delivery.integration.ts` (Node 24) to verify both polling and WeFlow SSE delivery and their WeChat destination.
