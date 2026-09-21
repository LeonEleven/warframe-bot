/**
 * 配置加载：全部来自 .env（或进程环境变量）。
 * 不硬编码 token 与 QQ 号。
 *
 * 环境变量优先级：进程已有的环境变量 > .env 文件（Node 的 --env-file / loadEnvFile 语义）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LogLevel } from './logger.js';

export const DEFAULT_WARFRAME_API_URL = 'https://api.warframestat.us/pc/fissures';
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_NAPCAT_BASE_URL = 'http://127.0.0.1:3000';
export const DEFAULT_NAPCAT_TIMEOUT_MS = 15_000;
export const DEFAULT_STATE_FILE = path.join('data', 'state.json');
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export const MIN_POLL_INTERVAL_MS = 5_000;
export const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const QQ_PATTERN = /^\d{5,12}$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  warframeApiUrl: string;
  pollIntervalMs: number;
  httpTimeoutMs: number;
  napcatBaseUrl: string;
  napcatToken: string | null;
  napcatTimeoutMs: number;
  /** 目标 QQ 号；未配置时为 null（`npm run check` 允许为空） */
  targetQq: string | null;
  dryRun: boolean;
  stateFile: string;
  logLevel: LogLevel;
}

const appConfigSchema = z.object({
  warframeApiUrl: z.string().min(1),
  pollIntervalMs: z.number().int().min(MIN_POLL_INTERVAL_MS).max(MAX_POLL_INTERVAL_MS),
  httpTimeoutMs: z.number().int().min(1_000),
  napcatBaseUrl: z.string().min(1),
  napcatToken: z.string().min(1).nullable(),
  napcatTimeoutMs: z.number().int().min(1_000),
  targetQq: z.string().regex(QQ_PATTERN).nullable(),
  dryRun: z.boolean(),
  stateFile: z.string().min(1),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
});

export interface LoadConfigOptions {
  /** 是否强制要求 TARGET_QQ（默认 true；`npm run check` 传 false） */
  requireTargetQq?: boolean;
  /** 环境变量来源，默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 相对路径基准目录，默认 process.cwd() */
  cwd?: string;
  /** 是否尝试加载 .env，默认 true */
  loadDotEnv?: boolean;
  /** .env 文件名，默认 ".env" */
  envFileName?: string;
}

/** 读取 .env 到 process.env（不存在则静默跳过）。返回实际读取的文件路径。 */
export function loadDotEnvFile(fileName = '.env', cwd = process.cwd()): string | null {
  const filePath = path.resolve(cwd, fileName);
  if (!existsSync(filePath)) return null;
  process.loadEnvFile(filePath);
  return filePath;
}

function readRaw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${name} 必须是整数，当前值: "${raw}"`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new ConfigError(`${name} 必须在 ${bounds.min} ~ ${bounds.max} 之间，当前值: ${value}`);
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  switch (raw.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'y':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'n':
    case 'off':
      return false;
    default:
      throw new ConfigError(`${name} 必须是 true/false（也接受 1/0、yes/no、on/off），当前值: "${raw}"`);
  }
}

/**
 * 加载并校验配置。
 * @throws ConfigError 配置缺失或格式错误
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const {
    requireTargetQq = true,
    env = process.env,
    cwd = process.cwd(),
    loadDotEnv = true,
    envFileName = '.env',
  } = options;

  if (loadDotEnv) loadDotEnvFile(envFileName, cwd);

  const targetQqRaw = readRaw(env, 'TARGET_QQ') ?? null;
  if (targetQqRaw !== null && !QQ_PATTERN.test(targetQqRaw)) {
    throw new ConfigError(`TARGET_QQ 必须是 5~12 位纯数字，当前值: "${targetQqRaw}"`);
  }
  if (targetQqRaw === null && requireTargetQq) {
    throw new ConfigError(
      '缺少 TARGET_QQ：请在项目根目录的 .env 中填写接收通知的 QQ 号，例如 TARGET_QQ=10001（可参考 .env.example）',
    );
  }

  const candidate = {
    warframeApiUrl: readRaw(env, 'WARFRAME_API_URL') ?? DEFAULT_WARFRAME_API_URL,
    pollIntervalMs: readNumber(env, 'POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, {
      min: MIN_POLL_INTERVAL_MS,
      max: MAX_POLL_INTERVAL_MS,
    }),
    httpTimeoutMs: readNumber(env, 'HTTP_TIMEOUT_MS', DEFAULT_HTTP_TIMEOUT_MS, {
      min: 1_000,
      max: 10 * 60 * 1000,
    }),
    napcatBaseUrl: readRaw(env, 'NAPCAT_BASE_URL') ?? DEFAULT_NAPCAT_BASE_URL,
    napcatToken: readRaw(env, 'NAPCAT_TOKEN') ?? null,
    napcatTimeoutMs: readNumber(env, 'NAPCAT_TIMEOUT_MS', DEFAULT_NAPCAT_TIMEOUT_MS, {
      min: 1_000,
      max: 10 * 60 * 1000,
    }),
    targetQq: targetQqRaw,
    dryRun: readBoolean(env, 'DRY_RUN', false),
    stateFile: path.resolve(cwd, readRaw(env, 'STATE_FILE') ?? DEFAULT_STATE_FILE),
    logLevel: readRaw(env, 'LOG_LEVEL') ?? DEFAULT_LOG_LEVEL,
  };

  const parsed = appConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`配置校验失败 -> ${details}`);
  }

  return parsed.data;
}

/** 取出必定存在的 TARGET_QQ（否则抛出可读错误）。 */
export function requireTargetQq(config: AppConfig): string {
  if (config.targetQq === null) {
    throw new ConfigError('缺少 TARGET_QQ：请在 .env 中配置接收通知的 QQ 号');
  }
  return config.targetQq;
}

/** 打印用：隐藏 token，仅显示是否设置。 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    warframeApiUrl: config.warframeApiUrl,
    pollIntervalMs: config.pollIntervalMs,
    httpTimeoutMs: config.httpTimeoutMs,
    napcatBaseUrl: config.napcatBaseUrl,
    napcatToken: config.napcatToken === null ? '(未设置)' : '(已设置)',
    napcatTimeoutMs: config.napcatTimeoutMs,
    targetQq: config.targetQq ?? '(未设置)',
    dryRun: config.dryRun,
    stateFile: config.stateFile,
    logLevel: config.logLevel,
  };
}
