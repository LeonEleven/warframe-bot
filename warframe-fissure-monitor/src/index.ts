/**
 * 程序入口：加载配置 -> 加载状态 -> 循环检查。
 */

import { describeConfig, loadConfig, requireTargetQq } from './config.js';
import { createLogger, describeError } from './logger.js';
import { NapCatClient } from './notify/napcat.js';
import { runPollCycle } from './poller.js';
import { runMonitorLoop } from './runner.js';
import { StateStore } from './state/store.js';
import { fetchFissures } from './warframe/client.js';

async function main(): Promise<void> {
  const config = loadConfig({ requireTargetQq: true });
  const logger = createLogger(config.logLevel);
  const targetQq = requireTargetQq(config);

  const store = await StateStore.load({ filePath: config.stateFile, logger });
  const napcat = new NapCatClient({
    baseUrl: config.napcatBaseUrl,
    token: config.napcatToken,
    timeoutMs: config.napcatTimeoutMs,
    logger,
  });

  const controller = new AbortController();
  const shutdown = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) return;
    logger.info(`收到 ${signal}，正在退出...`);
    controller.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('Warframe 裂缝监控启动', describeConfig(config));
  logger.info(`已加载 ${store.size} 条历史通知记录（来自 ${config.stateFile}）`);
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
        fetchFissures: () => fetchFissures({ apiUrl: config.warframeApiUrl, timeoutMs: config.httpTimeoutMs, logger }),
        sendMessage: (message) => napcat.sendPrivateMessage(targetQq, message),
      });

      if (config.dryRun && outcome.message !== null) {
        logger.info(`[DRY_RUN] 以下消息本应发送给 QQ ${targetQq}：\n${outcome.message}`);
      }
    },
  });
}

main().catch((error: unknown) => {
  console.error(`[FATAL] 启动失败: ${describeError(error)}`);
  process.exitCode = 1;
});
