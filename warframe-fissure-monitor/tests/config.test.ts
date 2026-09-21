/**
 * 配置加载测试：默认值、数据源选择、旧变量兼容、代理校验、脱敏。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigError,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_NAPCAT_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  describeConfig,
  loadConfig,
  requireTargetQq,
} from '../src/config.js';
import { DEFAULT_WARFRAMESTAT_API_URL, DEFAULT_WORLDSTATE_URL } from '../src/warframe/defaults.js';

const BASE_ENV = {
  TARGET_QQ: '10001',
  NAPCAT_TOKEN: 'super-secret-token',
} satisfies NodeJS.ProcessEnv;

function load(env: NodeJS.ProcessEnv, options: { requireTargetQq?: boolean } = {}) {
  return loadConfig({
    env,
    loadDotEnv: false,
    requireTargetQq: options.requireTargetQq ?? true,
    cwd: process.cwd(),
  });
}

test('未设置任何变量时：默认使用 official 官方 WorldState', () => {
  const config = load({ TARGET_QQ: '10001' });

  assert.equal(config.warframeSource, 'official');
  assert.equal(config.worldStateUrl, DEFAULT_WORLDSTATE_URL);
  assert.equal(config.warframestatApiUrl, DEFAULT_WARFRAMESTAT_API_URL);
  assert.equal(config.warframeProxyUrl, null);
  assert.equal(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  assert.equal(config.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
  assert.equal(config.napcatBaseUrl, DEFAULT_NAPCAT_BASE_URL);
  assert.equal(config.napcatToken, null);
  assert.equal(config.dryRun, false);
  assert.equal(config.targetQq, '10001');
  assert.deepEqual(config.warnings, []);
  assert.equal(config.lockFile.endsWith('monitor.lock'), true);
});

test('读取全部新环境变量', () => {
  const config = load({
    ...BASE_ENV,
    WARFRAME_SOURCE: 'auto',
    WARFRAME_WORLDSTATE_URL: 'https://example.com/worldState.php',
    WARFRAMESTAT_API_URL: 'https://example.com/fissures?language=en',
    WARFRAME_PROXY_URL: 'http://127.0.0.1:7890',
    POLL_INTERVAL_MS: '90000',
    HEARTBEAT_INTERVAL_MS: '3600000',
    HTTP_TIMEOUT_MS: '3000',
    NAPCAT_TIMEOUT_MS: '4000',
    DRY_RUN: 'true',
    LOG_LEVEL: 'debug',
  });

  assert.equal(config.warframeSource, 'auto');
  assert.equal(config.worldStateUrl, 'https://example.com/worldState.php');
  assert.equal(config.warframestatApiUrl, 'https://example.com/fissures?language=en');
  assert.equal(config.warframeProxyUrl, 'http://127.0.0.1:7890');
  assert.equal(config.pollIntervalMs, 90_000);
  assert.equal(config.heartbeatIntervalMs, 3_600_000);
  assert.equal(config.httpTimeoutMs, 3_000);
  assert.equal(config.napcatTimeoutMs, 4_000);
  assert.equal(config.dryRun, true);
  assert.equal(config.logLevel, 'debug');
});

test('WARFRAME_SOURCE 非法值给出可读错误', () => {
  assert.throws(() => load({ TARGET_QQ: '10001', WARFRAME_SOURCE: 'de' }), ConfigError);
  assert.equal(load({ TARGET_QQ: '10001', WARFRAME_SOURCE: 'AUTO' }).warframeSource, 'auto');
});

test('旧变量 WARFRAME_API_URL：作为备用源地址兼容并给出废弃警告', () => {
  const config = load({ TARGET_QQ: '10001', WARFRAME_API_URL: 'https://legacy.example.com/fissures' });

  assert.equal(config.warframestatApiUrl, 'https://legacy.example.com/fissures');
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0] ?? '', /WARFRAME_API_URL 已废弃/);
  // 默认数据源仍然是 official，不受旧变量影响
  assert.equal(config.warframeSource, 'official');
  assert.equal(config.worldStateUrl, DEFAULT_WORLDSTATE_URL);
});

test('新旧变量同时设置：新变量优先，旧变量被忽略并警告（不会静默互相覆盖）', () => {
  const config = load({
    TARGET_QQ: '10001',
    WARFRAME_API_URL: 'https://legacy.example.com/fissures',
    WARFRAMESTAT_API_URL: 'https://new.example.com/fissures',
  });

  assert.equal(config.warframestatApiUrl, 'https://new.example.com/fissures');
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0] ?? '', /被忽略/);
});

test('WARFRAME_PROXY_URL 只接受 http/https', () => {
  assert.throws(() => load({ TARGET_QQ: '10001', WARFRAME_PROXY_URL: 'socks5://127.0.0.1:1080' }), ConfigError);
  assert.throws(() => load({ TARGET_QQ: '10001', WARFRAME_PROXY_URL: 'not-a-url' }), ConfigError);
  assert.equal(load({ TARGET_QQ: '10001', WARFRAME_PROXY_URL: 'https://proxy.example.com:8443' }).warframeProxyUrl, 'https://proxy.example.com:8443');
  // 留空 = 不启用代理
  assert.equal(load({ TARGET_QQ: '10001', WARFRAME_PROXY_URL: '   ' }).warframeProxyUrl, null);
});

test('缺少 TARGET_QQ 时抛出可读错误', () => {
  assert.throws(() => load({}), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /TARGET_QQ/);
    assert.match(error.message, /\.env/);
    return true;
  });
});

test('TARGET_QQ 非纯数字时抛出错误（不回显具体值）', () => {
  assert.throws(() => load({ TARGET_QQ: 'abc123' }), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.doesNotMatch(error.message, /abc123/);
    return true;
  });
});

test('requireTargetQq=false 时允许 TARGET_QQ 为空（check 模式）', () => {
  const config = load({ NAPCAT_TOKEN: 'x' }, { requireTargetQq: false });

  assert.equal(config.targetQq, null);
  assert.throws(() => requireTargetQq(config), ConfigError);
});

test('POLL_INTERVAL_MS / HEARTBEAT_INTERVAL_MS 边界校验', () => {
  assert.throws(() => load({ TARGET_QQ: '10001', POLL_INTERVAL_MS: '1000' }), ConfigError);
  assert.throws(() => load({ TARGET_QQ: '10001', POLL_INTERVAL_MS: 'abc' }), ConfigError);
  assert.throws(() => load({ TARGET_QQ: '10001', HEARTBEAT_INTERVAL_MS: '1000' }), ConfigError);
  assert.equal(load({ TARGET_QQ: '10001', HEARTBEAT_INTERVAL_MS: '60000' }).heartbeatIntervalMs, 60_000);
});

test('DRY_RUN 支持多种写法', () => {
  assert.equal(load({ TARGET_QQ: '10001', DRY_RUN: '1' }).dryRun, true);
  assert.equal(load({ TARGET_QQ: '10001', DRY_RUN: 'YES' }).dryRun, true);
  assert.equal(load({ TARGET_QQ: '10001', DRY_RUN: 'off' }).dryRun, false);
  assert.throws(() => load({ TARGET_QQ: '10001', DRY_RUN: 'maybe' }), ConfigError);
});

test('describeConfig 不会泄漏 token / QQ 号 / 代理凭据', () => {
  const config = load({
    ...BASE_ENV,
    WARFRAME_PROXY_URL: 'http://proxyuser:proxypass@127.0.0.1:7890',
  });
  const description = JSON.stringify(describeConfig(config));

  assert.doesNotMatch(description, /super-secret-token/);
  assert.doesNotMatch(description, /10001/);
  assert.doesNotMatch(description, /proxypass/);
  assert.doesNotMatch(description, /proxyuser/);
  assert.match(description, /\(已配置\)/);
  assert.match(description, /\*\*\*@127\.0\.0\.1:7890/);
});
