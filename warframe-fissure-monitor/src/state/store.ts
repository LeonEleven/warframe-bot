/**
 * 持久化去重状态。
 *
 * 文件格式（data/state.json）：
 * {
 *   "version": 1,
 *   "notified": {
 *     "<fissure.id>": { "id": "...", "expiry": "...", "notifiedAt": "..." }
 *   }
 * }
 *
 * 规则：
 * - 只有 NapCat 真正发送成功之后才允许写入（由调用方保证）
 * - 程序重启后读取该文件，已通知过的 fissure.id 不再通知
 * - 定期清理「已过期至少 2 小时」的历史记录
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { describeError, type Logger } from '../logger.js';
import type { Fissure } from '../types.js';

export const STATE_FILE_VERSION = 1;

/** 过期超过该时长后清理历史 ID（2 小时） */
export const PRUNE_AFTER_MS = 2 * 60 * 60 * 1000;

const notifiedEntrySchema = z.object({
  id: z.string().min(1),
  expiry: z.string().min(1),
  notifiedAt: z.string().min(1),
});

export type NotifiedEntry = z.infer<typeof notifiedEntrySchema>;

const stateFileSchema = z.object({
  version: z.number().int().optional(),
  notified: z.record(z.string(), notifiedEntrySchema).optional(),
});

export interface StateFile {
  version: number;
  notified: Record<string, NotifiedEntry>;
}

export interface StateStoreOptions {
  /** state.json 的绝对/相对路径 */
  filePath: string;
  logger?: Logger;
  /** 便于测试注入时钟 */
  now?: () => Date;
  /** 清理阈值，默认 2 小时 */
  pruneAfterMs?: number;
}

export class StateStore {
  private readonly filePath: string;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;
  private readonly pruneAfterMs: number;
  private readonly entries: Map<string, NotifiedEntry>;

  private constructor(options: StateStoreOptions, entries: Map<string, NotifiedEntry>) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.pruneAfterMs = options.pruneAfterMs ?? PRUNE_AFTER_MS;
    this.entries = entries;
  }

  /**
   * 读取状态文件。文件不存在则返回空状态；文件损坏则备份后从空状态开始。
   */
  static async load(options: StateStoreOptions): Promise<StateStore> {
    const entries = new Map<string, NotifiedEntry>();
    const store = new StateStore(options, entries);
    const { filePath, logger } = options;

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        logger?.debug(`状态文件不存在，将从空状态开始: ${filePath}`);
        return store;
      }
      throw error;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      await store.backupCorruptedFile(`JSON 解析失败: ${describeError(error)}`);
      return store;
    }

    const parsed = stateFileSchema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      await store.backupCorruptedFile(`结构校验失败: ${detail}`);
      return store;
    }

    for (const [key, entry] of Object.entries(parsed.data.notified ?? {})) {
      entries.set(key, entry);
    }
    logger?.debug(`已加载状态文件，包含 ${entries.size} 条已通知记录: ${filePath}`);
    return store;
  }

  private async backupCorruptedFile(reason: string): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
    this.logger?.warn(`状态文件无法使用（${reason}），已备份为 ${backupPath}，本次从空状态开始`);
    try {
      await rename(this.filePath, backupPath);
    } catch (error) {
      this.logger?.warn(`备份状态文件失败: ${describeError(error)}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** 该 fissure.id 是否已经通知过。 */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): NotifiedEntry | undefined {
    return this.entries.get(id);
  }

  /** 所有已通知的 ID（已排序，便于输出）。 */
  ids(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** 允许被通知过的 ID（用于 check 脚本展示）。 */
  entriesSnapshot(): NotifiedEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 记录一条已成功通知的裂缝（仅内存，需自行 save）。 */
  markNotified(fissure: Fissure, notifiedAt: Date = this.now()): NotifiedEntry {
    const entry: NotifiedEntry = {
      id: fissure.id,
      expiry: fissure.expiry,
      notifiedAt: notifiedAt.toISOString(),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /**
   * 清理历史记录：expiry 早于「当前时间 - pruneAfterMs」的条目会被删除。
   * expiry 无法解析时退化为参考 notifiedAt。
   * @returns 被删除的 ID 列表
   */
  pruneExpired(now: Date = this.now()): string[] {
    const threshold = now.getTime() - this.pruneAfterMs;
    const removed: string[] = [];

    for (const [id, entry] of this.entries) {
      const expiryMs = Date.parse(entry.expiry);
      const reference = Number.isFinite(expiryMs) ? expiryMs : Date.parse(entry.notifiedAt);
      if (!Number.isFinite(reference)) continue;
      if (reference < threshold) {
        this.entries.delete(id);
        removed.push(id);
      }
    }

    return removed.sort();
  }

  toJSON(): StateFile {
    const notified: Record<string, NotifiedEntry> = {};
    for (const id of this.ids()) {
      const entry = this.entries.get(id);
      if (entry !== undefined) notified[id] = entry;
    }
    return { version: STATE_FILE_VERSION, notified };
  }

  /** 原子写入状态文件（先写 .tmp 再 rename）。 */
  async save(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
    this.logger?.debug(`状态文件已写入: ${this.filePath}（${this.entries.size} 条）`);
  }
}
