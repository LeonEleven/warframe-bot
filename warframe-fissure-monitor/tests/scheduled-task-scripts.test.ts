/**
 * 部署层守护测试：Windows 计划任务脚本（scripts/*.ps1）的静态检查。
 *
 * 为什么用静态检查而不是真的注册任务：
 * - CI 运行在 Linux/临时环境，不能（也不应该）往 Runner 的 Task Scheduler 注册长期任务
 * - 计划任务的真实注册 / 启动 / 停止行为已在本机 Windows 上人工验证（见 README 与提交说明）
 *
 * 这里锁定的关键契约：
 * - 只有一个逻辑任务名，且三个脚本一致
 * - 延迟是 Task Scheduler 原生 Trigger Delay（PT60S），不是 action 里的 sleep/timeout
 * - MultipleInstances=IgnoreNew、ExecutionTimeLimit=PT0S（无限）、RestartInterval=PT1M
 * - 使用当前登录用户（Interactive + Limited），不使用 SYSTEM、不保存密码
 * - action 指向 scripts\run-monitor.cmd，工作目录为项目根
 * - 不含硬编码用户路径与任何凭据
 * - 脚本保存为 UTF-8 with BOM（Windows PowerShell 5.1 才能正确解析中文）+ CRLF
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TASK_NAME = 'Warframe Fissure Monitor';

interface ScriptFile {
  name: string;
  path: string;
  text: string;
  bytes: Buffer;
}

async function readScript(name: string): Promise<ScriptFile> {
  const url = new URL(`../scripts/${name}`, import.meta.url);
  const bytes = await readFile(url);
  // PowerShell 5.1 需要 BOM 才能把文件当 UTF-8 读；Node 解码后 BOM 会成为 U+FEFF，这里去掉便于断言
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  return { name, path: fileURLToPath(url), text, bytes };
}

async function readAll(): Promise<{
  install: ScriptFile;
  status: ScriptFile;
  uninstall: ScriptFile;
}> {
  const [install, status, uninstall] = await Promise.all([
    readScript('install-scheduled-task.ps1'),
    readScript('status-scheduled-task.ps1'),
    readScript('uninstall-scheduled-task.ps1'),
  ]);
  return { install, status, uninstall };
}

function extractTaskName(text: string): string | null {
  const match = /\$TaskName\s*=\s*'([^']+)'/.exec(text);
  return match?.[1] ?? null;
}

test('三个计划任务脚本都存在且非空', async () => {
  const scripts = await readAll();

  for (const script of Object.values(scripts)) {
    assert.ok(script.bytes.length > 0, `${script.path} 不应为空`);
    assert.match(script.text, /#Requires -Version 5\.1/, `${script.name} 应声明最低 PowerShell 5.1`);
  }
});

test('三个脚本使用同一个任务名', async () => {
  const scripts = await readAll();

  for (const script of Object.values(scripts)) {
    assert.equal(extractTaskName(script.text), TASK_NAME, `${script.name} 的任务名必须一致`);
  }
});

test('脚本保存为 UTF-8 with BOM（Windows PowerShell 5.1 才能正确读中文）+ CRLF', async () => {
  const scripts = await readAll();

  for (const script of Object.values(scripts)) {
    const [b0, b1, b2] = [script.bytes[0], script.bytes[1], script.bytes[2]];
    assert.ok(
      b0 === 0xef && b1 === 0xbb && b2 === 0xbf,
      `${script.name} 必须以 UTF-8 BOM 开头，否则 PowerShell 5.1 会把中文按本地代码页解析`,
    );
    assert.ok(!script.bytes.toString('utf8').includes('\uFFFD'), `${script.name} 必须是合法 UTF-8`);

    const crlf = (script.text.match(/\r\n/g) ?? []).length;
    const lines = (script.text.match(/\n/g) ?? []).length;
    assert.equal(crlf, lines, `${script.name} 必须全部使用 CRLF 换行`);
  }
});

test('install：使用 Task Scheduler 原生 Trigger Delay = 60 秒（不是 sleep/timeout 模拟）', async () => {
  const { install } = await readAll();

  assert.ok(install.text.includes('-AtLogOn'), '必须使用 AtLogOn 触发器');
  assert.ok(install.text.includes("$LogonDelay = 'PT60S'"), '延迟常量必须为 PT60S（60 秒）');
  assert.match(install.text, /\$trigger\.Delay\s*=\s*\$LogonDelay/, '必须把延迟赋给 trigger.Delay');

  assert.doesNotMatch(install.text, /Start-Sleep\s+-Seconds\s+60/i, '不得用 Start-Sleep 模拟 60 秒延迟');
  assert.doesNotMatch(install.text, /timeout\s+\/t/i, '不得用 timeout /t 模拟延迟');
  assert.doesNotMatch(install.text, /ping\s+-n/i, '不得用 ping 模拟延迟');
});

test('install：多实例 / 执行时限 / 重启 / 电池 / 空闲等设置符合长期常驻要求', async () => {
  const { install } = await readAll();

  // 多实例：IgnoreNew（第一层保护；项目内 PID lock 为第二层）
  assert.ok(install.text.includes('IgnoreNew'), 'Must use MultipleInstances IgnoreNew');
  // 执行时限：PT0S = 无限制
  assert.ok(install.text.includes('-ExecutionTimeLimit ([TimeSpan]::Zero)'), '执行时限必须为无限制（PT0S）');
  // 失败重启：1 分钟 / 3 次
  assert.ok(install.text.includes('$RestartIntervalMinutes = 1'), '重启间隔应为 1 分钟');
  assert.ok(install.text.includes('$RestartCount = 3'), '重启次数应为 3');
  assert.ok(install.text.includes('-RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes)'));
  // 电池
  assert.ok(install.text.includes('-AllowStartIfOnBatteries'), '应允许电池供电时启动');
  assert.ok(install.text.includes('-DontStopIfGoingOnBatteries'), '切换到电池不应停止');
  // 错过启动机会时补启
  assert.ok(install.text.includes('-StartWhenAvailable'), '错过计划时间后应可补启动');
  // 空闲与网络：都不做要求
  assert.ok(!install.text.includes('-RunOnlyIfIdle'), '不得要求计算机空闲');
  assert.doesNotMatch(install.text, /NetworkProfile|NetworkSettings|-NetworkName/i, '不得绑定网络配置');
});

test('install：使用当前登录用户、Interactive + Limited，不使用 SYSTEM、不需要密码', async () => {
  const { install } = await readAll();

  assert.ok(
    install.text.includes('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name'),
    '必须通过 WindowsIdentity 获取当前用户，不能硬编码用户名',
  );
  assert.ok(install.text.includes('-LogonType Interactive'), '应为 Interactive（仅在用户登录时运行）');
  assert.ok(install.text.includes('-RunLevel Limited'), '应为 Limited（不需要管理员）');
  assert.doesNotMatch(install.text, /-LogonType\s+Password/i, '不得要求保存 Windows 密码');
  assert.doesNotMatch(install.text, /-LogonType\s+S4U/i, '不得使用 S4U');
  // 检查的是「实际配置」而非注释措辞
  assert.doesNotMatch(install.text, /NT AUTHORITY\\SYSTEM/i, '不得把任务配置为 SYSTEM 账户运行');
  assert.doesNotMatch(install.text, /-UserId\s+['"]?SYSTEM['"]?/i, '不得把 UserId 设为 SYSTEM');
  assert.doesNotMatch(install.text, /-Password\s+\S/i, '不得涉及任何密码参数');
});

test('install：action 指向 run-monitor.cmd，工作目录为项目根，路径含空格时安全', async () => {
  const { install } = await readAll();

  assert.ok(install.text.includes('run-monitor.cmd'), 'action 必须指向 run-monitor.cmd');
  assert.ok(install.text.includes('cmd.exe'), '应通过 cmd.exe /d /c 调用批处理');
  assert.ok(install.text.includes('/d /c'), '应使用 /d /c 参数');
  assert.ok(install.text.includes('""{0}""'), '路径必须用双层引号包裹，兼容含空格的路径');
  assert.ok(install.text.includes('-WorkingDirectory $projectRoot'), '工作目录应为项目根目录');
  assert.ok(install.text.includes('Join-Path $scriptDir'), '必须依据脚本自身位置定位项目根目录');
  assert.ok(install.text.includes('Register-ScheduledTask'), '必须调用 Register-ScheduledTask');
  assert.ok(install.text.includes('-Force'), '重复安装时应更新同名任务（幂等）');
});

test('install：安装前检查 run-monitor.cmd / dist\\index.js / .env / node', async () => {
  const { install } = await readAll();

  assert.ok(install.text.includes("Join-Path $projectRoot 'scripts\\run-monitor.cmd'"), '应检查启动脚本');
  assert.ok(install.text.includes("Join-Path $projectRoot 'dist\\index.js'"), '应检查编译产物');
  assert.ok(install.text.includes('npm run build'), '缺少 dist 时应提示先构建');
  assert.ok(install.text.includes("Join-Path $projectRoot '.env'"), '应检查 .env 是否存在');
  assert.ok(install.text.includes('Get-Command node'), '应检查 node 是否可用');
  assert.match(install.text, /exit 1/, '检查失败时应以非 0 退出');
});

test('status：报告任务与项目侧状态，且完全只读', async () => {
  const { status } = await readAll();

  for (const expected of [
    'Get-ScheduledTask',
    'Get-ScheduledTaskInfo',
    'LastRunTime',
    'LastTaskResult',
    'NextRunTime',
    'Triggers',
    'Principal',
    "data\\monitor.lock",
    'Get-Process -Id',
    'stale',
    'logs\\monitor.log',
    'Length',
    'LastWriteTime',
  ]) {
    assert.ok(status.text.includes(expected), `status 脚本应包含 ${expected}`);
  }

  // 只读：不得出现任何修改系统或项目状态的调用
  for (const forbidden of [
    'Register-ScheduledTask',
    'Unregister-ScheduledTask',
    'Stop-ScheduledTask',
    'Start-ScheduledTask -TaskName $TaskName',
    'Remove-Item',
    'Stop-Process',
    'Set-Content',
    'Out-File',
  ]) {
    assert.ok(!status.text.includes(forbidden), `status 脚本必须是只读的，不得包含 ${forbidden}`);
  }
});

test('uninstall：幂等删除任务，不删除项目文件，也不强杀进程', async () => {
  const { uninstall } = await readAll();

  assert.ok(uninstall.text.includes('Unregister-ScheduledTask'), '必须删除任务');
  assert.ok(uninstall.text.includes('Stop-ScheduledTask'), '任务在运行时应先停止');
  assert.ok(uninstall.text.includes('任务不存在，无需删除。'), '任务不存在时应给出幂等提示而非异常');
  assert.ok(uninstall.text.includes('-Confirm:$false'), '应非交互式执行');

  // 不删除项目文件：检查的是实际行为（不存在任何破坏性命令），而不是注释措辞
  for (const destructive of [
    'Remove-Item',
    'Remove-ItemProperty',
    'Clear-Content',
    'Set-Content',
    'Out-File',
    'Move-Item',
    'Rename-Item',
    'New-Item',
    'del ',
    'rmdir',
    'erase ',
  ]) {
    assert.ok(!uninstall.text.includes(destructive), `uninstall 不得包含破坏性命令：${destructive}`);
  }
  assert.ok(
    uninstall.text.includes('不会删除任何项目文件'),
    'uninstall 应明确说明不会删除任何项目文件',
  );
  // 默认不 kill monitor：强制结束只允许出现在受开关保护的函数内，且所有调用点都必须显式传开关
  assert.ok(uninstall.text.includes('[switch]$StopMonitorProcess'), '应提供显式的 -StopMonitorProcess 开关');
  const killCalls = uninstall.text.match(/Stop-Process/g) ?? [];
  assert.equal(killCalls.length, 1, '强制结束进程的调用应当只有一处');
  const killIndex = uninstall.text.indexOf('Stop-Process');
  const guardIndex = uninstall.text.indexOf('if (-not $Enabled)');
  assert.ok(guardIndex > 0 && guardIndex < killIndex, '强制结束必须位于 `if (-not $Enabled) { ... return }` 之后');
  assert.ok(
    uninstall.text.includes('param([switch]$Enabled)'),
    '清理函数应通过 [switch]$Enabled 才能强停',
  );
  const enabledCallSites = [...uninstall.text.matchAll(/-Enabled(?::\$StopMonitorProcess)?/g)];
  assert.ok(enabledCallSites.length >= 2, '所有清理调用点都应显式传入开关（其中至少一处为 -Enabled:$StopMonitorProcess）');
  assert.ok(
    uninstall.text.includes('-Enabled:$StopMonitorProcess'),
    '调用点必须使用 -Enabled:$StopMonitorProcess，保证默认路径不强停',
  );
  assert.ok(
    uninstall.text.includes('本脚本默认不会强杀它'),
    '默认路径必须明确说明不会强杀 monitor 进程',
  );
  // 实测结论要写清楚：Stop-ScheduledTask 不会连带结束 node 子进程
  assert.ok(
    uninstall.text.includes('不会连带结束 node 子进程'),
    'uninstall 文档应说明 Stop-ScheduledTask 的孤立子进程行为',
  );
  // 实测结论要写清楚：Stop-ScheduledTask 不会连带结束 node 子进程
  assert.ok(
    uninstall.text.includes('不会连带结束 node 子进程'),
    'uninstall 文档应说明 Stop-ScheduledTask 的孤立子进程行为',
  );
});

test('三个脚本都不含硬编码用户路径与任何凭据', async () => {
  const scripts = await readAll();

  for (const script of Object.values(scripts)) {
    assert.doesNotMatch(script.text, /C:\\Users\\/i, `${script.name} 不得硬编码用户目录`);
    assert.ok(!script.text.includes('TARGET_QQ'), `${script.name} 不得出现 TARGET_QQ`);
    assert.ok(!script.text.includes('NAPCAT_TOKEN'), `${script.name} 不得出现 NAPCAT_TOKEN`);
    assert.doesNotMatch(script.text, /\bghp_|\bgithub_pat_/i, `${script.name} 不得包含 token 字符串`);
    assert.doesNotMatch(script.text, /chcp/i, `${script.name} 不得修改代码页`);
  }
});

test('install 干跑模式可预览且不注册任务', async () => {
  const { install } = await readAll();

  assert.ok(install.text.includes('[switch]$DryRun'), 'install 应支持 -DryRun 预览');
  assert.match(
    install.text,
    /if\s*\(\$DryRun\)\s*\{[\s\S]*?exit 0/,
    'DryRun 分支必须在 Register-ScheduledTask 之前退出，确保不注册任务',
  );

  const dryRunIndex = install.text.indexOf('if ($DryRun)');
  const registerIndex = install.text.indexOf('Register-ScheduledTask `');
  assert.ok(dryRunIndex > 0 && registerIndex > dryRunIndex, 'DryRun 分支应出现在注册之前');
});
