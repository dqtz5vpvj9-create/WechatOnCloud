import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { useUI } from './ui';

type Quality = 'standard' | 'hd';
type State = { quality: Quality; phase: string; error?: string };
const Context = createContext<{ state: State; toggle: () => void }>({ state: { quality: 'standard', phase: 'loading' }, toggle: () => {} });
export const useDisplayQuality = () => useContext(Context);

export function DisplayQualityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ quality: 'standard', phase: 'loading' });
  const { confirm, toast } = useUI();
  useEffect(() => { if (state.error) toast(state.error, 'error'); }, [state.error, toast]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      let fast = false;
      try {
        const next = await api.getDesktopQuality();
        if (active && ['standard', 'hd'].includes(next.quality)) setState(next);
        fast = next.phase === 'applying';
      } catch { /* Keep the last known global setting during reconnects. */ }
      if (active) timer = setTimeout(poll, fast ? 500 : 5000);
    };
    void poll();
    window.addEventListener('focus', poll);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('focus', poll); };
  }, [state.phase === 'applying']);
  const toggle = async () => {
    const quality = state.quality === 'hd' ? 'standard' : 'hd';
    if (!await confirm({ title: `切换到${quality === 'hd' ? '高清' : '标准'}画质？`,
      body: '这是全局设置，所有设备上的微信和 WeFlow 会同步切换。应用将短暂重启，请先发送或保存正在编辑的内容。高清模式使用约四倍渲染像素，会增加资源和带宽开销。',
      confirmText: '切换并重启应用' })) return;
    try {
      const next = await api.setDesktopQuality(quality);
      setState(next);
    } catch (error: any) { toast(error.message, 'error'); }
  };
  return <Context.Provider value={{ state, toggle }}>{children}</Context.Provider>;
}

export function QualityToggle({ settings = false }: { settings?: boolean }) {
  const { state, toggle } = useDisplayQuality();
  const { user } = useAuth();
  const busy = state.phase === 'loading' || state.phase === 'applying';
  return <div className={settings ? 'quality-settings' : 'quality-quick'}>
    <button className={settings ? 'btn' : 'ws-action'} disabled={busy || user?.role !== 'admin'} onClick={toggle}
      title={state.error || '全局画质设置，微信与 WeFlow 共用'} aria-label="切换全局画质">
      {state.phase === 'applying' ? '画质切换中…' : `画质：${state.quality === 'hd' ? '高清' : '标准'}`}
    </button>
    {settings && <p className="muted small">全局生效，各设备同步。切换需要短暂重启应用。{state.error}</p>}
  </div>;
}

// KasmVNC's own fixed-resolution/scaling path preserves pointer coordinates.
export function connectDisplayQuality(win: Window, quality: Quality): () => void {
  let previous = '';
  const apply = () => {
    if (!win.document.documentElement.classList.contains('noVNC_connected')) return;
    const container = win.document.getElementById('noVNC_container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const scale = Math.min(2, 8192 / rect.width, 8192 / rect.height,
      Math.sqrt(16_777_216 / (rect.width * rect.height)));
    const width = Math.max(2, Math.floor(rect.width * scale / 2) * 2);
    const height = Math.max(2, Math.floor(rect.height * scale / 2) * 2);
    const key = `${quality}/${width}/${height}`;
    if (key === previous) return;
    previous = key;
    // Kasm's automatic antialiasing also applies an extra scale on narrow
    // high-DPI screens. Use its supported smoothing control to keep 1x/2x exact.
    const smoothing = win.document.getElementById('noVNC_setting_anti_aliasing') as HTMLSelectElement | null;
    if (smoothing && smoothing.value !== '1') {
      smoothing.value = '1';
      const event = win.document.createEvent('Event');
      event.initEvent('change', true, false);
      smoothing.dispatchEvent(event);
    }
    const send = (data: object) => win.postMessage(data, win.location.origin);
    send({ action: 'setvideoquality', value: quality === 'hd' ? 3 : 2 });
    send({ action: 'enable_hidpi', value: false });
    send({ action: 'resize', value: quality === 'hd' ? 'scale' : 'remote' });
    if (quality === 'hd') send({ action: 'set_resolution', value_x: width, value_y: height });
  };
  const observer = new MutationObserver(apply);
  observer.observe(win.document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const resize = new ResizeObserver(apply);
  resize.observe(win.document.documentElement);
  apply();
  return () => { observer.disconnect(); resize.disconnect(); };
}
