/**
 * 可选代理支持。
 *
 * 只有显式配置 WARFRAME_PROXY_URL 时才创建 dispatcher，并且**只**注入到
 * Warframe 数据源（official / warframestat）。
 *
 * 绝不要求用户设置全局 HTTP_PROXY / HTTPS_PROXY / NODE_USE_ENV_PROXY，
 * 也绝不让 NapCat（http://127.0.0.1:3000）走代理。
 */

import { ProxyAgent } from 'undici';
import { redactUrl } from '../redact.js';

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
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

/** 日志用：脱敏后的代理地址。 */
export function describeProxy(proxyUrl: string | null): string {
  return proxyUrl === null || proxyUrl.trim() === '' ? '(未启用)' : redactUrl(proxyUrl);
}
