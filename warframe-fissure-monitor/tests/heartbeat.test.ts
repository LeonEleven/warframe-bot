/**
 * 心跳测试：间隔控制、日志内容、以及「心跳绝不发送 QQ」。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createMonitorStats, formatHeartbeat, Heartbeat } from '../src/heartbeat.js';
import type { NapCatSendResult } from '../src/notify/napcat.js';
import { runPollCycle } from '../src/poller.js';
import { StateStore } from '../src/state/store.js';
import { createMemoryLogger, withTempDir } from './helpers.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;

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
  stats.cycles = 57;
  stats.lastSuccessAt = new Date('2026-09-21T00:59:48.000Z');
  stats.lastFissureCount = 30;
  stats.lastErrorAt = new Date('2026-09-21T01:30:00.000Z');

  const text = formatHeartbeat(stats);

  assert.match(text, /^监控运行正常 /);
  assert.match(text, /provider=official/);
  assert.match(text, /累计轮询=57/);
  assert.match(text, /最近成功获取=2026-09-21T00:59:48\.000Z/);
  assert.match(text, /最近一次裂缝数量=30/);
  assert.match(text, /最近一次错误=2026-09-21T01:30:00\.000Z/);
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

test('心跳只写日志：反复触发心跳也绝不调用 NapCat', async () => {
  await withTempDir(async (dir) => {
    const logger = createMemoryLogger();
    const store = await StateStore.load({ filePath: path.join(dir, 'data', 'state.json'), logger });
    const sent: string[] = [];
    const sendMessage = async (message: string): Promise<NapCatSendResult> => {
      sent.push(message);
      return { ok: true, targetQq: '10001', endpoint: 'http://127.0.0.1:3000/send_private_msg', status: 'ok', retcode: 0 };
    };

    // 每轮都触发心跳（intervalMs = 0 的等价效果：每次都到点）
    let current = new Date('2026-09-21T00:00:00.000Z');
    const heartbeat = new Heartbeat({ intervalMs: 1, logger, now: () => current });
    const stats = createMonitorStats('official');

    for (let round = 0; round < 5; round += 1) {
      current = new Date(current.getTime() + 1_000);
      const outcome = await runPollCycle({
        logger,
        store,
        now: () => current,
        fetchFissures: async () => [],
        sendMessage,
      });
      assert.equal(outcome.error, null);

      stats.cycles += 1;
      stats.lastSuccessAt = outcome.checkedAt;
      stats.lastFissureCount = outcome.fetchedCount;
      assert.equal(heartbeat.maybeLog(stats), true);
    }

    assert.equal(sent.length, 0, '心跳绝不能触发 QQ 消息');
    assert.equal(logger.records.filter((record) => record.message.includes('监控运行正常')).length, 5);
  });
});
