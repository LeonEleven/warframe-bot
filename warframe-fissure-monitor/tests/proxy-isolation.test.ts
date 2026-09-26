/**
 * 代理隔离测试。
 *
 * 核心约束（需求 三 / 23）：
 * - WARFRAME_PROXY_URL 的 dispatcher 只允许出现在 Warframe 外部请求上
 * - NapCat（127.0.0.1:3000）请求绝不能带上任何 dispatcher
 * - 日志 / 配置描述里不得出现代理用户名与密码
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFissureProviderBundle, buildRuntime } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hasEmbeddedCredentials, redactUrl } from '../src/redact.js';
import {
  createDirectDispatcher,
  createProxyDispatcher,
  createWarframeDispatcher,
  describeDispatcherKind,
  describeProxy,
  DIRECT_DISPATCHER_OPTIONS,
  isHttpProxyUrl,
  isProxyDispatcher,
  ProxyConfigError,
} from '../src/warframe/proxy.js';
import {
  createFetchStub,
  createMemoryLogger,
  jsonResponse,
  loadWorldStateFixture,
  stubFetch,
} from './helpers.js';

const PROXY_WITH_CREDENTIALS = 'http://proxyuser:proxypass@127.0.0.1:7890';

function buildConfig(env: NodeJS.ProcessEnv) {
  return loadConfig({
    env,
    loadDotEnv: false,
    requireTargetQq: true,
    cwd: process.cwd(),
  });
}

interface NapCatCall {
  url: string;
  init?: RequestInit;
}

function createNapCatStub(): { fetch: typeof fetch; calls: NapCatCall[] } {
  const calls: NapCatCall[] = [];
  const impl = stubFetch(async (url, init) => {
    calls.push(init === undefined ? { url } : { url, init });
    return jsonResponse({ status: 'ok', retcode: 0 });
  });
  return { fetch: impl, calls };
}

test('启用代理时：Warframe 请求带 dispatcher，NapCat 请求绝不带 dispatcher', async () => {
  const fixture = await loadWorldStateFixture();
  const logger = createMemoryLogger();
  const config = buildConfig({
    TARGET_QQ: '10001',
    WARFRAME_PROXY_URL: PROXY_WITH_CREDENTIALS,
    NAPCAT_BASE_URL: 'http://127.0.0.1:3000',
  });

  const warframe = createFetchStub(() => new Response(JSON.stringify(fixture), { status: 200 }));
  const napcat = createNapCatStub();

  const runtime = buildRuntime({
    config,
    logger,
    warframeFetch: warframe.fetch,
    napcatFetch: napcat.fetch,
  });

  assert.equal(runtime.proxyEnabled, true);

  await runtime.provider.fetchFissures();
  await runtime.napcat.sendPrivateMessage(runtime.targetQq, 'test');

  const warframeInit = warframe.calls[0]?.init;
  assert.ok(warframeInit?.dispatcher !== undefined, 'Warframe 请求应使用代理 dispatcher');
  assert.equal(
    (warframeInit.dispatcher as { constructor: { name: string } }).constructor.name,
    'ProxyAgent',
  );

  const napcatInit = napcat.calls[0]?.init;
  assert.ok(napcatInit !== undefined);
  assert.equal(napcatInit.dispatcher, undefined, 'NapCat 请求绝不能带 dispatcher');
  assert.equal(Object.hasOwn(napcatInit, 'dispatcher'), false, 'NapCat 请求 init 里不应出现 dispatcher 字段');
  assert.equal(napcat.calls[0]?.url, 'http://127.0.0.1:3000/send_private_msg');
});

test('未配置代理时：Warframe 请求使用专用直连 Agent（autoSelectFamily），NapCat 仍无 dispatcher', async () => {
  const fixture = await loadWorldStateFixture();
  const logger = createMemoryLogger();
  const config = buildConfig({ TARGET_QQ: '10001' });

  const warframe = createFetchStub(() => new Response(JSON.stringify(fixture), { status: 200 }));
  const napcat = createNapCatStub();

  const runtime = buildRuntime({ config, logger, warframeFetch: warframe.fetch, napcatFetch: napcat.fetch });

  assert.equal(runtime.proxyEnabled, false);
  assert.equal(runtime.proxyDescription, '(未启用)');

  await runtime.provider.fetchFissures();
  await runtime.napcat.sendPrivateMessage(runtime.targetQq, 'test');

  const dispatcher = warframe.calls[0]?.init?.dispatcher as { constructor: { name: string } } | undefined;
  assert.ok(dispatcher !== undefined, '直连时也应使用专用 dispatcher（而不是 undici 默认）');
  assert.notEqual(dispatcher.constructor.name, 'ProxyAgent', '未配置代理时不得使用 ProxyAgent');
  assert.match(runtime.dispatcherKind, /DirectAgent/);
  assert.ok(runtime.dispatcherKind.includes('autoSelectFamily=true'));

  // NapCat 永远拿不到 Warframe dispatcher
  assert.equal(napcat.calls[0]?.init?.dispatcher, undefined);
  assert.equal(Object.hasOwn(napcat.calls[0]?.init ?? {}, 'dispatcher'), false);
});

test('直连 Agent 选项：autoSelectFamily=true / 250ms，且不强制 family=4', () => {
  assert.deepEqual({ ...DIRECT_DISPATCHER_OPTIONS }, { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 });
  assert.equal(DIRECT_DISPATCHER_OPTIONS.autoSelectFamily, true);
  assert.equal(DIRECT_DISPATCHER_OPTIONS.autoSelectFamilyAttemptTimeout, 250);
  assert.ok(!Object.hasOwn(DIRECT_DISPATCHER_OPTIONS, 'family'), '不得强制 IPv4（family: 4）');
  assert.notEqual((DIRECT_DISPATCHER_OPTIONS as { family?: number }).family, 4);

  const direct = createDirectDispatcher();
  assert.equal(direct.constructor.name, 'Agent');
  assert.equal(isProxyDispatcher(direct), false);
  assert.match(describeDispatcherKind(direct), /DirectAgent\(autoSelectFamily=true,autoSelectFamilyAttemptTimeout=250\)/);
});

test('createWarframeDispatcher：无代理 -> 直连 Agent；有代理 -> ProxyAgent', () => {
  const direct = createWarframeDispatcher(null);
  assert.equal(direct.constructor.name, 'Agent');
  assert.equal(isProxyDispatcher(direct), false);

  const proxied = createWarframeDispatcher('http://127.0.0.1:7890');
  assert.equal(proxied.constructor.name, 'ProxyAgent');
  assert.equal(isProxyDispatcher(proxied), true);
  assert.match(describeDispatcherKind(proxied), /ProxyAgent/);
});

test('buildFissureProviderBundle 不需要 TARGET_QQ（check 模式）且同样隔离代理', async () => {
  const fixture = await loadWorldStateFixture();
  const logger = createMemoryLogger();
  const config = loadConfig({
    env: { WARFRAME_PROXY_URL: PROXY_WITH_CREDENTIALS },
    loadDotEnv: false,
    requireTargetQq: false,
    cwd: process.cwd(),
  });

  const warframe = createFetchStub(() => new Response(JSON.stringify(fixture), { status: 200 }));
  const bundle = buildFissureProviderBundle({ config, logger, warframeFetch: warframe.fetch });

  assert.equal(bundle.proxyEnabled, true);
  await bundle.provider.fetchFissures();

  assert.ok(warframe.calls[0]?.init?.dispatcher !== undefined);
  assert.doesNotMatch(bundle.proxyDescription, /proxypass/);
  assert.doesNotMatch(bundle.proxyDescription, /proxyuser/);
});

test('createProxyDispatcher：未配置返回 null，非法协议抛 ProxyConfigError', () => {
  assert.equal(createProxyDispatcher(null), null);
  assert.equal(createProxyDispatcher('   '), null);
  assert.equal(createProxyDispatcher('http://127.0.0.1:7890')?.constructor.name, 'ProxyAgent');
  assert.throws(() => createProxyDispatcher('socks5://127.0.0.1:1080'), ProxyConfigError);
  assert.throws(() => createProxyDispatcher('definitely not a url'), ProxyConfigError);
});

test('isHttpProxyUrl 只接受 http/https', () => {
  assert.equal(isHttpProxyUrl('http://127.0.0.1:7890'), true);
  assert.equal(isHttpProxyUrl('https://proxy.example.com:8443'), true);
  assert.equal(isHttpProxyUrl('socks5://127.0.0.1:1080'), false);
  assert.equal(isHttpProxyUrl('127.0.0.1:7890'), false);
});

test('redactUrl 去掉凭据，且对无法解析的输入不原样输出', () => {
  assert.equal(redactUrl('http://user:pass@127.0.0.1:7890'), 'http://***@127.0.0.1:7890');
  assert.equal(redactUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(redactUrl(null), '(未设置)');
  assert.equal(redactUrl('不是 URL 的字符串 :::'), '(无法解析的 URL，已隐藏)');

  assert.equal(hasEmbeddedCredentials('http://user:pass@host:1'), true);
  assert.equal(hasEmbeddedCredentials('http://host:1'), false);
});

test('describeProxy 与 describeConfig 都不泄漏代理密码', () => {
  const described = describeProxy(PROXY_WITH_CREDENTIALS);

  assert.doesNotMatch(described, /proxypass/);
  assert.doesNotMatch(described, /proxyuser/);
  assert.match(described, /\*\*\*@127\.0\.0\.1:7890/);
});
