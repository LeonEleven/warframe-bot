/**
 * 心跳测试：间隔控制、日志内容、「心跳绝不发送 QQ」，
 * 以及「取数据成功」与「发通知成功」的语义区分。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { applyPollOutcome, createMonitorStats, formatHeartbeat, Heartbeat } from '../src/heartbeat.js';
import type { NapCatSendResult } from '../src/notify/napcat.js';
import { runPollCycle } from '../src/poller.js';
import { StateStore } from '../src/state/store.js';
import { formatLocalTimestamp } from '../src/time.js';
import { createMemoryLogger, makeFissure, withTempDir } from './helpers.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const NOW = new Date('2026-01-01T12:00:00.000Z');

function okSendResult(): NapCatSendResult {
  return {
    ok: true,
    targetQq: '10001',
    endpoint: 'http://127.0.0.1:3000/send_private_msg',
    status: 'ok',
    retcode: 0,
  };
}

function failedSendResult(): NapCatSendResult {
  return {
    ok: false,
    targetQq: '10001',
    endpoint: 'http://127.0.0.1:3000/send_private_msg',
    status: 'failed',
    retcode: 100,
    error: 'NapCat 发送失败：status=failed, retcode=100',
  };
}

/** 建一个只依赖内存/临时目录的轮询环境 */
async function createCycleContext(dir: string, sendResult: NapCatSendResult | (() => Promise<NapCatSendResult>)) {
  const logger = createMemoryLogger();
  const store = await StateStore.load({ filePath: path.join(dir, 'data', 'state.json'), logger, now: () => NOW });
  const sent: string[] = [];

  return {
    logger,
    store,
    sent,
    run: (fetchFissures: () => Promise<ReturnType<typeof makeFissure>[]>) =>
      runPollCycle({
        logger,
        store,
        now: () => NOW,
        fetchFissures,
        sendMessage: async (message: string) => {
          sent.push(message);
          return typeof sendResult === 'function' ? sendResult() : sendResult;
        },
      }),
  };
}

test('未到间隔不输出，到达间隔输出一次', () => {
  const logger = createMemoryLogger();
  let current = new Date('2026-09-21T00:00:00.000Z');
  const heartbeat = new Heartbeat({ intervalMs: SIX_HOURS, logger, now: () => current });
  const stats = createMonitorStats('official');
  stats.cycles = 10;
  stats.lastSuccessAt = current;
  stats.lastFissureCount = 30;

  assert.equal(heartbeat.maybeLog(stats), false, '刚启动时不应输出');
  assert.equal(heartbeat.nextDueInMs(), SIX_HOURS);

  current = new Date(current.getTime() + 60 * 60 * 1000);
  assert.equal(heartbeat.maybeLog(stats), false, '1 小时后不应输出');

  current = new Date(current.getTime() + 5 * 60 * 60 * 1000);
  assert.equal(heartbeat.maybeLog(stats), true, '累计 6 小时后应输出');
  assert.equal(heartbeat.maybeLog(stats), false, '刚输出过不应重复');

  assert.equal(logger.records.filter((record) => record.level === 'info').length, 1);
});

test('心跳文本包含 provider / 累计轮询 / 最近成功获取 / 最近一次裂缝数量', () => {
  const stats = createMonitorStats('official');
  const successAt = new Date('2026-09-21T00:59:48.000Z');
  const errorAt = new Date('2026-09-21T01:30:00.000Z');
  stats.cycles = 57;
  stats.lastSuccessAt = successAt;
  stats.lastFissureCount = 30;
  stats.lastErrorAt = errorAt;

  const text = formatHeartbeat(stats);

  assert.match(text, /^监控运行正常 /);
  assert.match(text, /provider=official/);
  assert.match(text, /累计轮询=57/);
  assert.match(text, /最近一次裂缝数量=30/);
  // 时间使用运行机器的本地时区（与日志前缀一致），因此用同一个 formatter 计算期望值，避免依赖 CI 机器时区
  assert.ok(
    text.includes(`最近成功获取=${formatLocalTimestamp(successAt)}`),
    `最近成功获取应为本地时间格式，实际：${text}`,
  );
  assert.ok(
    text.includes(`最近一次错误=${formatLocalTimestamp(errorAt)}`),
    `最近一次错误应为本地时间格式，实际：${text}`,
  );
  assert.ok(!text.includes('Z'), '心跳文本不得再出现 UTC 的 Z 后缀');
  assert.match(text, /最近成功获取=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/);
});

test('从未成功获取时心跳仍然可读', () => {
  const stats = createMonitorStats('auto');
  const text = formatHeartbeat(stats);

  assert.match(text, /provider=auto/);
  assert.match(text, /累计轮询=0/);
  assert.match(text, /最近成功获取=从未/);
  assert.match(text, /最近一次裂缝数量=未知/);
  assert.doesNotMatch(text, /最近一次错误/);
});

test('Warframe 获取成功但 NapCat 发送失败：lastSuccessAt 仍然更新，且不污染 lastErrorAt', async () => {
  await withTempDir(async (dir) => {
    const context = await createCycleContext(dir, failedSendResult());
    const stats = createMonitorStats('official');

    const outcome = await context.run(async () => [makeFissure({ id: 'steel-void-survival' })]);
    applyPollOutcome(stats, outcome);

    // 取数据确实成功
    assert.equal(outcome.fetchSucceeded, true);
    assert.equal(outcome.fetchError, null);
    assert.equal(outcome.fetchedCount, 1);

    // 通知确实失败
    assert.equal(context.sent.length, 1);
    assert.notEqual(outcome.notificationError, null);
    assert.equal(outcome.error, outcome.notificationError);

    // 心跳统计语义：取成功就算成功
    assert.equal(stats.lastSuccessAt?.toISOString(), NOW.toISOString(), '取数据成功必须刷新 lastSuccessAt');
    assert.equal(stats.lastFissureCount, 1);
    assert.equal(stats.lastErrorAt, null, 'NapCat 失败不算 Warframe 获取失败');

    // 通知失败仍然要 logger.error，且不写 state（下一轮重试）
    assert.ok(context.logger.records.some((record) => record.level === 'error'));
    const reloaded = await StateStore.load({
      filePath: path.join(dir, 'data', 'state.json'),
      logger: context.logger,
      now: () => NOW,
    });
    assert.equal(reloaded.size, 0, 'NapCat 失败绝不能写入 state.json');
  });
});

test('provider 获取失败：更新 lastErrorAt，且不刷新 lastSuccessAt / lastFissureCount', async () => {
  await withTempDir(async (dir) => {
    const context = await createCycleContext(dir, okSendResult());
    const stats = createMonitorStats('official');
    const previousSuccess = new Date('2026-01-01T11:30:00.000Z');
    stats.lastSuccessAt = previousSuccess;
    stats.lastFissureCount = 30;

    const outcome = await context.run(async () => {
      throw new Error('official WorldState 获取失败: HTTP 502');
    });
    applyPollOutcome(stats, outcome);

    assert.equal(outcome.fetchSucceeded, false);
    assert.notEqual(outcome.fetchError, null);
    assert.equal(outcome.notificationError, null);
    assert.equal(outcome.error, outcome.fetchError);

    assert.equal(stats.lastErrorAt?.toISOString(), NOW.toISOString(), '获取失败必须更新 lastErrorAt');
    assert.equal(stats.lastSuccessAt, previousSuccess, '获取失败不得刷新 lastSuccessAt');
    assert.equal(stats.lastFissureCount, 30, '获取失败不得改变最近裂缝数量');
    assert.equal(context.sent.length, 0, '获取失败不得发送 QQ');
    assert.equal(stats.cycles, 1);
  });
});

test('获取成功但没有匹配裂缝：同样算成功（不更新 lastErrorAt）', async () => {
  await withTempDir(async (dir) => {
    const context = await createCycleContext(dir, okSendResult());
    const stats = createMonitorStats('official');

    const outcome = await context.run(async () => [makeFissure({ id: 'not-matching', isHard: false })]);
    applyPollOutcome(stats, outcome);

    assert.equal(outcome.fetchSucceeded, true);
    assert.equal(outcome.matchedCount, 0);
    assert.equal(stats.lastSuccessAt?.toISOString(), NOW.toISOString());
    assert.equal(stats.lastFissureCount, 1);
    assert.equal(stats.lastErrorAt, null);
    assert.equal(context.sent.length, 0);
  });
});

test('心跳只写日志：反复触发心跳也绝不调用 NapCat', async () => {
  await withTempDir(async (dir) => {
    const context = await createCycleContext(dir, okSendResult());
    const sent = context.sent;

    // 每轮都触发心跳（intervalMs = 1 的等价效果：每次都到点）
    let current = new Date('2026-09-21T00:00:00.000Z');
    const heartbeat = new Heartbeat({ intervalMs: 1, logger: context.logger, now: () => current });
    const stats = createMonitorStats('official');

    for (let round = 0; round < 5; round += 1) {
      current = new Date(current.getTime() + 1_000);
      const outcome = await context.run(async () => []);
      applyPollOutcome(stats, outcome);
      assert.equal(outcome.error, null);

      assert.equal(heartbeat.maybeLog(stats), true);
    }

    assert.equal(sent.length, 0, '心跳绝不能触发 QQ 消息');
    assert.equal(stats.cycles, 5, 'applyPollOutcome 负责累计轮询次数');
    assert.equal(context.logger.records.filter((record) => record.message.includes('监控运行正常')).length, 5);
  });
});
