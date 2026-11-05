(() => {
  if (window.top !== window) return;
  const invoke = action => window.__TAURI__.core.invoke('desktop_update', { action });
  let notice;
  let dismissed;
  let manual = false;
  function render(status) {
    const show = status.phase === 'available' || status.phase === 'downloading' || status.phase === 'installing' || manual;
    if (!show || (status.version === dismissed && !manual)) return;
    if (!document.body) return;
    if (!notice?.isConnected) {
      notice = document.createElement('div');
      notice.id = 'yunwei-update-status';
      notice.setAttribute('role', 'status');
      Object.assign(notice.style, {position:'fixed',left:'20px',bottom:'20px',zIndex:'2147483646',maxWidth:'380px',padding:'12px 16px',borderRadius:'10px',background:'#202824',color:'#fff',boxShadow:'0 4px 20px #0003',font:'14px/1.5 system-ui,sans-serif'});
      document.body.append(notice);
    }
    notice.replaceChildren();
    const text = document.createElement('div');
    text.textContent = status.phase === 'available' ? `云微 ${status.version} 已就绪`
      : status.phase === 'checking' ? '正在检查云微更新…'
      : status.phase === 'downloading' ? `正在下载更新 ${status.total ? Math.min(100, Math.round(status.downloaded / status.total * 100)) + '%' : ''}`
      : status.phase === 'installing' ? '正在安装更新…'
      : status.phase === 'error' ? '检查更新失败，请稍后重试'
      : `云微 ${status.currentVersion} 已是最新版本`;
    notice.append(text);
    if (status.error && status.phase === 'available') {
      const error = document.createElement('div');
      error.textContent = '更新失败，当前版本仍可使用，请重试。';
      notice.append(error);
    }
    const button = (label, action) => {
      const item = document.createElement('button');
      item.textContent = label;
      Object.assign(item.style, {border:'0',padding:'6px 12px 0 0',background:'transparent',color:'#67d89a',cursor:'pointer'});
      item.onclick = action;
      notice.append(item);
    };
    if (status.phase === 'available') button('更新并重启', async () => {
      try { await invoke('install'); } catch { render(await invoke('status')); }
    });
    if (!['downloading', 'installing'].includes(status.phase)) {
      if (status.phase === 'error') button('重试', async () => render(await invoke('check')));
      button(status.phase === 'available' ? '稍后' : '关闭', () => { dismissed = status.version; manual = false; notice.remove(); });
    }
  }
  const poll = () => { void invoke('status').then(render).catch(() => {}); };
  window.addEventListener('yunwei-check-updates', async () => { manual = true; dismissed = undefined; render({phase:'checking'}); render(await invoke('check')); });
  window.addEventListener('DOMContentLoaded', poll, {once:true});
  setInterval(poll, 1500);
})();
