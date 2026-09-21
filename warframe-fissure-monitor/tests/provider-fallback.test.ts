/**
 * 数据源选择与 auto fallback 测试（需求：official 优先、失败才回退、两者都失败安全失败且不发 QQ）。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runPollCycle } from '../src/poller.js';
import { StateStore } from '../src/state/store.js';
import { OfficialWorldStateProvider } from '../src/warframe/official-provider.js';
import { createFissureProvider, ProviderError } from '../src/warframe/provider.js';
import { WarframeStatProvider } from '../src/warframe/warframestat-provider.js';
import {
  createFetchStub,
  createMemoryLogger,
  loadWorldStateFixture,
  withTempDir,
  WORLDSTATE_FIXTURE_FETCHED_AT,
} from './helpers.js';

const WARFRAMESTAT_BODY = [
  {
    id: 'ws-ani',
    expiry: '2026-09-21T02:28:56.086Z',
    node: 'Ani (Void)',
    nodeKey: 'Ani (Void)',
    missionType: 'Survival',
    missionTypeKey: 'Survival',
    tier: 'Neo',
    tierNum: 3,
    isHard: true,
    isStorm: false,
  },
];

async function buildAutoProvider(options: {
  officialWorks: boolean;
  warframestatWorks: boolean;
  logger: ReturnType<typeof createMemoryLogger>;
}) {
  const fixture = await loadWorldStateFixture();
  const officialUrl = 'https://api.warframe.com/cdn/worldState.php';
  const warframestatUrl = 'https://api.warframestat.us/pc/fissures?language=en';

  const stub = createFetchStub((url) => {
    if (url.includes('worldState.php')) {
      return options.officialWorks
        ? new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('gateway error', { status: 502 });
    }
    return options.warframestatWorks
      ? new Response(JSON.stringify(WARFRAMESTAT_BODY), { status: 200 })
      : new Response('blocked', { status: 403 });
  });

  const official = new OfficialWorldStateProvider({ url: officialUrl, timeoutMs: 5_000, fetchImpl: stub.fetch, logger: options.logger });
  const warframestat = new WarframeStatProvider({ url: warframestatUrl, timeoutMs: 5_000, fetchImpl: stub.fetch, logger: options.logger });
  const provider = createFissureProvider({ source: 'auto', official, warframestat, logger: options.logger });

  return { provider, stub };
}

test('createFissureProvider 按 WARFRAME_SOURCE 选择数据源', () => {
  const logger = createMemoryLogger();
  const official = new OfficialWorldStateProvider({ timeoutMs: 1_000 });
  const warframestat = new WarframeStatProvider({ timeoutMs: 1_000 });

  assert.equal(createFissureProvider({ source: 'official', official, warframestat, logger }).name, 'official');
  assert.equal(createFissureProvider({ source: 'warframestat', official, warframestat, logger }).name, 'warframestat');

  const auto = createFissureProvider({ source: 'auto', official, warframestat, logger });
  assert.equal(auto.name, 'auto');
  assert.equal(auto.url, official.url, 'auto 的主地址应是 official');
});

test('auto：official 成功时绝不请求 fallback provider', async () => {
  const logger = createMemoryLogger();
  const { provider, stub } = await buildAutoProvider({ officialWorks: true, warframestatWorks: true, logger });

  const result = await provider.fetchFissures();

  assert.equal(result.provider, 'official');
  assert.equal(result.fissures.length, 5);
  assert.deepEqual(stub.urls(), ['https://api.warframe.com/cdn/worldState.php']);
  assert.ok(!stub.urls().some((url) => url.includes('warframestat')), '不应请求 WarframeStat.us');
  assert.equal(logger.records.filter((record) => record.level === 'warn').length, 0);
});

test('auto：official 失败时回退到 warframestat 并记录 warn 日志', async () => {
  const logger = createMemoryLogger();
  const { provider, stub } = await buildAutoProvider({ officialWorks: false, warframestatWorks: true, logger });

  const result = await provider.fetchFissures();

  assert.equal(result.provider, 'warframestat');
  assert.equal(result.fissures.length, 1);
  assert.deepEqual(stub.urls(), [
    'https://api.warframe.com/cdn/worldState.php',
    'https://api.warframestat.us/pc/fissures?language=en',
  ]);
  assert.ok(logger.text().includes('official 获取失败 -> fallback 到 warframestat'));
});

test('auto：两个 provider 都失败时抛出 ProviderError(kind=unavailable) 且聚合两边原因', async () => {
  const logger = createMemoryLogger();
  const { provider } = await buildAutoProvider({ officialWorks: false, warframestatWorks: false, logger });

  await assert.rejects(() => provider.fetchFissures(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'unavailable');
    assert.match(error.message, /official/);
    assert.match(error.message, /warframestat/);
    return true;
  });
});

test('两个 provider 都失败时本轮安全失败：记录错误但绝不给 QQ 发送任何消息', async () => {
  await withTempDir(async (dir) => {
    const logger = createMemoryLogger();
    const { provider } = await buildAutoProvider({ officialWorks: false, warframestatWorks: false, logger });
    const store = await StateStore.load({ filePath: path.join(dir, 'state.json'), logger, now: () => WORLDSTATE_FIXTURE_FETCHED_AT });
    const sent: string[] = [];

    const outcome = await runPollCycle({
      logger,
      store,
      now: () => WORLDSTATE_FIXTURE_FETCHED_AT,
      fetchFissures: async () => (await provider.fetchFissures()).fissures,
      sendMessage: async (message) => {
        sent.push(message);
        return { ok: true, targetQq: '10001', endpoint: 'http://127.0.0.1:3000/send_private_msg', status: 'ok', retcode: 0 };
      },
    });

    assert.equal(sent.length, 0, 'provider 故障绝不能触发 QQ 通知');
    assert.notEqual(outcome.error, null);
    assert.equal(outcome.notified, false);
    assert.equal(outcome.fetchedCount, 0);
    assert.ok(logger.records.some((record) => record.level === 'error'), '应记录错误日志');
  });
});
