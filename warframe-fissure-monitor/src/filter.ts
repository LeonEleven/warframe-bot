/**
 * 裂缝匹配规则（全部为“纯函数”，便于单元测试）。
 *
 * 命中条件（必须同时满足）：
 *   1. isHard === true            （Steel Path）
 *   2. isStorm === false          （非 Void Storm）
 *   3. missionType === "Survival" （生存任务，英文规范值）
 *   4. 节点名以 "(Void)" 结尾      （虚空节点，动态判断，不硬编码 Ani / Mot）
 *   5. expiry > 当前时间           （尚未过期）
 *
 * 注意 unknown 语义：
 *   isHard / isStorm 为 null（上游未给出该字段）时一律「不匹配」，
 *   绝不把 unknown 当成 false。因此这里一律使用 === 严格比较。
 * 节点中文名（阿尼 / 默特）只用于显示，绝不参与匹配。
 */

import type { Fissure } from './types.js';

export const SURVIVAL_MISSION = 'Survival';
export const VOID_NODE_SUFFIX = '(void)';

/** 供 CLI / README 复用的规则描述。 */
export const MATCH_CRITERIA_DESCRIPTION =
  'isHard === true && isStorm === false && missionType === "Survival" && node 以 "(Void)" 结尾 && expiry > 当前时间';

/** 去掉首尾空白并合并中间连续空白。 */
export function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** 节点是否属于 Void：节点名（忽略大小写与多余空格）以 "(Void)" 结尾。 */
export function isVoidNode(node: string): boolean {
  return normalizeLabel(node).toLowerCase().endsWith(VOID_NODE_SUFFIX);
}

/** 是否生存任务（忽略大小写与多余空格）。 */
export function isSurvivalMission(missionType: string): boolean {
  return normalizeLabel(missionType).toLowerCase() === SURVIVAL_MISSION.toLowerCase();
}

/** expiry 的毫秒时间戳；无法解析时返回 null。 */
export function getExpiryTimeMs(fissure: Fissure): number | null {
  const parsed = Date.parse(fissure.expiry);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 单条裂缝是否满足全部通知条件。 */
export function matchesFissureCriteria(fissure: Fissure, now: Date = new Date()): boolean {
  if (fissure.isHard !== true) return false;
  if (fissure.isStorm !== false) return false;
  if (!isSurvivalMission(fissure.missionType)) return false;
  if (!isVoidNode(fissure.node)) return false;

  const expiryMs = getExpiryTimeMs(fissure);
  if (expiryMs === null) return false;
  return expiryMs > now.getTime();
}

/** 过滤出所有满足条件的裂缝（保持原顺序）。 */
export function selectMatchingFissures(fissures: readonly Fissure[], now: Date = new Date()): Fissure[] {
  return fissures.filter((fissure) => matchesFissureCriteria(fissure, now));
}

/** 供 check / 统计使用：明确标记为 Steel Path 的裂缝数量（unknown 不计入）。 */
export function countSteelPathFissures(fissures: readonly Fissure[]): number {
  return fissures.filter((fissure) => fissure.isHard === true).length;
}
