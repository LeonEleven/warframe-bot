/**
 * Warframe 外部 HTTP 请求的共享实现。
 *
 * 特点：
 * - 统一 timeout（每个 attempt 独立使用 AbortSignal.timeout，单次上限约 HTTP_TIMEOUT_MS）
 * - 支持注入 undici Dispatcher：
 *     * 未配置代理 -> 专用直连 Agent（autoSelectFamily，见 proxy.ts）
 *     * 配置代理   -> ProxyAgent
 *   只给 Warframe 数据源使用；NapCat 请求绝不使用这里的 dispatcher（见 notify/napcat.ts）
 * - **有限重试**：默认最多 3 次尝试，退避 1s / 3s，只重试瞬时故障
 * - 错误信息里出现的 URL 一律脱敏
 *
 * 注意：official WorldState 的响应头是 text/html 但内容是 JSON，因此这里不做
 * content-type 校验，由各 provider 自己解析。JSON 解析失败不属于网络瞬时错误，
 * **不会**在这里重试（解析发生在 provider 层）。
 *
 * 关于耗时：单次超时 10s、重试 2 次、退避 1s + 3s，最坏约 34s，仍在 60s 轮询间隔内；
 * 而且 poller 是「上一轮完全结束后再等待」，因此不会出现轮询重叠。
 */

import { fetch as undiciFetch } from 'undici';
import { describeError, type Logger } from '../logger.js';
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
  /** 可选：读取 Retry-After 等响应头（真实 Response 天然满足） */
  readonly headers?: { get(name: string): string | null };
}

export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 重试策略
 * ------------------------------------------------------------------ */

export interface HttpRetryPolicy {
  /** 最大总尝试次数（含第一次） */
  maxAttempts: number;
  /** 每次失败后的退避时间；不足时复用最后一项 */
  backoffMs: readonly number[];
  /** Retry-After 的上限（避免上游让我们睡很久） */
  maxRetryAfterMs: number;
}

export const DEFAULT_HTTP_RETRY_POLICY: HttpRetryPolicy = {
  maxAttempts: 3,
  backoffMs: [1_000, 3_000],
  maxRetryAfterMs: 10_000,
};

/** 可以安全重试的 HTTP 状态码（GET 是幂等的）。 */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];

/** 可以安全重试的错误 code（网络/连接层瞬时错误）。 */
export const RETRYABLE_ERROR_CODES: readonly string[] = [
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
];

/** 可以安全重试的错误 name（含 AbortSignal.timeout 与 undici 的超时类错误）。 */
export const RETRYABLE_ERROR_NAMES: readonly string[] = [
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'SocketError',
];

/** DOMException 的 TIMEOUT_ERR 数值码 */
const DOM_EXCEPTION_TIMEOUT_ERR = 23;

export type SleepFunction = (milliseconds: number) => Promise<void>;

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.includes(status) || (status >= 500 && status <= 599);
}

/* ------------------------------------------------------------------ *
 * 错误诊断：递归检查 cause / errors 链上的 name 与 code
 * ------------------------------------------------------------------ */

export interface ErrorChainEntry {
  name: string;
  code: string;
  message: string;
}

export interface ErrorDiagnostic {
  chain: ErrorChainEntry[];
  /** 简短描述，如 `TypeError -> ConnectTimeoutError` */
  summary: string;
  codes: string[];
  retryable: boolean;
  /** 命中的重试依据，如 ['code=UND_ERR_CONNECT_TIMEOUT'] */
  matched: string[];
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function collectChain(error: unknown, depth: number, maxDepth: number, seen: Set<unknown>, out: ErrorChainEntry[]): void {
  if (depth > maxDepth) return;
  if (error === null || (typeof error !== 'object' && typeof error !== 'string')) return;
  if (seen.has(error)) return;
  seen.add(error);

  const record = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  out.push({
    name: asText(record.name) || (typeof error === 'string' ? 'Error' : 'UnknownError'),
    code: asText(record.code),
    message: asText(record.message) || asText(error),
  });

  if (record.cause !== undefined) collectChain(record.cause, depth + 1, maxDepth, seen, out);
  // undici 在 autoSelectFamily 多地址都失败时可能抛出 AggregateError
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) collectChain(nested, depth + 1, maxDepth, seen, out);
  }
}

/**
 * 检查错误链（含 cause 与 AggregateError.errors），判断是否属于可重试的瞬时故障。
 * 不输出任何敏感信息（只保留 name / code / message，URL 由调用方脱敏）。
 */
export function inspectErrorChain(error: unknown, maxDepth = 8): ErrorDiagnostic {
  const chain: ErrorChainEntry[] = [];
  collectChain(error, 0, maxDepth, new Set<unknown>(), chain);

  const matched: string[] = [];
  for (const entry of chain) {
    if (entry.code !== '' && RETRYABLE_ERROR_CODES.includes(entry.code)) matched.push(`code=${entry.code}`);
    if (entry.name !== '' && RETRYABLE_ERROR_NAMES.includes(entry.name)) matched.push(`name=${entry.name}`);
    if (entry.code === String(DOM_EXCEPTION_TIMEOUT_ERR)) matched.push(`code=${DOM_EXCEPTION_TIMEOUT_ERR}(TIMEOUT_ERR)`);
  }

  const summary = chain.map((entry) => entry.name).filter((name, index, all) => all.indexOf(name) === index).join(' -> ');
  const codes = chain.map((entry) => entry.code).filter((code) => code !== '');

  return { chain, summary: summary === '' ? 'UnknownError' : summary, codes, retryable: matched.length > 0, matched };
}

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

export class HttpRequestError extends Error {
  readonly url: string;
  readonly status: number | null;
  /** 是否属于「可重试的瞬时故障」（重试耗尽后仍为 true） */
  readonly retryable: boolean;
  readonly diagnostic: ErrorDiagnostic;
  readonly attempts: number;

  constructor(
    message: string,
    options: {
      url: string;
      status?: number | null;
      cause?: unknown;
      retryable?: boolean;
      diagnostic?: ErrorDiagnostic;
      attempts?: number;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpRequestError';
    this.url = redactUrl(options.url);
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.diagnostic = options.diagnostic ?? inspectErrorChain(options.cause);
    this.attempts = options.attempts ?? 1;
  }
}

/* ------------------------------------------------------------------ *
 * 单次尝试
 * ------------------------------------------------------------------ */

const defaultHeaders: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'user-agent': 'warframe-fissure-monitor/1.0',
  'cache-control': 'no-cache',
};

interface AttemptFailure {
  ok: false;
  kind: 'network' | 'http' | 'body' | 'empty' | 'too-large';
  status: number | null;
  cause: unknown;
  diagnostic: ErrorDiagnostic;
  retryAfterMs: number | null;
  message: string;
}

type AttemptResult = { ok: true; body: string } | AttemptFailure;

/** 解析 Retry-After（秒数或 HTTP-date），返回毫秒；无法解析返回 null。 */
export function parseRetryAfterMs(headers: ResponseLike['headers'], nowMs: number): number | null {
  if (headers === undefined) return null;

  const raw = headers.get('retry-after') ?? headers.get('Retry-After');
  if (raw === null || raw === undefined || raw.trim() === '') return null;

  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }

  return null;
}

async function performAttempt(options: {
  url: string;
  timeoutMs: number;
  label: string;
  headers?: Record<string, string>;
  dispatcher?: unknown;
  fetchImpl: FetchLike;
  maxBytes: number;
  nowMs: number;
}): Promise<AttemptResult> {
  const { url, timeoutMs, label, headers, dispatcher, fetchImpl, maxBytes, nowMs } = options;

  let response: ResponseLike;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { ...defaultHeaders, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });
  } catch (error) {
    const diagnostic = inspectErrorChain(error);
    return {
      ok: false,
      kind: 'network',
      status: null,
      cause: error,
      diagnostic,
      retryAfterMs: null,
      message: `${label} 请求异常（${redactUrl(url)}，单次超时 ${timeoutMs}ms）: ${describeError(error)}`,
    };
  }

  if (!response.ok) {
    const diagnostic = inspectErrorChain(null);
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      cause: undefined,
      diagnostic,
      retryAfterMs: parseRetryAfterMs(response.headers, nowMs),
      message: `${label} 返回 HTTP ${response.status} ${response.statusText}（${redactUrl(url)}）`,
    };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    const diagnostic = inspectErrorChain(error);
    return {
      ok: false,
      kind: 'body',
      status: response.status,
      cause: error,
      diagnostic,
      retryAfterMs: null,
      message: `${label} 响应读取失败: ${describeError(error)}`,
    };
  }

  if (body.length === 0) {
    return {
      ok: false,
      kind: 'empty',
      status: response.status,
      cause: undefined,
      diagnostic: inspectErrorChain(null),
      retryAfterMs: null,
      message: `${label} 返回了空响应（${redactUrl(url)}）`,
    };
  }
  if (body.length > maxBytes) {
    return {
      ok: false,
      kind: 'too-large',
      status: response.status,
      cause: undefined,
      diagnostic: inspectErrorChain(null),
      retryAfterMs: null,
      message: `${label} 响应过大（${body.length} > ${maxBytes} 字节）`,
    };
  }

  return { ok: true, body };
}

/** 该次失败是否值得重试（只针对瞬时故障；解析/业务错误不在此层）。 */
function isRetryableFailure(failure: AttemptFailure): boolean {
  switch (failure.kind) {
    case 'network':
    case 'body':
      return failure.diagnostic.retryable;
    case 'http':
      return failure.status !== null && isRetryableHttpStatus(failure.status);
    case 'empty':
      // 200 却拿到空 body：CDN 抖动的典型症状，GET 幂等，允许重试
      return true;
    case 'too-large':
      // 响应体积异常属于确定性保护，重试没有意义
      return false;
    default:
      return false;
  }
}

function describeFailure(failure: AttemptFailure): string {
  const parts = [`error=${failure.diagnostic.summary}`];
  if (failure.diagnostic.codes.length > 0) {
    parts.push(`code=${failure.diagnostic.codes.join('/')}`);
  }
  if (failure.diagnostic.matched.length > 0) {
    parts.push(`retryableBy=${failure.diagnostic.matched.join(',')}`);
  }
  return parts.join(' ');
}

function backoffFor(policy: HttpRetryPolicy, attempt: number): number {
  const index = Math.min(attempt - 1, policy.backoffMs.length - 1);
  return policy.backoffMs[index] ?? 0;
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

export interface HttpGetTextOptions {
  /** 请求地址（真实地址） */
  url: string;
  /** 单次尝试的超时（毫秒） */
  timeoutMs: number;
  /** 日志与错误信息里使用的来源名称，例如 "official WorldState" */
  label: string;
  headers?: Record<string, string>;
  /** Warframe 专用 dispatcher（直连 Agent 或 ProxyAgent） */
  dispatcher?: unknown;
  /** 便于测试注入；默认使用 undici 的 fetch */
  fetchImpl?: FetchLike;
  maxBytes?: number;
  /** 便于测试注入；默认使用 timers/promises 的 setTimeout */
  sleep?: SleepFunction;
  /** 便于测试注入；默认 Date.now */
  now?: () => number;
  /** 重试策略覆盖（默认 3 次尝试 / 1s、3s 退避） */
  retry?: Partial<HttpRetryPolicy>;
  /** 重试日志（中间失败 WARN、重试后成功 INFO） */
  logger?: Logger;
}

/**
 * GET 请求并返回响应文本。
 *
 * - 瞬时故障（网络异常 / 408·425·429·5xx / 空响应）最多尝试 maxAttempts 次
 * - 4xx 客户端错误、响应过大等确定性失败立即抛出，不做重试
 * - 只抛出一个最终错误（HttpRequestError），其中包含 attempt、错误链 name/code
 */
export async function httpGetText(options: HttpGetTextOptions): Promise<string> {
  const {
    url,
    timeoutMs,
    label,
    headers,
    dispatcher,
    fetchImpl = undiciFetch as unknown as FetchLike,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    sleep = defaultSleep,
    now = Date.now,
    logger,
  } = options;

  const policy: HttpRetryPolicy = { ...DEFAULT_HTTP_RETRY_POLICY, ...options.retry };
  let lastFailure: AttemptFailure | null = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const result = await performAttempt({
      url,
      timeoutMs,
      label,
      headers,
      dispatcher,
      fetchImpl,
      maxBytes,
      nowMs: now(),
    });

    if (result.ok) {
      if (attempt > 1) {
        logger?.info(`${label} 在第 ${attempt}/${policy.maxAttempts} 次尝试成功`);
      }
      return result.body;
    }

    lastFailure = result;
    const retryable = isRetryableFailure(result);
    const isLastAttempt = attempt >= policy.maxAttempts;

    if (!retryable || isLastAttempt) {
      // 最终失败只抛一次；调用方（provider -> poller）会以 ERROR 记录，
      // 且绝不会因此给 QQ 发送任何消息。
      throw new HttpRequestError(
        `${result.message}：attempt=${attempt}/${policy.maxAttempts} ${describeFailure(result)}`,
        {
          url,
          status: result.status,
          cause: result.cause,
          retryable,
          diagnostic: result.diagnostic,
          attempts: attempt,
        },
      );
    }

    // 中间失败用 WARN，避免把可自行恢复的抖动记成严重故障
    const retryAfterMs = result.retryAfterMs;
    const delayMs =
      retryAfterMs !== null && retryAfterMs > 0
        ? Math.min(retryAfterMs, policy.maxRetryAfterMs)
        : backoffFor(policy, attempt);

    logger?.warn(
      `Warframe 请求失败，准备重试 source=${label} attempt=${attempt}/${policy.maxAttempts} ` +
        `retryInMs=${delayMs} reason=${result.message} ${describeFailure(result)}`,
    );

    await sleep(delayMs);
  }

  // 理论上不可达（循环内必然 return 或 throw），保险起见仍给出明确错误
  throw new HttpRequestError(`${label} 请求失败：attempt=${policy.maxAttempts}/${policy.maxAttempts}`, {
    url,
    status: lastFailure?.status ?? null,
    cause: lastFailure?.cause,
    retryable: true,
    attempts: policy.maxAttempts,
  });
}

async function defaultSleep(milliseconds: number): Promise<void> {
  const { setTimeout: delay } = await import('node:timers/promises');
  await delay(milliseconds);
}

/** 解析 JSON 文本，失败时抛出带来源信息的 HttpRequestError（不重试）。 */
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
