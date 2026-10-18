import { isIP } from 'node:net';

// 手机聊天记录迁移只开放这个固定的实例端口；VNC 继续由面板反代。
export const MIGRATION_CONTAINER_PORT = 8015;
export const MIGRATION_PORT_KEY = '8015/tcp';

export interface MigrationConfig {
  enabled: boolean;
  bindAddress: string;
  hostPort: number;
}

export interface MigrationApplyState {
  applying: boolean;
  error: string | null;
  previousConfig?: MigrationConfig;
  // 仅用于本次重建失败/面板重启后的恢复，不克隆旧容器的运行时配置。
  imageId?: string;
}

export class MigrationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export function defaultMigrationConfig(): MigrationConfig {
  return { enabled: false, bindAddress: '', hostPort: MIGRATION_CONTAINER_PORT };
}

// 面板在容器内，不能把自己的网卡误认成宿主网卡。这里只允许明确的 RFC1918 IPv4；
// IP 是否确实存在于宿主、非 Docker 进程是否占用端口，最终由 Docker start 检查。
export function isPrivateLanIPv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseMigrationConfig(raw: unknown): MigrationConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MigrationError('迁移配置必须是 JSON 对象');
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['enabled', 'bindAddress', 'hostPort'].includes(key))) {
    throw new MigrationError('迁移配置只接受 enabled、bindAddress 和 hostPort');
  }
  if (typeof value.enabled !== 'boolean') throw new MigrationError('enabled 必须是布尔值');
  const address = value.bindAddress === undefined ? '' : value.bindAddress;
  if (typeof address !== 'string' || address !== address.trim()) {
    throw new MigrationError('bindAddress 必须是无空白的宿主局域网 IPv4 地址');
  }
  if ((value.enabled || address !== '') && !isPrivateLanIPv4(address)) {
    throw new MigrationError('请填写宿主机的 RFC1918 局域网 IPv4，不能使用通配、回环、公网地址或主机名');
  }
  const port = value.hostPort === undefined ? MIGRATION_CONTAINER_PORT : value.hostPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MigrationError('hostPort 必须是 1–65535 之间的整数');
  }
  return { enabled: value.enabled, bindAddress: address, hostPort: port };
}

export function instanceMigrationConfig(inst: { migration?: MigrationConfig }): MigrationConfig {
  return inst.migration === undefined ? defaultMigrationConfig() : parseMigrationConfig(inst.migration);
}

export function migrationRecoveryImage(info: any, state?: MigrationApplyState): string | undefined {
  // inspect 的当前镜像优先；删旧后启动失败时只能使用持久化的恢复 ID，不能转向 latest。
  return typeof info?.Image === 'string' && info.Image ? info.Image : state?.imageId;
}

interface MigrationReservation {
  id: string;
  name: string;
  migration?: MigrationConfig;
  migrationState?: MigrationApplyState;
}

export function assertMigrationPortUnreserved(
  config: MigrationConfig,
  instances: MigrationReservation[],
  exceptId?: string,
): void {
  if (!config.enabled) return;
  for (const inst of instances) {
    if (inst.id === exceptId) continue;
    const reserved = [instanceMigrationConfig(inst)];
    // 回滚完成前也保留旧绑定，避免另一实例抢占导致无法恢复。
    if (inst.migrationState?.applying && inst.migrationState.previousConfig) {
      reserved.push(inst.migrationState.previousConfig);
    }
    if (reserved.some((r) => r.enabled && r.bindAddress === config.bindAddress && r.hostPort === config.hostPort)) {
      throw new MigrationError(`该局域网地址和端口已由实例「${inst.name}」保留`, 409);
    }
  }
}

export function publishedPortConflicts(
  config: MigrationConfig,
  port: { IP?: string; PublicPort?: number; Type?: string },
): boolean {
  return config.enabled && port.Type === 'tcp' && port.PublicPort === config.hostPort &&
    (!port.IP || ['0.0.0.0', '::', config.bindAddress].includes(port.IP));
}

export function migrationContainerPorts(config: MigrationConfig): {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
} {
  const valid = parseMigrationConfig(config);
  return valid.enabled
    ? {
      exposedPorts: { [MIGRATION_PORT_KEY]: {} },
      portBindings: { [MIGRATION_PORT_KEY]: [{ HostIp: valid.bindAddress, HostPort: String(valid.hostPort) }] },
    }
    : { exposedPorts: {}, portBindings: {} };
}

export function migrationMappingMatches(config: MigrationConfig, info: any, active = false): boolean {
  const bindings = (active ? info?.NetworkSettings?.Ports : info?.HostConfig?.PortBindings)?.[MIGRATION_PORT_KEY] || [];
  if (!config.enabled) return bindings.length === 0;
  return bindings.length === 1 && bindings[0].HostIp === config.bindAddress &&
    String(bindings[0].HostPort) === String(config.hostPort);
}

function ipv4Subnet(address: string, prefix: unknown): string | null {
  if (isIP(address) !== 4 || typeof prefix !== 'number' || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const ip = address.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const subnet = (ip & mask) >>> 0;
  return [24, 16, 8, 0].map((shift) => (subnet >>> shift) & 255).join('.') + '/' + prefix;
}

export function describeMigrationContainer(info: any, preferredNetwork?: string | null) {
  // 已停止容器只有声明，端口并未发布；声明差异由 migrationMappingMatches 单独计算。
  const ports = info?.State?.Running ? info?.NetworkSettings?.Ports : undefined;
  const bindings = (ports?.[MIGRATION_PORT_KEY] || []).map((binding: any) => ({
    hostIp: String(binding.HostIp || '0.0.0.0'),
    hostPort: Number(binding.HostPort),
    containerPort: MIGRATION_CONTAINER_PORT,
    protocol: 'tcp' as const,
  }));
  const networks = info?.NetworkSettings?.Networks || {};
  const endpoint: any = (preferredNetwork && networks[preferredNetwork]) ||
    Object.values(networks).find((network: any) => isIP(String(network?.IPAddress || '')) === 4);
  const address = String(endpoint?.IPAddress || '');
  return {
    bindings,
    containerIp: isIP(address) === 4 ? address : null,
    subnet: ipv4Subnet(address, endpoint?.IPPrefixLen),
    running: !!info?.State?.Running,
  };
}

export function assertMigrationNatNetwork(info: any): void {
  const mode = info?.Options?.['com.docker.network.bridge.gateway_mode_ipv4'];
  if (info?.Driver !== 'bridge' || (mode && mode !== 'nat') || info?.Internal === true || info?.EnableIPv4 === false) {
    throw new MigrationError('迁移端口映射要求启用 IPv4 的非 internal bridge 网络及默认/nat 网关模式；当前网络不能保证绑定指定的宿主地址');
  }
}

export function migrationErrorMessage(error: unknown): string {
  // Docker 代理可能返回整页 HTML；持久化错误有界，不把响应正文写满 accounts.json。
  return String((error as any)?.message || error).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function procHasMigrationListener(contents: string): boolean {
  const port = MIGRATION_CONTAINER_PORT.toString(16).toUpperCase().padStart(4, '0');
  return contents.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[3] === '0A' && fields[1]?.toUpperCase().endsWith(':' + port);
  });
}
