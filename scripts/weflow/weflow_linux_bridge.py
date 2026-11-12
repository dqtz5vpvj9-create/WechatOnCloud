"""Read-only WeChat source -> encrypted, incrementally refreshed WeFlow databases."""
import pathlib,sys,json,os,time,secrets,traceback,shutil,hashlib,fcntl,signal
from weflow_source_snapshot import source_state
from weflow_incremental_snapshot import SnapshotCache, state_token
from weflow_notification_settings import MUTE_SOURCE, read_muted_sessions
BASE=pathlib.Path('/config/weflow')
EXTERNAL=os.environ.get('WOC_BRIDGE_EXTERNAL')=='1'
if (BASE/'data/bridge-external').exists() and not EXTERNAL:
    sys.exit('Bridge runs in its isolated worker; invoke maintenance there')
sys.path.insert(0,str(BASE/'bridge-libs'))
from sqlcipher3 import dbapi2 as sqlite
PRIVATE=BASE/'data/private';PRIVATE.mkdir(parents=True,exist_ok=True,mode=0o700)
mapping=json.loads((PRIVATE/'database-key-map.json').read_text())
source=pathlib.Path(mapping['sourceAccount'])
target=BASE/'data/bridge/xwechat_files'/source.name
target.mkdir(parents=True,exist_ok=True,mode=0o700)
credentials=PRIVATE/'bridge-credentials.json'
if credentials.exists():secret=json.loads(credentials.read_text())
else:
    password=secrets.token_hex(16)
    secret={'password':password,'decryptKey':password.encode().hex(),'dbPath':str(target.parent),'accountDir':str(target),'myWxid':source.name.rsplit('_',1)[0]}
    credentials.write_text(json.dumps(secret));os.chmod(credentials,0o600)
for child in source.iterdir():
    if child.name=='db_storage':continue
    link=target/child.name
    if not link.exists():link.symlink_to(child,target_is_directory=child.is_dir())
scratch=PRIVATE/'bridge-snapshots'
snapshot_cache=SnapshotCache(PRIVATE/'incremental-snapshots')
checkpoint=PRIVATE/'bridge-checkpoint.json'
key_fingerprint=hashlib.sha256((json.dumps(mapping,sort_keys=True)+secret['password']).encode()).hexdigest()
def destination_state(path):
    def stat(p):
        try:
            s=p.stat();return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns]
        except FileNotFoundError:return None
    wal=stat(pathlib.Path(str(path)+'-wal'))
    return [stat(path),wal if wal and wal[2]>32 else None]
def destination_matches(previous,path):
    # WeFlow may enable WAL, checkpoint, or add its own indexes while reading a
    # mirror. These benign writes must not trigger a complete history recopy.
    # Missing/replaced/truncated mirrors still require authoritative recovery.
    try:
        old=previous[0];current=destination_state(path)[0]
        return bool(old and current and old[:2]==current[:2] and current[2]>=old[2])
    except (TypeError,IndexError):return False
def load_checkpoint():
    try:
        if checkpoint.stat().st_size>1024*1024:return {}
        state=json.loads(checkpoint.read_text())
        if state.get('version')!=1 or state.get('keys')!=key_fingerprint:return {}
        return {k:v for k,v in state['databases'].items() if k in mapping['keys'] and isinstance(v,dict)}
    except (OSError,ValueError,KeyError,TypeError,AttributeError):return {}
def save_checkpoint(records):
    temp=checkpoint.with_suffix('.tmp');temp.write_text(json.dumps({'version':1,'keys':key_fingerprint,'databases':records}));temp.chmod(0o600);temp.replace(checkpoint)
def _synchronize():
    started=time.monotonic()
    # This workspace is exclusively owned by the bridge-sync lock. Recover
    # incomplete snapshots left by a killed process before allocating another.
    if scratch.exists():
        for folder in scratch.iterdir():
            if folder.is_dir() and not folder.is_symlink() and folder.name.startswith('snapshot-'):
                assert folder.parent==scratch.resolve();shutil.rmtree(folder)
    records=load_checkpoint()
    updated=0;errors=[];muted_sessions=None
    metrics={'baseSnapshotsReused':0,'sourceDbBytesRead':0,'sourceWalBytesRead':0}
    for name,keyinfo in mapping['keys'].items():
        path=pathlib.Path('/'+name.lstrip('/'));dest=target/path.relative_to(source)
        src=dst=None;folder=None;contact_muted=None
        try:
            before=source_state(path)
            previous=records.get(name)
            if previous and previous.get('source')==state_token(before) and destination_matches(previous.get('destination'),dest):continue
            dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            folder,snapshot,captured,delta=snapshot_cache.capture(path,scratch,store_cache=bool(previous))
            metrics['baseSnapshotsReused']+=int(delta['baseReused'])
            metrics['sourceDbBytesRead']+=delta['sourceDbBytesRead']
            metrics['sourceWalBytesRead']+=delta['sourceWalBytesRead']
            # SQLite can rewrite SHM even with mode=ro. Only open our private copy.
            assert snapshot.parent == folder and folder.parent == scratch.resolve()
            src=sqlite.connect(snapshot.as_uri()+'?mode=ro',uri=True,timeout=5)
            src.execute('PRAGMA key="x\''+keyinfo['key']+'\'"')
            src.execute('PRAGMA query_only=ON')
            source_count=src.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]
            if path.name.lower()=='contact.db':
                contact_muted=read_muted_sessions(src)
            dst=sqlite.connect(str(dest),timeout=5)
            dst.execute("PRAGMA key='"+secret['password']+"'")
            dst.execute('PRAGMA cipher_compatibility=4')
            src.backup(dst,pages=256,sleep=0.05)
            count=dst.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]
            if count!=source_count:raise RuntimeError('Destination schema count differs')
            dst.close();dst=None;src.close();src=None
            os.chmod(dest,0o600);records[name]={'source':state_token(captured),'destination':destination_state(dest)};updated+=1
            if contact_muted is not None:muted_sessions=contact_muted
        except Exception as e:errors.append({'database':path.name,'error':str(e)[:180]})
        finally:
            if dst:dst.close()
            if src:src.close()
            if folder:shutil.rmtree(folder)
    mute_file=BASE/'data/muted-sessions.json';muted_count=None
    if muted_sessions is not None:
        mute_temp=mute_file.with_suffix('.tmp')
        mute_temp.write_text(json.dumps({'time':time.strftime('%Y-%m-%d %H:%M:%S'),'source':MUTE_SOURCE,'muted':sorted(set(muted_sessions))}))
        os.chmod(mute_temp,0o600);mute_temp.replace(mute_file)
        muted_count=len(set(muted_sessions))
    elif mute_file.exists():
        try:muted_count=len(json.loads(mute_file.read_text()).get('muted',[]))
        except Exception:pass
    save_checkpoint(records)
    result={'time':time.strftime('%Y-%m-%d %H:%M:%S'),'databases':len(mapping['keys']),'synced':len(records),'updated':updated,'errors':errors,'sourceMode':'byte-copy-only','snapshotWalValidated':True,'destinationEncrypted':True,'mutedSessions':muted_count,'syncMs':round((time.monotonic()-started)*1000),**metrics}
    status=BASE/'data/bridge-status.json';temp=status.with_suffix('.tmp');temp.write_text(json.dumps(result));temp.replace(status)
    print(json.dumps(result),flush=True)
    return result
def synchronize():
    with (PRIVATE/'bridge-sync.lock').open('a') as lock:
        os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX)
        return _synchronize()
def stop_bridge(signum,frame):
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop_bridge)
signal.signal(signal.SIGINT,stop_bridge)
def has_consumers():
    for kind in ('notifications','desktop'):
        try:
            age=time.time()-(BASE/'data/consumers'/kind).stat().st_mtime
            if 0<=age<45:return True
        except FileNotFoundError:pass
    return not EXTERNAL and any(pathlib.Path('/tmp').glob('woc-weflow-consumer-*'))
if '--once' in sys.argv:
    result=synchronize();sys.exit(1 if result['errors'] else 0)
while True:
    if has_consumers():
        synchronize();time.sleep(15)
    else:
        time.sleep(2)
