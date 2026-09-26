/**
 * 程序入口：加载配置 -> 获取单实例锁 -> 加载状态 -> 顺序轮询（带心跳与优雅退出）。
 */

import { buildRuntime, type MonitorRuntime } from './app.js';
import { describeConfig, loadConfig } from './config.js';
import { applyPollOutcome, createMonitorStats, Heartbeat } from './heartbeat.js';
import { InstanceAlreadyRunningError, SingleInstanceLock } from './lock.js';
import { createLogger, describeError } from './logger.js';
import { runPollCycle } from './poller.js';
import { runMonitorLoop } from './runner.js';
import { StateStore } from './state/store.js';
import { closeDispatcher } from './warframe/proxy.js';

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

  // 需要在 finally 里优雅关闭 Warframe dispatcher，因此在 try 之外声明
  let runtime: MonitorRuntime | undefined;

  try {
    const store = await StateStore.load({ filePath: config.stateFile, logger });
    const monitorRuntime = buildRuntime({ config, logger });
    runtime = monitorRuntime;
    const heartbeat = new Heartbeat({ intervalMs: config.heartbeatIntervalMs, logger });
    const stats = createMonitorStats(monitorRuntime.provider.name);

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
      proxy: monitorRuntime.proxyDescription,
      warframeDispatcher: monitorRuntime.dispatcherKind,
    });
    logger.info(
      `数据源: ${monitorRuntime.provider.name}；已加载 ${store.size} 条历史通知记录（来自 ${config.stateFile}）`,
    );
    if (config.dryRun) {
      logger.warn('DRY_RUN=true：只检测并打印，不会真正发送 QQ 消息');
    }

    await runMonitorLoop({
      intervalMs: config.pollIntervalMs,
      logger,
      signal: controller.signal,
      runCycle: async () => {
        const outcome = await runPollCycle({
          logger,
          store,
          dryRun: config.dryRun,
          fetchFissures: async () => {
            const result = await monitorRuntime.provider.fetchFissures();
            stats.provider = result.provider;
            return result.fissures;
          },
          sendMessage: (message) => monitorRuntime.napcat.sendPrivateMessage(monitorRuntime.targetQq, message),
        });

        // 统计语义：只有 provider 获取失败才算「本轮出错」；
        // NapCat 发送失败不影响「Warframe 最近成功获取时间」
        applyPollOutcome(stats, outcome);

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
    // 优雅关闭 Warframe 专用 dispatcher（直连 Agent / ProxyAgent 复用了整个进程生命周期）
    await closeDispatcher(runtime?.dispatcher, logger);
  }
}

main().catch((error: unknown) => {
  console.error(`[FATAL] 启动失败: ${describeError(error)}`);
  process.exitCode = 1;
});
