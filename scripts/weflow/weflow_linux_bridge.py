"""Read-only WeChat source -> encrypted, incrementally refreshed WeFlow databases."""
import pathlib,sys,json,os,time,secrets,traceback,shutil
from weflow_source_snapshot import capture_snapshot, source_state
from weflow_notification_settings import MUTE_SOURCE, read_muted_sessions
BASE=pathlib.Path('/config/weflow')
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
fingerprints={};iteration=0
scratch=PRIVATE/'snapshots'
def synchronize():
    updated=0;errors=[];muted_sessions=None
    for name,keyinfo in mapping['keys'].items():
        path=pathlib.Path('/'+name.lstrip('/'));dest=target/path.relative_to(source)
        before=source_state(path)
        if fingerprints.get(name)==before:continue
        src=dst=None;folder=None;contact_muted=None
        try:
            dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            folder,snapshot,captured=capture_snapshot(path,scratch)
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
            os.chmod(dest,0o600);fingerprints[name]=captured;updated+=1
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
    result={'time':time.strftime('%Y-%m-%d %H:%M:%S'),'databases':len(mapping['keys']),'synced':len(fingerprints),'updated':updated,'errors':errors,'sourceMode':'byte-copy-only','snapshotWalValidated':True,'destinationEncrypted':True,'mutedSessions':muted_count}
    status=BASE/'data/bridge-status.json';temp=status.with_suffix('.tmp');temp.write_text(json.dumps(result));temp.replace(status)
    print(json.dumps(result),flush=True)
    return result
if '--once' in sys.argv:
    result=synchronize();sys.exit(1 if result['errors'] else 0)
while True:
    if any(pathlib.Path('/tmp').glob('woc-weflow-consumer-*')):
        synchronize();time.sleep(15)
    else:
        time.sleep(2)
