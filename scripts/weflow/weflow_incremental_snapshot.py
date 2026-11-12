"""Reuse immutable private base pages and fetch only appended committed WAL bytes.

All live access is ordinary byte I/O. SQL may open only the returned private
snapshot. Changed base files, WAL generations and invalid caches rebuild safely.
"""
import fcntl
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
import time

from weflow_source_snapshot import SnapshotBusy, source_state, validate_wal


def cache_stat(path):
    st = path.stat()
    # Creating/removing a private hard link changes ctime, not file contents.
    return [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]


def state_token(state):
    return json.dumps([state[0], state[1], state[2].hex()], separators=(',', ':'))


class SnapshotCache:
    def __init__(self, root, max_bytes=768 * 1024 * 1024):
        if Path(root).is_symlink():
            raise ValueError('Snapshot cache must not be a symlink')
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.max_bytes = max_bytes

    def _remove(self, entry):
        if entry.parent != self.root or not re.fullmatch(r'[a-f0-9]{64}', entry.name) or entry.is_symlink():
            raise ValueError('Invalid cache cleanup target')
        if entry.exists():
            shutil.rmtree(entry)

    def _entry(self, source):
        return self.root / hashlib.sha256(str(source).encode()).hexdigest()

    def _budget(self, keep):
        entries = []
        for entry in self.root.iterdir():
            if entry.is_symlink() or not entry.is_dir() or not re.fullmatch(r'[a-f0-9]{64}', entry.name):
                continue
            size = sum(p.stat().st_size for p in entry.iterdir() if p.is_file())
            entries.append((entry.stat().st_mtime_ns, entry, size))
        total = sum(x[2] for x in entries)
        for _, entry, size in sorted(entries):
            if total <= self.max_bytes:
                break
            if entry == keep:
                continue
            self._remove(entry)
            total -= size
        if total > self.max_bytes:
            self._remove(keep)  # Snapshot hard links stay valid after eviction.

    def capture(self, source, scratch, attempts=8, store_cache=True):
        source = Path(source).resolve(strict=True)
        scratch = Path(scratch).resolve()
        if self.root == source or self.root in source.parents or scratch == source or scratch in source.parents:
            raise ValueError('Live source must be outside private cache/scratch')
        scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (self.root / '.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            self._budget(None)
            return self._capture(source, scratch, attempts, store_cache)

    def _capture(self, source, scratch, attempts, store_cache):
        entry = self._entry(source)
        last_error = 'Source changed during incremental capture'
        for _ in range(attempts):
            folder = Path(tempfile.mkdtemp(prefix='snapshot-', dir=scratch))
            dest = folder / source.name
            wal_dest = Path(str(dest) + '-wal')
            metrics = {'baseReused': False, 'sourceDbBytesRead': 0, 'sourceWalBytesRead': 0}
            try:
                if entry.is_symlink():
                    raise ValueError('Cache entry must not be a symlink')
                before = source_state(source)
                metadata = None
                try:
                    meta = entry / 'state.json'
                    if meta.stat().st_size < 16384:
                        metadata = json.loads(meta.read_text())
                    base_valid = (metadata and not (entry / 'base').is_symlink()
                                  and cache_stat(entry / 'base')[:2] != list(before[0][:2])
                                  and metadata['version'] == 1 and metadata['source'] == str(source)
                                  and metadata['main'] == list(before[0]) and cache_stat(entry / 'base') == metadata['baseStat'])
                except (OSError, ValueError, KeyError, TypeError):
                    base_valid = False
                if base_valid:
                    os.link(entry / 'base', dest)
                    metrics['baseReused'] = True
                else:
                    shutil.copyfile(source, dest)
                    metrics['sourceDbBytesRead'] = source.stat().st_size
                wal_source = Path(str(source) + '-wal')
                try:
                    with wal_source.open('rb') as src:
                        header = src.read(32)
                        metrics['sourceWalBytesRead'] += len(header)
                        reused = False
                        if base_valid and metadata.get('walHeader') == header.hex() and len(before[2]) >= 100:
                            old_end = metadata.get('walEnd', 0)
                            if len(header) == 32 and old_end >= 32:
                                page_size = struct.unpack_from('>I', header, 8)[0]
                                mx = struct.unpack_from('<I', before[2], 16)[0]
                                end = 32 + mx * (page_size + 24)
                                if end >= old_end and cache_stat(entry / 'wal') == metadata['walStat']:
                                    src.seek(old_end - (page_size + 24))
                                    boundary = src.read(24)
                                    metrics['sourceWalBytesRead'] += len(boundary)
                                    if boundary.hex() == metadata.get('lastFrame'):
                                        shutil.copyfile(entry / 'wal', wal_dest)
                                        src.seek(old_end)
                                        with wal_dest.open('ab') as out:
                                            remaining = end - old_end
                                            while remaining:
                                                block = src.read(min(remaining, 1024 * 1024))
                                                if not block:
                                                    raise SnapshotBusy('Incomplete committed WAL tail')
                                                out.write(block)
                                                metrics['sourceWalBytesRead'] += len(block)
                                                remaining -= len(block)
                                        reused = True
                        if not reused:
                            src.seek(0)
                            with wal_dest.open('wb') as out:
                                shutil.copyfileobj(src, out, 1024 * 1024)
                            metrics['sourceWalBytesRead'] += wal_dest.stat().st_size
                except FileNotFoundError:
                    pass
                after = source_state(source)
                if before != after:
                    raise SnapshotBusy('Source changed during incremental capture')
                end = 0
                if wal_dest.exists() and wal_dest.stat().st_size:
                    with wal_dest.open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as wal:
                        end = validate_wal(wal, before[2])
                        header_hex = bytes(wal[:32]).hex()
                        page_size = struct.unpack_from('>I', wal, 8)[0] if end else 0
                        boundary = bytes(wal[end - page_size - 24:end - page_size]).hex() if end else ''
                    with wal_dest.open('r+b') as f:
                        f.truncate(end)
                else:
                    validate_wal(b'', before[2])
                    header_hex = boundary = ''
                if not end:
                    wal_dest.unlink(missing_ok=True)
                if store_cache and (dest.stat().st_size + end) <= self.max_bytes:
                    entry.mkdir(exist_ok=True, mode=0o700)
                    if not base_valid:
                        # Immutable raw base; readers get private hard links and
                        # must use SQLite mode=ro. SQL never opens this cache path.
                        new_base = entry / 'base.new'
                        new_base.unlink(missing_ok=True)
                        os.link(dest, new_base)
                        new_base.chmod(0o400)
                        new_base.replace(entry / 'base')
                    if end:
                        shutil.copyfile(wal_dest, entry / 'wal.new')
                        (entry / 'wal.new').chmod(0o600)
                        (entry / 'wal.new').replace(entry / 'wal')
                    else:
                        (entry / 'wal').unlink(missing_ok=True)
                    state = {'version': 1, 'source': str(source), 'main': list(before[0]),
                             'baseStat': cache_stat(entry / 'base'), 'walHeader': header_hex,
                             'walEnd': end, 'lastFrame': boundary,
                             'walStat': cache_stat(entry / 'wal') if end else None}
                    temp = entry / 'state.new'
                    temp.write_text(json.dumps(state)); temp.chmod(0o600); temp.replace(entry / 'state.json')
                    os.utime(entry, None)
                    self._budget(entry)
                return folder, dest, after, metrics
            except (SnapshotBusy, FileNotFoundError, KeyError, TypeError, ValueError) as exc:
                last_error = str(exc)
                shutil.rmtree(folder)
                self._remove(entry)
                time.sleep(0.05)
            except BaseException:
                shutil.rmtree(folder)
                raise
        raise SnapshotBusy(last_error)
