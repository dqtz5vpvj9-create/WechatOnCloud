import { installFileDragOut } from './fileDragOut';
const frame = document.querySelector('iframe')!;
frame.addEventListener('load', () => {
  installFileDragOut(frame, 'aabbcc1234', message => fetch('/error?message=' + encodeURIComponent(message)));
  frame.contentWindow!.document.addEventListener('mousedown', () => setTimeout(() => (window as any).__fixtureDrag(), 80), true);
  fetch('/ready', { method: 'POST' });
});

