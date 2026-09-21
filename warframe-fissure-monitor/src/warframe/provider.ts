/**
 * 裂缝数据源抽象。
 *
 * 上层（poller / filter / message / check）只认识 Fissure domain model，
 * 不依赖任何第三方 parser 对象。
 *
 * 数据源选择：
 *   official      -> 只使用 Digital Extremes 官方 WorldState（默认）
 *   warframestat  -> 只使用 WarframeStat.us
 *   auto          -> 先 official，只有请求/解析失败才回退 warframestat
 *
 * provider 出错只记录日志；绝不因为 provider 出错给 QQ 发任何故障通知。
 */

import { describeError, type Logger } from '../logger.js';
import { redactUrl } from '../redact.js';
import type { Fissure } from '../types.js';

export type FissureSource = 'official' | 'auto' | 'warframestat';

export interface FissureFetchResult {
  fissures: Fissure[];
  /** 实际生效的 provider 名 */
  provider: string;
  /** 实际请求的地址（已脱敏） */
  url: string;
  /** 被跳过的脏记录数量 */
  skipped: number;
}

export interface FissureProvider {
  readonly name: string;
  /** 主要请求地址（已脱敏，可直接打印） */
  readonly url: string;
  fetchFissures(): Promise<FissureFetchResult>;
}

export type ProviderErrorKind = 'request' | 'parse' | 'empty' | 'unavailable';

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;

  constructor(provider: string, kind: ProviderErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
  }
}

/**
 * auto 模式：先 primary（official），失败才用 fallback（warframestat）。
 * 只做日志提示与错误聚合，不做任何 QQ 通知。
 */
export class FallbackFissureProvider implements FissureProvider {
  readonly name = 'auto';
  readonly url: string;
  readonly fallbackUrl: string;

  private readonly primary: FissureProvider;
  private readonly fallback: FissureProvider;
  private readonly logger: Logger;

  constructor(primary: FissureProvider, fallback: FissureProvider, logger: Logger) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
    this.url = primary.url;
    this.fallbackUrl = fallback.url;
  }

  async fetchFissures(): Promise<FissureFetchResult> {
    try {
      return await this.primary.fetchFissures();
    } catch (primaryError) {
      const primaryReason = describeError(primaryError);
      this.logger.warn(
        `${this.primary.name} 获取失败 -> fallback 到 ${this.fallback.name}（原因：${primaryReason}）`,
      );

      try {
        return await this.fallback.fetchFissures();
      } catch (fallbackError) {
        throw new ProviderError(
          'auto',
          'unavailable',
          `${this.primary.name} 与 ${this.fallback.name} 均获取失败：` +
            `[${this.primary.name}] ${primaryReason}；[${this.fallback.name}] ${describeError(fallbackError)}`,
          { cause: fallbackError },
        );
      }
    }
  }
}

export interface CreateFissureProviderOptions {
  source: FissureSource;
  official: FissureProvider;
  warframestat: FissureProvider;
  logger: Logger;
}

/** 按配置选择数据源；auto 时返回带 fallback 的组合 provider。 */
export function createFissureProvider(options: CreateFissureProviderOptions): FissureProvider {
  const { source, official, warframestat, logger } = options;

  switch (source) {
    case 'official':
      return official;
    case 'warframestat':
      return warframestat;
    case 'auto':
      return new FallbackFissureProvider(official, warframestat, logger);
    default: {
      const exhaustive: never = source;
      throw new Error(`未知的 WARFRAME_SOURCE: ${String(exhaustive)}`);
    }
  }
}

/** 展示用：provider 当前实际请求的地址。 */
export function describeProvider(provider: FissureProvider): string {
  const suffix = provider instanceof FallbackFissureProvider ? `（备用：${redactUrl(provider.fallbackUrl)}）` : '';
  return `${provider.name} <- ${redactUrl(provider.url)}${suffix}`;
}
