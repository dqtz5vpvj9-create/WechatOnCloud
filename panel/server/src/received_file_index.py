"""Bounded, rebuildable file metadata index. Never opens a WeChat database."""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

RECONCILE_SECONDS = 60
ACTIVE_SECONDS = 30
MAX_CACHE_BYTES = 16 * 1024 * 1024


def signature(st):
    return json.dumps((st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns))


def months(root):
    if not root.is_dir():
        return
    with os.scandir(root) as accounts:
        for account in accounts:
            if not account.is_dir(follow_symlinks=False):
                continue
            msg = Path(account.path) / 'msg'
            files = msg / 'file'
            if msg.is_symlink() or files.is_symlink() or not files.is_dir():
                continue
            with os.scandir(files) as children:
                for month in children:
                    if re.fullmatch(r'\d{4}-\d{2}', month.name) and month.is_dir(follow_symlinks=False):
                        yield Path(month.path), signature(month.stat(follow_symlinks=False))


def file_rows(month, stats):
    stats['scannedMonths'] += 1
    with os.scandir(month) as entries:
        for entry in entries:
            if not entry.is_file(follow_symlinks=False):
                continue
            st = entry.stat(follow_symlinks=False)
            stats['fileStats'] += 1
            yield entry.name, st.st_size, st.st_mtime_ns


def list_files(root, cache, now=None):
    root, cache = Path(root), Path(cache)
    now = time.time() if now is None else now
    stats = {'scannedMonths': 0, 'cachedMonths': 0, 'fileStats': 0, 'fallback': False}
    current = list(months(root))
    if not current:
        return [], stats
    # Cache is disposable, private, and capped. Exhaustion/corruption falls back
    # to the complete monthly listing; it never truncates the returned files.
    connection = None
    cache_safe = False
    try:
        if cache.parent.is_symlink():
            raise ValueError('Cache directory must not be a symlink')
        cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        cache.parent.chmod(0o700)
        if cache.is_symlink():
            raise ValueError('Cache path must not be a symlink')
        cache_safe = True
        if cache.exists() and cache.stat().st_size > MAX_CACHE_BYTES:
            raise ValueError('Cache exceeded size limit')
        connection = sqlite3.connect(cache, timeout=1)
        cache.chmod(0o600)
        connection.execute('PRAGMA max_page_count=4096')
        connection.execute('PRAGMA journal_size_limit=1048576')
        connection.executescript('''
          CREATE TABLE IF NOT EXISTS metadata(root TEXT);
          CREATE TABLE IF NOT EXISTS months(path TEXT PRIMARY KEY, signature TEXT, scanned REAL);
          CREATE TABLE IF NOT EXISTS files(month TEXT, name TEXT, size INTEGER, mtime INTEGER,
            active_until REAL, PRIMARY KEY(month,name));
        ''')
        old_root = connection.execute('SELECT root FROM metadata').fetchone()
        if old_root != (str(root),):
            connection.executescript('DELETE FROM files; DELETE FROM months; DELETE FROM metadata;')
            connection.execute('INSERT INTO metadata VALUES(?)', (str(root),))
        connection.execute('CREATE TEMP TABLE present(path TEXT PRIMARY KEY)')
        connection.executemany('INSERT INTO present VALUES(?)', [(str(p),) for p, _ in current])
        connection.execute('DELETE FROM files WHERE month NOT IN(SELECT path FROM present)')
        connection.execute('DELETE FROM months WHERE path NOT IN(SELECT path FROM present)')
        for month, stamp in current:
            path = str(month)
            previous = connection.execute('SELECT signature,scanned FROM months WHERE path=?', (path,)).fetchone()
            if previous is None or previous[0] != stamp or not 0 <= now - previous[1] < RECONCILE_SECONDS:
                old = {n: (s, t) for n, s, t in connection.execute('SELECT name,size,mtime FROM files WHERE month=?', (path,))}
                connection.execute('DELETE FROM files WHERE month=?', (path,))
                for name, size, mtime in file_rows(month, stats):
                    active = now + ACTIVE_SECONDS if mtime / 1e9 >= now - ACTIVE_SECONDS or previous and old.get(name) != (size, mtime) else 0
                    connection.execute('INSERT INTO files VALUES(?,?,?,?,?)', (path, name, size, mtime, active))
                # A concurrent download/rename will force a rescan next time.
                stable = signature(month.stat()) == stamp
                connection.execute('INSERT OR REPLACE INTO months VALUES(?,?,?)', (path, stamp if stable else '', now))
            else:
                stats['cachedMonths'] += 1
                # In-progress files can grow without changing directory mtime.
                active = connection.execute('SELECT name,size,mtime,active_until FROM files WHERE month=? AND active_until>?', (path, now)).fetchall()
                for name, old_size, old_mtime, until in active:
                    try:
                        file = month / name
                        if file.is_symlink():
                            raise FileNotFoundError()
                        st = file.stat()
                        stats['fileStats'] += 1
                        changed = (st.st_size, st.st_mtime_ns) != (old_size, old_mtime)
                        connection.execute('UPDATE files SET size=?,mtime=?,active_until=? WHERE month=? AND name=?',
                            (st.st_size, st.st_mtime_ns, now + ACTIVE_SECONDS if changed else until, path, name))
                    except FileNotFoundError:
                        connection.execute('DELETE FROM files WHERE month=? AND name=?', (path, name))
        connection.commit()
        rows = []
        for month, name, size, mtime in connection.execute('SELECT month,name,size,mtime FROM files'):
            if not name or '/' in name or '\0' in name or name in ('.', '..'):
                raise ValueError('Invalid cached filename')
            rows.append((str(Path(month) / name), size, mtime / 1e9))
        return rows, stats
    except (sqlite3.Error, ValueError, OSError) as error:
        if connection:
            connection.close()
            connection = None
        stats['fallback'] = True
        rows = [(str(month / name), size, mtime / 1e9)
                for month, _ in current for name, size, mtime in file_rows(month, stats)]
        # Keep exactly one cache file; a corrupt/full cache is rebuilt next call.
        busy = getattr(error, 'sqlite_errorcode', None) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
        if cache_safe and not busy and cache.exists() and not cache.is_symlink():
            try:
                cache.unlink()
            except OSError:
                pass
        return rows, stats
    finally:
        if connection:
            connection.close()


if __name__ == '__main__':
    rows, stats = list_files(sys.argv[1], sys.argv[2])
    for path, size, mtime in rows:
        print(f'{path}\t{size}\t{mtime:.9f}')
    if '--stats' in sys.argv:
        print(json.dumps(stats), file=sys.stderr)
