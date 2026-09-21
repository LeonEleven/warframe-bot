/**
 * Warframe 数据源客户端（Node 内置 fetch + 超时）。
 */

import { describeError, type Logger } from '../logger.js';
import type { Fissure } from '../types.js';
import { parseFissuresResponse } from './schema.js';

export const USER_AGENT = 'warframe-fissure-monitor/1.0 (+https://api.warframestat.us)';

export class WarframeApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WarframeApiError';
  }
}

export interface FetchFissuresOptions {
  apiUrl: string;
  /** 请求超时（毫秒） */
  timeoutMs: number;
  /** 便于测试注入；默认使用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/** 拉取当前裂缝列表；失败时抛出 WarframeApiError。 */
export async function fetchFissures(options: FetchFissuresOptions): Promise<Fissure[]> {
  const { apiUrl, timeoutMs, fetchImpl = fetch, logger } = options;

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new WarframeApiError(`请求 Warframe API 失败（${apiUrl}，超时 ${timeoutMs}ms）: ${describeError(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new WarframeApiError(`Warframe API 返回 HTTP ${response.status} ${response.statusText}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new WarframeApiError(`Warframe API 响应不是合法 JSON: ${describeError(error)}`, { cause: error });
  }

  try {
    const result = parseFissuresResponse(payload);
    if (result.skipped.length > 0) {
      logger?.warn(`Warframe API 有 ${result.skipped.length} 条裂缝记录无法解析，已跳过`, result.skipped.slice(0, 3));
    }
    return result.fissures;
  } catch (error) {
    throw new WarframeApiError(`Warframe API 响应解析失败: ${describeError(error)}`, { cause: error });
  }
}
