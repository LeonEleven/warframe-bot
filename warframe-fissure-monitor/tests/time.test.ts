/**
 * 日志时间格式化测试。
 *
 * 目标：面向人的日志时间必须是「运行机器的本地时区」，而机器数据（monitor.lock / state.json / API 时间）
 * 仍然保持 UTC ISO。测试本身不依赖 CI 机器实际位于哪个时区：
 * - 纯函数（offset 计算）直接单测，与机器时区无关；
 * - 本地时间戳用「往返解析」（new Date(formatted).getTime() === 原时间）验证符号与语义，同样与时区无关；
 * - 需要确定输出的场景用 TZ 环境变量启动子进程（Node 在 Windows 与 Linux 上都支持），
 *   并覆盖 DST（America/New_York 冬夏 offset 不同）。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  formatLocalTimestamp,
  formatOffsetFromTimezoneOffset,
  getLocalUtcOffsetMinutes,
} from '../src/time.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TIME_MODULE_URL = new URL('../src/time.ts', import.meta.url).href;
const LOGGER_MODULE_URL = new URL('../src/logger.ts', import.meta.url).href;
const HEARTBEAT_MODULE_URL = new URL('../src/heartbeat.ts', import.meta.url).href;

const LOCAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

/* ------------------------------------------------------------------ *
 * 纯函数：offset 计算（与机器时区无关）
 * ------------------------------------------------------------------ */

test('formatOffsetFromTimezoneOffset：符号方向与 ISO 一致（getTimezoneOffset 是反的）', () => {
  // getTimezoneOffset() 返回 UTC-本地：UTC+8 => -480
  assert.equal(formatOffsetFromTimezoneOffset(-480), '+08:00', 'UTC+8 必须输出 +08:00');
  assert.equal(formatOffsetFromTimezoneOffset(300), '-05:00', 'UTC-5 必须输出 -05:00');
  assert.equal(formatOffsetFromTimezoneOffset(0), '+00:00', 'UTC 必须输出 +00:00');
  assert.equal(formatOffsetFromTimezoneOffset(-330), '+05:30', '半小时时区必须输出 +05:30');
  assert.equal(formatOffsetFromTimezoneOffset(345), '-05:45', '负数半小时时区必须输出 -05:45');
  assert.equal(formatOffsetFromTimezoneOffset(-720), '+12:00');
  assert.equal(formatOffsetFromTimezoneOffset(720), '-12:00');
  assert.equal(formatOffsetFromTimezoneOffset(-285), '+04:45');
});

test('formatOffsetFromTimezoneOffset：始终是 ±HH:mm，小时与分钟都补零', () => {
  for (const offset of [-480, 300, 0, -330, 345, -720, -60, 60]) {
    const formatted = formatOffsetFromTimezoneOffset(offset);
    assert.match(formatted, /^[+-]\d{2}:\d{2}$/, `${offset} -> ${formatted} 必须匹配 ±HH:mm`);
  }
});

test('getLocalUtcOffsetMinutes：与 getTimezoneOffset 符号相反', () => {
  const date = new Date('2026-01-15T12:00:00.000Z');
  assert.equal(getLocalUtcOffsetMinutes(date), -date.getTimezoneOffset());
});

/* ------------------------------------------------------------------ *
 * formatLocalTimestamp：格式、毫秒、符号、不修改原 Date
 * ------------------------------------------------------------------ */

test('formatLocalTimestamp：格式为 YYYY-MM-DDTHH:mm:ss.SSS±HH:mm', () => {
  const formatted = formatLocalTimestamp(new Date());

  assert.match(formatted, LOCAL_TIMESTAMP_PATTERN);
  assert.ok(!formatted.endsWith('Z'), '不得再输出 UTC 的 Z 后缀');
});

test('formatLocalTimestamp：毫秒始终三位（含前导零）', () => {
  const cases: Array<[number, string]> = [
    [7, '.007'],
    [70, '.070'],
    [700, '.700'],
    [0, '.000'],
    [1, '.001'],
  ];

  for (const [milliseconds, expected] of cases) {
    // 用本地时间构造，保证断言与机器时区无关
    const date = new Date(2026, 0, 15, 12, 0, 0, milliseconds);
    const formatted = formatLocalTimestamp(date);
    assert.ok(
      formatted.includes(`T12:00:00${expected}`),
      `毫秒 ${milliseconds} 应输出 ${expected}，实际 ${formatted}`,
    );
    assert.match(formatted, LOCAL_TIMESTAMP_PATTERN);
  }
});

test('formatLocalTimestamp：offset 与该时刻本地时区一致（含 DST 自动生效）', () => {
  const dates = [
    new Date('2026-01-15T12:00:00.000Z'),
    new Date('2026-07-15T12:00:00.000Z'),
    new Date(),
  ];

  for (const date of dates) {
    const formatted = formatLocalTimestamp(date);
    const expectedOffset = formatOffsetFromTimezoneOffset(date.getTimezoneOffset());
    assert.ok(
      formatted.endsWith(expectedOffset),
      `${date.toISOString()} 的 offset 应为 ${expectedOffset}，实际 ${formatted}`,
    );
  }
});

test('formatLocalTimestamp：往返解析得到同一瞬时（证明 offset 符号正确，不依赖机器时区）', () => {
  const instants = [
    '2026-01-15T12:00:00.000Z',
    '2026-07-15T12:00:00.000Z',
    '2026-09-21T07:20:06.467Z',
    '2025-12-31T23:59:59.999Z',
  ];

  for (const instant of instants) {
    const date = new Date(instant);
    const formatted = formatLocalTimestamp(date);
    assert.equal(
      new Date(formatted).getTime(),
      date.getTime(),
      `${instant} 格式化后为 ${formatted}，往返解析必须回到同一瞬时`,
    );
  }
});

test('formatLocalTimestamp：不会修改传入的 Date（UTC 内部时间值不变）', () => {
  const date = new Date('2026-09-21T07:20:06.467Z');
  const before = date.getTime();
  const beforeIso = date.toISOString();

  formatLocalTimestamp(date);

  assert.equal(date.getTime(), before, 'Date 的内部时间值必须保持不变');
  assert.equal(date.toISOString(), beforeIso, 'Date 的 UTC ISO 表示必须保持不变');
});

test('formatLocalTimestamp：非法日期安全降级，不抛异常', () => {
  assert.equal(formatLocalTimestamp(new Date(Number.NaN)), 'invalid-date');
});

/* ------------------------------------------------------------------ *
 * 确定性时区测试：用 TZ 启动子进程（Windows 与 Linux 都支持）
 * ------------------------------------------------------------------ */

interface TzProbe {
  timestamp: string;
  timestampSummer: string;
  heartbeat: string;
  logLine: string;
}

function runInTimezone(timezone: string): TzProbe {
  const source = `
import { formatLocalTimestamp } from ${JSON.stringify(TIME_MODULE_URL)};
import { formatHeartbeat } from ${JSON.stringify(HEARTBEAT_MODULE_URL)};
import { createLogger } from ${JSON.stringify(LOGGER_MODULE_URL)};

const captured = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
createLogger('info').info('probe');
process.stdout.write = originalWrite;

const probe = {
  timestamp: formatLocalTimestamp(new Date('2026-01-15T12:00:00.000Z')),
  timestampSummer: formatLocalTimestamp(new Date('2026-07-15T12:00:00.000Z')),
  heartbeat: formatHeartbeat({
    provider: 'official',
    cycles: 360,
    lastSuccessAt: new Date('2026-01-15T12:00:00.000Z'),
    lastFissureCount: 30,
    lastErrorAt: new Date('2026-01-15T13:30:00.000Z'),
  }),
  logLine: captured.join(''),
};
process.stdout.write(JSON.stringify(probe));
`;

  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '--import', 'tsx', '-e', source],
    { encoding: 'utf8', cwd: PROJECT_ROOT, env: { ...process.env, TZ: timezone } },
  );

  return JSON.parse(stdout.trim()) as TzProbe;
}

/** TZ 环境变量是否被当前 Node 与平台支持（不支持时跳过确定性用例） */
const tzSupportProbe = ((): { supported: boolean; reason: string } => {
  try {
    const probe = runInTimezone('UTC');
    return probe.timestamp === '2026-01-15T12:00:00.000+00:00'
      ? { supported: true, reason: '' }
      : { supported: false, reason: `TZ 未被采纳（UTC 探针返回 ${probe.timestamp}）` };
  } catch (error) {
    return { supported: false, reason: `无法启动子进程：${String(error)}` };
  }
})();

const tzSkip = tzSupportProbe.supported ? false : `跳过：${tzSupportProbe.reason}`;

test('TZ=Asia/Shanghai：输出 +08:00（UTC+8）', { skip: tzSkip }, () => {
  const probe = runInTimezone('Asia/Shanghai');

  assert.equal(probe.timestamp, '2026-01-15T20:00:00.000+08:00');
  assert.equal(probe.timestampSummer, '2026-07-15T20:00:00.000+08:00', '中国无 DST，冬夏一致');
  assert.equal(
    probe.heartbeat,
    '监控运行正常 provider=official 累计轮询=360 ' +
      '最近成功获取=2026-01-15T20:00:00.000+08:00 最近一次裂缝数量=30 ' +
      '最近一次错误=2026-01-15T21:30:00.000+08:00',
  );
  assert.match(
    probe.logLine,
    /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00\] INFO {2}probe\n$/,
    `日志前缀必须是本地时间，实际：${probe.logLine}`,
  );
  assert.ok(!probe.logLine.includes('Z]'), '日志前缀不得再出现 UTC 的 Z');
});

test('TZ=America/New_York：DST 自动生效（冬 -05:00 / 夏 -04:00）', { skip: tzSkip }, () => {
  const probe = runInTimezone('America/New_York');

  assert.equal(probe.timestamp, '2026-01-15T07:00:00.000-05:00', '冬季应为 UTC-5');
  assert.equal(probe.timestampSummer, '2026-07-15T08:00:00.000-04:00', '夏季应为 UTC-4（DST）');
  assert.ok(
    probe.heartbeat.includes('最近成功获取=2026-01-15T07:00:00.000-05:00'),
    `心跳时间也应使用本地时区，实际：${probe.heartbeat}`,
  );
  assert.match(probe.logLine, /-0[45]:00\] INFO {2}probe\n$/);
});

test('TZ=UTC：输出 +00:00（而不是 Z）', { skip: tzSkip }, () => {
  const probe = runInTimezone('UTC');

  assert.equal(probe.timestamp, '2026-01-15T12:00:00.000+00:00');
  assert.ok(probe.heartbeat.includes('最近成功获取=2026-01-15T12:00:00.000+00:00'));
  assert.match(probe.logLine, /\+00:00\] INFO {2}probe\n$/);
});

/* ------------------------------------------------------------------ *
 * 源码契约：面向人的日志不得再用 toISOString
 * ------------------------------------------------------------------ */

test('logger.ts 不再用 toISOString 作为日志前缀', () => {
  const loggerSource = readFileSync(new URL('../src/logger.ts', import.meta.url), 'utf8');

  assert.ok(!loggerSource.includes('toISOString'), 'logger.ts 不应再出现 toISOString');
  assert.ok(
    loggerSource.includes('formatLocalTimestamp(new Date())'),
    'logger.ts 应使用统一的本地时间 formatter',
  );
});

test('heartbeat.ts 不再把 Date.toISOString() 直接输出给用户', () => {
  const heartbeatSource = readFileSync(new URL('../src/heartbeat.ts', import.meta.url), 'utf8');

  assert.ok(!heartbeatSource.includes('toISOString'), 'heartbeat.ts 不应再出现 toISOString');
  assert.ok(
    heartbeatSource.includes('formatLocalTimestamp(stats.lastSuccessAt)'),
    '心跳的「最近成功获取」应使用本地时间 formatter',
  );
  assert.ok(
    heartbeatSource.includes('formatLocalTimestamp(stats.lastErrorAt)'),
    '心跳的「最近一次错误」应使用本地时间 formatter',
  );
});

test('机器数据仍保持 UTC ISO：lock.ts / state/store.ts / mapping.ts 不受本次改动影响', () => {
  const lockSource = readFileSync(new URL('../src/lock.ts', import.meta.url), 'utf8');
  const storeSource = readFileSync(new URL('../src/state/store.ts', import.meta.url), 'utf8');
  const mappingSource = readFileSync(new URL('../src/warframe/mapping.ts', import.meta.url), 'utf8');

  assert.ok(lockSource.includes('startedAt: now().toISOString()'), 'monitor.lock 的 startedAt 必须仍是 UTC ISO');
  assert.ok(!lockSource.includes('formatLocalTimestamp'), 'lock.ts 不得改用本地时间');
  assert.ok(storeSource.includes('notifiedAt: notifiedAt.toISOString()'), 'state.json 的时间必须仍是 UTC ISO');
  assert.ok(!storeSource.includes('formatLocalTimestamp'), 'store.ts 不得改用本地时间');
  assert.ok(mappingSource.includes('toISOString()'), 'API 时间归一化必须仍是 UTC ISO');
  assert.ok(!mappingSource.includes('formatLocalTimestamp'), 'mapping.ts 不得改用本地时间');
});
