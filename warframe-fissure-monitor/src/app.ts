/**
 * 依赖装配（便于测试与职责分离）。
 *
 * 关键安全约束：
 * - WARFRAME_PROXY_URL 对应的 undici dispatcher **只**注入 Warframe 数据源
 * - NapCat 客户端永远拿不到 dispatcher，请求 127.0.0.1:3000 绝不经过代理
 * - 因此不需要（也不允许要求）用户设置全局 HTTP_PROXY / HTTPS_PROXY / NODE_USE_ENV_PROXY
 */

import { requireTargetQq, type AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { NapCatClient } from './notify/napcat.js';
import type { FetchLike } from './warframe/http.js';
import { OfficialWorldStateProvider } from './warframe/official-provider.js';
import { createProxyDispatcher, describeProxy } from './warframe/proxy.js';
import { createFissureProvider, type FissureProvider } from './warframe/provider.js';
import { WarframeStatProvider } from './warframe/warframestat-provider.js';

export interface BuildProviderOptions {
  config: AppConfig;
  logger: Logger;
  /** 测试注入：Warframe 侧 HTTP（默认 undici fetch） */
  warframeFetch?: FetchLike;
}

export interface FissureProviderBundle {
  provider: FissureProvider;
  /** 是否启用了 Warframe 代理 */
  proxyEnabled: boolean;
  /** 可在日志中安全打印的代理描述（已脱敏） */
  proxyDescription: string;
}

/** 只构建数据源（`npm run check` 用，不需要 TARGET_QQ）。 */
export function buildFissureProviderBundle(options: BuildProviderOptions): FissureProviderBundle {
  const { config, logger, warframeFetch } = options;

  const dispatcher = createProxyDispatcher(config.warframeProxyUrl);

  const official = new OfficialWorldStateProvider({
    url: config.worldStateUrl,
    timeoutMs: config.httpTimeoutMs,
    fetchImpl: warframeFetch,
    dispatcher: dispatcher ?? undefined,
    logger,
  });

  const warframestat = new WarframeStatProvider({
    url: config.warframestatApiUrl,
    timeoutMs: config.httpTimeoutMs,
    fetchImpl: warframeFetch,
    dispatcher: dispatcher ?? undefined,
    logger,
  });

  return {
    provider: createFissureProvider({ source: config.warframeSource, official, warframestat, logger }),
    proxyEnabled: dispatcher !== null,
    proxyDescription: describeProxy(config.warframeProxyUrl),
  };
}

export interface BuildRuntimeOptions extends BuildProviderOptions {
  /** 测试注入：NapCat 侧 HTTP（默认全局 fetch，且绝不带 dispatcher） */
  napcatFetch?: typeof fetch;
}

export interface MonitorRuntime extends FissureProviderBundle {
  napcat: NapCatClient;
  targetQq: string;
}

/** 构建完整运行时（监控进程用）。 */
export function buildRuntime(options: BuildRuntimeOptions): MonitorRuntime {
  const { config, logger, napcatFetch } = options;
  const bundle = buildFissureProviderBundle(options);

  // 注意：这里刻意不传 dispatcher —— NapCat 必须直连本机
  const napcat = new NapCatClient({
    baseUrl: config.napcatBaseUrl,
    token: config.napcatToken,
    timeoutMs: config.napcatTimeoutMs,
    fetchImpl: napcatFetch,
    logger,
  });

  return { ...bundle, napcat, targetQq: requireTargetQq(config) };
}
