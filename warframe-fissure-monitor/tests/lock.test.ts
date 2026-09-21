/**
 * 单实例锁测试：stale lock 自愈、存活 PID 拒绝第二实例、release 语义。
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  InstanceAlreadyRunningError,
  isProcessAlive,
  LOCK_FILE_VERSION,
  SingleInstanceLock,
} from '../src/lock.js';
import { createMemoryLogger, withTempDir } from './helpers.js';

const NOW = new Date('2026-09-21T00:00:00.000Z');

function lockPath(dir: string): string {
  return path.join(dir, 'monitor.lock');
}

test('acquire 会自动创建缺失的父目录（data/）', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'data', 'monitor.lock');
    const lock = await SingleInstanceLock.acquire({ filePath, pid: 3131, now: () => NOW });

    assert.equal((await readRawLock(filePath)).pid, 3131);
    await lock.release();
  });
});

async function readRawLock(filePath: string): Promise<{ version: number; pid: number; startedAt: string }> {
  return JSON.parse(await readFile(filePath, 'utf8')) as { version: number; pid: number; startedAt: string };
}

test('首次启动：获取锁并写入包含 PID 的内容', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    const lock = await SingleInstanceLock.acquire({ filePath, pid: 4242, now: () => NOW });

    assert.equal(lock.info.pid, 4242);
    const payload = await readRawLock(filePath);
    assert.equal(payload.version, LOCK_FILE_VERSION);
    assert.equal(payload.pid, 4242);
    assert.equal(payload.startedAt, NOW.toISOString());

    await lock.release();
  });
});

test('已存在存活 PID 时，第二个实例被拒绝启动，且不破坏原有锁', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    const first = await SingleInstanceLock.acquire({ filePath, pid: 4242, now: () => NOW });

    await assert.rejects(
      () => SingleInstanceLock.acquire({ filePath, pid: 4343, isAlive: (pid) => pid === 4242 }),
      (error: unknown) => {
        assert.ok(error instanceof InstanceAlreadyRunningError);
        assert.equal(error.pid, 4242);
        assert.match(error.message, /已有监控实例正在运行/);
        return true;
      },
    );

    const payload = await readRawLock(filePath);
    assert.equal(payload.pid, 4242, '原有实例的锁必须保持不变');

    await first.release();
  });
});

test('真实存活的 PID（当前进程）也会阻止第二实例', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    await writeFile(
      filePath,
      JSON.stringify({ version: LOCK_FILE_VERSION, pid: process.pid, startedAt: NOW.toISOString() }),
      'utf8',
    );

    await assert.rejects(
      () => SingleInstanceLock.acquire({ filePath, pid: process.pid + 1 }),
      InstanceAlreadyRunningError,
    );
    assert.equal(isProcessAlive(process.pid), true);
  });
});

test('stale lock（PID 已不存在）自动清理并正常启动', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    // 一个几乎不可能存在的 PID；同时注入 isAlive 保证测试与真机无关
    await writeFile(
      filePath,
      JSON.stringify({ version: LOCK_FILE_VERSION, pid: 999_999, startedAt: NOW.toISOString() }),
      'utf8',
    );
    const logger = createMemoryLogger();

    const lock = await SingleInstanceLock.acquire({
      filePath,
      pid: 5151,
      logger,
      now: () => NOW,
      isAlive: () => false,
    });

    assert.equal(lock.info.pid, 5151);
    assert.equal((await readRawLock(filePath)).pid, 5151, 'stale lock 应被自己的 PID 覆盖');
    assert.match(logger.text(), /stale lock/);

    await lock.release();
  });
});

test('损坏的锁文件视为 stale lock（不阻塞启动）', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    const logger = createMemoryLogger();

    for (const broken of ['{ not json', '{"pid":"not-a-number"}', '']) {
      await writeFile(filePath, broken, 'utf8');
      const lock = await SingleInstanceLock.acquire({ filePath, pid: 6161, logger, now: () => NOW });
      assert.equal(lock.info.pid, 6161);
      await lock.release();
    }

    assert.match(logger.text(), /stale lock/);
  });
});

test('release 删除自己的锁，重复 release 返回 false', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    const lock = await SingleInstanceLock.acquire({ filePath, pid: 7171, now: () => NOW });

    assert.equal(await lock.release(), true);
    await assert.rejects(() => readFile(filePath, 'utf8'), /ENOENT/);
    assert.equal(await lock.release(), false);
  });
});

test('release 绝不删除已被其它进程接管的锁', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    const logger = createMemoryLogger();
    const lock = await SingleInstanceLock.acquire({ filePath, pid: 8181, logger, now: () => NOW });

    // 模拟锁被另一个进程接管
    await writeFile(
      filePath,
      JSON.stringify({ version: LOCK_FILE_VERSION, pid: 8282, startedAt: NOW.toISOString() }),
      'utf8',
    );

    assert.equal(await lock.release(), false);
    assert.equal((await readRawLock(filePath)).pid, 8282);
    assert.match(logger.text(), /已被其它进程接管/);
  });
});

test('isProcessAlive 对非法 PID 返回 false', () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test('attachExitHandler 返回可解除的清理函数', async () => {
  await withTempDir(async (dir) => {
    const filePath = lockPath(dir);
    const lock = await SingleInstanceLock.acquire({ filePath, pid: 9191, now: () => NOW });

    const detach = lock.attachExitHandler();
    assert.equal(typeof detach, 'function');
    detach();

    await lock.release();
  });
});
