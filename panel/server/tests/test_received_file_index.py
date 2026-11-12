import os
from pathlib import Path
import sys
import sqlite3
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from received_file_index import list_files


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'accounts'
        self.month = self.root / 'example/msg/file/2026-11'
        self.month.mkdir(parents=True)
        self.cache = self.base / 'cache/index.sqlite'

    def tearDown(self):
        self.temp.cleanup()

    def file(self, name, data=b'old'):
        path = self.month / name
        path.write_bytes(data)
        os.utime(path, (900, 900))
        return path

    def test_warm_index_avoids_file_stats_and_survives_new_connection(self):
        self.file('old.pdf'); self.file('报告 [1]*.pdf')
        first, cold = list_files(self.root, self.cache, now=1000)
        second, warm = list_files(self.root, self.cache, now=1001)
        self.assertEqual(first, second)
        self.assertEqual(cold['fileStats'], 2)
        self.assertEqual(warm['fileStats'], 0)
        self.assertEqual(warm['scannedMonths'], 0)
        self.assertEqual(warm['cachedMonths'], 1)

    def test_new_delete_rename_and_new_month_are_detected(self):
        path = self.file('old.pdf')
        list_files(self.root, self.cache, now=1000)
        path.rename(self.month / 'renamed.pdf')
        self.file('new.pdf')
        rows, stats = list_files(self.root, self.cache, now=1001)
        self.assertEqual({Path(r[0]).name for r in rows}, {'renamed.pdf', 'new.pdf'})
        self.assertEqual(stats['scannedMonths'], 1)
        (self.month / 'new.pdf').unlink()
        extra = self.month.parent / '2026-12'; extra.mkdir()
        (extra / 'next.pdf').write_bytes(b'next')
        rows, _ = list_files(self.root, self.cache, now=1002)
        self.assertEqual({Path(r[0]).name for r in rows}, {'renamed.pdf', 'next.pdf'})

    def test_growing_download_and_periodic_in_place_reconciliation(self):
        self.file('baseline.pdf')
        list_files(self.root, self.cache, now=1000)
        growing = self.file('growing.pdf', b'a')
        list_files(self.root, self.cache, now=1001)
        stamp = self.month.stat().st_mtime_ns
        growing.write_bytes(b'completed')
        self.assertEqual(stamp, self.month.stat().st_mtime_ns)
        rows, stats = list_files(self.root, self.cache, now=1002)
        self.assertEqual(next(r[1] for r in rows if Path(r[0]).name == 'growing.pdf'), 9)
        self.assertEqual(stats['scannedMonths'], 0)
        self.assertEqual(stats['fileStats'], 1)
        self.file('baseline.pdf', b'overwritten')
        rows, _ = list_files(self.root, self.cache, now=1062)
        self.assertEqual(next(r[1] for r in rows if Path(r[0]).name == 'baseline.pdf'), 11)

    def test_corrupt_cache_falls_back_without_losing_files(self):
        self.file('complete.pdf')
        self.cache.parent.mkdir()
        self.cache.write_bytes(b'corrupt cache')
        rows, stats = list_files(self.root, self.cache, now=1000)
        self.assertTrue(stats['fallback'])
        self.assertEqual(len(rows), 1)
        rows, stats = list_files(self.root, self.cache, now=1001)
        self.assertFalse(stats['fallback'])
        self.assertEqual(len(rows), 1)

    def test_busy_cache_is_retained_and_listing_falls_back(self):
        self.file('available.pdf')
        list_files(self.root, self.cache, now=1000)
        writer = sqlite3.connect(self.cache)
        writer.execute('BEGIN IMMEDIATE')
        try:
            rows, stats = list_files(self.root, self.cache, now=1001)
            self.assertTrue(stats['fallback'])
            self.assertTrue(self.cache.exists())
            self.assertEqual(len(rows), 1)
        finally:
            writer.rollback(); writer.close()
        rows, stats = list_files(self.root, self.cache, now=1001)
        self.assertFalse(stats['fallback'])
        self.assertEqual(len(rows), 1)


if __name__ == '__main__':
    unittest.main()
