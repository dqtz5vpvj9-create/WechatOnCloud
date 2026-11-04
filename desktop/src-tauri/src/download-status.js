(() => {
  if (window.top !== window) return;
  let timer;
  window.__yunweiDownloadStatus = ({ status, name, path }) => {
    let notice = document.getElementById('yunwei-download-status');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'yunwei-download-status';
      notice.setAttribute('role', 'status');
      Object.assign(notice.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
        maxWidth: 'min(440px, calc(100vw - 40px))', padding: '14px 18px',
        borderRadius: '10px', background: '#202824', color: '#fff',
        boxShadow: '0 4px 20px #0003', font: '14px/1.5 system-ui, sans-serif',
        overflowWrap: 'anywhere', cursor: 'pointer',
      });
      notice.addEventListener('click', () => notice.remove());
      document.body.append(notice);
    }
    notice.dataset.status = status;
    notice.textContent = status === 'started' ? `正在下载：${name || '文件'}`
      : status === 'finished' ? `已下载：${path || name || '文件已保存到下载文件夹'}`
      : `下载失败：${name || '请检查下载文件夹权限后重试'}`;
    clearTimeout(timer);
    if (status !== 'started') timer = setTimeout(() => notice.remove(), 12000);
  };
})();
