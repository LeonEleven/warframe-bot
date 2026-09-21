/**
 * WarframeStat.us provider 测试（备用数据源，保留原有能力）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WarframeStatProvider } from '../src/warframe/warframestat-provider.js';
import { ProviderError } from '../src/warframe/provider.js';
import { createFetchStub, failingFetch } from './helpers.js';

const WARFRAMESTAT_FIXTURE = [
  {
    id: 'ws-mot',
    activation: '2026-09-21T00:31:02.382Z',
    expiry: '2026-09-21T02:28:56.086Z',
    node: 'Mot (Void)',
    nodeKey: 'Mot (Void)',
    missionType: 'Survival',
    missionTypeKey: 'Survival',
    enemy: 'Orokin',
    tier: 'Axi',
    tierNum: 4,
    isHard: true,
    isStorm: false,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('解析标准 WarframeStat.us 响应', async () => {
  const stub = createFetchStub(() => jsonResponse(WARFRAMESTAT_FIXTURE));
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  const result = await provider.fetchFissures();

  assert.equal(result.provider, 'warframestat');
  assert.equal(result.fissures.length, 1);
  assert.equal(result.fissures[0]?.node, 'Mot (Void)');
  assert.equal(result.skipped, 0);
  assert.deepEqual(stub.urls(), ['https://api.warframestat.us/pc/fissures?language=en']);
});

test('missionKey fallback：只有 missionKey 时也能得到规范任务类型', async () => {
  const stub = createFetchStub(() =>
    jsonResponse([
      {
        id: 'ws-mission-key',
        expiry: '2026-09-21T02:28:56.086Z',
        node: 'Ani (Void)',
        nodeKey: 'Ani (Void)',
        missionType: 'Defense',
        missionKey: 'Survival',
        tier: 'Axi',
        tierNum: 4,
        isHard: true,
        isStorm: false,
      },
    ]),
  );
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  const result = await provider.fetchFissures();

  assert.equal(result.fissures[0]?.missionType, 'Survival');
  assert.equal(result.fissures[0]?.missionTypeKey, null);
});

test('缺少 isStorm / isHard 时保持 unknown（null）', async () => {
  const stub = createFetchStub(() =>
    jsonResponse([{ id: 'ws-unknown', expiry: '2026-09-21T02:28:56.086Z', node: 'Mot (Void)', missionType: 'Survival' }]),
  );
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  const result = await provider.fetchFissures();

  assert.equal(result.fissures[0]?.isHard, null);
  assert.equal(result.fissures[0]?.isStorm, null);
});

test('HTTP 403（Cloudflare）-> ProviderError(kind=request)', async () => {
  const stub = createFetchStub(() => new Response('<html>blocked</html>', { status: 403, statusText: 'Forbidden' }));
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  await assert.rejects(() => provider.fetchFissures(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.provider, 'warframestat');
    assert.equal(error.kind, 'request');
    assert.match(error.message, /HTTP 403/);
    return true;
  });
});

test('网络异常 -> ProviderError(kind=request)', async () => {
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: failingFetch().fetch });

  await assert.rejects(() => provider.fetchFissures(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'request');
    return true;
  });
});

test('响应不是数组 -> ProviderError(kind=parse)', async () => {
  const stub = createFetchStub(() => jsonResponse({ nope: true }));
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  await assert.rejects(() => provider.fetchFissures(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'parse');
    return true;
  });
});

test('响应不是合法 JSON -> ProviderError(kind=parse)', async () => {
  const stub = createFetchStub(() => new Response('not json at all', { status: 200 }));
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  await assert.rejects(() => provider.fetchFissures(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'parse');
    return true;
  });
});

test('单条脏数据被跳过并计入 skipped', async () => {
  const stub = createFetchStub(() => jsonResponse([...WARFRAMESTAT_FIXTURE, { id: 'broken' }]));
  const provider = new WarframeStatProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  const result = await provider.fetchFissures();

  assert.equal(result.fissures.length, 1);
  assert.equal(result.skipped, 1);
});
