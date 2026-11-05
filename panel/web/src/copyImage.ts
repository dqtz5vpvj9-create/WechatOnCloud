// 在点击回调中直接调用；ClipboardItem 用 Promise 等待网络，write 保留当前用户手势。
// 复制成功只表示已写入本机剪贴板，所有失败都交给调用方显示。
export async function copyImageToLocalClipboard(loadImage: () => Promise<Blob>): Promise<void> {
  if (!window.isSecureContext) throw new Error('请使用 HTTPS 打开云微后复制图片');
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined' || ClipboardItem.supports?.('image/png') === false) {
    throw new Error('当前浏览器不支持复制图片到剪贴板');
  }
  const image = loadImage();
  // 权限被拒时浏览器可能不读取 ClipboardItem 中的 Promise，仍需接住网络失败。
  void image.catch(() => {});
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
  } catch (error) {
    await image; // 优先显示“没有图片”等实际读取错误。
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error('复制失败：浏览器未允许写入剪贴板，请保持云微在前台并重试');
    }
    throw new Error('图片未能写入本机剪贴板，请重新复制图片后重试');
  }
}
