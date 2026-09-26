/**
 * Warframe 请求的 undici dispatcher（直连 Agent / 可选代理）。
 *
 * - WARFRAME_PROXY_URL 为空（默认）：创建**专用直连 Agent**，开启 family autoselection，
 *   让 Node 在解析到多个地址族时自动尝试（Happy Eyeballs），对间歇性 DNS / CDN / 网络路径抖动更鲁棒。
 *   刻意**不**强制 `family: 4`：当前没有证据表明应当永久禁用 IPv6。
 * - WARFRAME_PROXY_URL 有值：使用 ProxyAgent（可选备用，正常情况不需要）。
 *
 * 只注入到 Warframe 数据源（official / warframestat 共用）；NapCat（127.0.0.1:3000）永远直连，
 * 绝不使用这里的 dispatcher。
 *
 * 绝不要求用户设置全局 HTTP_PROXY / HTTPS_PROXY / NODE_USE_ENV_PROXY。
 */

import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { describeError, type Logger } from '../logger.js';
import { redactUrl } from '../redact.js';

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

/**
 * 直连 Agent 的选项（导出便于单测断言）。
 * - autoSelectFamily: 自动在多个地址族之间选择（IPv4/IPv6）
 * - autoSelectFamilyAttemptTimeout: 单个地址族尝试 250ms 后切换下一个
 * 注意：这里**没有** family 限制（不强制 IPv4）。
 */
export const DIRECT_DISPATCHER_OPTIONS = {
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250,
} as const;

/** 创建 Warframe 直连 Agent（进程内复用一个即可，不要每次请求新建）。 */
export function createDirectDispatcher(): Agent {
  return new Agent({ ...DIRECT_DISPATCHER_OPTIONS });
}

export function isHttpProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 创建代理 dispatcher。
 * @returns 未配置代理时返回 null
 * @throws ProxyConfigError 代理地址非法
 */
export function createProxyDispatcher(proxyUrl: string | null): ProxyAgent | null {
  if (proxyUrl === null || proxyUrl.trim() === '') return null;

  const trimmed = proxyUrl.trim();
  if (!isHttpProxyUrl(trimmed)) {
    throw new ProxyConfigError(
      `WARFRAME_PROXY_URL 必须是 http:// 或 https:// 开头的合法地址（当前值已隐藏，协议不受支持）`,
    );
  }

  return new ProxyAgent(trimmed);
}

/**
 * Warframe 请求专用 dispatcher：**永远返回一个**（代理或直连 Agent），供 official / warframestat 共用。
 * 应在进程启动时创建一次并复用；进程退出时可调用 closeDispatcher 优雅关闭。
 */
export function createWarframeDispatcher(proxyUrl: string | null): Dispatcher {
  return createProxyDispatcher(proxyUrl) ?? createDirectDispatcher();
}

/** 该 dispatcher 是否来自 WARFRAME_PROXY_URL 配置。 */
export function isProxyDispatcher(dispatcher: Dispatcher): boolean {
  return dispatcher instanceof ProxyAgent;
}

/** 日志用：dispatcher 类型（不含任何凭据）。 */
export function describeDispatcherKind(dispatcher: Dispatcher): string {
  if (isProxyDispatcher(dispatcher)) return 'ProxyAgent(proxy)';
  return (
    `DirectAgent(autoSelectFamily=${String(DIRECT_DISPATCHER_OPTIONS.autoSelectFamily)},` +
    `autoSelectFamilyAttemptTimeout=${DIRECT_DISPATCHER_OPTIONS.autoSelectFamilyAttemptTimeout})`
  );
}

/** 优雅关闭 dispatcher（失败只记 debug，不影响退出流程）。 */
export async function closeDispatcher(dispatcher: Dispatcher | undefined, logger?: Logger): Promise<void> {
  if (dispatcher === undefined) return;
  try {
    await dispatcher.close();
  } catch (error) {
    logger?.debug(`关闭 Warframe dispatcher 失败（忽略）: ${describeError(error)}`);
  }
}

/** 日志用：脱敏后的代理地址。 */
export function describeProxy(proxyUrl: string | null): string {
  return proxyUrl === null || proxyUrl.trim() === '' ? '(未启用)' : redactUrl(proxyUrl);
}
