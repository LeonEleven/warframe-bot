/**
 * 测试公共工具。
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger, LogLevel } from '../src/logger.js';
import type { Fissure } from '../src/types.js';

/** 测试中统一使用的“当前时间” */
export const FIXED_NOW = new Date('2026-01-01T12:00:00.000Z');
/** 未来 30 分钟（相对 FIXED_NOW） */
export const FUTURE_EXPIRY = '2026-01-01T12:30:00.000Z';
/** 过去 30 分钟（相对 FIXED_NOW） */
export const PAST_EXPIRY = '2026-01-01T11:30:00.000Z';

/** 默认构造一条“满足全部条件”的裂缝，用 overrides 改成各种反例。 */
export function makeFissure(overrides: Partial<Fissure> = {}): Fissure {
  return {
    id: 'fissure-default',
    activation: '2026-01-01T11:45:00.000Z',
    expiry: FUTURE_EXPIRY,
    node: 'Ani (Void)',
    nodeKey: 'Ani (Void)',
    missionType: 'Survival',
    missionTypeKey: 'Survival',
    enemy: 'Corrupted',
    tier: 'Axi',
    tierNum: 4,
    isHard: true,
    isStorm: false,
    ...overrides,
  };
}

export interface MemoryLogRecord {
  level: LogLevel;
  message: string;
  meta: unknown;
}

export interface MemoryLogger extends Logger {
  records: MemoryLogRecord[];
  /** 所有日志拼成的文本，便于断言“没有报错” */
  text(): string;
}

/** 记录日志但不打印，避免测试输出被污染。 */
export function createMemoryLogger(): MemoryLogger {
  const records: MemoryLogRecord[] = [];
  const push =
    (level: LogLevel) =>
    (message: string, meta?: unknown): void => {
      records.push({ level, message, meta });
    };

  return {
    level: 'debug',
    records,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    text: () => records.map((record) => `${record.level}: ${record.message}`).join('\n'),
  };
}

async function createTempDir(): Promise<string> {
  const candidates = [tmpdir(), path.join(process.cwd(), '.tmp')];
  let lastError: unknown;

  for (const base of candidates) {
    try {
      await mkdir(base, { recursive: true });
      return await mkdtemp(path.join(base, 'wfm-test-'));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** 在临时目录中执行测试，结束后清理。 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await createTempDir();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

/** 构造一个可断言的 fetch 替身。 */
export function stubFetch(handler: FetchHandler): typeof fetch {
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  };
  return impl as unknown as typeof fetch;
}

/** 构造 JSON 响应。 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 记录 fetch 调用的简易工具。 */
export interface RecordedCall {
  url: string;
  init?: RequestInit;
  json(): unknown;
}

export function recordingFetch(response: Response): { calls: RecordedCall[]; fetch: typeof fetch } {
  const calls: RecordedCall[] = [];
  const impl = stubFetch(async (url, init) => {
    calls.push({
      url,
      init,
      json: () => JSON.parse(String(init?.body ?? 'null')) as unknown,
    });
    return response;
  });
  return { calls, fetch: impl };
}
