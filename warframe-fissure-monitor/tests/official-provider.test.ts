/**
 * Official（DE WorldState）provider 测试。
 *
 * 全部基于仓库内保存的最小 fixture，不依赖实时 Warframe 数据、不联网。
 * fixture 由真实 WorldState 快照裁剪而来（ActiveMissions[0..1] + VoidStorms[0] + ProjectPct + Tmp）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectMatchingFissures } from '../src/filter.js';
import {
  createParserLogger,
  OfficialWorldStateProvider,
  parseOfficialWorldState,
} from '../src/warframe/official-provider.js';
import { ProviderError } from '../src/warframe/provider.js';
import { createFetchStub, createMemoryLogger, failingFetch, loadWorldStateFixture, WORLDSTATE_FIXTURE_FETCHED_AT } from './helpers.js';

const NOW = WORLDSTATE_FIXTURE_FETCHED_AT;

function jsonResponseWithHtmlContentType(body: unknown): Response {
  // 官方响应头确实是 text/html，这里刻意保留以证明解析不依赖 content-type
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });
}

test('能从固定 WorldState fixture 解析出裂缝', async () => {
  const fixture = await loadWorldStateFixture();
  const result = parseOfficialWorldState(fixture);

  assert.equal(result.provider, 'official');
  assert.equal(result.skipped, 0);
  assert.deepEqual(
    result.fissures.map((fissure) => fissure.node).sort(),
    ['Adaro (Sedna)', 'Ani (Void)', 'Belenus (Void)', 'Mot (Void)', 'Ogal Cluster (Earth)'],
  );
});

test('fixture 中 Hard=true 正确映射为 isHard=true', async () => {
  const fixture = await loadWorldStateFixture();
  const result = parseOfficialWorldState(fixture);

  const mot = result.fissures.find((fissure) => fissure.node === 'Mot (Void)');
  assert.ok(mot !== undefined);
  assert.equal(mot.isHard, true);
  assert.equal(mot.missionType, 'Survival');
  assert.equal(mot.missionTypeKey, 'Survival');
  assert.equal(mot.tier, 'Axi');
  assert.equal(mot.tierNum, 4);
  assert.equal(mot.nodeKey, 'Mot (Void)');
  assert.equal(mot.enemy, 'Orokin');
});

test('Void Storm（ActiveMissionTier）正确映射为 isStorm=true', async () => {
  const fixture = await loadWorldStateFixture();
  const result = parseOfficialWorldState(fixture);

  const storm = result.fissures.find((fissure) => fissure.isStorm === true);
  assert.ok(storm !== undefined);
  assert.equal(storm.node, 'Ogal Cluster (Earth)');
  assert.equal(storm.missionTypeKey, 'Skirmish');
  assert.equal(storm.tier, 'Lith');
});

test('普通裂缝（无 ActiveMissionTier）映射为 isStorm=false', async () => {
  const fixture = await loadWorldStateFixture();
  const result = parseOfficialWorldState(fixture);

  const belenus = result.fissures.find((fissure) => fissure.node === 'Belenus (Void)');
  assert.ok(belenus !== undefined);
  assert.equal(belenus.isStorm, false);
  assert.equal(belenus.isHard, false);
  assert.equal(belenus.missionTypeKey, 'Defense');
});

test('fixture 中「Steel Path + Void + Survival + 非 VoidStorm」正好匹配 Mot 与 Ani', async () => {
  const fixture = await loadWorldStateFixture();
  const result = parseOfficialWorldState(fixture);
  const matched = selectMatchingFissures(result.fissures, NOW);

  assert.deepEqual(
    matched.map((fissure) => fissure.node),
    ['Mot (Void)', 'Ani (Void)'],
  );
  assert.ok(matched.every((fissure) => fissure.isHard === true && fissure.isStorm === false));
});

test('通过 HTTP 获取并解析（不依赖 content-type，fixture 走完整 provider 路径）', async () => {
  const fixture = await loadWorldStateFixture();
  const stub = createFetchStub(() => jsonResponseWithHtmlContentType(fixture));
  const provider = new OfficialWorldStateProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  const result = await provider.fetchFissures();

  assert.equal(result.provider, 'official');
  assert.equal(result.fissures.length, 5);
  assert.deepEqual(stub.urls(), ['https://api.warframe.com/cdn/worldState.php']);
});

test('official provider 请求失败 -> ProviderError(kind=request)', async () => {
  const provider = new OfficialWorldStateProvider({ timeoutMs: 5_000, fetchImpl: failingFetch().fetch });

  await assert.rejects(
    () => provider.fetchFissures(),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.provider, 'official');
      assert.equal(error.kind, 'request');
      return true;
    },
  );
});

test('official provider HTTP 500 -> ProviderError(kind=request)，且 5xx 会有限重试', async () => {
  const stub = createFetchStub(() => new Response('boom', { status: 500 }));
  const delays: number[] = [];
  const provider = new OfficialWorldStateProvider({
    timeoutMs: 5_000,
    fetchImpl: stub.fetch,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  await assert.rejects(() => provider.fetchFissures(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'request');
    assert.match(error.message, /HTTP 500/);
    assert.match(error.message, /attempt=3\/3/);
    return true;
  });

  assert.equal(stub.calls.length, 3, '5xx 应重试到上限');
  assert.deepEqual(delays, [1_000, 3_000], '退避应为 1s / 3s');
});

test('响应被网关拦截（HTML 而非 JSON）-> ProviderError(kind=parse)', async () => {
  const stub = createFetchStub(() => new Response('<!DOCTYPE html><html>Cloudflare</html>', { status: 200 }));
  const provider = new OfficialWorldStateProvider({ timeoutMs: 5_000, fetchImpl: stub.fetch });

  await assert.rejects(() => provider.fetchFissures(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'parse');
    return true;
  });
});

test('响应是 JSON 但没有 ActiveMissions/VoidStorms -> ProviderError(kind=empty)', async () => {
  const fixture = (await loadWorldStateFixture()) as Record<string, unknown>;
  const withoutArrays = { Tmp: fixture.Tmp, ProjectPct: fixture.ProjectPct };

  assert.throws(() => parseOfficialWorldState(withoutArrays), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'empty');
    return true;
  });
});

test('单条脏记录只跳过该条（不会静默制造错误匹配，也不会毁掉整批）', async () => {
  const fixture = (await loadWorldStateFixture()) as { ActiveMissions: unknown[]; VoidStorms: unknown[] };
  const dirty = {
    ...fixture,
    ActiveMissions: [
      ...fixture.ActiveMissions,
      { Node: 'SolNode409', MissionType: 'MT_SURVIVAL', Modifier: 'VoidT4', Hard: true }, // 缺 _id
      { _id: { $oid: 'fixture-broken-expiry' }, Node: 'SolNode405', MissionType: 'MT_SURVIVAL' }, // 缺 Expiry
      { _id: { $oid: 'fixture-no-tier' }, Node: 'SolNode405', MissionType: 'MT_SURVIVAL' }, // 缺 Modifier（parser 会抛错）
      { _id: { $oid: 'fixture-no-node' }, MissionType: 'MT_SURVIVAL', Modifier: 'VoidT4' }, // 缺 Node
      'not-an-object',
    ],
  };
  const logger = createMemoryLogger();

  const result = parseOfficialWorldState(dirty, { logger });

  assert.equal(result.fissures.length, 5, '合法记录仍然全部解析');
  assert.equal(result.skipped, 5, '脏记录全部计入 skipped');
  assert.ok(
    result.fissures.every((fissure) => fissure.id !== '' && Number.isFinite(Date.parse(fissure.expiry))),
    '被跳过的脏记录不会进入结果',
  );
  assert.match(logger.text(), /无法解析，已跳过/);
});

/**
 * 控制台噪音测试。
 *
 * 背景（已核对 parser 源码）：
 * warframe-worldstate-parser 的 defaultDeps 里 `logger: console`，且构造函数做
 * `{ ...defaultDeps, ...deps }`；因此不注入 logger 时，每次 new WorldState() 都会
 * 往 console.debug 打印 "No defined kuva data, skipping data" / "No outpost data, skipping"。
 * 本项目改为注入自己的 logger（见 createParserLogger），因此解析期间不应有任何 console 输出。
 */

type ConsoleMethodName = 'debug' | 'log' | 'warn' | 'error';

interface ConsoleCapture {
  calls: Array<{ method: ConsoleMethodName; args: unknown[] }>;
  /** 恢复原始 console 方法 */
  restore(): void;
  /** 断言 console 方法已与原始引用完全一致 */
  assertRestored(): void;
}

const CONSOLE_METHODS: ConsoleMethodName[] = ['debug', 'log', 'warn', 'error'];

function captureConsole(): ConsoleCapture {
  const target = console as unknown as Record<ConsoleMethodName, (...args: unknown[]) => void>;
  const originals = new Map<ConsoleMethodName, (...args: unknown[]) => void>();
  const calls: Array<{ method: ConsoleMethodName; args: unknown[] }> = [];

  for (const method of CONSOLE_METHODS) {
    originals.set(method, target[method]);
    target[method] = (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  }

  return {
    calls,
    restore: (): void => {
      for (const method of CONSOLE_METHODS) {
        const original = originals.get(method);
        if (original !== undefined) target[method] = original;
      }
    },
    assertRestored: (): void => {
      for (const method of CONSOLE_METHODS) {
        assert.equal(target[method], originals.get(method), `console.${method} 必须被恢复为原始引用`);
      }
    },
  };
}

test('解析 WorldState 时不会向 console 写入任何内容（含 console.debug）', async () => {
  const fixture = await loadWorldStateFixture();
  const capture = captureConsole();
  let fissureCount = 0;

  try {
    fissureCount = parseOfficialWorldState(fixture).fissures.length;
  } finally {
    capture.restore();
  }

  assert.equal(fissureCount, 5);
  assert.deepEqual(capture.calls, [], '解析期间不应有任何 console 输出（之前是 console.debug 噪音）');
  capture.assertRestored();
});

test('即使提供了 logger，解析期间 console 仍然保持干净，且 console 方法在结束后完全恢复', async () => {
  const fixture = await loadWorldStateFixture();
  const logger = createMemoryLogger();
  const capture = captureConsole();

  try {
    parseOfficialWorldState(fixture, { logger });
    assert.deepEqual(capture.calls, []);
  } finally {
    capture.restore();
  }

  capture.assertRestored();
});

test('parser 的 debug 信息被转发到 logger.debug（不丢信息、不吞未知警告）', async () => {
  const fixture = await loadWorldStateFixture();
  const logger = createMemoryLogger();
  const capture = captureConsole();

  try {
    parseOfficialWorldState(fixture, { logger });
  } finally {
    capture.restore();
  }
  capture.assertRestored();

  const debugMessages = logger.records.filter((record) => record.level === 'debug').map((record) => record.message);
  assert.ok(
    debugMessages.some((message) => message.includes('[worldstate-parser] No defined kuva data, skipping data')),
    'kuva 提示应转发到 logger.debug',
  );
  assert.ok(
    debugMessages.some((message) => message.includes('[worldstate-parser] No outpost data, skipping')),
    'outpost 提示应转发到 logger.debug',
  );
});

test('createParserLogger 原样转发任意 parser 信息（不吞掉真正的诊断警告）', () => {
  const logger = createMemoryLogger();
  const parserLogger = createParserLogger(logger);

  parserLogger.debug('Failed to fetch bounty rewards for Cetus: request failed');

  assert.ok(
    logger.text().includes('[worldstate-parser] Failed to fetch bounty rewards for Cetus: request failed'),
    '未知/重要信息必须被转发，而不是被丢弃',
  );
});

test('createParserLogger 在未提供 logger 时安全地什么都不做', () => {
  const parserLogger = createParserLogger(undefined);
  assert.doesNotThrow(() => parserLogger.debug('anything'));
});

test('fixture 中的裂缝不会因为解析而变成 unknown 标志', async () => {
  const fixture = await loadWorldStateFixture();
  const result = parseOfficialWorldState(fixture);

  assert.ok(result.fissures.every((fissure) => typeof fissure.isHard === 'boolean'));
  assert.ok(result.fissures.every((fissure) => typeof fissure.isStorm === 'boolean'));
});
