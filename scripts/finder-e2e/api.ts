export const api = {
  async fileDragEvents(_id: string, signal: AbortSignal, handler: (event: any) => void) {
    (window as any).__fixtureDrag = () => handler({ type: 'files', paths: [{ name: 'woc-finder-test.txt', ticket: 'A'.repeat(43), directory: false }] });
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
  async releaseFileDrag(_id: string) {
    await fetch('/release', { method: 'POST' });
  },
};

