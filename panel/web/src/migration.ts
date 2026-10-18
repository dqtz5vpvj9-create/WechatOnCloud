import type { MigrationCheck, MigrationConfig, MigrationStatus } from './api.ts';

// 与服务端保持同一范围：显式 RFC1918 IPv4，不能把默认绑定扩大到所有网卡。
export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseMigrationForm(enabled: boolean, address: string, port: string): MigrationConfig {
  const bindAddress = address.trim();
  if ((enabled || bindAddress !== '') && !isPrivateIPv4(bindAddress)) {
    throw new Error('请填写宿主机的局域网 IPv4（10.x.x.x、172.16–31.x.x 或 192.168.x.x），不能使用 0.0.0.0、回环地址或公网地址');
  }
  const rawPort = port.trim() || '8015';
  const hostPort = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    throw new Error('宿主机端口须为 1–65535 的整数，默认 8015');
  }
  return { enabled, bindAddress, hostPort };
}

export function migrationStatusSummary(status: MigrationStatus): string {
  if (status.applying) return '正在应用映射，实例可能暂时断开；完成后会自动刷新。';
  if (status.error) return '上次应用未完成，请查看错误和当前实际映射。';
  if (status.pending) {
    return status.actual.running
      ? '配置已保存，尚未应用到当前容器；请保存并应用。'
      : '配置已保存，等待下次启动实例时应用。';
  }
  if (status.config.enabled && !status.actual.running) {
    return '配置已保存到停止的容器；启动后才发布迁移端口。';
  }
  return status.config.enabled
    ? '映射配置已应用；这不代表微信聊天记录迁移已成功。'
    : '迁移端口映射已关闭。';
}

export function migrationCheckSummary(check: MigrationCheck): { listening: string; reachable: string } {
  return {
    listening: check.listening === true
      ? '容器内 TCP 8015 正在监听。'
      : check.listening === false
        ? '容器内 TCP 8015 当前未监听。请先在微信中进入聊天记录迁移页面，再检测。'
        : '尚未确认容器内 TCP 8015 是否监听。',
    reachable: check.reachable === true
      ? '面板可连接容器 TCP 8015；这不能证明宿主端口映射路径或手机可达。'
      : check.reachable === false
        ? '面板未连通容器 TCP 8015；请结合微信监听状态检查容器网络，不能单独判断手机到实例的路径。'
        : '尚未确认面板到容器 TCP 8015 的连通性。',
  };
}
