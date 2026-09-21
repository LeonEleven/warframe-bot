/**
 * Digital Extremes 官方 WorldState 数据源（默认、首选）。
 *
 * 数据链路：
 *   https://api.warframe.com/cdn/worldState.php
 *     -> warframe-worldstate-parser（WFCD 维护）
 *     -> 本项目 Fissure domain model
 *
 * 关键事实（已针对真实响应验证）：
 * - 官方世界里裂缝在 `ActiveMissions`（普通 + 钢铁）与 `VoidStorms`（九重天虚空风暴）两个数组里，
 *   不再是旧的 `Fissures` 字段。
 * - parser 的映射：
 *     isHard  = Boolean(raw.Hard)              （Hard 仅钢铁之路裂缝存在）
 *     isStorm = Boolean(raw.ActiveMissionTier)（存在 ActiveMissionTier 即为虚空风暴）
 *     tier    = fissureModifier(raw.Modifier ?? raw.ActiveMissionTier)
 *     node    = 由 raw.Node（内部 key，如 SolNode409）翻译成 "Mot (Void)"
 * - 响应头是 text/html 但内容是 JSON，因此不校验 content-type。
 * - parser 依赖 class-transformer 装饰器，必须先 import 'reflect-metadata'。
 *
 * locale 固定使用 en：中文只用于展示层（src/localization），绝不参与筛选。
 */

import 'reflect-metadata';
import { WorldState, type Fissure as ParserFissure, type InitialWorldState } from 'warframe-worldstate-parser';
import { describeError, type Logger } from '../logger.js';
import type { Fissure } from '../types.js';
import { DEFAULT_WORLDSTATE_URL } from './defaults.js';
import { httpGetText, type FetchLike } from './http.js';
import { firstNonEmpty, strictBoolean, toIsoOrNull, toTierNumber } from './mapping.js';
import { ProviderError, type FissureFetchResult, type FissureProvider } from './provider.js';

export { DEFAULT_WORLDSTATE_URL };

/**
 * parser 支持的 locale 联合类型。
 * 从 WorldState 构造函数推导，避免直接依赖 parser 的传递依赖包。
 */
export type WorldStateLocale = NonNullable<ConstructorParameters<typeof WorldState>[1]>['locale'];

export const OFFICIAL_LOCALE: WorldStateLocale = 'en';

export interface OfficialProviderOptions {
  url?: string;
  timeoutMs: number;
  /** 解析用 locale，默认 'en'；仅影响 parser 输出的显示名，不影响筛选 */
  locale?: WorldStateLocale;
  fetchImpl?: FetchLike;
  /** 仅在配置了 WARFRAME_PROXY_URL 时传入 */
  dispatcher?: unknown;
  logger?: Logger;
}

type MapOutcome = { ok: true; fissure: Fissure } | { ok: false; reason: string };

/** 把 parser 的 Fissure 对象映射成本项目的 domain model。 */
export function mapOfficialFissure(entry: ParserFissure): MapOutcome {
  const id = firstNonEmpty(entry?.id);
  if (id === null) return { ok: false, reason: '缺少 id' };

  const expiryIso = toIsoOrNull(entry?.expiry);
  if (expiryIso === null) return { ok: false, reason: 'expiry 缺失或无法解析' };

  // 优先使用 *Key（locale 无关的英文规范值），匹配永远基于英文
  const node = firstNonEmpty(entry?.nodeKey, entry?.node);
  if (node === null) return { ok: false, reason: 'node / nodeKey 缺失' };

  const missionType = firstNonEmpty(entry?.missionTypeKey, entry?.missionType);
  if (missionType === null) return { ok: false, reason: 'missionType / missionTypeKey 缺失' };

  return {
    ok: true,
    fissure: {
      id,
      activation: toIsoOrNull(entry?.activation),
      expiry: expiryIso,
      node,
      nodeKey: firstNonEmpty(entry?.nodeKey),
      missionType,
      missionTypeKey: firstNonEmpty(entry?.missionTypeKey),
      enemy: firstNonEmpty(entry?.enemy),
      tier: firstNonEmpty(entry?.tier) ?? 'Unknown',
      tierNum: toTierNumber(entry?.tierNum),
      isHard: strictBoolean(entry?.isHard),
      isStorm: strictBoolean(entry?.isStorm),
    },
  };
}

export interface ParseOfficialOptions {
  locale?: WorldStateLocale;
  logger?: Logger;
  /** 结果里回填的 URL（已脱敏） */
  url?: string;
}

interface DroppedEntry {
  list: 'ActiveMissions' | 'VoidStorms';
  index: number;
  reason: string;
}

interface SanitizeResult {
  payload: unknown;
  dropped: DroppedEntry[];
}

const FISSURE_LISTS = ['ActiveMissions', 'VoidStorms'] as const;

/**
 * 在交给 parser 之前先剔除「会让 parser 直接抛错」的脏条目。
 *
 * 背景：warframe-worldstate-parser 的 fissureTier() 在缺少
 * Modifier / ActiveMissionTier 时会抛 TypeError，导致**整批** WorldState 解析失败。
 * 单条脏数据不该让整个监控轮次失败，因此这里只做 parser 硬性前提的最小过滤
 * （不做任何猜测），其余字段仍由 parser 与 mapper 负责。
 */
function sanitizeFissureEntries(payload: unknown): SanitizeResult {
  const source = payload as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { ...source };
  const dropped: DroppedEntry[] = [];

  for (const list of FISSURE_LISTS) {
    const raw = source[list];
    if (!Array.isArray(raw)) continue;

    const kept: unknown[] = [];
    raw.forEach((entry, index) => {
      const reason = describeUnparsableEntry(entry);
      if (reason === null) {
        kept.push(entry);
        return;
      }
      dropped.push({ list, index, reason });
    });
    sanitized[list] = kept;
  }

  return { payload: sanitized, dropped };
}

/** 返回不可解析的原因；null 表示可以交给 parser。 */
function describeUnparsableEntry(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return '记录不是对象';
  const record = entry as Record<string, unknown>;

  const node = record['Node'];
  if (typeof node !== 'string' || node.trim() === '') return '缺少 Node 字段';

  const modifier = record['Modifier'] ?? record['ActiveMissionTier'];
  if (typeof modifier !== 'string' || modifier.trim() === '') {
    return '缺少 Modifier / ActiveMissionTier 字段（无法确定裂缝等级）';
  }

  return null;
}

/**
 * 构造注入给 warframe-worldstate-parser 的 logger。
 *
 * 为什么需要它（已核对 parser 源码）：
 * parser 的 `defaultDeps = { sortieData, locale: 'en', logger: console }`，
 * 构造函数会做 `{ ...defaultDeps, ...deps }`，所以**不传 logger 时它就用 console**，
 * 于是每次 `new WorldState()` 都会往 console.debug 打印：
 *   - "No defined kuva data, skipping data"（Kuva.mjs：我们没提供 kuvaData，必然触发）
 *   - "No outpost data, skipping"（SentientOutpost.mjs：同理）
 * 监控每 60 秒解析一次，会持续污染 logs/monitor.log。
 *
 * 这里**不使用也不覆盖 console**，而是走 parser 官方的依赖注入点，把它的日志转发到
 * 我们自己的 logger.debug（带 [worldstate-parser] 前缀）。
 * 已确认 parser 总共只有 3 处 logger 调用：除上面两条无害提示外，还有
 * SyndicateJob 的 `Failed to fetch bounty rewards for ...`（真实诊断信息），
 * 它同样会保留在 debug 级别，不会被吞掉。
 */
export function createParserLogger(logger?: Logger): { debug: (message: string) => void } {
  return {
    debug: (message: string): void => {
      logger?.debug(`[worldstate-parser] ${message}`);
    },
  };
}

/**
 * 解析官方 WorldState 原始对象。
 * @throws ProviderError 整体结构不对 / parser 抛错
 */
export function parseOfficialWorldState(payload: unknown, options: ParseOfficialOptions = {}): FissureFetchResult {
  const url = options.url ?? DEFAULT_WORLDSTATE_URL;
  const locale = options.locale ?? OFFICIAL_LOCALE;
  const logger = options.logger;

  const container = payload as { ActiveMissions?: unknown; VoidStorms?: unknown } | null | undefined;
  const hasFissureArrays = Array.isArray(container?.ActiveMissions) || Array.isArray(container?.VoidStorms);
  if (!hasFissureArrays) {
    throw new ProviderError(
      'official',
      'empty',
      'official WorldState 响应里没有 ActiveMissions / VoidStorms 字段，可能不是有效的 WorldState（例如被网关拦截返回的 HTML）',
    );
  }

  // 先剔除会让 parser 整体抛错的脏条目，避免「一条坏数据毁掉整轮」
  const sanitized = sanitizeFissureEntries(payload);

  let worldState: WorldState;
  try {
    // 注入 logger，避免 parser 默认使用 console 造成每轮噪音（见 createParserLogger 说明）
    worldState = new WorldState(sanitized.payload as InitialWorldState, {
      locale,
      logger: createParserLogger(logger),
    });
  } catch (error) {
    throw new ProviderError('official', 'parse', `official WorldState 解析失败: ${describeError(error)}`, {
      cause: error,
    });
  }

  const parsed: ParserFissure[] = Array.isArray(worldState.fissures) ? worldState.fissures : [];
  const fissures: Fissure[] = [];
  const skipped: Array<{ index: number; reason: string }> = sanitized.dropped.map((entry) => ({
    index: entry.index,
    reason: `[${entry.list}] ${entry.reason}`,
  }));
  const seenIds = new Set<string>();

  parsed.forEach((entry, index) => {
    const outcome = mapOfficialFissure(entry);
    if (!outcome.ok) {
      // 单条异常只跳过该条：绝不猜测字段、绝不制造错误匹配
      skipped.push({ index, reason: outcome.reason });
      return;
    }
    if (seenIds.has(outcome.fissure.id)) {
      skipped.push({ index, reason: `重复的 fissure.id: ${outcome.fissure.id}` });
      return;
    }
    seenIds.add(outcome.fissure.id);
    fissures.push(outcome.fissure);
  });

  if (skipped.length > 0) {
    logger?.warn(`official WorldState 有 ${skipped.length} 条裂缝记录无法解析，已跳过`, skipped.slice(0, 3));
  }

  return { fissures, provider: 'official', url, skipped: skipped.length };
}

/** 官方 WorldState provider。 */
export class OfficialWorldStateProvider implements FissureProvider {
  readonly name = 'official';
  readonly url: string;

  private readonly timeoutMs: number;
  private readonly locale: WorldStateLocale;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly dispatcher: unknown;
  private readonly logger: Logger | undefined;

  constructor(options: OfficialProviderOptions) {
    this.url = options.url ?? DEFAULT_WORLDSTATE_URL;
    this.timeoutMs = options.timeoutMs;
    this.locale = options.locale ?? OFFICIAL_LOCALE;
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
        label: 'official WorldState',
        fetchImpl: this.fetchImpl,
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      throw new ProviderError('official', 'request', `official WorldState 获取失败: ${describeError(error)}`, {
        cause: error,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ProviderError('official', 'parse', `official WorldState 响应不是合法 JSON: ${describeError(error)}`, {
        cause: error,
      });
    }

    return parseOfficialWorldState(payload, { locale: this.locale, logger: this.logger, url: this.url });
  }
}
