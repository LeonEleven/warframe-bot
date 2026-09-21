/**
 * 持久化去重状态测试：写入、重启加载、2 小时清理、损坏文件容错。
 */

import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { PRUNE_AFTER_MS, StateStore } from '../src/state/store.js';
import { createMemoryLogger, makeFissure, withTempDir } from './helpers.js';

const HOUR = 60 * 60 * 1000;

test('markNotified + save 后可被重新加载（模拟进程重启）', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'data', 'state.json');
    const logger = createMemoryLogger();

    const store = await StateStore.load({ filePath, logger });
    assert.equal(store.size, 0);

    store.markNotified(makeFissure({ id: 'fissure-1', expiry: '2026-01-01T12:30:00.000Z' }));
    await store.save();

    const reloaded = await StateStore.load({ filePath, logger });
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.has('fissure-1'), true);
    assert.equal(reloaded.get('fissure-1')?.expiry, '2026-01-01T12:30:00.000Z');

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      notified: Record<string, { expiry: string; notifiedAt: string }>;
    };
    assert.equal(raw.version, 1);
    assert.equal(Object.keys(raw.notified).length, 1);
    assert.equal(raw.notified['fissure-1']?.expiry, '2026-01-01T12:30:00.000Z');
    assert.ok(typeof raw.notified['fissure-1']?.notifiedAt === 'string');
  });
});

test('重启后已通知的 fissure 不允许再次通知', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'state.json');
    const logger = createMemoryLogger();

    const first = await StateStore.load({ filePath, logger });
    first.markNotified(makeFissure({ id: 'already-notified' }));
    await first.save();

    // 模拟进程重启：全新的 store 实例，从磁盘读取
    const second = await StateStore.load({ filePath, logger });
    assert.equal(second.has('already-notified'), true);
    assert.equal(second.has('another-fissure'), false);
  });
});

test('pruneExpired 删除已过期至少 2 小时的历史 ID', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'state.json');
    const logger = createMemoryLogger();
    const now = new Date('2026-01-01T12:00:00.000Z');

    const store = await StateStore.load({ filePath, logger, now: () => now });
    store.markNotified(makeFissure({ id: 'expired-long-ago', expiry: new Date(now.getTime() - 3 * HOUR).toISOString() }));
    store.markNotified(makeFissure({ id: 'expired-just-now', expiry: new Date(now.getTime() - 1 * HOUR).toISOString() }));
    store.markNotified(makeFissure({ id: 'still-active', expiry: new Date(now.getTime() + 1 * HOUR).toISOString() }));
    await store.save();

    const removed = store.pruneExpired(now);
    assert.deepEqual(removed, ['expired-long-ago']);
    assert.equal(store.has('expired-long-ago'), false);
    assert.equal(store.has('expired-just-now'), true);
    assert.equal(store.has('still-active'), true);

    await store.save();
    const reloaded = await StateStore.load({ filePath, logger });
    assert.deepEqual(reloaded.ids(), ['expired-just-now', 'still-active']);
  });
});

test('prune 边界：刚好 2 小时前过期的记录会被保留', async () => {
  await withTempDir(async (dir) => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const store = await StateStore.load({ filePath: path.join(dir, 'state.json'), now: () => now });
    const boundary = new Date(now.getTime() - PRUNE_AFTER_MS + 1_000).toISOString();
    store.markNotified(makeFissure({ id: 'boundary', expiry: boundary }));

    assert.deepEqual(store.pruneExpired(now), []);
    assert.equal(store.has('boundary'), true);
  });
});

test('状态文件不存在时从空状态开始', async () => {
  await withTempDir(async (dir) => {
    const store = await StateStore.load({ filePath: path.join(dir, 'missing', 'state.json') });
    assert.equal(store.size, 0);
    assert.deepEqual(store.ids(), []);
  });
});

test('状态文件损坏时从空状态开始并备份原文件', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'state.json');
    await writeFile(filePath, '{ this is not json', 'utf8');
    const logger = createMemoryLogger();

    const store = await StateStore.load({ filePath, logger });
    assert.equal(store.size, 0);
    assert.ok(logger.text().includes('状态文件无法使用'));

    const backups = await readdir(dir);
    assert.ok(backups.some((name) => name.includes('.corrupt-') && name.endsWith('.bak')));
  });
});

test('ids 与 entriesSnapshot 保持稳定排序', async () => {
  await withTempDir(async (dir) => {
    const store = await StateStore.load({ filePath: path.join(dir, 'state.json') });
    store.markNotified(makeFissure({ id: 'charlie' }));
    store.markNotified(makeFissure({ id: 'alpha' }));
    store.markNotified(makeFissure({ id: 'bravo' }));

    assert.deepEqual(store.ids(), ['alpha', 'bravo', 'charlie']);
    assert.deepEqual(
      store.entriesSnapshot().map((entry) => entry.id),
      ['alpha', 'bravo', 'charlie'],
    );
  });
});
