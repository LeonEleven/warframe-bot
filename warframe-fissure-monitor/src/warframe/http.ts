/**
 * Warframe 外部 HTTP 请求的共享实现。
 *
 * 特点：
 * - 统一 timeout（AbortSignal.timeout）
 * - 支持可选的 undici Dispatcher（仅当配置了 WARFRAME_PROXY_URL 时才会传入）
 * - 只给 Warframe 数据源使用；NapCat 请求绝不使用这里的 dispatcher（见 notify/napcat.ts）
 * - 错误信息里出现的 URL 一律脱敏
 *
 * 注意：official WorldState 的响应头是 text/html 但内容是 JSON，因此这里不做
 * content-type 校验，由各 provider 自己解析。
 */

import { fetch as undiciFetch } from 'undici';
import { describeError } from '../logger.js';
import { redactUrl } from '../redact.js';

/** 最小化的 fetch 形状，便于测试注入（默认实现来自 undici）。 */
export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<ResponseLike>;

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 仅 Warframe 请求会传；NapCat 不使用 */
  dispatcher?: unknown;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class HttpRequestError extends Error {
  readonly url: string;
  readonly status: number | null;

  constructor(message: string, options: { url: string; status?: number | null; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpRequestError';
    this.url = redactUrl(options.url);
    this.status = options.status ?? null;
  }
}

export interface HttpGetTextOptions {
  /** 请求地址（真实地址） */
  url: string;
  /** 超时（毫秒） */
  timeoutMs: number;
  /** 日志与错误信息里使用的来源名称，例如 "official WorldState" */
  label: string;
  headers?: Record<string, string>;
  /** 可选的 undici Dispatcher（代理） */
  dispatcher?: unknown;
  /** 便于测试注入；默认使用 undici 的 fetch */
  fetchImpl?: FetchLike;
  maxBytes?: number;
}

const defaultHeaders: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'user-agent': 'warframe-fissure-monitor/1.0',
  'cache-control': 'no-cache',
};

/** GET 请求并返回响应文本；任何失败都抛出 HttpRequestError。 */
export async function httpGetText(options: HttpGetTextOptions): Promise<string> {
  const {
    url,
    timeoutMs,
    label,
    headers,
    dispatcher,
    fetchImpl = undiciFetch as unknown as FetchLike,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = options;

  let response: ResponseLike;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { ...defaultHeaders, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });
  } catch (error) {
    throw new HttpRequestError(`${label} 请求失败（${redactUrl(url)}，超时 ${timeoutMs}ms）: ${describeError(error)}`, {
      url,
      cause: error,
    });
  }

  if (!response.ok) {
    throw new HttpRequestError(`${label} 返回 HTTP ${response.status} ${response.statusText}（${redactUrl(url)}）`, {
      url,
      status: response.status,
    });
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw new HttpRequestError(`${label} 响应读取失败: ${describeError(error)}`, { url, cause: error });
  }

  if (body.length === 0) {
    throw new HttpRequestError(`${label} 返回了空响应（${redactUrl(url)}）`, { url, status: response.status });
  }
  if (body.length > maxBytes) {
    throw new HttpRequestError(`${label} 响应过大（${body.length} > ${maxBytes} 字节）`, {
      url,
      status: response.status,
    });
  }

  return body;
}

/** 解析 JSON 文本，失败时抛出带来源信息的 HttpRequestError。 */
export function parseJsonBody(body: string, options: { url: string; label: string }): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new HttpRequestError(`${options.label} 响应不是合法 JSON: ${describeError(error)}`, {
      url: options.url,
      cause: error,
    });
  }
}
