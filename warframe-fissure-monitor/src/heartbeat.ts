/**
 * 心跳日志。
 *
 * 长期运行时用来确认「程序还活着、数据还在更新」，默认每 6 小时输出一条 info。
 *
 * 设计约束：心跳**只写日志**，它甚至没有 NapCat 的任何依赖（结构上不可能发 QQ 消息）。
 */

import type { Logger } from './logger.js';
import type { PollOutcome } from './poller.js';

export interface MonitorStats {
  /** 实际生效的 provider 名（auto 模式下可能回退） */
  provider: string;
  /** 累计完成轮询次数 */
  cycles: number;
  /** 最近一次成功获取 Warframe 裂缝数据的时间（与 QQ 通知是否成功无关） */
  lastSuccessAt: Date | null;
  /** 最近一次成功获取到的裂缝数量 */
  lastFissureCount: number | null;
  /** 最近一次 Warframe / provider 请求或解析失败的时间 */
  lastErrorAt: Date | null;
}

export function createMonitorStats(provider: string): MonitorStats {
  return {
    provider,
    cycles: 0,
    lastSuccessAt: null,
    lastFissureCount: null,
    lastErrorAt: null,
  };
}

/**
 * 用一轮轮询结果更新心跳统计。
 *
 * 语义要点（注意区分「取数据」与「发通知」两件事）：
 * - 只要 provider 成功返回 fissures（fetchSucceeded），就刷新 lastSuccessAt / lastFissureCount，
 *   **即使随后 NapCat 发送失败**，也仍然算「本轮成功获取」。
 * - 只有 Warframe / provider 请求或解析失败（!fetchSucceeded）才刷新 lastErrorAt。
 * - NapCat 发送失败由 poller 记 error 日志并下一轮重试，不会污染 lastSuccessAt。
 */
export function applyPollOutcome(stats: MonitorStats, outcome: PollOutcome): void {
  stats.cycles += 1;

  if (outcome.fetchSucceeded) {
    stats.lastSuccessAt = outcome.checkedAt;
    stats.lastFissureCount = outcome.fetchedCount;
    return;
  }

  stats.lastErrorAt = outcome.checkedAt;
}

/** 生成心跳日志文本（便于测试断言，不直接落盘）。 */
export function formatHeartbeat(stats: MonitorStats): string {
  const parts = [
    '监控运行正常',
    `provider=${stats.provider}`,
    `累计轮询=${stats.cycles}`,
    `最近成功获取=${stats.lastSuccessAt === null ? '从未' : stats.lastSuccessAt.toISOString()}`,
    `最近一次裂缝数量=${stats.lastFissureCount === null ? '未知' : stats.lastFissureCount}`,
  ];
  if (stats.lastErrorAt !== null) {
    parts.push(`最近一次错误=${stats.lastErrorAt.toISOString()}`);
  }
  return parts.join(' ');
}

export interface HeartbeatOptions {
  /** 心跳间隔（毫秒） */
  intervalMs: number;
  logger: Logger;
  now?: () => Date;
}

export class Heartbeat {
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private lastEmittedAt: Date;

  constructor(options: HeartbeatOptions) {
    this.intervalMs = options.intervalMs;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.lastEmittedAt = this.now();
  }

  /** 距下次心跳还有多久（毫秒）。 */
  nextDueInMs(): number {
    return Math.max(0, this.intervalMs - (this.now().getTime() - this.lastEmittedAt.getTime()));
  }

  /**
   * 到达间隔时输出一条 info 心跳。
   * @returns 本次是否输出了心跳
   */
  maybeLog(stats: MonitorStats): boolean {
    const now = this.now();
    if (now.getTime() - this.lastEmittedAt.getTime() < this.intervalMs) return false;

    this.lastEmittedAt = now;
    this.logger.info(formatHeartbeat(stats));
    return true;
  }
}
