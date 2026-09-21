/**
 * `npm run check`
 *
 * 真实调用 Warframe API，展示当前所有裂缝、匹配结果与去重状态。
 * 该命令「绝不」发送任何 QQ 消息。
 */

import { describeConfig, loadConfig } from '../config.js';
import { MATCH_CRITERIA_DESCRIPTION, selectMatchingFissures } from '../filter.js';
import { createLogger, describeError } from '../logger.js';
import { buildNotificationMessage, formatFissureLine, formatLocalDateTime } from '../notify/message.js';
import { StateStore } from '../state/store.js';
import type { Fissure } from '../types.js';
import { fetchFissures } from '../warframe/client.js';

function section(title: string): void {
  console.log('');
  console.log(`----- ${title} -----`);
}

async function main(): Promise<void> {
  const config = loadConfig({ requireTargetQq: false });
  const logger = createLogger(config.logLevel);
  const now = new Date();

  console.log('=========================================================');
  console.log(' Warframe 裂缝监控 · 检查模式（不会发送任何 QQ 消息）');
  console.log('=========================================================');
  console.log(`数据源   : ${config.warframeApiUrl}`);
  console.log(`检查时间 : ${formatLocalDateTime(now)}`);
  console.log(`匹配条件 : ${MATCH_CRITERIA_DESCRIPTION}`);
  console.log(`请求超时 : ${config.httpTimeoutMs} ms`);
  console.log(`状态文件 : ${config.stateFile}`);
  console.log(`QQ 通知  : 本命令不发送（TARGET_QQ=${config.targetQq ?? '未配置'}）`);
  console.log(`配置概览 : ${JSON.stringify(describeConfig(config))}`);

  let fissures: Fissure[];
  try {
    fissures = await fetchFissures({
      apiUrl: config.warframeApiUrl,
      timeoutMs: config.httpTimeoutMs,
      logger,
    });
  } catch (error) {
    console.error('');
    console.error(`✗ 获取 Warframe 裂缝数据失败：${describeError(error)}`);
    console.error('  （仅本次检查失败；监控进程会在下一轮自动重试）');
    process.exitCode = 1;
    return;
  }

  const store = await StateStore.load({ filePath: config.stateFile, logger });
  const matched = selectMatchingFissures(fissures, now);
  const matchedIds = new Set(matched.map((fissure) => fissure.id));
  const pending = matched.filter((fissure) => !store.has(fissure.id));

  section('汇总');
  console.log(`裂缝总数        : ${fissures.length}`);
  console.log(`匹配条件        : ${matched.length}`);
  console.log(`其中未通知过    : ${pending.length}（运行 npm start 时会被通知）`);
  console.log(`其中已通知过    : ${matched.length - pending.length}（去重状态，会被跳过）`);
  console.log(`历史记录总数    : ${store.size}`);

  section('匹配结果（Steel Path · Survival · Void · 未过期）');
  if (matched.length === 0) {
    console.log('（当前没有满足条件的裂缝）');
  } else {
    for (const fissure of matched) {
      const notified = store.has(fissure.id) ? '已通知' : '未通知';
      console.log(`[匹配][${notified}] ${formatFissureLine(fissure, now)}`);
    }
  }

  if (pending.length > 0) {
    section('将要发送的 QQ 消息预览（仅预览，不会发送）');
    console.log(buildNotificationMessage(pending, now));
  }

  section('全部裂缝');
  const sorted = [...fissures].sort((a, b) => {
    const left = matchedIds.has(a.id) ? 0 : 1;
    const right = matchedIds.has(b.id) ? 0 : 1;
    if (left !== right) return left - right;
    return a.node.localeCompare(b.node);
  });
  for (const fissure of sorted) {
    const marker = matchedIds.has(fissure.id) ? '[匹配]' : '[    ]';
    console.log(`${marker} ${formatFissureLine(fissure, now)}`);
  }

  section('已通知历史（state.json）');
  if (store.size === 0) {
    console.log('（空）');
  } else {
    for (const entry of store.entriesSnapshot()) {
      console.log(`${entry.id} | expiry=${entry.expiry} | notifiedAt=${entry.notifiedAt}`);
    }
  }

  console.log('');
  console.log('完成：本次检查没有发送任何 QQ 消息。');
}

main().catch((error: unknown) => {
  console.error(`[FATAL] 检查失败: ${describeError(error)}`);
  process.exitCode = 1;
});
