import hashlib
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest

from weflow_incremental_snapshot import SnapshotCache
from weflow_source_snapshot import SnapshotBusy

try:
    from sqlcipher3 import dbapi2 as sqlcipher
except ImportError:
    sqlcipher = None


class SnapshotTests(unittest.TestCase):
    driver = sqlite3
    encrypted = False

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.db'
        self.writer = self.connect(self.source)
        self.writer.execute('PRAGMA journal_mode=WAL')
        self.writer.execute('PRAGMA wal_autocheckpoint=0')
        self.writer.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT, unread INTEGER)')
        self.writer.executemany('INSERT INTO messages VALUES(?,?,?)', [(i, 'fixture' * 200, 1) for i in range(1, 201)])
        self.writer.commit()
        self.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.cache = SnapshotCache(self.root / 'cache')

    def tearDown(self):
        self.writer.close()
        self.temp.cleanup()

    def connect(self, path, ro=False):
        c = self.driver.connect(path.as_uri() + '?mode=ro' if ro else str(path), uri=ro)
        if self.encrypted:
            c.execute("PRAGMA key='synthetic-test-key'")
        if ro:
            c.execute('PRAGMA query_only=ON')
        return c

    def capture(self):
        folder, private, _, metrics = self.cache.capture(self.source, self.root / 'scratch')
        try:
            reader = self.connect(private, True)
            self.assertEqual(reader.execute('PRAGMA quick_check').fetchone()[0], 'ok')
            rows = reader.execute('SELECT * FROM messages ORDER BY id').fetchall()
            reader.close()
            return rows, metrics
        finally:
            shutil.rmtree(folder)

    def test_wal_append_reads_only_tail_and_survives_new_cache_object(self):
        _, first = self.capture()
        self.assertGreater(first['sourceDbBytesRead'], 0)
        self.writer.execute("INSERT INTO messages VALUES(201,'new',1)"); self.writer.commit()
        _, second = self.capture()
        self.assertTrue(second['baseReused'])
        self.assertEqual(second['sourceDbBytesRead'], 0)
        self.writer.execute("INSERT INTO messages VALUES(202,'newer',1)"); self.writer.commit()
        self.cache = SnapshotCache(self.root / 'cache')
        rows, third = self.capture()
        self.assertEqual(rows[-1], (202, 'newer', 1))
        self.assertEqual(third['sourceDbBytesRead'], 0)
        self.assertLess(third['sourceWalBytesRead'], Path(str(self.source) + '-wal').stat().st_size)

    def test_old_row_updates_deletes_checkpoint_and_log_reset(self):
        self.capture()
        self.writer.execute("UPDATE messages SET body='revoked',unread=0 WHERE id=1")
        self.writer.execute('DELETE FROM messages WHERE id=2'); self.writer.commit()
        rows, update = self.capture()
        self.assertEqual(rows[0], (1, 'revoked', 0))
        self.assertEqual(len(rows), 199)
        self.assertTrue(update['baseReused'])
        self.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.writer.execute("INSERT INTO messages VALUES(203,'after checkpoint',0)"); self.writer.commit()
        rows, reset = self.capture()
        self.assertEqual(rows[-1][0], 203)
        self.assertGreater(reset['sourceDbBytesRead'], 0)

    def test_source_bytes_remain_identical_and_corrupt_cache_is_rebuilt(self):
        self.writer.execute("UPDATE messages SET unread=0 WHERE id=1"); self.writer.commit()
        files = [Path(str(self.source) + suffix) for suffix in ('', '-wal', '-shm')]
        before = [hashlib.sha256(p.read_bytes()).digest() for p in files]
        self.capture()
        self.assertEqual(before, [hashlib.sha256(p.read_bytes()).digest() for p in files])
        entry = self.cache._entry(self.source)
        with (entry / 'wal').open('r+b') as f:
            f.seek(60); f.write(b'corrupt')
        rows, _ = self.capture()
        self.assertEqual(rows[0][2], 0)

    def test_replacing_database_invalidates_cached_base(self):
        self.capture()
        self.writer.close()
        replacement = self.root / 'replacement.db'
        other = self.connect(replacement)
        other.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT, unread INTEGER)')
        other.execute("INSERT INTO messages VALUES(999,'replacement',0)"); other.commit(); other.close()
        replacement.replace(self.source)
        self.writer = self.connect(self.source)
        rows, result = self.capture()
        self.assertEqual(rows, [(999, 'replacement', 0)])
        self.assertFalse(result['baseReused'])

    def test_uncommitted_changes_are_not_published(self):
        self.capture()
        self.writer.execute("UPDATE messages SET body='uncommitted' WHERE id=1")
        rows, _ = self.capture()
        self.assertEqual(rows[0][1], 'fixture' * 200)
        self.writer.rollback()

    def test_cache_budget_and_concurrent_checkpoints(self):
        self.capture()
        self.cache.max_bytes = 1
        rows, result = self.capture()
        self.assertEqual(len(rows), 200)
        self.assertGreater(result['sourceDbBytesRead'], 0)
        self.assertEqual(list((self.root / 'cache').glob('*/base')), [])
        self.cache.max_bytes = 768 * 1024 * 1024
        errors = []
        def write():
            try:
                c = self.connect(self.source)
                for n in range(201, 221):
                    c.execute('INSERT INTO messages VALUES(?,?,1)', (n, 'concurrent'))
                    c.commit()
                    if n % 5 == 0:
                        c.execute('PRAGMA wal_checkpoint(PASSIVE)')
                    time.sleep(0.02)
                c.close()
            except BaseException as exc:
                errors.append(exc)
        thread = threading.Thread(target=write);thread.start()
        observations = []
        while thread.is_alive():
            try:
                rows, _ = self.capture()
                observations.append(len(rows))
                self.assertEqual([r[0] for r in rows], list(range(1, len(rows) + 1)))
            except SnapshotBusy:
                pass
        thread.join()
        self.assertFalse(errors)
        self.assertEqual(observations, sorted(observations))
        self.assertEqual(len(self.capture()[0]), 220)


@unittest.skipIf(sqlcipher is None, 'SQLCipher fixture runs in the Linux instance test environment')
class EncryptedSnapshotTests(SnapshotTests):
    driver = sqlcipher
    encrypted = True


if __name__ == '__main__':
    unittest.main()
