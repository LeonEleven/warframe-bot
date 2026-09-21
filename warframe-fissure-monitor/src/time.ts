/**
 * 面向人的时间格式化（日志前缀 / 心跳文本）。
 *
 * 设计原则：
 * - **机器存储与比较**一律保持 UTC（ISO 8601 带 Z）：`data/monitor.lock` 的 startedAt、
 *   `data/state.json` 的时间、Warframe API 的 activation/expiry 等，都不能因为日志好看而改变语义。
 * - **只有给人看的日志**使用运行机器的当前系统时区（含该时刻实际生效的 DST offset）。
 *
 * 实现要点：
 * - 只使用 Date 的本地 getter 与 getTimezoneOffset()；
 * - 不使用 toLocaleString()（输出会随 Windows 语言/区域变化），也不做 toString() 字符串截取；
 * - 不硬编码任何时区（不写 Asia/Shanghai、UTC+8、+08:00 之类常量）。
 */

/** 数字左侧补零（只用于非负的时间分量；正负号单独处理）。 */
function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * 把 `Date.prototype.getTimezoneOffset()` 的返回值转换为 ISO 风格的 `±HH:mm`。
 *
 * 注意方向：`getTimezoneOffset()` 返回的是「UTC − 本地」（分钟），
 * 因此 UTC+8 会得到 -480，与 ISO offset 的符号**相反**，这里已翻转。
 *
 * 纯函数（不读取机器时区），便于在任意时区的机器上做确定性单测。
 */
export function formatOffsetFromTimezoneOffset(timezoneOffsetMinutes: number): string {
  const offsetMinutes = -Math.trunc(timezoneOffsetMinutes);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

/** 指定时刻在本地时区实际生效的 UTC offset（分钟，东为正；自动包含 DST）。 */
export function getLocalUtcOffsetMinutes(date: Date): number {
  return -date.getTimezoneOffset();
}

/**
 * 本地时区的日志时间戳：`YYYY-MM-DDTHH:mm:ss.SSS±HH:mm`
 *
 * @example
 * formatLocalTimestamp(new Date(2026, 8, 21, 15, 20, 6, 467)); // 系统位于 UTC+8 时
 * // => '2026-09-21T15:20:06.467+08:00'
 */
export function formatLocalTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) return 'invalid-date';

  const year = pad(date.getFullYear(), 4);
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const milliseconds = pad(date.getMilliseconds(), 3);
  const offset = formatOffsetFromTimezoneOffset(date.getTimezoneOffset());

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${offset}`;
}
