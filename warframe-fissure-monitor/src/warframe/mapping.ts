/**
 * 各 provider 共用的归一化工具。
 *
 * 关键约定：**绝不猜测布尔语义**。
 * 上游没有给出字段时保持 null（unknown），由 filter 严格判断，unknown 一律不通知。
 */

/** 返回第一个「非空字符串」（会 trim）；都没有则返回 null。 */
export function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** 只有真正的 boolean 才转换，其余（undefined / null / 字符串）一律视为 unknown。 */
export function strictBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Date -> ISO 字符串；非法或缺失返回 null。 */
export function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/** tierNum 归一化为正整数；无法解析返回 null。 */
export function toTierNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
