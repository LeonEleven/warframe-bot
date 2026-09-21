/**
 * `npm run test:notification`
 *
 * 构造一条假的 Mot (Void) / Survival / Axi / isHard=true 裂缝，
 * 通过真实的 NapCat HTTP API 给 TARGET_QQ 发送一条测试通知。
 * 不依赖等待真实裂缝，也不会写入 data/state.json（不影响真实去重）。
 */

import { loadConfig, requireTargetQq } from '../config.js';
import { matchesFissureCriteria } from '../filter.js';
import { createLogger, describeError } from '../logger.js';
import { buildNotificationMessage } from '../notify/message.js';
import { NapCatClient, type NapCatSendResult } from '../notify/napcat.js';
import type { Fissure } from '../types.js';

function buildFakeFissure(now: Date): Fissure {
  const activation = new Date(now.getTime() - 60_000).toISOString();
  const expiry = new Date(now.getTime() + 30 * 60_000).toISOString();

  return {
    id: `test-notification-${now.getTime()}`,
    activation,
    expiry,
    node: 'Mot (Void)',
    nodeKey: 'Mot (Void)',
    missionType: 'Survival',
    missionTypeKey: 'Survival',
    enemy: 'Corrupted',
    tier: 'Axi',
    tierNum: 4,
    isHard: true,
    isStorm: false,
  };
}

async function main(): Promise<void> {
  const config = loadConfig({ requireTargetQq: true });
  const logger = createLogger(config.logLevel);
  const targetQq = requireTargetQq(config);
  const now = new Date();
  const fissure = buildFakeFissure(now);

  console.log('=========================================================');
  console.log(' NapCat 通知测试（构造假裂缝，真实发送）');
  console.log('=========================================================');
  console.log(`NapCat   : ${config.napcatBaseUrl}/send_private_msg`);
  console.log(`Token    : ${config.napcatToken === null ? '(未设置)' : '(已设置)'}`);
  console.log(`TARGET_QQ: ${targetQq}`);
  console.log(`超时     : ${config.napcatTimeoutMs} ms`);
  console.log(`假裂缝   : ${fissure.node} / ${fissure.missionType} / ${fissure.tier} / isHard=${fissure.isHard} / isStorm=${fissure.isStorm}`);
  console.log(`expiry   : ${fissure.expiry}`);
  console.log(`DRY_RUN  : ${config.dryRun}`);

  if (!matchesFissureCriteria(fissure, now)) {
    console.error('');
    console.error('✗ 内部错误：构造的假裂缝没有通过匹配条件，请检查 filter 逻辑。');
    process.exitCode = 1;
    return;
  }
  console.log('✓ 假裂缝通过匹配条件（Steel Path + Survival + Void + 未过期）');

  const message = buildNotificationMessage([fissure], now, {
    title: '【Warframe 裂缝监控 · 测试通知】',
    footer: '说明：这是一条由 npm run test:notification 发送的测试消息，未写入 data/state.json。',
  });

  console.log('');
  console.log('----- 消息内容 -----');
  console.log(message);
  console.log('--------------------');
  console.log('');

  if (config.dryRun) {
    console.log('DRY_RUN=true，未实际调用 NapCat（把 .env 里的 DRY_RUN 改成 false 即可真实发送）。');
    return;
  }

  const client = new NapCatClient({
    baseUrl: config.napcatBaseUrl,
    token: config.napcatToken,
    timeoutMs: config.napcatTimeoutMs,
    logger,
  });

  let result: NapCatSendResult;
  try {
    result = await client.sendPrivateMessage(targetQq, message);
  } catch (error) {
    console.error(`✗ 调用 NapCat 时发生异常: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }

  if (result.ok) {
    console.log(`✓ 发送成功（status=ok, retcode=0）-> QQ ${targetQq}`);
    console.log('  注意：测试通知不会写入 data/state.json，不影响真实去重。');
    return;
  }

  console.error(`✗ 发送失败: ${result.error ?? '未知原因'}`);
  if (result.detail !== undefined) console.error(`  NapCat 响应: ${result.detail}`);
  console.error('  排查建议：');
  console.error('   1. NapCat 是否已启动，且 HTTP 服务端口与 NAPCAT_BASE_URL 一致');
  console.error('   2. 若 NapCat 配置了 token，.env 里的 NAPCAT_TOKEN 必须一致');
  console.error('   3. TARGET_QQ 是否是机器人好友（非好友无法发送私聊）');
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`[FATAL] 测试通知失败: ${describeError(error)}`);
  process.exitCode = 1;
});
