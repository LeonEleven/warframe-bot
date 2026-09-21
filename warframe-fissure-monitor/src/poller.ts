/**
 * 单轮轮询逻辑（不含定时器，方便测试）。
 *
 * 重要约定：
 * - Warframe 请求失败：只记录错误，本轮结束，绝不因此给 QQ 发任何消息
 * - 只有 NapCat 返回 status === "ok" 且 retcode === 0 时，才把 fissure.id 写入 state.json
 * - 发送失败时不写入任何已通知记录，下一轮会再次尝试
 */

import { selectMatchingFissures } from './filter.js';
import { describeError, type Logger } from './logger.js';
import { buildNotificationMessage } from './notify/message.js';
import type { NapCatSendResult } from './notify/napcat.js';
import type { StateStore } from './state/store.js';
import type { Fissure } from './types.js';

export interface PollDependencies {
  /** 拉取当前裂缝（失败应抛异常） */
  fetchFissures: () => Promise<Fissure[]>;
  /** 发送一条 QQ 私聊消息（失败应返回 ok: false，而不是抛异常） */
  sendMessage: (message: string) => Promise<NapCatSendResult>;
  store: StateStore;
  logger: Logger;
  /** true 时只生成消息并打印，不发送、不写状态 */
  dryRun?: boolean;
  now?: () => Date;
}

export interface PollOutcome {
  checkedAt: Date;
  /** 本次拉取到的裂缝总数 */
  fetchedCount: number;
  /** 满足通知条件的裂缝数 */
  matchedCount: number;
  /** 其中尚未通知过的数量 */
  pendingCount: number;
  /** 是否真的发送了 QQ 消息 */
  notified: boolean;
  /** 本应发送的消息内容（dry run / 失败时可用于排查） */
  message: string | null;
  /** 被清理的历史 ID */
  prunedIds: string[];
  /** 本轮错误信息（Warframe 请求失败 / NapCat 发送失败） */
  error: string | null;
}

/** 执行一轮检查。除状态文件读写异常外不会抛错。 */
export async function runPollCycle(dependencies: PollDependencies): Promise<PollOutcome> {
  const { fetchFissures, sendMessage, store, logger, dryRun = false } = dependencies;
  const now = dependencies.now?.() ?? new Date();

  const outcome: PollOutcome = {
    checkedAt: now,
    fetchedCount: 0,
    matchedCount: 0,
    pendingCount: 0,
    notified: false,
    message: null,
    prunedIds: [],
    error: null,
  };

  // 1) 清理过期至少 2 小时的历史 ID（与发送无关，独立处理）
  try {
    const pruned = store.pruneExpired(now);
    outcome.prunedIds = pruned;
    if (pruned.length > 0) {
      logger.info(`清理已过期超过 2 小时的历史通知记录：${pruned.length} 条`);
      await store.save();
    }
  } catch (error) {
    logger.error(`清理状态文件失败（不影响本轮检测）: ${describeError(error)}`);
  }

  // 2) 拉取裂缝数据
  let fissures: Fissure[];
  try {
    fissures = await fetchFissures();
  } catch (error) {
    outcome.error = describeError(error);
    logger.error(`拉取 Warframe 裂缝数据失败，本轮跳过（不会给 QQ 发送任何错误消息）: ${outcome.error}`);
    return outcome;
  }
  outcome.fetchedCount = fissures.length;

  // 3) 匹配条件（无匹配属于常态，用 debug 避免 60 秒一条的噪音日志）
  const matched = selectMatchingFissures(fissures, now);
  outcome.matchedCount = matched.length;
  if (matched.length === 0) {
    logger.debug(`本轮共 ${fissures.length} 条裂缝，没有匹配项`);
    return outcome;
  }

  // 4) 持久化去重
  const pending = matched.filter((fissure) => !store.has(fissure.id));
  outcome.pendingCount = pending.length;
  if (pending.length === 0) {
    logger.debug(`匹配 ${matched.length} 条裂缝，但均已通知过，跳过`);
    return outcome;
  }

  const message = buildNotificationMessage(pending, now);
  outcome.message = message;

  // 5) dry run：只打印数量，完整消息由调用方（index）输出，避免日志里出现两份
  if (dryRun) {
    logger.info(`[DRY_RUN] 检测到 ${pending.length} 条新的匹配裂缝，未发送 QQ 消息`);
    return outcome;
  }

  // 6) 真正发送
  let result: NapCatSendResult;
  try {
    result = await sendMessage(message);
  } catch (error) {
    outcome.error = describeError(error);
    logger.error(`发送 QQ 通知时发生异常，本轮不记录为已通知，下一轮将重试: ${outcome.error}`);
    return outcome;
  }

  if (!result.ok) {
    outcome.error = result.error ?? 'NapCat 发送失败';
    logger.error(`NapCat 发送失败，本轮不记录为已通知，下一轮将重试: ${outcome.error}`, {
      status: result.status,
      retcode: result.retcode,
      detail: result.detail,
    });
    return outcome;
  }

  // 7) 只有发送成功后才写入已通知状态
  for (const fissure of pending) {
    store.markNotified(fissure, now);
  }
  try {
    await store.save();
  } catch (error) {
    logger.error(`发送成功但写入状态文件失败（重启后可能重复通知）: ${describeError(error)}`);
  }

  outcome.notified = true;
  logger.info(
    `已通知 ${pending.length} 条新裂缝: ${pending.map((fissure) => `${fissure.node}(${fissure.id})`).join('、')}`,
  );
  return outcome;
}
