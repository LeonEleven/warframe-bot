/**
 * Warframe 裂缝（fissure）领域模型。
 *
 * 字段说明：
 * - node / missionType 是“归一化后”的英文规范值，已经处理好各数据源的字段差异：
 *     missionType = missionTypeKey ?? missionKey ?? missionType
 *     node        = nodeKey        ?? node
 * - nodeKey / missionTypeKey 保留原始值，仅用于排查问题。
 * - 匹配永远使用英文规范值（Survival / Void / Steel Path），中文只用于显示。
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
  /** 裂缝等级对应数字，例如 4（仅用于 check / debug / 测试，不进入 QQ 文案） */
  tierNum: number | null;
  /**
   * 是否钢铁之路（Steel Path）。
   * null 表示上游数据没有明确给出该字段（unknown）——unknown 绝不允许当作 false，
   * 匹配时必须严格 `isHard === true`。
   */
  isHard: boolean | null;
  /**
   * 是否虚空风暴（Void Storm）。
   * null 表示 upstream 未明确给出（unknown）——匹配时必须严格 `isStorm === false`。
   */
  isStorm: boolean | null;
}

