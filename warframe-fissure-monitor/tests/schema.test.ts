/**
 * WarframeStat.us 响应解析测试：字段兼容、unknown 语义、脏数据跳过、响应外形校验。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WarframeResponseFormatError, parseFissuresResponse } from '../src/warframe/schema.js';

const VALID_RAW = {
  id: 'fissure-1',
  activation: '2026-01-01T11:45:00.000Z',
  expiry: '2026-01-01T12:30:00.000Z',
  node: 'Ani (Void)',
  nodeKey: 'Ani (Void)',
  missionType: 'Survival',
  missionTypeKey: 'Survival',
  enemy: 'Corrupted',
  tier: 'Axi',
  tierNum: 4,
  isHard: true,
  isStorm: false,
};

test('解析标准数组响应', () => {
  const result = parseFissuresResponse([VALID_RAW]);

  assert.equal(result.skipped.length, 0);
  assert.equal(result.fissures.length, 1);
  const fissure = result.fissures[0];
  assert.ok(fissure !== undefined);
  assert.deepEqual(fissure, {
    id: 'fissure-1',
    activation: '2026-01-01T11:45:00.000Z',
    expiry: '2026-01-01T12:30:00.000Z',
    node: 'Ani (Void)',
    nodeKey: 'Ani (Void)',
    missionType: 'Survival',
    missionTypeKey: 'Survival',
    enemy: 'Corrupted',
    tier: 'Axi',
    tierNum: 4,
    isHard: true,
    isStorm: false,
  });
});

test('缺少 missionTypeKey / nodeKey 时回退到 missionType / node', () => {
  const result = parseFissuresResponse([
    {
      id: 'fissure-legacy',
      expiry: '2026-01-01T12:30:00.000Z',
      node: 'Mot (Void)',
      missionType: 'Survival',
      tier: 'Axi',
      isHard: true,
      isStorm: false,
    },
  ]);

  assert.equal(result.skipped.length, 0);
  const fissure = result.fissures[0];
  assert.ok(fissure !== undefined);
  assert.equal(fissure.node, 'Mot (Void)');
  assert.equal(fissure.missionType, 'Survival');
  assert.equal(fissure.nodeKey, null);
  assert.equal(fissure.missionTypeKey, null);
});

test('mission type fallback 顺序：missionTypeKey -> missionKey -> missionType', () => {
  const withKey = parseFissuresResponse([
    { ...VALID_RAW, id: 'k1', missionType: 'Defense', missionKey: 'Interception', missionTypeKey: 'Survival' },
  ]);
  assert.equal(withKey.fissures[0]?.missionType, 'Survival');

  const withMissionKey = parseFissuresResponse([
    { ...VALID_RAW, id: 'k2', missionType: 'Defense', missionKey: 'Survival', missionTypeKey: undefined },
  ]);
  assert.equal(withMissionKey.fissures[0]?.missionType, 'Survival');

  const withMissionType = parseFissuresResponse([
    { ...VALID_RAW, id: 'k3', missionType: 'Survival', missionKey: undefined, missionTypeKey: undefined },
  ]);
  assert.equal(withMissionType.fissures[0]?.missionType, 'Survival');
});

test('isHard / isStorm 缺失时保持 unknown（null），绝不猜测成 false', () => {
  const result = parseFissuresResponse([{ ...VALID_RAW, isHard: undefined, isStorm: undefined }]);
  const fissure = result.fissures[0];

  assert.ok(fissure !== undefined);
  assert.equal(fissure.isHard, null);
  assert.equal(fissure.isStorm, null);
  assert.notEqual(fissure.isStorm, false, 'unknown 不能被当成「确定不是 Void Storm」');
});

test('isHard / isStorm 为 false 时仍然是明确的 false', () => {
  const result = parseFissuresResponse([{ ...VALID_RAW, isHard: false, isStorm: false }]);
  assert.equal(result.fissures[0]?.isHard, false);
  assert.equal(result.fissures[0]?.isStorm, false);
});

test('缺少 tier 时使用 Unknown 兜底；tierNum 支持字符串', () => {
  const noTier = parseFissuresResponse([{ ...VALID_RAW, id: 't1', tier: undefined, tierNum: undefined }]);
  assert.equal(noTier.fissures[0]?.tier, 'Unknown');
  assert.equal(noTier.fissures[0]?.tierNum, null);

  const stringTier = parseFissuresResponse([{ ...VALID_RAW, id: 't2', tierNum: '4' }]);
  assert.equal(stringTier.fissures[0]?.tierNum, 4);
});

test('接受 { fissures: [...] } 外形', () => {
  const result = parseFissuresResponse({ fissures: [VALID_RAW] });
  assert.equal(result.fissures.length, 1);
});

test('整体外形错误时抛出 WarframeResponseFormatError', () => {
  assert.throws(() => parseFissuresResponse({ nope: true }), WarframeResponseFormatError);
  assert.throws(() => parseFissuresResponse(null), WarframeResponseFormatError);
});

test('单条脏数据只跳过该条，不影响其它记录', () => {
  const result = parseFissuresResponse([
    VALID_RAW,
    { ...VALID_RAW, id: 'no-node', node: undefined, nodeKey: undefined },
    { ...VALID_RAW, id: 'bad-expiry', expiry: 'tomorrow-ish' },
    { ...VALID_RAW, id: 12_345 },
    'not-an-object',
  ]);

  assert.equal(result.fissures.length, 1);
  assert.equal(result.skipped.length, 4);
  assert.ok(result.skipped.every((item) => typeof item.reason === 'string' && item.reason.length > 0));
});

test('重复 id 只保留第一条', () => {
  const result = parseFissuresResponse([VALID_RAW, { ...VALID_RAW, node: 'Duplicate (Void)', nodeKey: 'Duplicate (Void)' }]);

  assert.equal(result.fissures.length, 1);
  assert.equal(result.fissures[0]?.node, 'Ani (Void)');
  assert.equal(result.skipped.length, 1);
});
