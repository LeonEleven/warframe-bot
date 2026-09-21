/**
 * 程序入口：加载配置 -> 获取单实例锁 -> 加载状态 -> 顺序轮询（带心跳与优雅退出）。
 */

import { buildRuntime } from './app.js';
import { describeConfig, loadConfig } from './config.js';
import { createMonitorStats, Heartbeat } from './heartbeat.js';
import { InstanceAlreadyRunningError, SingleInstanceLock } from './lock.js';
import { createLogger, describeError } from './logger.js';
import { runPollCycle } from './poller.js';
import { runMonitorLoop } from './runner.js';
import { StateStore } from './state/store.js';

async function main(): Promise<void> {
  const config = loadConfig({ requireTargetQq: true });
  const logger = createLogger(config.logLevel);

  for (const warning of config.warnings) {
    logger.warn(warning);
  }

  // 单实例保护：必须在开始轮询之前
  let lock: SingleInstanceLock;
  try {
    lock = await SingleInstanceLock.acquire({ filePath: config.lockFile, logger });
  } catch (error) {
    if (error instanceof InstanceAlreadyRunningError) {
      logger.error(
        `${error.message}；请先停止已有实例（任务计划程序中的任务，或原窗口的 Ctrl+C），不要同时运行两个监控进程。`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const detachExitHandler = lock.attachExitHandler();

  try {
    const store = await StateStore.load({ filePath: config.stateFile, logger });
    const runtime = buildRuntime({ config, logger });
    const heartbeat = new Heartbeat({ intervalMs: config.heartbeatIntervalMs, logger });
    const stats = createMonitorStats(runtime.provider.name);

    const controller = new AbortController();
    const shutdown = (signal: NodeJS.Signals): void => {
      if (controller.signal.aborted) return;
      logger.info(`收到 ${signal}，等待当前轮次结束后退出...`);
      controller.abort();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    logger.info('Warframe 裂缝监控启动', {
      ...describeConfig(config),
      lockPid: lock.info.pid,
      proxy: runtime.proxyDescription,
    });
    logger.info(
      `数据源: ${runtime.provider.name}；已加载 ${store.size} 条历史通知记录（来自 ${config.stateFile}）`,
    );
    if (config.dryRun) {
      logger.warn('DRY_RUN=true：只检测并打印，不会真正发送 QQ 消息');
    }

    await runMonitorLoop({
      intervalMs: config.pollIntervalMs,
      logger,
      signal: controller.signal,
      runCycle: async () => {
        stats.cycles += 1;

        const outcome = await runPollCycle({
          logger,
          store,
          dryRun: config.dryRun,
          fetchFissures: async () => {
            const result = await runtime.provider.fetchFissures();
            stats.provider = result.provider;
            return result.fissures;
          },
          sendMessage: (message) => runtime.napcat.sendPrivateMessage(runtime.targetQq, message),
        });

        if (outcome.error === null) {
          stats.lastSuccessAt = outcome.checkedAt;
          stats.lastFissureCount = outcome.fetchedCount;
        } else {
          stats.lastErrorAt = new Date();
        }

        if (config.dryRun && outcome.message !== null) {
          logger.info(`[DRY_RUN] 以下消息本应发送给已配置的 TARGET_QQ：\n${outcome.message}`);
        }

        // 心跳只写日志，绝不发送 QQ
        heartbeat.maybeLog(stats);
      },
    });
  } finally {
    await lock.release();
    detachExitHandler();
  }
}

main().catch((error: unknown) => {
  console.error(`[FATAL] 启动失败: ${describeError(error)}`);
  process.exitCode = 1;
});
