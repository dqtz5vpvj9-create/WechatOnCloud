"""Synthetic SQLCipher source and mirror only; run in an isolated container."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, '/config/weflow/bridge-libs')
from sqlcipher3 import dbapi2 as sql


class BridgeTests(unittest.TestCase):
    def test_persistent_checkpoint_wal_updates_deletes_and_destination_repair(self):
        base=Path('/config/weflow');private=base/'data/private';private.mkdir(parents=True)
        account=Path('/config/xwechat_files/synthetic_account');source=account/'db_storage/message/message_0.db';source.parent.mkdir(parents=True)
        raw='12'*32
        writer=sql.connect(str(source));writer.execute('PRAGMA key="x\''+raw+'\'"');writer.execute('PRAGMA journal_mode=WAL');writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY,body TEXT,unread INTEGER)')
        writer.executemany('INSERT INTO messages VALUES(?,?,?)',[(i,'synthetic payload'*100,1) for i in range(1,201)]);writer.commit();writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        (private/'database-key-map.json').write_text(json.dumps({'sourceAccount':str(account),'keys':{str(source).lstrip('/'):{'key':raw}}}))
        (private/'bridge-credentials.json').write_text(json.dumps({'password':'synthetic-mirror-key'}))
        bridge=Path(__file__).parent/'weflow_linux_bridge.py'
        target=base/'data/bridge/xwechat_files'/account.name/'db_storage/message/message_0.db'
        def sync():
            p=subprocess.run([sys.executable,str(bridge),'--once'],capture_output=True,text=True,check=True)
            result=json.loads(p.stdout.splitlines()[-1]);self.assertFalse(result['errors']);return result
        def rows():
            reader=sql.connect(target.as_uri()+'?mode=ro',uri=True);reader.execute("PRAGMA key='synthetic-mirror-key'");reader.execute('PRAGMA query_only=ON')
            self.assertEqual(reader.execute('PRAGMA quick_check').fetchone()[0],'ok');result=reader.execute('SELECT * FROM messages ORDER BY id').fetchall();reader.close();return result
        try:
            self.assertEqual(sync()['updated'],1)
            self.assertEqual(len(rows()),200)
            self.assertEqual(sync()['updated'],0,'New process must reuse persistent checkpoint')
            mirror=sql.connect(str(target));mirror.execute("PRAGMA key='synthetic-mirror-key'");mirror.execute('PRAGMA journal_mode=WAL');mirror.execute('CREATE INDEX reader_index ON messages(unread)');mirror.close()
            self.assertEqual(sync()['updated'],0,'Reader-side pragmas and indexes must not re-copy history')
            writer.execute("INSERT INTO messages VALUES(201,'new',1)");writer.commit()
            self.assertEqual(sync()['updated'],1)
            writer.execute("UPDATE messages SET body='revoked',unread=0 WHERE id=1")
            writer.execute('DELETE FROM messages WHERE id=2');writer.commit()
            result=sync();self.assertEqual(result['baseSnapshotsReused'],1);self.assertEqual(result['sourceDbBytesRead'],0)
            current=rows();self.assertEqual(current[0],(1,'revoked',0));self.assertEqual(len(current),200)
            writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            writer.execute("UPDATE messages SET unread=0 WHERE id=3");writer.commit()
            self.assertGreater(sync()['sourceDbBytesRead'],0)
            # Missing/replaced mirrors recover even if the source did not change.
            target.unlink()
            for suffix in ('-wal','-shm'):Path(str(target)+suffix).unlink(missing_ok=True)
            self.assertEqual(sync()['updated'],1)
            self.assertIn((3,'synthetic payload'*100,0),rows())
            self.assertEqual(sync()['updated'],0)
            self.assertEqual(list((private/'bridge-snapshots').iterdir()),[])
        finally:
            writer.close()


if __name__=='__main__':unittest.main()
