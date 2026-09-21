/**
 * 简体中文展示层（presentation only）。
 *
 * 这里的所有映射**只用于生成 QQ 文案 / 控制台显示**，
 * 绝不参与匹配判断 —— 匹配永远使用英文规范值（Survival / Void / Steel Path boolean）。
 *
 * 未知节点、未知星系、未知 tier 一律安全回退到英文原名，不会因为缺少映射导致通知失败。
 */

/** Void 中与本项目相关的生存节点中文名 */
export const VOID_NODE_ZH_CN: Readonly<Record<string, string>> = {
  Ani: '阿尼',
  Mot: '默特',
};

/** 星系（节点括号里的区域）中文名 */
export const REGION_ZH_CN: Readonly<Record<string, string>> = {
  Void: '虚空',
};

/** 裂缝等级中文名 */
export const TIER_ZH_CN: Readonly<Record<string, string>> = {
  Lith: '古纪',
  Meso: '前纪',
  Neo: '中纪',
  Axi: '后纪',
  Requiem: '安魂',
  Omnia: '全能',
};

/** 任务类型中文名 */
export const MISSION_TYPE_ZH_CN: Readonly<Record<string, string>> = {
  Survival: '生存',
};

export const STEEL_PATH_LABEL = '钢铁之路（Steel Path）';

export interface NodeLabel {
  /** 节点名，例如 "Mot" */
  name: string;
  /** 星系 / 区域，例如 "Void"；无法判断时为 null */
  region: string | null;
}

/**
 * 可靠地把 "Mot (Void)" 拆成 name = "Mot"、region = "Void"。
 * 采用「最后一对括号」的通用解析，不使用任何固定下标截取；
 * 没有括号时视为整串都是节点名。
 */
export function parseNodeLabel(node: string): NodeLabel {
  const trimmed = typeof node === 'string' ? node.trim() : '';
  if (trimmed === '') return { name: '', region: null };

  const lastOpen = trimmed.lastIndexOf('(');
  const lastClose = trimmed.lastIndexOf(')');
  if (lastOpen > 0 && lastClose > lastOpen) {
    const name = trimmed.slice(0, lastOpen).trim();
    const region = trimmed.slice(lastOpen + 1, lastClose).trim();
    if (name !== '') {
      const trailing = trimmed.slice(lastClose + 1).trim();
      return {
        name: trailing === '' ? name : `${name} ${trailing}`.trim(),
        region: region === '' ? null : region,
      };
    }
  }

  return { name: trimmed, region: null };
}

/** 中文名（不含英文）；未知节点返回原名。 */
export function localizeNodeName(name: string): string {
  const key = typeof name === 'string' ? name.trim() : '';
  return VOID_NODE_ZH_CN[key] ?? key;
}

/** "默特（Mot）" 形式；未知节点只显示英文原名。 */
export function localizeNodeLabel(name: string): string {
  const key = typeof name === 'string' ? name.trim() : '';
  const zh = VOID_NODE_ZH_CN[key];
  return zh === undefined ? key : `${zh}（${key}）`;
}

/** "虚空（Void）" 形式；未知区域回退英文。 */
export function localizeRegionLabel(region: string): string {
  const key = typeof region === 'string' ? region.trim() : '';
  const zh = REGION_ZH_CN[key];
  return zh === undefined ? key : `${zh}（${key}）`;
}

/** "后纪（Axi）" 形式；未知 tier 回退英文。 */
export function localizeTierLabel(tier: string): string {
  const key = typeof tier === 'string' ? tier.trim() : '';
  const zh = TIER_ZH_CN[key];
  return zh === undefined ? key : `${zh}（${key}）`;
}

/** "生存（Survival）" 形式；未知任务类型回退英文。 */
export function localizeMissionLabel(missionType: string): string {
  const key = typeof missionType === 'string' ? missionType.trim() : '';
  const zh = MISSION_TYPE_ZH_CN[key];
  return zh === undefined ? key : `${zh}（${key}）`;
}

const CIRCLED_NUMBERS = [
  '①',
  '②',
  '③',
  '④',
  '⑤',
  '⑥',
  '⑦',
  '⑧',
  '⑨',
  '⑩',
  '⑪',
  '⑫',
  '⑬',
  '⑭',
  '⑮',
  '⑯',
  '⑰',
  '⑱',
  '⑲',
  '⑳',
];

/** 序号：①..⑳，超出范围回退 "N."。 */
export function circledNumber(index: number): string {
  return CIRCLED_NUMBERS[index - 1] ?? `${index}.`;
}
