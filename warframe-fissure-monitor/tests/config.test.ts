/**
 * 配置加载测试：默认值、必填项、格式校验、token 不泄漏。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigError,
  DEFAULT_NAPCAT_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WARFRAME_API_URL,
  describeConfig,
  loadConfig,
  requireTargetQq,
} from '../src/config.js';

const BASE_ENV = {
  TARGET_QQ: '10001',
  NAPCAT_TOKEN: 'super-secret-token',
} satisfies NodeJS.ProcessEnv;

function load(env: NodeJS.ProcessEnv) {
  return loadConfig({ env, loadDotEnv: false, requireTargetQq: true, cwd: process.cwd() });
}

test('未设置任何变量时使用默认值', () => {
  const config = load({ TARGET_QQ: '10001' });

  assert.equal(config.warframeApiUrl, DEFAULT_WARFRAME_API_URL);
  assert.equal(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  assert.equal(config.napcatBaseUrl, DEFAULT_NAPCAT_BASE_URL);
  assert.equal(config.napcatToken, null);
  assert.equal(config.dryRun, false);
  assert.equal(config.targetQq, '10001');
});

test('读取全部环境变量', () => {
  const config = load({
    ...BASE_ENV,
    WARFRAME_API_URL: 'https://example.com/fissures',
    POLL_INTERVAL_MS: '90000',
    NAPCAT_BASE_URL: 'http://192.168.1.10:3000/',
    DRY_RUN: 'true',
    HTTP_TIMEOUT_MS: '3000',
    NAPCAT_TIMEOUT_MS: '4000',
    LOG_LEVEL: 'debug',
  });

  assert.equal(config.warframeApiUrl, 'https://example.com/fissures');
  assert.equal(config.pollIntervalMs, 90_000);
  assert.equal(config.napcatBaseUrl, 'http://192.168.1.10:3000/');
  assert.equal(config.napcatToken, 'super-secret-token');
  assert.equal(config.dryRun, true);
  assert.equal(config.httpTimeoutMs, 3_000);
  assert.equal(config.napcatTimeoutMs, 4_000);
  assert.equal(config.logLevel, 'debug');
});

test('缺少 TARGET_QQ 时抛出可读错误', () => {
  assert.throws(() => load({}), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /TARGET_QQ/);
    assert.match(error.message, /\.env/);
    return true;
  });
});

test('TARGET_QQ 非纯数字时抛出错误', () => {
  assert.throws(() => load({ TARGET_QQ: 'abc123' }), ConfigError);
  assert.throws(() => load({ TARGET_QQ: '123' }), ConfigError);
});

test('requireTargetQq=false 时允许 TARGET_QQ 为空（check 模式）', () => {
  const config = loadConfig({ env: { NAPCAT_TOKEN: 'x' }, loadDotEnv: false, requireTargetQq: false });

  assert.equal(config.targetQq, null);
  assert.throws(() => requireTargetQq(config), ConfigError);
});

test('POLL_INTERVAL_MS 非法或过小时抛出错误', () => {
  assert.throws(() => load({ TARGET_QQ: '10001', POLL_INTERVAL_MS: '1000' }), ConfigError);
  assert.throws(() => load({ TARGET_QQ: '10001', POLL_INTERVAL_MS: 'abc' }), ConfigError);
});

test('DRY_RUN 支持多种写法', () => {
  assert.equal(load({ TARGET_QQ: '10001', DRY_RUN: '1' }).dryRun, true);
  assert.equal(load({ TARGET_QQ: '10001', DRY_RUN: 'YES' }).dryRun, true);
  assert.equal(load({ TARGET_QQ: '10001', DRY_RUN: 'off' }).dryRun, false);
  assert.throws(() => load({ TARGET_QQ: '10001', DRY_RUN: 'maybe' }), ConfigError);
});

test('describeConfig 不会泄漏 token 内容', () => {
  const config = load({ ...BASE_ENV });
  const description = JSON.stringify(describeConfig(config));

  assert.doesNotMatch(description, /super-secret-token/);
  assert.match(description, /\(已设置\)/);
});
