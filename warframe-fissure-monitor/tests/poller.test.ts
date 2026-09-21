/**
 * 轮询流程测试：
 * - 只有 NapCat 发送成功才写入已通知状态
 * - 发送失败 -> 不写状态，下一轮重试
 * - Warframe 请求失败 -> 绝不给 QQ 发消息
 * - 多次匹配合并为一条消息
 */

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { NapCatSendResult } from '../src/notify/napcat.js';
import { runPollCycle, type PollDependencies, type PollOutcome } from '../src/poller.js';
import { StateStore } from '../src/state/store.js';
import type { Fissure } from '../src/types.js';
import { FIXED_NOW, createMemoryLogger, makeFissure, withTempDir, type MemoryLogger } from './helpers.js';

const ENDPOINT = 'http://127.0.0.1:3000/send_private_msg';

function okResult(): NapCatSendResult {
  return { ok: true, targetQq: '10001', endpoint: ENDPOINT, status: 'ok', retcode: 0 };
}

function failResult(error = 'NapCat 发送失败：status=failed, retcode=100'): NapCatSendResult {
  return { ok: false, targetQq: '10001', endpoint: ENDPOINT, status: 'failed', retcode: 100, error };
}

interface Harness {
  filePath: string;
  logger: MemoryLogger;
  store: StateStore;
  sent: string[];
  /** 设置本轮的裂缝数据；传函数可模拟请求失败 */
  setFissures(source: Fissure[] | (() => Promise<Fissure[]>)): void;
  /** 设置下一轮 NapCat 是否成功 */
  setSendOk(ok: boolean): void;
  run(options?: { dryRun?: boolean; store?: StateStore }): Promise<PollOutcome>;
  reload(): Promise<StateStore>;
  exists(): Promise<boolean>;
}

async function createHarness(dir: string, now: Date = FIXED_NOW): Promise<Harness> {
  const filePath = path.join(dir, 'data', 'state.json');
  const logger = createMemoryLogger();
  const store = await StateStore.load({ filePath, logger, now: () => now });

  let source: Fissure[] | (() => Promise<Fissure[]>) = [];
  let sendOk = true;
  const sent: string[] = [];

  const deps: PollDependencies = {
    store,
    logger,
    now: () => now,
    fetchFissures: async () => (typeof source === 'function' ? source() : source),
    sendMessage: async (message: string) => {
      sent.push(message);
      return sendOk ? okResult() : failResult();
    },
  };

  return {
    filePath,
    logger,
    store,
    sent,
    setFissures: (next) => {
      source = next;
    },
    setSendOk: (ok) => {
      sendOk = ok;
    },
    run: (options = {}) =>
      runPollCycle({ ...deps, store: options.store ?? store, dryRun: options.dryRun ?? false }),
    reload: () => StateStore.load({ filePath, logger, now: () => now }),
    exists: async () => {
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

test('成功发送后才写入已通知状态', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures([makeFissure({ id: 'steel-void-survival' })]);

    const outcome = await harness.run();

    assert.equal(outcome.notified, true);
    assert.equal(outcome.fetchedCount, 1);
    assert.equal(outcome.matchedCount, 1);
    assert.equal(outcome.pendingCount, 1);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.store.has('steel-void-survival'), true);
    assert.equal(await harness.exists(), true);
  });
});

test('同一轮内不会重复通知，且已通知的裂缝不会再次发送', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures([makeFissure({ id: 'steel-void-survival' })]);

    await harness.run();
    const second = await harness.run();

    assert.equal(harness.sent.length, 1, '已通知过的裂缝不应再次发送');
    assert.equal(second.notified, false);
    assert.equal(second.matchedCount, 1);
    assert.equal(second.pendingCount, 0);
  });
});

test('程序重启加载 state.json 后仍然不重复通知', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures([makeFissure({ id: 'restart-case' })]);
    await harness.run();
    assert.equal(harness.sent.length, 1);

    // 模拟进程重启：新的 StateStore 实例 + 新的依赖
    const restarted = await harness.reload();
    assert.equal(restarted.has('restart-case'), true);

    const second = await harness.run({ store: restarted });

    assert.equal(second.notified, false);
    assert.equal(second.pendingCount, 0);
    assert.equal(harness.sent.length, 1);
  });
});

test('NapCat 发送失败时不得写入已通知状态，下一轮会重试', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures([makeFissure({ id: 'retry-case' })]);
    harness.setSendOk(false);

    const failed = await harness.run();

    assert.equal(harness.sent.length, 1);
    assert.equal(failed.notified, false);
    assert.notEqual(failed.error, null);
    assert.equal(harness.store.has('retry-case'), false);
    assert.equal(await harness.exists(), false, '发送失败时不应写入 state.json');
    const afterFailure = await harness.reload();
    assert.equal(afterFailure.size, 0);

    // 下一轮：允许再次尝试
    harness.setSendOk(true);
    const retried = await harness.run();

    assert.equal(harness.sent.length, 2, '发送失败后下一轮应重新尝试');
    assert.equal(retried.notified, true);
    assert.equal(harness.store.has('retry-case'), true);
  });
});

test('Warframe 请求失败时记录错误但不给 QQ 发送任何消息', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures(async () => {
      throw new Error('Warframe API 返回 HTTP 503');
    });

    const outcome = await harness.run();

    assert.equal(harness.sent.length, 0, '拉取失败时绝不能给 QQ 发消息');
    assert.notEqual(outcome.error, null);
    assert.match(outcome.error ?? '', /HTTP 503/);
    assert.equal(outcome.matchedCount, 0);
    assert.equal(await harness.exists(), false);
    assert.ok(harness.logger.text().includes('本轮跳过'));
  });
});

test('一轮中的多个新匹配裂缝合并为一条 QQ 消息', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures([
      makeFissure({ id: 'a', node: 'Ani (Void)', nodeKey: 'Ani (Void)' }),
      makeFissure({ id: 'b', node: 'Mot (Void)', nodeKey: 'Mot (Void)', tier: 'Neo', tierNum: 3 }),
      makeFissure({ id: 'c', node: 'Taveuni (Kuva Fortress)', nodeKey: 'Taveuni (Kuva Fortress)' }),
      makeFissure({ id: 'd', isHard: false }),
    ]);

    const outcome = await harness.run();

    assert.equal(harness.sent.length, 1, '多条新裂缝只发一条消息');
    const message = harness.sent[0] ?? '';
    assert.match(message, /Ani \(Void\)/);
    assert.match(message, /Mot \(Void\)/);
    assert.doesNotMatch(message, /Taveuni/);
    assert.equal(outcome.pendingCount, 2);
    assert.equal(harness.store.has('a'), true);
    assert.equal(harness.store.has('b'), true);
    assert.equal(harness.store.has('c'), false);
  });
});

test('DRY_RUN 只生成消息，不发送也不写状态', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures([makeFissure({ id: 'dry-run-case' })]);

    const outcome = await harness.run({ dryRun: true });

    assert.equal(harness.sent.length, 0);
    assert.equal(outcome.notified, false);
    assert.notEqual(outcome.message, null);
    assert.match(outcome.message ?? '', /Ani \(Void\)/);
    assert.equal(harness.store.has('dry-run-case'), false);
    assert.equal(await harness.exists(), false);
  });
});

test('轮询时清理已过期至少 2 小时的历史 ID 并持久化', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    const threeHoursAgo = new Date(FIXED_NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    harness.store.markNotified(makeFissure({ id: 'stale', expiry: threeHoursAgo }));
    await harness.store.save();

    harness.setFissures([]);
    const outcome = await harness.run();

    assert.deepEqual(outcome.prunedIds, ['stale']);
    assert.equal(harness.store.has('stale'), false);

    const reloaded = await harness.reload();
    assert.equal(reloaded.has('stale'), false);
    assert.equal(reloaded.size, 0);
  });
});

test('不匹配的裂缝不会触发发送', async () => {
  await withTempDir(async (dir) => {
    const harness = await createHarness(dir);
    harness.setFissures([
      makeFissure({ id: 'not-sp', isHard: false }),
      makeFissure({ id: 'storm', isStorm: true }),
      makeFissure({ id: 'not-void', node: 'Adaro (Sedna)', nodeKey: 'Adaro (Sedna)' }),
      makeFissure({ id: 'not-survival', missionType: 'Defense', missionTypeKey: 'Defense' }),
      makeFissure({ id: 'expired', expiry: '2026-01-01T11:00:00.000Z' }),
    ]);

    const outcome = await harness.run();

    assert.equal(harness.sent.length, 0);
    assert.equal(outcome.matchedCount, 0);
    assert.equal(await harness.exists(), false);
  });
});
