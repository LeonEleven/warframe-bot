/**
 * 主循环测试：确认「上一轮结束后才等待间隔」、不会重叠、单轮错误不终止循环。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMonitorLoop } from '../src/runner.js';
import { createMemoryLogger } from './helpers.js';

const INTERVAL = 60_000;

test('顺序执行：每轮完成后才等待间隔，且任意时刻只有一轮在跑', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  await runMonitorLoop({
    intervalMs: INTERVAL,
    logger: createMemoryLogger(),
    signal: controller.signal,
    runCycle: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('cycle');
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    },
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      if (events.filter((event) => event === 'cycle').length >= 3) controller.abort();
    },
  });

  assert.equal(maxActive, 1, '不允许任务重叠');
  assert.deepEqual(events, [
    'cycle',
    `sleep:${INTERVAL}`,
    'cycle',
    `sleep:${INTERVAL}`,
    'cycle',
    `sleep:${INTERVAL}`,
  ]);
});

test('单轮抛错不会终止循环', async () => {
  const controller = new AbortController();
  const logger = createMemoryLogger();
  const events: string[] = [];
  let rounds = 0;

  await runMonitorLoop({
    intervalMs: INTERVAL,
    logger,
    signal: controller.signal,
    runCycle: async () => {
      rounds += 1;
      events.push(`cycle${rounds}`);
      if (rounds === 1) throw new Error('boom');
    },
    sleep: async () => {
      events.push('sleep');
      if (rounds >= 2) controller.abort();
    },
  });

  assert.deepEqual(events, ['cycle1', 'sleep', 'cycle2', 'sleep']);
  assert.ok(logger.text().includes('未捕获错误'));
  assert.ok(logger.text().includes('boom'));
});

test('sleep 抛 AbortError 时优雅结束', async () => {
  const controller = new AbortController();
  let rounds = 0;

  await runMonitorLoop({
    intervalMs: INTERVAL,
    logger: createMemoryLogger(),
    signal: controller.signal,
    runCycle: async () => {
      rounds += 1;
    },
    sleep: async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
  });

  assert.equal(rounds, 1);
});

test('signal 已经 abort 时不会执行任何检查', async () => {
  const controller = new AbortController();
  controller.abort();
  let rounds = 0;

  await runMonitorLoop({
    intervalMs: INTERVAL,
    logger: createMemoryLogger(),
    signal: controller.signal,
    runCycle: async () => {
      rounds += 1;
    },
  });

  assert.equal(rounds, 0);
});
