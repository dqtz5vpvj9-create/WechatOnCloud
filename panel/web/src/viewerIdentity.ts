export const NATIVE_VIEWER_KEY = 'woc_native_window_viewer';

export function viewerIdentity(native: boolean, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, random: () => string): string {
  if (native) {
    try {
      const saved = storage?.getItem(NATIVE_VIEWER_KEY);
      if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
      const id = random();
      storage?.setItem(NATIVE_VIEWER_KEY, id);
      return id;
    } catch { /* Restricted session storage falls back to a document identity. */ }
  }
  return random();
}
