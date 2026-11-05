export const hasWeFlowDesktop = (id?: string) => id === 'ad22dcbaa6';

export function WeFlowIcon() {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h16v12H9l-5 4V5Z" /><path d="M8 9h8M8 13h5" />
  </svg>;
}

// Full document navigation keeps the display-specific input and control session
// together. Opening either link in a new tab also retains independent desktops.
export function DesktopApps({ id, weflow = false, launch = false }: { id: string; weflow?: boolean; launch?: boolean }) {
  return <nav className={'desktop-apps' + (launch ? ' desktop-apps--launch' : '')} aria-label={launch ? '打开应用' : '应用切换'}>
    <a href={`/i/${id}`} className={'desktop-app' + (!launch && !weflow ? ' active' : '')} aria-current={!launch && !weflow ? 'page' : undefined}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 11Z" /><path d="M8 10h.01M15 10h.01" />
      </svg>
      <span>{launch ? '打开微信' : '微信'}</span>
    </a>
    <a href={`/i/${id}?screen=weflow`} className={'desktop-app' + (!launch && weflow ? ' active' : '')} aria-current={!launch && weflow ? 'page' : undefined}>
      <WeFlowIcon /><span>{launch ? '打开 WeFlow' : 'WeFlow'}</span>
    </a>
  </nav>;
}
