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
      document.body.append(notice);
    }
    notice.dataset.status = status;
    notice.replaceChildren();
    const text = document.createElement('div');
    text.textContent = status === 'started' ? `正在下载：${name || '文件'}`
      : status === 'finished' ? `已下载：${path || name || '文件已保存到下载文件夹'}`
      : `下载失败：${name || '请检查下载文件夹权限后重试'}`;
    notice.append(text);
    if (status === 'finished' && path) {
      const actions = document.createElement('div');
      Object.assign(actions.style, { display: 'flex', gap: '12px', marginTop: '8px' });
      for (const [label, reveal] of [['打开文件', false], ['打开所在文件夹', true]]) {
        const button = document.createElement('button');
        button.textContent = label;
        Object.assign(button.style, { border: '0', padding: '0', background: 'transparent', color: '#67d89a', cursor: 'pointer' });
        button.addEventListener('click', () => window.__TAURI__.core.invoke('open_download_path', { path, reveal }));
        actions.append(button);
      }
      notice.append(actions);
    }
    clearTimeout(timer);
    if (status !== 'started') timer = setTimeout(() => notice.remove(), 12000);
  };
})();
