/**
 * NapCatQQ（OneBot 11）HTTP 客户端。
 *
 * 只实现需要的私聊发送：
 *   POST ${NAPCAT_BASE_URL}/send_private_msg
 *   body: { "user_id": TARGET_QQ, "message": "..." }
 *   header: Authorization: Bearer ${NAPCAT_TOKEN}   （仅在设置了 token 时）
 *
 * 只有响应 status === "ok" 且 retcode === 0 才算发送成功。
 */

import { z } from 'zod';
import { describeError, type Logger } from '../logger.js';

const oneBotResponseSchema = z.object({
  // OneBot 11 的响应必须同时带 status 与 retcode
  status: z.string(),
  retcode: z.number(),
  message: z.string().optional(),
  wording: z.string().optional(),
});

export interface NapCatClientOptions {
  baseUrl: string;
  token?: string | null;
  /** 请求超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 便于测试注入；默认使用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface NapCatSendResult {
  /** 是否真正发送成功（status === "ok" 且 retcode === 0） */
  ok: boolean;
  targetQq: string;
  endpoint: string;
  status?: string;
  retcode?: number;
  /** 失败原因（网络错误 / HTTP 错误 / OneBot 返回失败） */
  error?: string;
  /** 响应细节，便于排查 */
  detail?: string;
}

export const DEFAULT_NAPCAT_TIMEOUT_MS = 15_000;

function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${suffix}`;
}

function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export class NapCatClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: NapCatClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NAPCAT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  /** 发送私聊消息。永不抛异常，成功与否通过返回值表达。 */
  async sendPrivateMessage(targetQq: string, message: string): Promise<NapCatSendResult> {
    const endpoint = joinUrl(this.baseUrl, '/send_private_msg');
    const base: NapCatSendResult = { ok: false, targetQq, endpoint };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token !== null && this.token !== '') {
      headers.authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: Number(targetQq), message }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = `请求 NapCat 失败（${endpoint}，超时 ${this.timeoutMs}ms）: ${describeError(error)}`;
      this.logger?.debug('NapCat 请求异常', reason);
      return { ...base, error: reason };
    }

    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      return { ...base, error: `读取 NapCat 响应失败: ${describeError(error)}` };
    }

    if (!response.ok) {
      return {
        ...base,
        error: `NapCat 返回 HTTP ${response.status} ${response.statusText}`,
        detail: truncate(text),
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      return { ...base, error: `NapCat 响应不是合法 JSON: ${describeError(error)}`, detail: truncate(text) };
    }

    const parsed = oneBotResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return { ...base, error: 'NapCat 响应不符合 OneBot 11 结构（缺少 status / retcode）', detail: truncate(text) };
    }

    const { status, retcode, message: message1, wording } = parsed.data;
    const ok = status === 'ok' && retcode === 0;

    if (ok) return { ...base, ok: true, status, retcode };

    return {
      ...base,
      ok: false,
      status,
      retcode,
      error: `NapCat 发送失败：status=${String(status)}, retcode=${String(retcode)}`,
      detail: truncate(message1 ?? wording ?? text),
    };
  }
}
