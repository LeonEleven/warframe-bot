/**
 * 敏感信息脱敏工具。
 *
 * 用于日志输出：任何包含凭据的 URL 都必须先经过 redactUrl 再写日志。
 * 例如 http://user:secret@127.0.0.1:7890 -> http://***@127.0.0.1:7890
 */

const CREDENTIALS_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*)@/i;

/**
 * 去掉 URL 中的 user:password 部分，仅保留主机与路径。
 * 解析失败时退化为「只保留协议」的安全形式。
 */
export function redactUrl(rawUrl: string | null | undefined): string {
  if (rawUrl === null || rawUrl === undefined || rawUrl.trim() === '') return '(未设置)';

  const trimmed = rawUrl.trim();
  const redacted = trimmed.replace(CREDENTIALS_PATTERN, '$1***@');
  if (redacted !== trimmed) return redacted;

  // 没有凭据时原样返回；无法解析的字符串不原样输出，避免意外泄漏
  try {
    return new URL(trimmed).toString();
  } catch {
    return '(无法解析的 URL，已隐藏)';
  }
}

/** URL 中是否包含 user:password 形式的凭据。 */
export function hasEmbeddedCredentials(rawUrl: string): boolean {
  return CREDENTIALS_PATTERN.test(rawUrl.trim());
}

/** QQ 号脱敏：日志里只显示「已配置」，不显示真实号码。 */
export function maskSecret(configured: boolean): string {
  return configured ? '(已配置)' : '(未设置)';
}
