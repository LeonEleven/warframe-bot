/**
 * NapCat（OneBot 11）客户端测试：
 * 只有 status === "ok" 且 retcode === 0 才算成功。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NapCatClient } from '../src/notify/napcat.js';
import { createMemoryLogger, jsonResponse, recordingFetch, stubFetch } from './helpers.js';

function createClient(init: {
  token?: string | null;
  fetchImpl: typeof fetch;
  baseUrl?: string;
}): NapCatClient {
  return new NapCatClient({
    baseUrl: init.baseUrl ?? 'http://127.0.0.1:3000',
    token: init.token ?? null,
    timeoutMs: 5_000,
    fetchImpl: init.fetchImpl,
    logger: createMemoryLogger(),
  });
}

test('status=ok 且 retcode=0 -> 成功，并发送正确的 URL / header / body', async () => {
  const recorder = recordingFetch(jsonResponse({ status: 'ok', retcode: 0, data: { message_id: 42 } }));
  const client = createClient({ token: 'secret-token', fetchImpl: recorder.fetch, baseUrl: 'http://127.0.0.1:3000/' });

  const result = await client.sendPrivateMessage('10001', 'hello warframe');

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.retcode, 0);

  const call = recorder.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, 'http://127.0.0.1:3000/send_private_msg');
  assert.equal(call.init?.method, 'POST');

  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.authorization, 'Bearer secret-token');
  assert.deepEqual(call.json(), { user_id: 10001, message: 'hello warframe' });
});

test('未设置 token 时不发送 Authorization 头', async () => {
  const recorder = recordingFetch(jsonResponse({ status: 'ok', retcode: 0 }));
  const client = createClient({ fetchImpl: recorder.fetch });

  const result = await client.sendPrivateMessage('10001', 'hi');

  assert.equal(result.ok, true);
  const headers = recorder.calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, undefined);
});

test('status=ok 但 retcode != 0 -> 失败', async () => {
  const client = createClient({
    fetchImpl: stubFetch(async () => jsonResponse({ status: 'ok', retcode: 100, message: 'bad request' })),
  });

  const result = await client.sendPrivateMessage('10001', 'hi');

  assert.equal(result.ok, false);
  assert.equal(result.retcode, 100);
  assert.match(result.error ?? '', /retcode=100/);
});

test('status=failed 即使 retcode=0 -> 失败', async () => {
  const client = createClient({
    fetchImpl: stubFetch(async () => jsonResponse({ status: 'failed', retcode: 0 })),
  });

  const result = await client.sendPrivateMessage('10001', 'hi');

  assert.equal(result.ok, false);
});

test('缺少 retcode 字段 -> 失败', async () => {
  const client = createClient({ fetchImpl: stubFetch(async () => jsonResponse({ status: 'ok' })) });

  const result = await client.sendPrivateMessage('10001', 'hi');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /不符合 OneBot 11 结构/);
});

test('HTTP 500 -> 失败并保留响应片段', async () => {
  const client = createClient({
    fetchImpl: stubFetch(async () => new Response('internal error', { status: 500 })),
  });

  const result = await client.sendPrivateMessage('10001', 'hi');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /HTTP 500/);
  assert.equal(result.detail, 'internal error');
});

test('响应不是合法 JSON -> 失败', async () => {
  const client = createClient({ fetchImpl: stubFetch(async () => new Response('<html>nope</html>', { status: 200 })) });

  const result = await client.sendPrivateMessage('10001', 'hi');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /不是合法 JSON/);
});

test('网络异常（连接被拒绝 / 超时）-> 失败且不抛异常', async () => {
  const client = createClient({
    fetchImpl: stubFetch(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
    }),
  });

  const result = await client.sendPrivateMessage('10001', 'hi');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /ECONNREFUSED/);
});
