/**
 * 通知文案测试：内容必须包含节点、tier、Steel Path、生存任务、expiry 与剩余时间。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNotificationMessage, formatFissureLine, formatLocalDateTime, formatRemaining } from '../src/notify/message.js';
import { FIXED_NOW, makeFissure } from './helpers.js';

test('formatRemaining 覆盖各时间尺度', () => {
  assert.equal(formatRemaining(90_000), '1 分 30 秒');
  assert.equal(formatRemaining(3_600_000), '1 小时 0 分');
  assert.equal(formatRemaining(90_000_000), '1 天 1 小时 0 分');
  assert.equal(formatRemaining(0), '已过期');
  assert.equal(formatRemaining(-5_000), '已过期');
  assert.equal(formatRemaining(Number.NaN), '未知');
});

test('formatLocalDateTime 输出 YYYY-MM-DD HH:mm:ss（本地时间）', () => {
  const local = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(formatLocalDateTime(local), '2026-01-02 03:04:05');
  assert.equal(formatLocalDateTime(Number.NaN), '未知时间');
});

test('单条裂缝消息包含全部要求的信息', () => {
  const fissure = makeFissure({ node: 'Mot (Void)', nodeKey: 'Mot (Void)', tier: 'Axi', tierNum: 4 });
  const message = buildNotificationMessage([fissure], FIXED_NOW);

  assert.match(message, /Mot \(Void\)/);
  assert.match(message, /Axi/);
  assert.match(message, /tierNum 4/);
  assert.match(message, /Steel Path/);
  assert.match(message, /生存（Survival）/);
  assert.match(message, /非 Void Storm/);
  assert.match(message, /过期时间：/);
  assert.match(message, /剩余 30 分 0 秒/);
  assert.match(message, /检查时间：/);
});

test('多条裂缝合并为一条消息并编号', () => {
  const first = makeFissure({ id: 'a', node: 'Ani (Void)', nodeKey: 'Ani (Void)', tier: 'Axi', tierNum: 4 });
  const second = makeFissure({
    id: 'b',
    node: 'Mot (Void)',
    nodeKey: 'Mot (Void)',
    tier: 'Neo',
    tierNum: 3,
    expiry: '2026-01-01T12:15:00.000Z',
  });

  const message = buildNotificationMessage([first, second], FIXED_NOW);

  assert.match(message, /发现 2 个新的 Steel Path 生存裂缝/);
  assert.match(message, /1\. 节点：Ani \(Void\)/);
  assert.match(message, /2\. 节点：Mot \(Void\)/);
  assert.match(message, /剩余 15 分 0 秒/);
  // 只有一条消息（而不是两条）
  assert.equal(message.split('检查时间：').length, 2);
});

test('自定义 title / footer 生效（测试通知用）', () => {
  const message = buildNotificationMessage([makeFissure()], FIXED_NOW, {
    title: '【测试】',
    subtitle: '测试说明',
    footer: '页脚说明',
  });

  assert.ok(message.startsWith('【测试】\n测试说明'));
  assert.ok(message.endsWith('页脚说明'));
});

test('formatFissureLine 提供单行摘要', () => {
  const line = formatFissureLine(makeFissure({ node: 'Mot (Void)', nodeKey: 'Mot (Void)' }), FIXED_NOW);
  assert.match(line, /Mot \(Void\)/);
  assert.match(line, /tier=Axi\/4/);
  assert.match(line, /isHard=true/);
  assert.match(line, /isStorm=false/);
  assert.match(line, /剩余=30 分 0 秒/);
  assert.match(line, /id=fissure-default/);
});
