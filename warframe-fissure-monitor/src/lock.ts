/**
 * 单实例保护。
 *
 * 目的：任务计划程序已经在跑监控时，用户又手工 `npm start`，
 * 不能出现两个进程同时轮询、同时给 QQ 发消息。
 *
 * 设计要点：
 * - 锁文件里记录 **PID**（不是空文件），启动时判断该 PID 是否仍然存活
 * - PID 存活  -> 认为已有实例，抛出 InstanceAlreadyRunningError，调用方退出
 * - PID 已死 / 文件损坏 -> 视为 stale lock，自动清理后正常启动（崩溃后能自愈）
 * - 正常退出（SIGINT/SIGTERM/正常返回）会删除锁文件
 * - 创建使用 wx（独占）标志，避免两个进程同时创建成功
 * - release 时校验 PID，绝不删除别的实例的锁
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { describeError, type Logger } from './logger.js';

export const LOCK_FILE_VERSION = 1;

const lockPayloadSchema = z.object({
  version: z.number().int(),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

export interface LockFilePayload {
  version: number;
  pid: number;
  startedAt: string;
}

export class InstanceAlreadyRunningError extends Error {
  readonly pid: number;

  constructor(pid: number, message?: string) {
    super(message ?? `已有监控实例正在运行（pid=${pid}），本次启动已取消`);
    this.name = 'InstanceAlreadyRunningError';
    this.pid = pid;
  }
}

/** 进程是否存活（signal 0 探测；EPERM 表示存在但不属于当前用户，也算存活）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

type LockReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; payload: LockFilePayload }
  | { kind: 'invalid'; reason: string };

async function readLockFile(filePath: string): Promise<LockReadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: describeError(error) };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    return { kind: 'invalid', reason: `JSON 解析失败: ${describeError(error)}` };
  }

  const parsed = lockPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
    return { kind: 'invalid', reason: `结构校验失败: ${detail}` };
  }
  return { kind: 'valid', payload: parsed.data };
}

async function removeLockFile(filePath: string, logger?: Logger): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      logger?.warn(`删除锁文件失败: ${describeError(error)}`);
    }
  }
}

export interface AcquireLockOptions {
  filePath: string;
  logger?: Logger;
  now?: () => Date;
  /** 便于测试注入 */
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

export class SingleInstanceLock {
  private readonly filePath: string;
  private readonly payload: LockFilePayload;
  private readonly logger: Logger | undefined;
  private released = false;

  private constructor(filePath: string, payload: LockFilePayload, logger?: Logger) {
    this.filePath = filePath;
    this.payload = payload;
    this.logger = logger;
  }

  /** 当前持有的锁信息。 */
  get info(): LockFilePayload {
    return this.payload;
  }

  /**
   * 获取单实例锁。
   * @throws InstanceAlreadyRunningError 已有存活实例
   */
  static async acquire(options: AcquireLockOptions): Promise<SingleInstanceLock> {
    const {
      filePath,
      logger,
      now = () => new Date(),
      pid = process.pid,
      isAlive = isProcessAlive,
    } = options;

    await mkdir(path.dirname(filePath), { recursive: true });

    // 最多重试几次，用于处理「同时启动」的竞态
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await readLockFile(filePath);

      if (existing.kind === 'valid') {
        if (existing.payload.pid === pid || isAlive(existing.payload.pid)) {
          throw new InstanceAlreadyRunningError(existing.payload.pid);
        }
        logger?.warn(
          `发现 stale lock（pid=${existing.payload.pid} 已不存在），自动清理后继续启动: ${filePath}`,
        );
        await removeLockFile(filePath, logger);
      } else if (existing.kind === 'invalid') {
        logger?.warn(`锁文件无法解析（${existing.reason}），视为 stale lock 并覆盖: ${filePath}`);
        await removeLockFile(filePath, logger);
      }

      const payload: LockFilePayload = { version: LOCK_FILE_VERSION, pid, startedAt: now().toISOString() };
      try {
        await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        logger?.debug(`已获取单实例锁: ${filePath}（pid=${pid}）`);
        return new SingleInstanceLock(filePath, payload, logger);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        // 竞态：别的进程刚好创建成功，重新判断
      }
    }

    throw new InstanceAlreadyRunningError(pid, `无法获取单实例锁（多次重试仍被占用）: ${filePath}`);
  }

  /**
   * 释放锁（只在锁仍属于自己时删除）。
   * @returns 是否真的删除了锁文件
   */
  async release(): Promise<boolean> {
    if (this.released) return false;

    const current = await readLockFile(this.filePath);
    if (current.kind === 'valid' && current.payload.pid !== this.payload.pid) {
      this.logger?.warn(`锁文件已被其它进程接管（pid=${current.payload.pid}），本次不删除: ${this.filePath}`);
      this.released = true;
      return false;
    }

    await removeLockFile(this.filePath, this.logger);
    this.released = true;
    this.logger?.debug(`已释放单实例锁: ${this.filePath}`);
    return true;
  }

  /**
   * 注册进程退出兜底清理（同步删除，仅当锁仍属于自己）。
   * 崩溃 / 强杀时不保证执行，此时下次启动会走 stale lock 自愈。
   */
  attachExitHandler(): () => void {
    const handler = (): void => {
      try {
        const raw = readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as { pid?: unknown };
        if (parsed.pid === this.payload.pid) unlinkSync(this.filePath);
      } catch {
        // 退出阶段忽略一切错误
      }
    };

    process.once('exit', handler);
    return () => {
      process.off('exit', handler);
    };
  }
}
