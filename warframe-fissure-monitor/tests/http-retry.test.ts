/**
 * Warframe HTTP 层稳定性测试：有限重试、只重试瞬时故障、退避、错误链诊断。
 *
 * 全部使用注入的 fetch 替身与 fake sleep（不真的等待、不制造真实断网），
 * 并断言重试日志（中间失败 WARN、重试后成功 INFO、首次成功无额外日志）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_HTTP_RETRY_POLICY,
  HttpRequestError,
  httpGetText,
  inspectErrorChain,
  isRetryableHttpStatus,
  parseRetryAfterMs,
} from '../src/warframe/http.js';
import { OfficialWorldStateProvider } from '../src/warframe/official-provider.js';
import { ProviderError } from '../src/warframe/provider.js';
import { createFetchStub, createMemoryLogger, loadWorldStateFixture } from './helpers.js';

const URL = 'https://api.warframe.com/cdn/worldState.php';
const LABEL = 'official WorldState';

/* ------------------------------------------------------------------ *
 * 测试替身
 * ------------------------------------------------------------------ */

interface SleepRecord {
  delays: number[];
  sleep: (milliseconds: number) => Promise<void>;
}

function createSleepRecorder(): SleepRecord {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (milliseconds: number): Promise<void> => {
      delays.push(milliseconds);
    },
  };
}

function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

/** undici 风格的嵌套错误：TypeError: fetch failed -> ConnectTimeoutError(code=UND_ERR_CONNECT_TIMEOUT) */
function connectTimeoutError(): Error {
  const cause = Object.assign(new Error('Connect Timeout Error'), {
    name: 'ConnectTimeoutError',
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  const error = new TypeError('fetch failed');
  (error as TypeError & { cause?: unknown }).cause = cause;
  return error;
}

/** 更深一层 + AggregateError（autoSelectFamily 多地址都失败时的形态） */
function aggregateEtimedoutError(): Error {
  const inner = Object.assign(new Error('connect ETIMEDOUT 20.205.243.166:443'), { code: 'ETIMEDOUT' });
  const aggregate = new AggregateError([inner], 'All connection attempts failed');
  const cause = Object.assign(new Error('fetch failed'), { name: 'Error' });
  (cause as Error & { cause?: unknown }).cause = aggregate;
  const error = new TypeError('fetch failed');
  (error as TypeError & { cause?: unknown }).cause = cause;
  return error;
}

function textResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: headers ?? { 'content-type': 'text/html' } });
}

/** 按脚本依次返回响应/抛错 */
function scriptedFetch(steps: Array<Response | Error>): ReturnType<typeof createFetchStub> {
  let index = 0;
  return createFetchStub(() => {
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    return step ?? textResponse('{}');
  });
}

async function callHttp(stub: ReturnType<typeof createFetchStub>, sleep: SleepRecord['sleep'], logger = createMemoryLogger()) {
  const body = await httpGetText({
    url: URL,
    timeoutMs: 10_000,
    label: LABEL,
    fetchImpl: stub.fetch,
    sleep,
    logger,
  });
  return { body, logger };
}

/* ------------------------------------------------------------------ *
 * 1-3：有限重试
 * ------------------------------------------------------------------ */

test('第 1 次 TimeoutError、第 2 次成功 -> 最终成功，退避 1000ms', async () => {
  const stub = scriptedFetch([timeoutError(), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();

  const { body } = await callHttp(stub, sleep.sleep, logger);

  assert.equal(body, '{"ok":true}');
  assert.equal(stub.calls.length, 2, '应尝试 2 次');
  assert.deepEqual(sleep.delays, [1_000], '退避应为 1000ms');
  assert.ok(
    logger.records.some((record) => record.level === 'warn' && record.message.includes('Warframe 请求失败，准备重试')),
    '中间失败应记一条 WARN',
  );
  const warnText = logger.records.filter((record) => record.level === 'warn').map((record) => record.message).join('\n');
  assert.ok(warnText.includes('attempt=1/3'), 'WARN 应包含 attempt=1/3');
  assert.ok(warnText.includes('retryInMs=1000'), 'WARN 应包含 retryInMs=1000');
  assert.ok(warnText.includes('source=official WorldState'), 'WARN 应包含 source');
  assert.ok(
    logger.text().includes(`${LABEL} 在第 2/3 次尝试成功`),
    '重试成功后应记一条 INFO',
  );
  assert.equal(
    logger.records.filter((record) => record.level === 'error').length,
    0,
    '重试期间不应记 ERROR',
  );
});

test('前 2 次 TimeoutError、第 3 次成功 -> 最终成功，退避 1000/3000ms', async () => {
  const stub = scriptedFetch([timeoutError(), timeoutError(), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();

  await callHttp(stub, sleep.sleep, logger);

  assert.equal(stub.calls.length, 3);
  assert.deepEqual(sleep.delays, [1_000, 3_000], '退避应为 1s / 3s');
  assert.ok(logger.text().includes('attempt=1/3'));
  assert.ok(logger.text().includes('attempt=2/3'));
  assert.ok(logger.text().includes(`${LABEL} 在第 3/3 次尝试成功`));
});

test('3 次均网络失败 -> 只抛一次失败，包含 attempt 与错误链诊断', async () => {
  const stub = scriptedFetch([connectTimeoutError(), connectTimeoutError(), connectTimeoutError()]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();

  await assert.rejects(
    () => callHttp(stub, sleep.sleep, logger),
    (error: unknown) => {
      assert.ok(error instanceof HttpRequestError);
      assert.equal(error.attempts, 3);
      assert.equal(error.retryable, true);
      assert.equal(error.status, null);
      assert.match(error.message, /attempt=3\/3/);
      assert.match(error.message, /error=TypeError -> ConnectTimeoutError/);
      assert.match(error.message, /code=UND_ERR_CONNECT_TIMEOUT/);
      assert.ok(!error.message.includes('Z]'), '错误信息不应包含日志时间戳');
      return true;
    },
  );

  assert.equal(stub.calls.length, 3, '不应无限重试');
  assert.deepEqual(sleep.delays, [1_000, 3_000]);
});

test('首次请求成功时不做额外 INFO 日志、不等待', async () => {
  const stub = scriptedFetch([textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();

  await callHttp(stub, sleep.sleep, logger);

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(sleep.delays, [], '首次成功不应有任何退避等待');
  assert.equal(logger.records.length, 0, '首次成功不应输出日志（http 层直接返回文本，不涉及 parser）');
});

/* ------------------------------------------------------------------ *
 * 4-5：可重试的 HTTP 状态
 * ------------------------------------------------------------------ */

test('HTTP 503 后成功 -> 会重试', async () => {
  const stub = scriptedFetch([textResponse('unavailable', 503), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();

  await callHttp(stub, sleep.sleep, logger);

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(sleep.delays, [1_000]);
  assert.ok(logger.text().includes('HTTP 503'));
});

test('HTTP 429 后成功 -> 会重试', async () => {
  const stub = scriptedFetch([textResponse('slow down', 429), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();

  await callHttp(stub, sleep.sleep, logger);

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(sleep.delays, [1_000]);
});

test('HTTP 500 / 502 / 504 也属于可重试状态', () => {
  for (const status of [408, 425, 429, 500, 501, 502, 503, 504, 599]) {
    assert.equal(isRetryableHttpStatus(status), true, `${status} 应可重试`);
  }
  for (const status of [400, 401, 403, 404, 405, 418, 451]) {
    assert.equal(isRetryableHttpStatus(status), false, `${status} 不应重试`);
  }
});

/* ------------------------------------------------------------------ *
 * 6-7：不可重试的客户端错误
 * ------------------------------------------------------------------ */

test('HTTP 403 -> 不重试，立即失败', async () => {
  const stub = scriptedFetch([textResponse('forbidden', 403)]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();

  await assert.rejects(
    () => callHttp(stub, sleep.sleep, logger),
    (error: unknown) => {
      assert.ok(error instanceof HttpRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.retryable, false);
      assert.match(error.message, /attempt=1\/3/);
      assert.match(error.message, /HTTP 403/);
      return true;
    },
  );

  assert.equal(stub.calls.length, 1, '403 不得重试');
  assert.deepEqual(sleep.delays, []);
  assert.equal(logger.records.filter((record) => record.level === 'warn').length, 0);
});

test('HTTP 404 -> 不重试，立即失败', async () => {
  const stub = scriptedFetch([textResponse('not found', 404)]);
  const sleep = createSleepRecorder();

  await assert.rejects(() => callHttp(stub, sleep.sleep), (error: unknown) => {
    assert.ok(error instanceof HttpRequestError);
    assert.equal(error.status, 404);
    assert.equal(error.retryable, false);
    return true;
  });

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(sleep.delays, []);
});

/* ------------------------------------------------------------------ *
 * 8：JSON 解析失败不属于 HTTP 重试
 * ------------------------------------------------------------------ */

test('JSON parse failure 不在 http 层重试（provider 直接报 parse 错误）', async () => {
  const stub = scriptedFetch([textResponse('<html>Cloudflare</html>', 200)]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();
  const provider = new OfficialWorldStateProvider({
    url: URL,
    timeoutMs: 10_000,
    fetchImpl: stub.fetch,
    sleep: sleep.sleep,
    logger,
  });

  await assert.rejects(
    () => provider.fetchFissures(),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'parse');
      return true;
    },
  );

  assert.equal(stub.calls.length, 1, '解析失败不得触发 HTTP 重试');
  assert.deepEqual(sleep.delays, []);
});

/* ------------------------------------------------------------------ *
 * 9：退避策略常量
 * ------------------------------------------------------------------ */

test('默认重试策略：最多 3 次尝试、退避 1s/3s、Retry-After 上限 10s', () => {
  assert.equal(DEFAULT_HTTP_RETRY_POLICY.maxAttempts, 3);
  assert.deepEqual([...DEFAULT_HTTP_RETRY_POLICY.backoffMs], [1_000, 3_000]);
  assert.equal(DEFAULT_HTTP_RETRY_POLICY.maxRetryAfterMs, 10_000);
});

test('Retry-After 会被遵守但有上限', async () => {
  const withRetryAfter = scriptedFetch([
    textResponse('slow down', 429, { 'retry-after': '2' }),
    textResponse('{"ok":true}'),
  ]);
  const sleepA = createSleepRecorder();
  await callHttp(withRetryAfter, sleepA.sleep);
  assert.deepEqual(sleepA.delays, [2_000], 'Retry-After: 2 秒应被遵守');

  const withHugeRetryAfter = scriptedFetch([
    textResponse('slow down', 429, { 'retry-after': '999' }),
    textResponse('{"ok":true}'),
  ]);
  const sleepB = createSleepRecorder();
  await callHttp(withHugeRetryAfter, sleepB.sleep);
  assert.deepEqual(sleepB.delays, [10_000], 'Retry-After 应被 maxRetryAfterMs 限制');

  const withInvalidRetryAfter = scriptedFetch([
    textResponse('slow down', 503, { 'retry-after': 'soon' }),
    textResponse('{"ok":true}'),
  ]);
  const sleepC = createSleepRecorder();
  await callHttp(withInvalidRetryAfter, sleepC.sleep);
  assert.deepEqual(sleepC.delays, [1_000], '无法解析时回退到固定退避');
});

test('parseRetryAfterMs 支持秒数与 HTTP-date', () => {
  const headers = (value: string) => ({ get: (name: string) => (name.toLowerCase() === 'retry-after' ? value : null) });

  assert.equal(parseRetryAfterMs(headers('3'), 0), 3_000);
  assert.equal(parseRetryAfterMs(headers('0'), 0), 0);
  assert.equal(parseRetryAfterMs(headers(''), 0), null);
  assert.equal(parseRetryAfterMs(headers('not-a-date'), 0), null);
  assert.equal(parseRetryAfterMs(undefined, 0), null);

  const now = Date.parse('2026-09-21T07:00:00.000Z');
  const httpDate = new Date(now + 5_000).toUTCString();
  assert.equal(parseRetryAfterMs(headers(httpDate), now), 5_000);
});

/* ------------------------------------------------------------------ *
 * 10：错误链（cause / AggregateError）识别
 * ------------------------------------------------------------------ */

test('inspectErrorChain 能识别嵌套与 AggregateError 中的瞬时错误码', () => {
  const timeout = inspectErrorChain(timeoutError());
  assert.equal(timeout.retryable, true);
  assert.ok(timeout.matched.some((item) => item.includes('TimeoutError')));

  const connectTimeout = inspectErrorChain(connectTimeoutError());
  assert.equal(connectTimeout.retryable, true);
  assert.ok(connectTimeout.matched.includes('code=UND_ERR_CONNECT_TIMEOUT'));
  assert.equal(connectTimeout.summary, 'TypeError -> ConnectTimeoutError');
  assert.deepEqual(connectTimeout.codes, ['UND_ERR_CONNECT_TIMEOUT']);

  const aggregate = inspectErrorChain(aggregateEtimedoutError());
  assert.equal(aggregate.retryable, true, 'AggregateError 内层的 ETIMEDOUT 也应被识别');
  assert.ok(aggregate.codes.includes('ETIMEDOUT'));

  const plain = inspectErrorChain(new Error('some logic bug'));
  assert.equal(plain.retryable, false, '普通错误不应被当作瞬时故障');

  const nullish = inspectErrorChain(null);
  assert.equal(nullish.retryable, false);

  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']) {
    const error = Object.assign(new Error(`boom ${code}`), { code });
    assert.equal(inspectErrorChain(error).retryable, true, `${code} 应可重试`);
  }
});

test('嵌套的 UND_ERR_CONNECT_TIMEOUT 会触发重试', async () => {
  const stub = scriptedFetch([connectTimeoutError(), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();

  await callHttp(stub, sleep.sleep);

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(sleep.delays, [1_000]);
});

test('AggregateError 中的 ETIMEDOUT 也会触发重试', async () => {
  const stub = scriptedFetch([aggregateEtimedoutError(), aggregateEtimedoutError(), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();

  await callHttp(stub, sleep.sleep);

  assert.equal(stub.calls.length, 3);
  assert.deepEqual(sleep.delays, [1_000, 3_000]);
});

/* ------------------------------------------------------------------ *
 * 其它：可配置策略 / 空响应 / 与 provider 的配合
 * ------------------------------------------------------------------ */

test('可以通过 retry 覆盖策略（例如只尝试 1 次）', async () => {
  const stub = scriptedFetch([timeoutError(), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();

  await assert.rejects(
    () =>
      httpGetText({
        url: URL,
        timeoutMs: 1_000,
        label: LABEL,
        fetchImpl: stub.fetch,
        sleep: sleep.sleep,
        retry: { maxAttempts: 1 },
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpRequestError);
      assert.equal(error.attempts, 1);
      return true;
    },
  );

  assert.equal(stub.calls.length, 1);
});

test('200 但空响应属于瞬时症状，会重试', async () => {
  const stub = scriptedFetch([textResponse('', 200), textResponse('{"ok":true}')]);
  const sleep = createSleepRecorder();

  await callHttp(stub, sleep.sleep);

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(sleep.delays, [1_000]);
});

test('provider 层：official 重试耗尽后才抛错（attempt=3/3 出现在消息里）', async () => {
  const stub = scriptedFetch([connectTimeoutError(), connectTimeoutError(), connectTimeoutError()]);
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();
  const provider = new OfficialWorldStateProvider({
    url: URL,
    timeoutMs: 10_000,
    fetchImpl: stub.fetch,
    sleep: sleep.sleep,
    logger,
  });

  await assert.rejects(
    () => provider.fetchFissures(),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'request');
      assert.match(error.message, /attempt=3\/3/);
      assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
      return true;
    },
  );

  assert.equal(stub.calls.length, 3);
  assert.equal(logger.records.filter((record) => record.level === 'error').length, 0, 'http 层不记 ERROR');
});

test('provider 层：正常 fixture 首次即成功，不产生重试日志', async () => {
  const fixture = await loadWorldStateFixture();
  const stub = createFetchStub(() => textResponse(JSON.stringify(fixture)));
  const sleep = createSleepRecorder();
  const logger = createMemoryLogger();
  const provider = new OfficialWorldStateProvider({
    url: URL,
    timeoutMs: 10_000,
    fetchImpl: stub.fetch,
    sleep: sleep.sleep,
    logger,
  });

  const result = await provider.fetchFissures();

  assert.equal(result.fissures.length, 5);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(sleep.delays, []);
  // 只关心「没有重试相关与错误日志」；parser 的 debug 提示不在本断言范围内
  assert.equal(
    logger.records.filter((record) => record.level === 'warn' || record.level === 'error').length,
    0,
  );
  assert.ok(!logger.text().includes('准备重试'));
  assert.ok(!logger.text().includes('次尝试成功'));
});
