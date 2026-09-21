/**
 * 配置加载：全部来自 .env（或进程环境变量）。
 * 不硬编码 token、QQ 号与代理密码。
 *
 * 环境变量优先级：进程已有的环境变量 > .env 文件（Node 的 loadEnvFile 语义）。
 *
 * 数据源相关：
 *   WARFRAME_SOURCE=official|auto|warframestat   （默认 official，即 DE 官方 WorldState）
 *   WARFRAME_WORLDSTATE_URL                      （official 地址）
 *   WARFRAMESTAT_API_URL                         （备用源地址）
 *   WARFRAME_PROXY_URL                           （默认空 = 不使用代理，只作用于 Warframe 请求）
 *   WARFRAME_API_URL                             （已废弃，作为 WARFRAMESTAT_API_URL 的兼容别名）
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LogLevel } from './logger.js';
import { maskSecret, redactUrl } from './redact.js';
import { DEFAULT_WARFRAMESTAT_API_URL, DEFAULT_WORLDSTATE_URL } from './warframe/defaults.js';
import { isHttpProxyUrl } from './warframe/proxy.js';
import type { FissureSource } from './warframe/provider.js';

export const DEFAULT_WARFRAME_SOURCE: FissureSource = 'official';
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 21_600_000; // 6 小时
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_NAPCAT_BASE_URL = 'http://127.0.0.1:3000';
export const DEFAULT_NAPCAT_TIMEOUT_MS = 15_000;
export const DEFAULT_STATE_FILE = path.join('data', 'state.json');
export const DEFAULT_LOCK_FILE_NAME = 'monitor.lock';
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export const MIN_POLL_INTERVAL_MS = 5_000;
export const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MIN_HEARTBEAT_INTERVAL_MS = 60_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

const QQ_PATTERN = /^\d{5,12}$/;
const FISSURE_SOURCES: readonly FissureSource[] = ['official', 'auto', 'warframestat'];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  /** 数据源：official（默认）/ auto / warframestat */
  warframeSource: FissureSource;
  /** official WorldState 地址 */
  worldStateUrl: string;
  /** WarframeStat.us 备用地址 */
  warframestatApiUrl: string;
  /** 可选代理（仅 Warframe 请求使用）；null = 未启用 */
  warframeProxyUrl: string | null;
  pollIntervalMs: number;
  /** 心跳日志间隔（毫秒），默认 6 小时；只写日志，绝不发 QQ */
  heartbeatIntervalMs: number;
  httpTimeoutMs: number;
  napcatBaseUrl: string;
  napcatToken: string | null;
  napcatTimeoutMs: number;
  /** 目标 QQ 号；未配置时为 null（`npm run check` 允许为空） */
  targetQq: string | null;
  dryRun: boolean;
  stateFile: string;
  /** 单实例锁文件（与 state.json 同目录） */
  lockFile: string;
  logLevel: LogLevel;
  /** 配置层面的提示（例如使用了已废弃变量），由调用方写日志 */
  warnings: string[];
}

const appConfigSchema = z.object({
  warframeSource: z.enum(['official', 'auto', 'warframestat']),
  worldStateUrl: z.string().min(1),
  warframestatApiUrl: z.string().min(1),
  warframeProxyUrl: z.string().min(1).nullable(),
  pollIntervalMs: z.number().int().min(MIN_POLL_INTERVAL_MS).max(MAX_POLL_INTERVAL_MS),
  heartbeatIntervalMs: z.number().int().min(MIN_HEARTBEAT_INTERVAL_MS).max(MAX_HEARTBEAT_INTERVAL_MS),
  httpTimeoutMs: z.number().int().min(1_000),
  napcatBaseUrl: z.string().min(1),
  napcatToken: z.string().min(1).nullable(),
  napcatTimeoutMs: z.number().int().min(1_000),
  targetQq: z.string().regex(QQ_PATTERN).nullable(),
  dryRun: z.boolean(),
  stateFile: z.string().min(1),
  lockFile: z.string().min(1),
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

function readFissureSource(env: NodeJS.ProcessEnv): FissureSource {
  const raw = readRaw(env, 'WARFRAME_SOURCE');
  if (raw === undefined) return DEFAULT_WARFRAME_SOURCE;
  const normalized = raw.toLowerCase();
  if (!FISSURE_SOURCES.includes(normalized as FissureSource)) {
    throw new ConfigError(
      `WARFRAME_SOURCE 只能是 ${FISSURE_SOURCES.join(' / ')}，当前值: "${raw}"（默认 official，即 DE 官方 WorldState）`,
    );
  }
  return normalized as FissureSource;
}

/**
 * 解析 WarframeStat 备用源地址，并处理已废弃的 WARFRAME_API_URL。
 * 绝不出现「两个变量含义重叠却静默互相覆盖」：同时设置时以新变量为准并给出警告。
 */
function resolveWarframestatUrl(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): string {
  const legacy = readRaw(env, 'WARFRAME_API_URL');
  const current = readRaw(env, 'WARFRAMESTAT_API_URL');

  if (legacy !== undefined && current === undefined) {
    warnings.push(
      `WARFRAME_API_URL 已废弃，请改用 WARFRAMESTAT_API_URL；本次仍作为备用源地址生效（${redactUrl(legacy)}）`,
    );
    return legacy;
  }
  if (legacy !== undefined && current !== undefined) {
    warnings.push('WARFRAME_API_URL 已废弃且被忽略：已设置 WARFRAMESTAT_API_URL，以后者为准');
  }
  return current ?? DEFAULT_WARFRAMESTAT_API_URL;
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

  const warnings: string[] = [];

  const targetQqRaw = readRaw(env, 'TARGET_QQ') ?? null;
  if (targetQqRaw !== null && !QQ_PATTERN.test(targetQqRaw)) {
    throw new ConfigError(`TARGET_QQ 必须是 5~12 位纯数字（当前值格式不正确，已隐藏）`);
  }
  if (targetQqRaw === null && requireTargetQq) {
    throw new ConfigError(
      '缺少 TARGET_QQ：请在项目根目录的 .env 中填写接收通知的 QQ 号，例如 TARGET_QQ=10001（可参考 .env.example）',
    );
  }

  const proxyRaw = readRaw(env, 'WARFRAME_PROXY_URL') ?? null;
  if (proxyRaw !== null && !isHttpProxyUrl(proxyRaw)) {
    throw new ConfigError(
      'WARFRAME_PROXY_URL 必须是 http:// 或 https:// 开头的合法代理地址（当前值已隐藏）。默认留空即可，official 数据源通常无需代理。',
    );
  }

  const stateFile = path.resolve(cwd, readRaw(env, 'STATE_FILE') ?? DEFAULT_STATE_FILE);

  const candidate = {
    warframeSource: readFissureSource(env),
    worldStateUrl: readRaw(env, 'WARFRAME_WORLDSTATE_URL') ?? DEFAULT_WORLDSTATE_URL,
    warframestatApiUrl: resolveWarframestatUrl(env, warnings),
    warframeProxyUrl: proxyRaw,
    pollIntervalMs: readNumber(env, 'POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, {
      min: MIN_POLL_INTERVAL_MS,
      max: MAX_POLL_INTERVAL_MS,
    }),
    heartbeatIntervalMs: readNumber(env, 'HEARTBEAT_INTERVAL_MS', DEFAULT_HEARTBEAT_INTERVAL_MS, {
      min: MIN_HEARTBEAT_INTERVAL_MS,
      max: MAX_HEARTBEAT_INTERVAL_MS,
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
    stateFile,
    lockFile: path.join(path.dirname(stateFile), DEFAULT_LOCK_FILE_NAME),
    logLevel: readRaw(env, 'LOG_LEVEL') ?? DEFAULT_LOG_LEVEL,
  };

  const parsed = appConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`配置校验失败 -> ${details}`);
  }

  return { ...parsed.data, warnings };
}

/** 取出必定存在的 TARGET_QQ（否则抛出可读错误）。 */
export function requireTargetQq(config: AppConfig): string {
  if (config.targetQq === null) {
    throw new ConfigError('缺少 TARGET_QQ：请在 .env 中配置接收通知的 QQ 号');
  }
  return config.targetQq;
}

/** 打印用：token / QQ 号只显示是否配置，代理地址去掉凭据。 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    warframeSource: config.warframeSource,
    worldStateUrl: redactUrl(config.worldStateUrl),
    warframestatApiUrl: redactUrl(config.warframestatApiUrl),
    warframeProxyUrl: config.warframeProxyUrl === null ? '(未启用)' : redactUrl(config.warframeProxyUrl),
    pollIntervalMs: config.pollIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    httpTimeoutMs: config.httpTimeoutMs,
    napcatBaseUrl: config.napcatBaseUrl,
    napcatToken: maskSecret(config.napcatToken !== null),
    napcatTimeoutMs: config.napcatTimeoutMs,
    targetQq: maskSecret(config.targetQq !== null),
    dryRun: config.dryRun,
    stateFile: config.stateFile,
    lockFile: config.lockFile,
    logLevel: config.logLevel,
  };
}
