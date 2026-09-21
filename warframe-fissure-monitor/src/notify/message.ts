/**
 * QQ 通知文案生成（简体中文优先，必要英文名放括号）。
 *
 * 一条裂缝：
 *   【Warframe 钢铁裂缝提醒】
 *
 *   发现新的虚空钢铁之路生存裂缝！
 *
 *   节点：默特（Mot）
 *   星系：虚空（Void）
 *   任务：生存（Survival）
 *   模式：钢铁之路（Steel Path）
 *   裂缝：后纪（Axi）
 *   剩余：1 小时 24 分
 *   结束：2026-09-21 11:26:18
 *
 *   检测：2026-09-21 10:02:04
 *
 * 多条裂缝会合并为一条消息并用 ①②③ 编号。
 * 文案中**不包含 tierNum**（tierNum 只用于 check / debug / 测试）。
 */

import { getExpiryTimeMs } from '../filter.js';
import {
  circledNumber,
  localizeMissionLabel,
  localizeNodeLabel,
  localizeRegionLabel,
  localizeTierLabel,
  parseNodeLabel,
  STEEL_PATH_LABEL,
} from '../localization/zh-cn.js';
import type { Fissure } from '../types.js';

export const NOTIFICATION_TITLE = '【Warframe 钢铁裂缝提醒】';

const PAD = (value: number, length = 2): string => String(value).padStart(length, '0');

/** 本地时区 "YYYY-MM-DD HH:mm:ss"。 */
export function formatLocalDateTime(input: Date | number): string {
  const date = typeof input === 'number' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '未知时间';
  return (
    `${date.getFullYear()}-${PAD(date.getMonth() + 1)}-${PAD(date.getDate())} ` +
    `${PAD(date.getHours())}:${PAD(date.getMinutes())}:${PAD(date.getSeconds())}`
  );
}

/** 人类可读的剩余时间，例如 "1 小时 24 分"。 */
export function formatRemaining(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '未知';
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds <= 0) return '已过期';

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (days > 0 || hours > 0) parts.push(`${hours} 小时`);
  parts.push(`${minutes} 分`);
  if (days === 0 && hours === 0) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

function expiryMsOf(fissure: Fissure): number | null {
  return getExpiryTimeMs(fissure);
}

function remainingText(fissure: Fissure, now: Date): string {
  const expiryMs = expiryMsOf(fissure);
  return expiryMs === null ? '未知' : formatRemaining(expiryMs - now.getTime());
}

function expiryText(fissure: Fissure): string {
  const expiryMs = expiryMsOf(fissure);
  return expiryMs === null ? '未知时间' : formatLocalDateTime(expiryMs);
}

function flagText(value: boolean | null): string {
  if (value === null) return 'unknown';
  return String(value);
}

/** QQ 文案里的字段块（星系 / 任务 / 模式 / 裂缝 / 剩余 / 结束）。 */
export function formatNotificationFields(fissure: Fissure, now: Date): string[] {
  const { region } = parseNodeLabel(fissure.node);
  return [
    `星系：${region === null ? '未知' : localizeRegionLabel(region)}`,
    `任务：${localizeMissionLabel(fissure.missionType)}`,
    `模式：${STEEL_PATH_LABEL}`,
    `裂缝：${localizeTierLabel(fissure.tier)}`,
    `剩余：${remainingText(fissure, now)}`,
    `结束：${expiryText(fissure)}`,
  ];
}

/** QQ 文案里的节点行："节点：默特（Mot）" 或 "① 阿尼（Ani）"。 */
export function formatNotificationNodeLine(fissure: Fissure, index: number | null): string {
  const { name } = parseNodeLabel(fissure.node);
  const label = localizeNodeLabel(name);
  return index === null ? `节点：${label}` : `${circledNumber(index)} ${label}`;
}

export interface NotificationMessageOptions {
  /** 标题，默认 "【Warframe 钢铁裂缝提醒】" */
  title?: string;
  /** 标题下的一句说明，默认按数量自动生成 */
  subtitle?: string;
  /** 消息末尾附加说明（例如测试通知） */
  footer?: string;
}

/** 把（可能有多个）裂缝合并成一条 QQ 消息。 */
export function buildNotificationMessage(
  fissures: readonly Fissure[],
  now: Date = new Date(),
  options: NotificationMessageOptions = {},
): string {
  const title = options.title ?? NOTIFICATION_TITLE;
  const count = fissures.length;
  const subtitle =
    options.subtitle ??
    (count > 1 ? `发现 ${count} 个新的虚空钢铁之路生存裂缝！` : '发现新的虚空钢铁之路生存裂缝！');

  const numbered = count > 1;
  const blocks = fissures.map((fissure, index) =>
    [
      formatNotificationNodeLine(fissure, numbered ? index + 1 : null),
      ...formatNotificationFields(fissure, now),
    ].join('\n'),
  );

  const lines: string[] = [title, '', subtitle, ''];
  lines.push(blocks.join('\n\n'));
  lines.push('');
  lines.push(`检测：${formatLocalDateTime(now)}`);
  if (options.footer !== undefined) lines.push(options.footer);

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 以下为开发者向输出（npm run check / debug / 测试），不进入 QQ 文案
 * ------------------------------------------------------------------ */

/** 单行摘要（含 tierNum / isHard / isStorm / id），用于 check 的完整列表。 */
export function formatFissureLine(fissure: Fissure, now: Date = new Date()): string {
  return [
    fissure.node,
    fissure.missionType,
    `tier=${fissure.tier}${fissure.tierNum === null ? '' : `/${fissure.tierNum}`}`,
    `isHard=${flagText(fissure.isHard)}`,
    `isStorm=${flagText(fissure.isStorm)}`,
    `expiry=${expiryText(fissure)}`,
    `剩余=${remainingText(fissure, now)}`,
    `id=${fissure.id}`,
  ].join(' | ');
}

/** 多行开发者详情，用于 check 里展开最终匹配项。 */
export function formatFissureDetail(fissure: Fissure, now: Date = new Date()): string {
  const rows: Array<[string, string]> = [
    ['node', fissure.node],
    ['nodeKey', fissure.nodeKey ?? '(null)'],
    ['missionType', fissure.missionType],
    ['missionTypeKey', fissure.missionTypeKey ?? '(null)'],
    ['enemy', fissure.enemy ?? '(null)'],
    ['tier', fissure.tier],
    ['tierNum', fissure.tierNum === null ? '(null)' : String(fissure.tierNum)],
    ['isHard', flagText(fissure.isHard)],
    ['isStorm', flagText(fissure.isStorm)],
    ['activation', fissure.activation === null ? '(null)' : formatLocalDateTime(Date.parse(fissure.activation))],
    ['expiry', expiryText(fissure)],
    ['remaining', remainingText(fissure, now)],
    ['id', fissure.id],
  ];
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, value]) => `  ${key.padEnd(width)} : ${value}`).join('\n');
}
