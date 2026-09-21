/**
 * 中文展示层测试：节点 / 星系 / tier 映射与安全 fallback。
 * 注意：这些映射只用于显示，绝不参与匹配判断。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  circledNumber,
  localizeMissionLabel,
  localizeNodeLabel,
  localizeNodeName,
  localizeRegionLabel,
  localizeTierLabel,
  parseNodeLabel,
} from '../src/localization/zh-cn.js';

test('Void 生存节点中文映射：Ani -> 阿尼，Mot -> 默特', () => {
  assert.equal(localizeNodeName('Ani'), '阿尼');
  assert.equal(localizeNodeName('Mot'), '默特');
  assert.equal(localizeNodeLabel('Ani'), '阿尼（Ani）');
  assert.equal(localizeNodeLabel('Mot'), '默特（Mot）');
});

test('未知节点安全 fallback 到英文原名，且不抛异常', () => {
  assert.equal(localizeNodeName('Orvin-Haarc'), 'Orvin-Haarc');
  assert.equal(localizeNodeLabel('Orvin-Haarc'), 'Orvin-Haarc');
  assert.equal(localizeNodeName(''), '');
  assert.equal(localizeNodeLabel('未知节点'), '未知节点');
  // 不应因为缺少映射而抛错
  assert.doesNotThrow(() => localizeNodeLabel('R-9 Cloud'));
});

test('parseNodeLabel 可靠拆分节点与星系（无固定下标 magic number）', () => {
  assert.deepEqual(parseNodeLabel('Ani (Void)'), { name: 'Ani', region: 'Void' });
  assert.deepEqual(parseNodeLabel('Mot (Void)'), { name: 'Mot', region: 'Void' });
  assert.deepEqual(parseNodeLabel('Adaro (Sedna)'), { name: 'Adaro', region: 'Sedna' });
  assert.deepEqual(parseNodeLabel('Tuvul Commons (Zariman)'), { name: 'Tuvul Commons', region: 'Zariman' });
  assert.deepEqual(parseNodeLabel('  Mot (Void)  '), { name: 'Mot', region: 'Void' });
  assert.deepEqual(parseNodeLabel('Mot(Void)'), { name: 'Mot', region: 'Void' });
  assert.deepEqual(parseNodeLabel('Void'), { name: 'Void', region: null });
  assert.deepEqual(parseNodeLabel(''), { name: '', region: null });
});

test('星系映射：Void -> 虚空（Void）', () => {
  assert.equal(localizeRegionLabel('Void'), '虚空（Void）');
  assert.equal(localizeRegionLabel('Sedna'), 'Sedna');
});

test('tier 中文映射：Lith/Meso/Neo/Axi/Requiem/Omnia', () => {
  assert.equal(localizeTierLabel('Lith'), '古纪（Lith）');
  assert.equal(localizeTierLabel('Meso'), '前纪（Meso）');
  assert.equal(localizeTierLabel('Neo'), '中纪（Neo）');
  assert.equal(localizeTierLabel('Axi'), '后纪（Axi）');
  assert.equal(localizeTierLabel('Requiem'), '安魂（Requiem）');
  assert.equal(localizeTierLabel('Omnia'), '全能（Omnia）');
});

test('未知 tier / 任务类型回退英文', () => {
  assert.equal(localizeTierLabel('Unknown'), 'Unknown');
  assert.equal(localizeTierLabel('VoidT9'), 'VoidT9');
  assert.equal(localizeMissionLabel('Survival'), '生存（Survival）');
  assert.equal(localizeMissionLabel('Defense'), 'Defense');
});

test('circledNumber 生成 ①②③...，超出范围回退 "N."', () => {
  assert.equal(circledNumber(1), '①');
  assert.equal(circledNumber(2), '②');
  assert.equal(circledNumber(20), '⑳');
  assert.equal(circledNumber(21), '21.');
});
