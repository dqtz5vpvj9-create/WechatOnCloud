"""Read notification preferences from a private contact.db snapshot.

Verified against native Linux WeChat menu toggles on 2026-11-04:
* Group Allow notifications: chat_room_notify 0 -> 1; mute: 1 -> 0.
* Direct chat mute: flag 0x803 -> 0xa03; allow: 0xa03 -> 0x803.
Other contact flags and chat_room_type do not determine notification permission.
"""

MUTE_SOURCE = 'wechat-native-v3:group.notify=0;direct.flag&0x200;official.verify_flag&0x8'


def read_muted_sessions(connection):
    columns = {row[1] for row in connection.execute('PRAGMA table_info(contact)')}
    if not {'username', 'chat_room_notify', 'flag', 'verify_flag'} <= columns:
        raise RuntimeError('Contact notification columns are missing')
    return [row[0] for row in connection.execute(
        "SELECT username FROM contact WHERE username IS NOT NULL AND username != '' AND ("
        "username='brandsessionholder' OR "
        "(username NOT LIKE '%@chatroom' AND ((verify_flag & 8) != 0 OR substr(username,1,3)='gh_')) OR "
        "(username LIKE '%@chatroom' AND chat_room_notify=0) OR "
        "(username NOT LIKE '%@chatroom' AND (flag & 512) != 0))"
    )]
