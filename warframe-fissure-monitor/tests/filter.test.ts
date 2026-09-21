/**
 * 匹配规则测试：必须覆盖需求里的 5 个判定条件与典型反例。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isSurvivalMission,
  isVoidNode,
  matchesFissureCriteria,
  normalizeLabel,
  selectMatchingFissures,
} from '../src/filter.js';
import { parseFissuresResponse } from '../src/warframe/schema.js';
import { FIXED_NOW, FUTURE_EXPIRY, makeFissure } from './helpers.js';

test('Steel Path + Void + Survival + 未过期 -> 正确匹配', () => {
  const fissure = makeFissure();
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), true);
});

test('普通 Survival（非 Steel Path）不匹配', () => {
  const fissure = makeFissure({ isHard: false });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('Steel Path 非 Survival 不匹配', () => {
  const fissure = makeFissure({ missionType: 'Extermination', missionTypeKey: 'Extermination' });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('Steel Path Survival 但不是 Void 节点不匹配', () => {
  const fissure = makeFissure({ node: 'Adaro (Sedna)', nodeKey: 'Adaro (Sedna)' });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('Void Survival 但非 Steel Path 不匹配', () => {
  const fissure = makeFissure({ node: 'Mot (Void)', nodeKey: 'Mot (Void)', isHard: false });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('Void Storm（isStorm === true）不匹配', () => {
  const fissure = makeFissure({ isStorm: true });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('已过期的裂缝不匹配', () => {
  const fissure = makeFissure({ expiry: '2026-01-01T11:59:59.000Z' });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('expiry 恰好等于当前时间不匹配（必须严格晚于）', () => {
  const fissure = makeFissure({ expiry: FIXED_NOW.toISOString() });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('expiry 无法解析时不匹配', () => {
  const fissure = makeFissure({ expiry: 'not-a-date' });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), false);
});

test('节点/任务类型的大小写与多余空格不影响判断', () => {
  const fissure = makeFissure({ node: '  ani   (VOID) ', missionType: ' survival ', missionTypeKey: ' survival ' });
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), true);
});

test('兼容 API 字段轻微变化：只有 missionType / node 时也能正确匹配', () => {
  const parsed = parseFissuresResponse([
    {
      id: 'legacy-shape',
      expiry: FUTURE_EXPIRY,
      node: 'Ani (Void)',
      missionType: 'Survival',
      tier: 'Axi',
      isHard: true,
      isStorm: false,
    },
  ]);

  assert.equal(parsed.skipped.length, 0);
  const fissure = parsed.fissures[0];
  assert.ok(fissure !== undefined);
  assert.equal(matchesFissureCriteria(fissure, FIXED_NOW), true);
});

test('isVoidNode 只认以 "(Void)" 结尾的节点', () => {
  assert.equal(isVoidNode('Ani (Void)'), true);
  assert.equal(isVoidNode('Mot (Void)'), true);
  assert.equal(isVoidNode('ani (void)'), true);
  assert.equal(isVoidNode('  Mot (Void)  '), true);
  assert.equal(isVoidNode('Void'), false);
  assert.equal(isVoidNode('(Void) Ani'), false);
  assert.equal(isVoidNode('Adaro (Sedna)'), false);
  assert.equal(isVoidNode('Void Storm (Neptune)'), false);
});

test('isSurvivalMission 只认 Survival', () => {
  assert.equal(isSurvivalMission('Survival'), true);
  assert.equal(isSurvivalMission(' survival '), true);
  assert.equal(isSurvivalMission('Survival (Steel Path)'), false);
  assert.equal(isSurvivalMission('Defense'), false);
});

test('normalizeLabel 合并空白', () => {
  assert.equal(normalizeLabel('  Ani    (Void) '), 'Ani (Void)');
});

test('selectMatchingFissures 只保留匹配项且保持顺序', () => {
  const fissures = [
    makeFissure({ id: 'a', node: 'Ani (Void)' }),
    makeFissure({ id: 'b', isHard: false }),
    makeFissure({ id: 'c', missionType: 'Defense', missionTypeKey: 'Defense' }),
    makeFissure({ id: 'd', node: 'Taveuni (Kuva Fortress)', nodeKey: 'Taveuni (Kuva Fortress)' }),
    makeFissure({ id: 'e', node: 'Mot (Void)', isStorm: false }),
    makeFissure({ id: 'f', expiry: '2026-01-01T11:00:00.000Z' }),
  ];

  const matched = selectMatchingFissures(fissures, FIXED_NOW);
  assert.deepEqual(
    matched.map((fissure) => fissure.id),
    ['a', 'e'],
  );
});
