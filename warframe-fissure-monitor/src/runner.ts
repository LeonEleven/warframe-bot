/**
 * 监控主循环。
 *
 * 刻意不使用 setInterval：每轮检查「完成后」才等待固定间隔，避免任务重叠。
 */

import { setTimeout as delay } from 'node:timers/promises';
import { describeError, type Logger } from './logger.js';

export type SleepFunction = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface MonitorLoopOptions {
  /** 每轮之间的等待时间（毫秒） */
  intervalMs: number;
  /** 执行一轮检查（内部自行处理业务错误） */
  runCycle: () => Promise<unknown>;
  logger: Logger;
  /** 用于优雅退出 */
  signal?: AbortSignal;
  /** 便于测试注入 */
  sleep?: SleepFunction;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, signal === undefined ? {} : { signal });
}

/**
 * 顺序执行检查循环：runCycle() -> 等待 intervalMs -> runCycle() -> ...
 * 直到 signal 被 abort。
 */
export async function runMonitorLoop(options: MonitorLoopOptions): Promise<void> {
  const { intervalMs, runCycle, logger, signal, sleep = defaultSleep } = options;

  // 通过函数读取，避免 TS 把属性收窄成常量
  const aborted = (): boolean => signal?.aborted === true;

  if (aborted()) {
    logger.info('收到退出信号，未开始检查');
    return;
  }

  logger.info(`监控循环启动，检查间隔 ${intervalMs} ms（上一轮结束后才开始计时）`);
  let round = 0;

  while (!aborted()) {
    round += 1;
    const startedAt = Date.now();
    logger.debug(`第 ${round} 轮检查开始`);

    try {
      await runCycle();
    } catch (error) {
      // 单轮异常不应终止长期运行
      logger.error(`第 ${round} 轮检查出现未捕获错误: ${describeError(error)}`);
    }

    if (aborted()) break;

    const elapsedMs = Date.now() - startedAt;
    logger.debug(`第 ${round} 轮检查完成，耗时 ${elapsedMs} ms，${intervalMs} ms 后开始下一轮`);

    try {
      await sleep(intervalMs, signal);
    } catch (error) {
      if (isAbortError(error)) break;
      throw error;
    }
  }

  logger.info('监控循环已停止');
}
