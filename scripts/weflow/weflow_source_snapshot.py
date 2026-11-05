"""Copy live SQLite files without opening a live database or touching its locks.

The caller may open only the returned, private snapshot with SQLite/SQLCipher.
Live WAL/SHM are read as ordinary bytes. Unstable or invalid snapshots fail closed.
"""
from pathlib import Path
import os
import shutil
import struct
import tempfile
import time


class SnapshotBusy(RuntimeError):
    pass


def _stat(path):
    try:
        s = path.stat()
        return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    except FileNotFoundError:
        return None


def source_state(path):
    path = Path(path)
    shm = Path(str(path) + '-shm')
    try:
        with shm.open('rb') as f:
            header = f.read(136)
    except FileNotFoundError:
        header = b''
    # Ignore reader lock bytes, but retain both wal-index headers and backfill.
    return (_stat(path), _stat(Path(str(path) + '-wal')), header[:100])


def _checksum(data, state=(0, 0), endian='<'):
    a, b = state
    for x, y in struct.iter_unpack(endian + 'II', data):
        a = (a + x + b) & 0xffffffff
        b = (b + y + a) & 0xffffffff
    return a, b


def validate_wal(wal, shm):
    """Return the last committed byte offset; never accept an incomplete commit."""
    mx = None
    if shm:
        if len(shm) < 96 or shm[:48] != shm[48:96]:
            raise SnapshotBusy('wal-index headers differ')
        if struct.unpack_from('<I', shm)[0] != 3007000 or shm[12] != 1:
            raise SnapshotBusy('uninitialized wal-index')
        if _checksum(shm[:40]) != struct.unpack_from('<II', shm, 40):
            raise SnapshotBusy('wal-index checksum mismatch')
        mx = struct.unpack_from('<I', shm, 16)[0]
        if len(shm) >= 100 and struct.unpack_from('<I', shm, 96)[0] > mx:
            raise SnapshotBusy('invalid checkpoint boundary')
        if mx == 0:
            return 0
    if not wal:
        if mx:
            raise SnapshotBusy('committed WAL is missing')
        return 0
    if len(wal) < 32:
        raise SnapshotBusy('short WAL header')
    h = struct.unpack_from('>8I', wal)
    magic, version, size = h[:3]
    if magic not in (0x377f0682, 0x377f0683) or version != 3007000:
        raise SnapshotBusy('unsupported WAL header')
    if size < 512 or size > 65536 or size & (size - 1):
        raise SnapshotBusy('invalid WAL page size')
    endian = '<' if magic == 0x377f0682 else '>'
    state = _checksum(wal[:24], endian=endian)
    if state != h[6:8]:
        raise SnapshotBusy('WAL header checksum mismatch')
    if mx is not None and shm[32:40] != wal[16:24]:
        raise SnapshotBusy('WAL generation changed')
    available = (len(wal) - 32) // (size + 24)
    if mx is not None and mx > available:
        raise SnapshotBusy('committed WAL is incomplete')
    last_commit = 0
    last_pages = 0
    for i in range(mx if mx is not None else available):
        at = 32 + i * (size + 24)
        frame = struct.unpack_from('>6I', wal, at)
        next_state = _checksum(wal[at:at + 8], state, endian)
        next_state = _checksum(wal[at + 24:at + 24 + size], next_state, endian)
        if frame[2:4] != h[4:6] or frame[4:6] != next_state or frame[0] == 0:
            if mx is not None:
                raise SnapshotBusy('committed WAL frame checksum mismatch')
            break
        state = next_state
        if frame[1]:
            last_commit = at + 24 + size
            last_pages = frame[1]
    if mx is not None:
        if last_commit != 32 + mx * (size + 24):
            raise SnapshotBusy('wal-index does not end on a committed frame')
        if state != struct.unpack_from('<II', shm, 24):
            raise SnapshotBusy('wal-index checksum differs from WAL')
        if last_pages != struct.unpack_from('<I', shm, 20)[0]:
            raise SnapshotBusy('wal-index database size differs from WAL')
    return last_commit


def capture_snapshot(source, scratch_root, attempts=8):
    source, scratch_root = Path(source).resolve(strict=True), Path(scratch_root).resolve()
    if source == scratch_root or scratch_root in source.parents:
        raise ValueError('live source must be outside the snapshot workspace')
    scratch_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    last_error = 'source changed during copy'
    for _ in range(attempts):
        before = source_state(source)
        folder = Path(tempfile.mkdtemp(prefix='snapshot-', dir=scratch_root))
        dest = folder / source.name
        try:
            # These are the only accesses to live database files: ordinary reads.
            shutil.copyfile(source, dest)
            wal_path = Path(str(source) + '-wal')
            try:
                wal = wal_path.read_bytes()
            except FileNotFoundError:
                wal = b''
            after = source_state(source)
            if before != after:
                raise SnapshotBusy('source changed during copy')
            end = validate_wal(wal, before[2])
            if end:
                target_wal = Path(str(dest) + '-wal')
                target_wal.write_bytes(wal[:end])
                target_wal.chmod(0o600)
            dest.chmod(0o600)
            return folder, dest, after
        except (SnapshotBusy, FileNotFoundError) as exc:
            last_error = str(exc)
            shutil.rmtree(folder)
            time.sleep(0.05)
        except BaseException:
            shutil.rmtree(folder)
            raise
    raise SnapshotBusy(last_error)
