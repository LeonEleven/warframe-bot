/**
 * `npm run check`
 *
 * 真实调用 Warframe 数据源（默认 official WorldState），展示：
 *   - 当前 provider 与数据 URL
 *   - 获取到的裂缝数量 / Steel Path 数量 / 最终符合数量
 *   - 每个匹配项的完整开发者信息
 *   - 将要发送的 QQ 消息预览
 *
 * 该命令**绝不**发送 QQ 消息，也**绝不**修改 notified state。
 */

import { buildFissureProviderBundle } from '../app.js';
import { describeConfig, loadConfig } from '../config.js';
import { countSteelPathFissures, MATCH_CRITERIA_DESCRIPTION, selectMatchingFissures } from '../filter.js';
import { createLogger, describeError } from '../logger.js';
import {
  buildNotificationMessage,
  formatFissureDetail,
  formatFissureLine,
  formatLocalDateTime,
} from '../notify/message.js';
import { StateStore } from '../state/store.js';
import { describeProvider } from '../warframe/provider.js';

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
  console.log(`数据源配置 : WARFRAME_SOURCE=${config.warframeSource}`);
  console.log(`匹配条件   : ${MATCH_CRITERIA_DESCRIPTION}`);
  console.log(`检查时间   : ${formatLocalDateTime(now)}`);
  console.log(`请求超时   : ${config.httpTimeoutMs} ms`);
  console.log(`状态文件   : ${config.stateFile}`);
  console.log(`代理       : ${config.warframeProxyUrl === null ? '未启用（official 通常无需代理）' : '(已启用，地址已脱敏)'}`);
  console.log(`配置概览   : ${JSON.stringify(describeConfig(config))}`);

  for (const warning of config.warnings) {
    console.log(`⚠ 配置提示  : ${warning}`);
  }

  const bundle = buildFissureProviderBundle({ config, logger });

  section('数据源');
  console.log(`provider   : ${bundle.provider.name}`);
  console.log(`数据 URL   : ${describeProvider(bundle.provider)}`);

  let result;
  try {
    result = await bundle.provider.fetchFissures();
  } catch (error) {
    console.error('');
    console.error(`✗ 获取裂缝数据失败：${describeError(error)}`);
    if (bundle.provider.name !== 'warframestat') {
      console.error('  提示：official WorldState 可以直连测试，命令见 README「如何测试官方 WorldState 是否可以直连」。');
    }
    console.error('  监控进程会在下一轮自动重试；本命令不会发送任何 QQ 消息。');
    process.exitCode = 1;
    return;
  }

  const fissures = result.fissures;
  const matched = selectMatchingFissures(fissures, now);
  const matchedIds = new Set(matched.map((fissure) => fissure.id));
  const store = await StateStore.load({ filePath: config.stateFile, logger });
  const pending = matched.filter((fissure) => !store.has(fissure.id));

  section('获取结果');
  if (bundle.provider.name === 'auto' && result.provider !== 'official') {
    console.log(`⚠ official 获取失败 -> fallback 到 ${result.provider}`);
  }
  console.log(`实际使用 provider : ${result.provider}`);
  console.log(`请求 URL          : ${result.url}`);
  console.log(`获取裂缝数量      : ${fissures.length}${result.skipped > 0 ? `（另有 ${result.skipped} 条脏记录被跳过）` : ''}`);
  console.log(`Steel Path 数量   : ${countSteelPathFissures(fissures)}`);
  console.log(`最终符合数量      : ${matched.length}（Steel Path + Void + Survival + 非 VoidStorm + 未过期）`);
  console.log(`其中未通知过      : ${pending.length}（npm start 时会通知）`);
  console.log(`其中已通知过      : ${matched.length - pending.length}（去重状态，会被跳过）`);

  section('最终匹配项（开发者信息）');
  if (matched.length === 0) {
    console.log('（当前没有满足条件的裂缝）');
  } else {
    for (const fissure of matched) {
      console.log(`[${store.has(fissure.id) ? '已通知' : '未通知'}]`);
      console.log(formatFissureDetail(fissure, now));
      console.log('');
    }
  }

  if (pending.length > 0) {
    section('QQ 消息预览（仅预览，不会发送）');
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
    console.log(`${matchedIds.has(fissure.id) ? '[匹配]' : '[    ]'} ${formatFissureLine(fissure, now)}`);
  }

  section('已通知历史（state.json，只读）');
  if (store.size === 0) {
    console.log('（空）');
  } else {
    for (const entry of store.entriesSnapshot()) {
      console.log(`${entry.id} | expiry=${entry.expiry} | notifiedAt=${entry.notifiedAt}`);
    }
  }

  console.log('');
  console.log('完成：本次检查没有发送任何 QQ 消息，也没有修改 notified state。');
}

main().catch((error: unknown) => {
  console.error(`[FATAL] 检查失败: ${describeError(error)}`);
  process.exitCode = 1;
});
