// Extra media storage declared by an offline history import. Database files
// remain in the original named volume; restart/upgrade uses this same mapping.
export const HISTORY_MEDIA_PATHS = ['msg/attach', 'msg/video', 'msg/file', 'msg/migrate', 'business/emoticon'] as const;
export interface HistoryMediaStorage {
  accountDirectory: string;
  mounts: Array<{ relativePath: typeof HISTORY_MEDIA_PATHS[number]; sourcePath: string }>;
}

export function historyMediaMounts(raw: unknown): Array<{ Type: 'bind'; Source: string; Target: string; ReadOnly: false }> {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('历史附件存储配置无效');
  const { accountDirectory, mounts } = raw as HistoryMediaStorage;
  if (typeof accountDirectory !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(accountDirectory)) {
    throw new Error('历史附件存储的微信账号目录无效');
  }
  if (!Array.isArray(mounts) || !mounts.length || mounts.length > HISTORY_MEDIA_PATHS.length) {
    throw new Error('历史附件存储目录数量无效');
  }
  const seen = new Set<string>();
  return mounts.map((m) => {
    if (!m || !HISTORY_MEDIA_PATHS.includes(m.relativePath) || seen.has(m.relativePath)) {
      throw new Error('历史附件存储只允许独立的附件、视频、文件、迁移媒体和表情目录');
    }
    seen.add(m.relativePath);
    if (typeof m.sourcePath !== 'string' || !m.sourcePath.startsWith('/') || m.sourcePath === '/' ||
        /[\\:\x00-\x1f]/.test(m.sourcePath) || m.sourcePath.slice(1).split('/').some((p) => !p || p === '.' || p === '..')) {
      throw new Error('历史附件存储须使用明确的宿主绝对路径');
    }
    return { Type: 'bind', Source: m.sourcePath, Target: `/config/xwechat_files/${accountDirectory}/${m.relativePath}`, ReadOnly: false };
  });
}
