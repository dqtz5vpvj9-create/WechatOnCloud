import sqlite3
import unittest

from weflow_notification_settings import read_muted_sessions


class NotificationSettingsTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE contact (username TEXT, chat_room_notify INTEGER, flag INTEGER, chat_room_type INTEGER)')

    def check_rows(self, rows, expected):
        self.db.executemany('INSERT INTO contact VALUES (?,?,?,?)', rows)
        self.assertEqual(set(read_muted_sessions(self.db)), set(expected))

    def test_native_group_toggle_and_previous_regressions(self):
        self.check_rows([
            ('group@chatroom', 0, 0x2, 0),
            ('allinai-regression@chatroom', 0, 0x2, 2),
            ('developer-regression@chatroom', 0, 0x10000002, 0),
            ('allowed@chatroom', 1, 0x803, 0),
        ], ['group@chatroom', 'allinai-regression@chatroom', 'developer-regression@chatroom'])
        self.db.execute("UPDATE contact SET chat_room_notify=1 WHERE username='group@chatroom'")
        self.assertNotIn('group@chatroom', read_muted_sessions(self.db))
        self.db.execute("UPDATE contact SET chat_room_notify=0 WHERE username='group@chatroom'")
        self.assertIn('group@chatroom', read_muted_sessions(self.db))

    def test_native_direct_chat_toggle(self):
        self.check_rows([('direct', 0, 0x803, 0)], [])
        self.db.execute('UPDATE contact SET flag=0xa03')
        self.assertEqual(read_muted_sessions(self.db), ['direct'])
        self.db.execute('UPDATE contact SET flag=0x803')
        self.assertEqual(read_muted_sessions(self.db), [])

    def test_unrelated_flags_do_not_override_notification_setting(self):
        self.check_rows([
            ('allowed@chatroom', 1, 0x10800202, 2),
            ('allowed-direct', 0, 0x10800003, 2),
            ('', 0, 512, 0),
            (None, 0, 512, 0),
        ], [])

    def test_rejects_incompatible_schema(self):
        self.db.execute('DROP TABLE contact')
        self.db.execute('CREATE TABLE contact (username TEXT)')
        with self.assertRaisesRegex(RuntimeError, 'columns are missing'):
            read_muted_sessions(self.db)


if __name__ == '__main__':
    unittest.main()
