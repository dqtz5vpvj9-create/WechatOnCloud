import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type InstanceWithStatus, type MigrationCheck, type MigrationConfig, type MigrationStatus } from './api';
import { migrationCheckSummary, migrationStatusSummary, parseMigrationForm } from './migration';
import { useUI } from './ui';

export function InstanceMigration({ inst, onClose, onChanged }: {
  inst: InstanceWithStatus;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { confirm } = useUI();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('8015');
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<MigrationCheck | null>(null);
  const [readError, setReadError] = useState('');
  const [formError, setFormError] = useState('');
  const [checkError, setCheckError] = useState('');
  const alive = useRef(false);
  const readSequence = useRef(0);
  const checkSequence = useRef(0);
  const submitLock = useRef(false);
  const wasApplying = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const fillForm = (config: MigrationConfig) => {
    setEnabled(config.enabled);
    setAddress(config.bindAddress);
    setPort(String(config.hostPort));
  };

  const refresh = useCallback(async (fill = false) => {
    const sequence = ++readSequence.current;
    try {
      const next = await api.getInstanceMigration(inst.id);
      if (!next?.config || !next.actual || !Array.isArray(next.actual.bindings) || typeof next.applying !== 'boolean') {
        throw new Error('迁移状态响应不完整，请刷新后确认当前配置');
      }
      if (!alive.current || sequence !== readSequence.current) return;
      const finished = wasApplying.current && !next.applying;
      wasApplying.current = next.applying;
      setStatus(next);
      setReadError('');
      if (fill || finished) fillForm(next.config); // 应用失败后也以服务端恢复的配置为准。
      if (finished) onChangedRef.current();
    } catch (e: any) {
      if (alive.current && sequence === readSequence.current) setReadError(e?.message || '读取迁移配置失败');
    } finally {
      if (alive.current && sequence === readSequence.current) setLoaded(true);
    }
  }, [inst.id]);

  useEffect(() => {
    alive.current = true;
    void refresh(true);
    return () => {
      alive.current = false;
      ++readSequence.current;
      ++checkSequence.current;
    };
  }, [refresh]);

  // 只在后端应用中轮询；每次读取完成后才安排下一次，慢请求不会叠加。
  useEffect(() => {
    if (!status?.applying) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status?.applying, refresh]);

  const clearCheck = () => {
    ++checkSequence.current;
    setCheck(null);
    setCheckError('');
    setChecking(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!status || submitLock.current || status.applying) return;
    setFormError('');
    let config: MigrationConfig;
    try {
      config = parseMigrationForm(enabled, address, port);
    } catch (e: any) {
      setFormError(e.message);
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      if (status.actual.running) {
        const ok = await confirm({
          title: config.enabled ? '保存映射并重启实例？' : '关闭映射并重启实例？',
          body: '应用端口配置需要重建正在运行的实例，微信会短暂断开。现有数据卷会保留，关闭映射也不会删除聊天记录。',
          confirmText: config.enabled ? '保存并重启' : '关闭并重启',
        });
        if (!ok || !alive.current) return;
      }
      if (!alive.current) return;
      ++readSequence.current; // 保存前开始的读取不能覆盖新配置。
      clearCheck();
      const result = await api.setInstanceMigration(inst.id, config);
      if (!result?.ok || typeof result.applying !== 'boolean') throw new Error('未收到有效的保存确认');
      if (!alive.current) return;
      wasApplying.current = result.applying;
      setStatus((current) => current && { ...current, applying: result.applying, error: null });
      await refresh(true);
      if (alive.current && !result.applying) onChangedRef.current();
    } catch (e: any) {
      if (!alive.current) return;
      // PUT 可能已被后端接收；只读回状态，不自动重复提交或重启。
      setFormError(`保存未确认：${e?.message || '请求失败'}。请核对当前配置和实际映射后再决定是否重试。`);
      await refresh();
    } finally {
      submitLock.current = false;
      if (alive.current) setSubmitting(false);
    }
  };

  const probe = async () => {
    if (!status || submitting || status.applying || checking) return;
    const sequence = ++checkSequence.current;
    setChecking(true);
    setCheck(null);
    setCheckError('');
    try {
      const result = await api.checkInstanceMigration(inst.id);
      if (!result || !('listening' in result) || !('reachable' in result)) throw new Error('端口检测响应不完整');
      if (alive.current && sequence === checkSequence.current) setCheck(result);
    } catch (e: any) {
      if (alive.current && sequence === checkSequence.current) setCheckError(e?.message || '检测失败');
    } finally {
      if (alive.current && sequence === checkSequence.current) setChecking(false);
    }
  };

  const busy = submitting || !!status?.applying;
  const changed = !!status && (enabled !== status.config.enabled || address.trim() !== status.config.bindAddress || port.trim() !== String(status.config.hostPort));
  const checkText = check && migrationCheckSummary(check);

  return (
    <div className="modal-mask" onClick={() => { if (!submitting) onClose(); }}>
      <form className="card modal migration-modal" role="dialog" aria-modal="true" aria-labelledby="migration-title"
        onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 id="migration-title">聊天记录迁移 · {inst.name}</h2>
        <p className="muted small migration-copy">为这个微信实例保存 TCP 8015 端口映射，供手机聊天记录迁移使用。配置会在实例升级、重建后保留。</p>
        {!loaded && <div className="muted small">读取迁移配置中…</div>}
        {readError && <div className="error" role="alert">{readError}</div>}
        {status && <>
          <label className="migration-toggle">
            <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => {
              setEnabled(e.target.checked);
              if (!e.target.checked) {
                // 关闭映射保留最后保存的地址，未保存的无效字段不能挡住关闭操作。
                setAddress(status.config.bindAddress);
                setPort(String(status.config.hostPort));
              }
              setFormError('');
              clearCheck();
            }} />
            开启 TCP 8015 映射
          </label>
          <div className="migration-fields">
            <label>
              <span className="field-label">宿主机局域网 IPv4{enabled ? '（必填）' : ''}</span>
              <input className="input" inputMode="decimal" value={address} placeholder="例如 192.168.1.20" required={enabled}
                disabled={busy || !enabled} autoComplete="off" spellCheck={false}
                onChange={(e) => { setAddress(e.target.value); setFormError(''); clearCheck(); }} />
            </label>
            <label>
              <span className="field-label">宿主机端口</span>
              <input className="input" inputMode="numeric" value={port} placeholder="8015" disabled={busy || !enabled}
                onChange={(e) => { setPort(e.target.value); setFormError(''); clearCheck(); }} />
            </label>
          </div>
          <p className="muted small migration-copy">填写 Docker 宿主机实际拥有的局域网地址；容器端口固定为 8015。多个实例不能占用同一宿主地址和端口。</p>
          <div className="vol-warn">
            {status.actual.running ? '保存并应用会短暂重启当前实例。' : '实例当前未运行，保存后在下次启动时应用。'}
            关闭映射不会删除聊天记录。迁移完成后可关闭此映射。
          </div>
          <section className="migration-state" aria-live="polite">
            <strong>{migrationStatusSummary(status)}</strong>
            {status.error && <div className="error" role="alert">{status.error}</div>}
            <dl>
              <dt>当前容器 IP</dt><dd>{status.actual.containerIp || '未获取'}</dd>
              <dt>Docker 网段</dt><dd>{status.actual.subnet || '未获取'}</dd>
              <dt>实际端口映射</dt><dd>{status.actual.bindings.length
                ? status.actual.bindings.map((b) => <div key={`${b.hostIp}:${b.hostPort}`}>{b.hostIp}:{b.hostPort} → 容器 {b.containerPort}/TCP</div>)
                : '无 TCP 8015 映射'}</dd>
            </dl>
          </section>
          <div className="migration-check">
            <button type="button" className="btn" onClick={probe}
              disabled={busy || checking || !status.actual.running || !status.config.enabled || status.pending}>
              {checking ? '检测中…' : '检测容器端口'}
            </button>
            <span className="muted small">先保存映射并启动实例，在微信内进入聊天记录迁移页面后检测。</span>
          </div>
          {checkText && <div className="migration-check-result small" role="status">
            <div>{checkText.listening}</div>
            <div>{checkText.reachable}</div>
            {check?.error && <div>{check.error}</div>}
          </div>}
          {checkError && <div className="error" role="alert">{checkError}</div>}
          <p className="muted small migration-copy">端口映射不会自动配置路由或防火墙。手机必须能访问微信迁移流程实际使用的地址；若使用容器 IP，需要路由和 Docker 转发许可，或在路由器配置对应的地址转换。检测仅检查容器内监听和面板到容器端口的连通性，不代表宿主映射路径或手机可达，也不代表迁移已完成。<a href="https://github.com/dqtz5vpvj9-create/WechatOnCloud/blob/main/doc/chat-migration.md" target="_blank" rel="noopener noreferrer">查看网络配置说明</a></p>
        </>}
        {formError && <div className="error" role="alert">{formError}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-text" disabled={busy} onClick={() => { clearCheck(); void refresh(!status); }}>刷新状态</button>
          <button type="button" className="btn" disabled={submitting} onClick={onClose}>{status?.applying ? '关闭窗口' : '关闭'}</button>
          <button className="btn btn-primary" disabled={busy || !status || !!readError || (!changed && !status.pending)}>
            {busy ? '应用中…' : enabled ? '保存并应用' : '保存并关闭映射'}
          </button>
        </div>
      </form>
    </div>
  );
}
