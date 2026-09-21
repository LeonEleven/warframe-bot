/**
 * QQ 通知文案生成。
 *
 * 每条裂缝包含：节点、裂缝等级 tier、Steel Path、生存任务、expiry、剩余时间。
 * 一次轮询发现的多个新裂缝会被合并成一条消息。
 */

import { getExpiryTimeMs } from '../filter.js';
import type { Fissure } from '../types.js';

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

/** 人类可读的剩余时间，例如 "1 小时 5 分"。 */
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

function tierText(fissure: Fissure): string {
  return fissure.tierNum === null ? fissure.tier : `${fissure.tier}（tierNum ${fissure.tierNum}）`;
}

function expiryText(fissure: Fissure): string {
  const expiryMs = getExpiryTimeMs(fissure);
  if (expiryMs === null) return '未知时间';
  return formatLocalDateTime(expiryMs);
}

function remainingText(fissure: Fissure, now: Date): string {
  const expiryMs = getExpiryTimeMs(fissure);
  if (expiryMs === null) return '未知';
  return formatRemaining(expiryMs - now.getTime());
}

/** 单行摘要，用于 `npm run check` 的控制台输出。 */
export function formatFissureLine(fissure: Fissure, now: Date = new Date()): string {
  return [
    fissure.node,
    fissure.missionType,
    `tier=${fissure.tier}${fissure.tierNum === null ? '' : `/${fissure.tierNum}`}`,
    `isHard=${fissure.isHard}`,
    `isStorm=${fissure.isStorm}`,
    `expiry=${expiryText(fissure)}`,
    `剩余=${remainingText(fissure, now)}`,
    `id=${fissure.id}`,
  ].join(' | ');
}

/** 多行详情的字段列表（用于 QQ 消息）。 */
export function formatFissureFields(fissure: Fissure, now: Date): string[] {
  return [
    `节点：${fissure.node}`,
    `裂缝等级：${tierText(fissure)}`,
    `任务类型：Steel Path · 生存（Survival）· 非 Void Storm`,
    `过期时间：${expiryText(fissure)}（剩余 ${remainingText(fissure, now)}）`,
  ];
}

export interface NotificationMessageOptions {
  /** 消息标题，默认 "【Warframe 裂缝提醒】" */
  title?: string;
  /** 标题下方的一句说明 */
  subtitle?: string;
  /** 消息末尾的附加说明 */
  footer?: string;
}

/** 把（可能有多个）裂缝合并成一条 QQ 消息。 */
export function buildNotificationMessage(
  fissures: readonly Fissure[],
  now: Date = new Date(),
  options: NotificationMessageOptions = {},
): string {
  const title = options.title ?? '【Warframe 裂缝提醒】';
  const lines: string[] = [title];

  const subtitle =
    options.subtitle ??
    (fissures.length > 1
      ? `发现 ${fissures.length} 个新的 Steel Path 生存裂缝（Void）：`
      : '发现 1 个新的 Steel Path 生存裂缝（Void）：');
  lines.push(subtitle);
  lines.push('');

  const numbered = fissures.length > 1;
  fissures.forEach((fissure, index) => {
    const fields = formatFissureFields(fissure, now);
    const [first, ...rest] = fields;
    if (first === undefined) return;
    lines.push(numbered ? `${index + 1}. ${first}` : first);
    for (const field of rest) lines.push(`   ${field}`);
    if (index !== fissures.length - 1) lines.push('');
  });

  lines.push('');
  lines.push(`检查时间：${formatLocalDateTime(now)}`);
  if (options.footer !== undefined) lines.push(options.footer);

  return lines.join('\n');
}
