/**
 * WarframeStat.us 备用数据源（保留原有能力）。
 *
 * GET https://api.warframestat.us/pc/fissures?language=en
 *   -> zod 校验 + 归一化（missionTypeKey ?? missionKey ?? missionType）
 *
 * 该站点在部分网络下会被 Cloudflare 拦截（HTTP 403），属于备用源；
 * 默认数据源是 official WorldState。
 */

import { describeError, type Logger } from '../logger.js';
import { DEFAULT_WARFRAMESTAT_API_URL } from './defaults.js';
import { httpGetText, parseJsonBody, type FetchLike } from './http.js';
import { ProviderError, type FissureFetchResult, type FissureProvider } from './provider.js';
import { parseFissuresResponse } from './schema.js';

export { DEFAULT_WARFRAMESTAT_API_URL };

export interface WarframeStatProviderOptions {
  url?: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  /** 仅在配置了 WARFRAME_PROXY_URL 时传入 */
  dispatcher?: unknown;
  logger?: Logger;
}

export class WarframeStatProvider implements FissureProvider {
  readonly name = 'warframestat';
  readonly url: string;

  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly dispatcher: unknown;
  private readonly logger: Logger | undefined;

  constructor(options: WarframeStatProviderOptions) {
    this.url = options.url ?? DEFAULT_WARFRAMESTAT_API_URL;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl;
    this.dispatcher = options.dispatcher;
    this.logger = options.logger;
  }

  async fetchFissures(): Promise<FissureFetchResult> {
    let body: string;
    try {
      body = await httpGetText({
        url: this.url,
        timeoutMs: this.timeoutMs,
        label: 'WarframeStat.us',
        fetchImpl: this.fetchImpl,
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      throw new ProviderError('warframestat', 'request', `WarframeStat.us 获取失败: ${describeError(error)}`, {
        cause: error,
      });
    }

    let payload: unknown;
    try {
      payload = parseJsonBody(body, { url: this.url, label: 'WarframeStat.us' });
    } catch (error) {
      throw new ProviderError('warframestat', 'parse', `WarframeStat.us 响应解析失败: ${describeError(error)}`, {
        cause: error,
      });
    }

    try {
      const result = parseFissuresResponse(payload);
      if (result.skipped.length > 0) {
        this.logger?.warn(
          `WarframeStat.us 有 ${result.skipped.length} 条裂缝记录无法解析，已跳过`,
          result.skipped.slice(0, 3),
        );
      }
      return {
        fissures: result.fissures,
        provider: this.name,
        url: this.url,
        skipped: result.skipped.length,
      };
    } catch (error) {
      throw new ProviderError('warframestat', 'parse', `WarframeStat.us 响应解析失败: ${describeError(error)}`, {
        cause: error,
      });
    }
  }
}
