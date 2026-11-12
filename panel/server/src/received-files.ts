// Visit only WeChat's monthly file directories. Walking the account tree also
// scans every image, database and retained backup before returning any files.
export function receivedFilesCommand(root = '/config/xwechat_files'): string[] {
  return ['sh', '-c', String.raw`
for account in "$1"/*; do
  [ -d "$account" ] && [ ! -L "$account" ] || continue
  files="$account/msg/file"
  [ ! -L "$account/msg" ] && [ ! -L "$files" ] && [ -d "$files" ] || continue
  find "$files" -mindepth 2 -maxdepth 2 -type f -printf '%p\t%s\t%T@\n' || exit $?
done
`, 'woc-received-files', root];
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
