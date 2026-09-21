/**
 * Warframe 裂缝（fissure）领域模型。
 *
 * 字段说明：
 * - node / missionType 是“归一化后”的值，已经处理好 API 的字段差异：
 *     missionType = fissure.missionTypeKey ?? fissure.missionType
 *     node        = fissure.nodeKey        ?? fissure.node
 * - nodeKey / missionTypeKey 保留原始值，仅用于排查问题。
 */
export interface Fissure {
  /** 唯一标识，用于持久化去重 */
  id: string;
  /** 出现时间（ISO 字符串，可能缺失） */
  activation: string | null;
  /** 结束时间（ISO 字符串，已校验可被 Date.parse 解析） */
  expiry: string;
  /** 归一化后的节点名，例如 "Ani (Void)" */
  node: string;
  /** 原始 nodeKey 字段 */
  nodeKey: string | null;
  /** 归一化后的任务类型，例如 "Survival" */
  missionType: string;
  /** 原始 missionTypeKey 字段 */
  missionTypeKey: string | null;
  /** 敌人派系，例如 "Corrupted" */
  enemy: string | null;
  /** 裂缝等级，例如 "Axi" */
  tier: string;
  /** 裂缝等级对应数字，例如 4 */
  tierNum: number | null;
  /** 是否钢铁之路（Steel Path） */
  isHard: boolean;
  /** 是否虚空风暴（Void Storm） */
  isStorm: boolean;
}
