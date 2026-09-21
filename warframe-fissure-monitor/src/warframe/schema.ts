/**
 * WarframeStat.us /fissures 响应的 zod 校验 + 归一化。
 *
 * 兼容性处理：
 * - missionType = missionTypeKey ?? missionKey ?? missionType
 * - node        = nodeKey        ?? node
 * - isHard / isStorm 缺失时保持 **unknown（null）**，绝不猜测成 false。
 *   上游没给出字段时必须视为未知，否则 unknown 会被误判成「确定不是 Void Storm」。
 *   真正匹配由 filter 用 === true / === false 严格判断。
 * - 单条记录解析失败只跳过该条，不影响整批数据
 * - 同时接受 [...] 与 { fissures: [...] } 两种响应外形
 */

import { z } from 'zod';
import type { Fissure } from '../types.js';
import { firstNonEmpty, strictBoolean, toTierNumber } from './mapping.js';

export class WarframeResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarframeResponseFormatError';
  }
}

/** 已知的裂缝字段（未知字段忽略）。 */
export const rawFissureSchema = z.object({
  id: z.string().min(1),
  activation: z.string().optional(),
  expiry: z.string().min(1),
  node: z.string().optional(),
  nodeKey: z.string().optional(),
  missionType: z.string().optional(),
  missionTypeKey: z.string().optional(),
  /** 部分版本/镜像只提供 missionKey（例如 "Survival"） */
  missionKey: z.string().optional(),
  enemy: z.string().optional(),
  tier: z.string().optional(),
  tierNum: z.union([z.number(), z.string()]).optional(),
  isHard: z.boolean().optional(),
  isStorm: z.boolean().optional(),
});


export type RawFissure = z.infer<typeof rawFissureSchema>;

export interface SkippedFissure {
  index: number;
  reason: string;
}

export interface FissureParseResult {
  fissures: Fissure[];
  skipped: SkippedFissure[];
}

const responseWrapperSchema = z.object({
  fissures: z.array(z.unknown()),
});

function extractList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const wrapped = responseWrapperSchema.safeParse(payload);
  if (wrapped.success) return wrapped.data.fissures;
  throw new WarframeResponseFormatError(
    `Warframe API 响应格式不符合预期：期望数组或 { fissures: [...] }，实际为 ${describeType(payload)}`,
  );
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

type NormalizeOutcome = { ok: true; fissure: Fissure } | { ok: false; reason: string };

function normalizeFissure(raw: RawFissure): NormalizeOutcome {
  const node = firstNonEmpty(raw.nodeKey, raw.node);
  if (node === null) return { ok: false, reason: '缺少 node / nodeKey 字段' };

  // 英文规范值优先：missionTypeKey -> missionKey -> missionType
  const missionType = firstNonEmpty(raw.missionTypeKey, raw.missionKey, raw.missionType);
  if (missionType === null) return { ok: false, reason: '缺少 missionType / missionTypeKey / missionKey 字段' };

  const expiryMs = Date.parse(raw.expiry);
  if (!Number.isFinite(expiryMs)) {
    return { ok: false, reason: `expiry 不是合法时间字符串: "${raw.expiry}"` };
  }

  const activation = raw.activation !== undefined && Number.isFinite(Date.parse(raw.activation)) ? raw.activation : null;

  return {
    ok: true,
    fissure: {
      id: raw.id,
      activation,
      expiry: raw.expiry,
      node,
      nodeKey: firstNonEmpty(raw.nodeKey),
      missionType,
      missionTypeKey: firstNonEmpty(raw.missionTypeKey),
      enemy: firstNonEmpty(raw.enemy),
      tier: firstNonEmpty(raw.tier) ?? 'Unknown',
      tierNum: toTierNumber(raw.tierNum),
      // 缺失 => unknown(null)，绝不猜测成 false
      isHard: strictBoolean(raw.isHard),
      isStorm: strictBoolean(raw.isStorm),
    },
  };
}

/**
 * 解析 Warframe /fissures 响应。
 * @throws WarframeResponseFormatError 响应整体外形不对（不是数组也没有 fissures 字段）
 */
export function parseFissuresResponse(payload: unknown): FissureParseResult {
  const list = extractList(payload);
  const fissures: Fissure[] = [];
  const skipped: SkippedFissure[] = [];
  const seenIds = new Set<string>();

  list.forEach((item, index) => {
    const parsed = rawFissureSchema.safeParse(item);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      skipped.push({ index, reason: `字段校验失败 -> ${detail}` });
      return;
    }

    const outcome = normalizeFissure(parsed.data);
    if (!outcome.ok) {
      skipped.push({ index, reason: outcome.reason });
      return;
    }

    if (seenIds.has(outcome.fissure.id)) {
      skipped.push({ index, reason: `重复的 fissure.id: ${outcome.fissure.id}` });
      return;
    }
    seenIds.add(outcome.fissure.id);
    fissures.push(outcome.fissure);
  });

  return { fissures, skipped };
}
