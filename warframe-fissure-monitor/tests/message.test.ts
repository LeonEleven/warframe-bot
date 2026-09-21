/**
 * 通知文案测试（简体中文优先，英文名放括号，不含 tierNum）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildNotificationMessage,
  formatFissureDetail,
  formatFissureLine,
  formatLocalDateTime,
  formatRemaining,
  NOTIFICATION_TITLE,
} from '../src/notify/message.js';
import { makeFissure } from './helpers.js';

// 使用本地时间构造，保证断言与机器时区无关
const NOW = new Date(2026, 0, 1, 12, 0, 0);
const MOT_EXPIRY = new Date(2026, 0, 1, 13, 24, 0).toISOString();
const ANI_EXPIRY = new Date(2026, 0, 1, 12, 15, 0).toISOString();

test('单条裂缝：文案完全符合约定的中文格式', () => {
  const fissure = makeFissure({ node: 'Mot (Void)', nodeKey: 'Mot (Void)', tier: 'Axi', tierNum: 4, expiry: MOT_EXPIRY });
  const message = buildNotificationMessage([fissure], NOW);

  assert.equal(
    message,
    [
      NOTIFICATION_TITLE,
      '',
      '发现新的虚空钢铁之路生存裂缝！',
      '',
      '节点：默特（Mot）',
      '星系：虚空（Void）',
      '任务：生存（Survival）',
      '模式：钢铁之路（Steel Path）',
      '裂缝：后纪（Axi）',
      '剩余：1 小时 24 分',
      '结束：2026-01-01 13:24:00',
      '',
      '检测：2026-01-01 12:00:00',
    ].join('\n'),
  );
});

test('文案包含 默特（Mot）/虚空（Void）/生存（Survival）/钢铁之路（Steel Path）/后纪（Axi）', () => {
  const message = buildNotificationMessage(
    [makeFissure({ node: 'Mot (Void)', nodeKey: 'Mot (Void)', expiry: MOT_EXPIRY })],
    NOW,
  );

  for (const expected of ['默特（Mot）', '虚空（Void）', '生存（Survival）', '钢铁之路（Steel Path）', '后纪（Axi）']) {
    assert.ok(message.includes(expected), `文案应包含 ${expected}`);
  }
});

test('QQ 文案中不出现 tierNum', () => {
  const fissure = makeFissure({ expiry: MOT_EXPIRY, tier: 'Axi', tierNum: 4 });
  const message = buildNotificationMessage([fissure], NOW);

  assert.doesNotMatch(message, /tierNum/);
  // 裂缝等级只显示中文+英文名，不附带数字等级
  assert.ok(message.includes('裂缝：后纪（Axi）'));
  assert.ok(!message.includes('（4）'));
  assert.ok(!message.includes('(4)'));
});

test('Ani 节点显示 阿尼（Ani）', () => {
  const message = buildNotificationMessage([makeFissure({ node: 'Ani (Void)', nodeKey: 'Ani (Void)', expiry: ANI_EXPIRY })], NOW);
  assert.ok(message.includes('节点：阿尼（Ani）'));
  assert.ok(message.includes('裂缝：后纪（Axi）'));
  assert.ok(message.includes('剩余：15 分 0 秒'));
});

test('多条裂缝合并为一条消息并用 ①② 编号', () => {
  const first = makeFissure({ id: 'a', node: 'Ani (Void)', nodeKey: 'Ani (Void)', tier: 'Neo', tierNum: 3, expiry: ANI_EXPIRY });
  const second = makeFissure({ id: 'b', node: 'Mot (Void)', nodeKey: 'Mot (Void)', tier: 'Axi', tierNum: 4, expiry: MOT_EXPIRY });

  const message = buildNotificationMessage([first, second], NOW);

  assert.ok(message.includes('发现 2 个新的虚空钢铁之路生存裂缝！'));
  assert.ok(message.includes('① 阿尼（Ani）'));
  assert.ok(message.includes('② 默特（Mot）'));
  assert.ok(message.includes('裂缝：中纪（Neo）'));
  assert.ok(message.includes('裂缝：后纪（Axi）'));
  assert.equal(message.split('检测：').length, 2);
});

test('未知节点安全回退英文，不抛异常', () => {
  const fissure = makeFissure({ node: 'Orvin-Haarc (Venus)', nodeKey: 'Orvin-Haarc (Venus)', expiry: MOT_EXPIRY });
  const message = buildNotificationMessage([fissure], NOW);

  assert.ok(message.includes('节点：Orvin-Haarc'));
  assert.ok(message.includes('星系：Venus'));
});

test('自定义 title / subtitle / footer 生效（测试通知使用）', () => {
  const message = buildNotificationMessage([makeFissure({ node: 'Mot (Void)', nodeKey: 'Mot (Void)', expiry: MOT_EXPIRY })], NOW, {
    title: '【测试】',
    subtitle: '测试说明',
    footer: '页脚说明',
  });

  assert.ok(message.startsWith('【测试】\n\n测试说明'));
  assert.ok(message.endsWith('页脚说明'));
});

test('formatRemaining 覆盖各时间尺度', () => {
  assert.equal(formatRemaining(90_000), '1 分 30 秒');
  assert.equal(formatRemaining(3_600_000), '1 小时 0 分');
  assert.equal(formatRemaining(90_000_000), '1 天 1 小时 0 分');
  assert.equal(formatRemaining(0), '已过期');
  assert.equal(formatRemaining(Number.NaN), '未知');
});

test('formatLocalDateTime 输出 YYYY-MM-DD HH:mm:ss（本地时间）', () => {
  assert.equal(formatLocalDateTime(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
  assert.equal(formatLocalDateTime(Number.NaN), '未知时间');
});

test('开发者向输出仍然保留 tierNum / isHard / isStorm / id', () => {
  const fissure = makeFissure({ node: 'Mot (Void)', nodeKey: 'Mot (Void)', expiry: MOT_EXPIRY, tier: 'Axi', tierNum: 4 });
  const line = formatFissureLine(fissure, NOW);
  const detail = formatFissureDetail(fissure, NOW);

  assert.match(line, /tier=Axi\/4/);
  assert.match(line, /isHard=true/);
  assert.match(line, /isStorm=false/);
  assert.match(line, /id=fissure-default/);

  assert.match(detail, /tierNum\s+: 4/);
  assert.match(detail, /isHard\s+: true/);
  assert.match(detail, /isStorm\s+: false/);
  assert.match(detail, /node\s+: Mot \(Void\)/);
});

test('unknown 标志在开发者输出里显示为 unknown', () => {
  const fissure = makeFissure({ isHard: null, isStorm: null });
  assert.match(formatFissureLine(fissure, NOW), /isHard=unknown/);
  assert.match(formatFissureLine(fissure, NOW), /isStorm=unknown/);
});
