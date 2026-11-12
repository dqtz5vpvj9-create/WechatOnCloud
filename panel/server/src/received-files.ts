import { readFileSync } from 'node:fs';

const indexScript = readFileSync(new URL('./received_file_index.py', import.meta.url), 'utf8');

// Persist monthly metadata; compatible images without Python retain the bounded
// directory scan. No extra service or source-database access is required.
export function receivedFilesCommand(root = '/config/xwechat_files', cache = '/config/.woc-file-index/index.sqlite'): string[] {
  return ['sh', '-c', String.raw`
if command -v python3 >/dev/null 2>&1; then
  exec python3 -c "$1" "$2" "$3"
fi
for account in "$2"/*; do
  [ -d "$account" ] && [ ! -L "$account" ] || continue
  files="$account/msg/file"
  [ ! -L "$account/msg" ] && [ ! -L "$files" ] && [ -d "$files" ] || continue
  find "$files" -mindepth 2 -maxdepth 2 -type f -printf '%p\t%s\t%T@\n' || exit $?
done
`, 'woc-received-files', indexScript, root, cache];
}

// month/name have already passed the API's basename/path validation. Pass them
// as argv and quote every expansion, including filenames containing glob chars.
export function receivedFileCommand(month: string, name: string, root = '/config/xwechat_files'): string[] {
  return ['sh', '-c', String.raw`
for account in "$1"/*; do
  [ -d "$account" ] && [ ! -L "$account" ] || continue
  files="$account/msg/file"
  [ ! -L "$account/msg" ] && [ ! -L "$files" ] && [ ! -L "$files/$2" ] || continue
  target="$files/$2/$3"
  if [ -f "$target" ] && [ ! -L "$target" ]; then
    printf '%s\n' "$target"
    exit 0
  fi
done
`, 'woc-received-file', root, month, name];
}
