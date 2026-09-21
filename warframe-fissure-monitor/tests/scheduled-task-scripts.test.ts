/**
 * 部署层守护测试：Windows 计划任务脚本（scripts/*.ps1）的静态检查。
 *
 * 为什么用静态检查而不是真的注册任务：
 * - CI 运行在 Linux/临时环境，不能（也不应该）往 Runner 的 Task Scheduler 注册长期任务
 * - 计划任务的真实注册 / 启动 / 停止 / 身份校验行为已在本机 Windows 上人工验证（见 README 与提交说明）
 *
 * 这里锁定的关键契约：
 * - 只有一个逻辑任务名，且三个主脚本一致
 * - 延迟是 Task Scheduler 原生 Trigger Delay（PT60S），不是 action 里的 sleep/timeout
 * - MultipleInstances=IgnoreNew、ExecutionTimeLimit=PT0S（无限）、RestartInterval=PT1M
 * - 使用当前登录用户（Interactive + Limited），不使用 SYSTEM、不保存密码
 * - action 指向 scripts\run-monitor.cmd，工作目录为项目根
 * - 不含硬编码用户路径与任何凭据
 * - 进程身份校验（PID + 进程名 + 命令行 + 启动时间）存在，且 Stop-Process 只在 verified 之后
 * - 脚本保存为 UTF-8 with BOM（Windows PowerShell 5.1 才能正确解析中文）+ CRLF
 *
 * 纯逻辑（进程名 / 命令行 / 启动时间判断）的行为测试见 tests/monitor-identity-logic.test.ts。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TASK_NAME = 'Warframe Fissure Monitor';

const MAIN_SCRIPTS = ['install-scheduled-task.ps1', 'status-scheduled-task.ps1', 'uninstall-scheduled-task.ps1'];
const ALL_SCRIPTS = ['scheduled-task-common.ps1', ...MAIN_SCRIPTS];

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

async function readAll(): Promise<Record<string, ScriptFile>> {
  const entries = await Promise.all(ALL_SCRIPTS.map(async (name) => [name, await readScript(name)] as const));
  return Object.fromEntries(entries);
}

function extractTaskName(text: string): string | null {
  const match = /\$TaskName\s*=\s*'([^']+)'/.exec(text);
  return match?.[1] ?? null;
}

test('四个部署脚本都存在、非空，并声明最低 PowerShell 5.1', async () => {
  const scripts = await readAll();

  for (const script of Object.values(scripts)) {
    assert.ok(script.bytes.length > 0, `${script.path} 不应为空`);
    assert.match(script.text, /#Requires -Version 5\.1/, `${script.name} 应声明最低 PowerShell 5.1`);
  }
});

test('三个主脚本使用同一个任务名', async () => {
  const scripts = await readAll();

  for (const name of MAIN_SCRIPTS) {
    assert.equal(extractTaskName(scripts[name]?.text ?? ''), TASK_NAME, `${name} 的任务名必须一致`);
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
  const { 'install-scheduled-task.ps1': install } = await readAll();
  assert.ok(install !== undefined);

  assert.ok(install.text.includes('-AtLogOn'), '必须使用 AtLogOn 触发器');
  assert.ok(install.text.includes("$LogonDelay = 'PT60S'"), '延迟常量必须为 PT60S（60 秒）');
  assert.match(install.text, /\$trigger\.Delay\s*=\s*\$LogonDelay/, '必须把延迟赋给 trigger.Delay');

  assert.doesNotMatch(install.text, /Start-Sleep\s+-Seconds\s+60/i, '不得用 Start-Sleep 模拟 60 秒延迟');
  assert.doesNotMatch(install.text, /timeout\s+\/t/i, '不得用 timeout /t 模拟延迟');
  assert.doesNotMatch(install.text, /ping\s+-n/i, '不得用 ping 模拟延迟');
});

test('install：多实例 / 执行时限 / 重启 / 电池 / 空闲等设置符合长期常驻要求', async () => {
  const { 'install-scheduled-task.ps1': install } = await readAll();
  assert.ok(install !== undefined);

  assert.ok(install.text.includes('IgnoreNew'), '必须使用 MultipleInstances IgnoreNew');
  assert.ok(install.text.includes('-ExecutionTimeLimit ([TimeSpan]::Zero)'), '执行时限必须为无限制（PT0S）');
  assert.ok(install.text.includes('$RestartIntervalMinutes = 1'), '重启间隔应为 1 分钟');
  assert.ok(install.text.includes('$RestartCount = 3'), '重启次数应为 3');
  assert.ok(install.text.includes('-RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes)'));
  assert.ok(install.text.includes('-AllowStartIfOnBatteries'), '应允许电池供电时启动');
  assert.ok(install.text.includes('-DontStopIfGoingOnBatteries'), '切换到电池不应停止');
  assert.ok(install.text.includes('-StartWhenAvailable'), '错过计划时间后应可补启动');
  assert.ok(!install.text.includes('-RunOnlyIfIdle'), '不得要求计算机空闲');
  assert.doesNotMatch(install.text, /NetworkProfile|NetworkSettings|-NetworkName/i, '不得绑定网络配置');
});

test('install：使用当前登录用户、Interactive + Limited，不使用 SYSTEM、不需要密码', async () => {
  const { 'install-scheduled-task.ps1': install } = await readAll();
  assert.ok(install !== undefined);

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
  const { 'install-scheduled-task.ps1': install } = await readAll();
  assert.ok(install !== undefined);

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
  const { 'install-scheduled-task.ps1': install } = await readAll();
  assert.ok(install !== undefined);

  assert.ok(install.text.includes("Join-Path $projectRoot 'scripts\\run-monitor.cmd'"), '应检查启动脚本');
  assert.ok(install.text.includes("Join-Path $projectRoot 'dist\\index.js'"), '应检查编译产物');
  assert.ok(install.text.includes('npm run build'), '缺少 dist 时应提示先构建');
  assert.ok(install.text.includes("Join-Path $projectRoot '.env'"), '应检查 .env 是否存在');
  assert.ok(install.text.includes('Get-Command node'), '应检查 node 是否可用');
  assert.match(install.text, /exit 1/, '检查失败时应以非 0 退出');
});

test('status：报告任务与项目侧状态，且完全只读', async () => {
  const { 'status-scheduled-task.ps1': status } = await readAll();
  assert.ok(status !== undefined);

  for (const expected of [
    'Get-ScheduledTask',
    'Get-ScheduledTaskInfo',
    'LastRunTime',
    'LastTaskResult',
    'NextRunTime',
    'Triggers',
    'Principal',
    "data\\monitor.lock",
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

test('status：不再把「PID 存在」直接当成 running（必须走身份校验）', async () => {
  const { 'status-scheduled-task.ps1': status } = await readAll();
  assert.ok(status !== undefined);

  assert.ok(status.text.includes('. $commonScript'), 'status 必须 dot-source 公共 helper');
  assert.ok(
    status.text.includes('Get-MonitorProcessIdentity'),
    'status 必须调用 Get-MonitorProcessIdentity 做身份校验，而不是只看 Get-Process 是否成功',
  );
  assert.ok(status.text.includes('running (verified)'), 'status 应输出 running (verified)');
  assert.ok(status.text.includes('suspicious / unverified'), 'status 应输出 suspicious / unverified');
  assert.ok(status.text.includes("switch ($identity.State)"), 'status 应按身份校验结果分支输出');
  assert.ok(
    !/Monitor process : running\s*'/i.test(status.text) || !status.text.includes("Monitor process : running'"),
    '不得再输出无条件判定为 running 的行',
  );
});

test('uninstall：幂等删除任务，不删除项目文件，强杀委托给经过身份校验的公共逻辑', async () => {
  const { 'uninstall-scheduled-task.ps1': uninstall } = await readAll();
  assert.ok(uninstall !== undefined);

  assert.ok(uninstall.text.includes('Unregister-ScheduledTask'), '必须删除任务');
  assert.ok(uninstall.text.includes('Stop-ScheduledTask'), '任务在运行时应先停止');
  assert.ok(uninstall.text.includes('任务不存在，无需删除。'), '任务不存在时应给出幂等提示而非异常');
  assert.ok(uninstall.text.includes('-Confirm:$false'), '应非交互式执行');

  // 不删除项目文件：检查实际行为（不存在任何破坏性命令）
  for (const destructive of ['Remove-Item', 'Remove-ItemProperty', 'Clear-Content', 'Set-Content', 'Out-File', 'Move-Item', 'Rename-Item', 'New-Item', 'del ', 'rmdir', 'erase ']) {
    assert.ok(!uninstall.text.includes(destructive), `uninstall 不得包含破坏性命令：${destructive}`);
  }
  assert.ok(uninstall.text.includes('不会删除任何项目文件'), 'uninstall 应明确说明不会删除任何项目文件');

  // 强杀逻辑已抽到公共 helper，且必须经过身份校验
  assert.ok(uninstall.text.includes('. $commonScript'), 'uninstall 必须 dot-source 公共 helper');
  assert.ok(uninstall.text.includes('Invoke-MonitorProcessCleanup'), 'uninstall 必须调用公共清理函数');
  assert.ok(uninstall.text.includes('-Enabled:$StopMonitorProcess'), '必须把显式开关传给清理函数');
  // 只看「实际调用」，注释/提示里出现关键字是允许的
  assert.ok(
    !/Stop-Process\s+-Id/i.test(uninstall.text),
    'uninstall 自己不应调用 Stop-Process（交由公共 identity guard 处理）',
  );
  assert.ok(uninstall.text.includes("$script:MonitorCleanupResult -eq 'refused'"), 'refused 时应以非 0 退出');
  assert.ok(uninstall.text.includes('exit 1'), 'refused 时应以非 0 退出');
  // 实测结论要写清楚：Stop-ScheduledTask 不会连带结束 node 子进程
  assert.ok(uninstall.text.includes('不会连带结束 node 子进程'), 'uninstall 文档应说明 Stop-ScheduledTask 的孤立子进程行为');
  // 拒绝强杀的说明与判定文案在公共 helper 里（见下一个测试）
});

test('公共 helper：进程身份校验要素齐全（CIM / 进程名 / 命令行 / 启动时间）', async () => {
  const { 'scheduled-task-common.ps1': common } = await readAll();
  assert.ok(common !== undefined);

  for (const fn of [
    'Get-MonitorExpectedScriptPath',
    'Test-MonitorProcessName',
    'Test-MonitorCommandLine',
    'Test-MonitorStartTime',
    'Read-MonitorLockFile',
    'Get-MonitorProcessIdentity',
    'Invoke-MonitorProcessCleanup',
  ]) {
    assert.ok(common.text.includes(`function ${fn}`), `公共 helper 应定义 ${fn}`);
  }

  assert.ok(common.text.includes('Get-CimInstance'), '应使用 Get-CimInstance 读取进程信息');
  assert.ok(common.text.includes('Win32_Process'), '应查询 Win32_Process');
  // 只看是否真的调用了 wmic（注释里提到这个词是允许的）
  assert.ok(!/^\s*wmic(\.exe)?\b/im.test(common.text), '不得调用已弃用的 wmic.exe');
  assert.ok(common.text.includes('ExecutablePath'), '应读取 ExecutablePath');
  assert.ok(common.text.includes('CommandLine'), '应读取 CommandLine');
  assert.ok(common.text.includes('StartTimeToleranceSeconds'), '启动时间比较必须有容忍参数');
  assert.ok(common.text.includes("State          = 'unverified'"), '默认状态必须是 unverified（不猜测）');
});

test('PID 重用防护：Stop-Process 只出现在 verified 分支之后，且只有一处', async () => {
  const scripts = await readAll();
  const common = scripts['scheduled-task-common.ps1'];
  assert.ok(common !== undefined);

  // 只统计「实际调用」，注释里提到 Stop-Process 不算
  const killCalls = common.text.match(/Stop-Process\s+-Id/g) ?? [];
  assert.equal(killCalls.length, 1, '强杀调用应当只有一处（且必须带 -Id）');

  const stopIndex = common.text.search(/Stop-Process\s+-Id/);

  // 未通过身份校验的分支必须直接 return，绝不能继续走到 Stop-Process
  const unverifiedGuard = /if \(\$identity\.State -ne 'verified'\) \{[\s\S]*?return 'refused'\s*\}/.exec(common.text);
  assert.ok(unverifiedGuard, '身份未通过时必须 return refused（不能继续往下执行）');
  const unverifiedGuardEnd = (unverifiedGuard.index ?? 0) + unverifiedGuard[0].length;

  // 默认（未指定 -StopMonitorProcess）路径同样必须直接 return
  const defaultGuards = [...common.text.matchAll(/if \(-not \$Enabled\) \{[\s\S]*?return 'reported'\s*\}/g)];
  assert.ok(defaultGuards.length >= 1, '默认路径必须 return reported（不强杀）');
  const defaultGuardEnds = defaultGuards.map((match) => (match.index ?? 0) + match[0].length);

  assert.ok(stopIndex > unverifiedGuardEnd, 'Stop-Process 必须在「未通过则 return」分支之后');
  assert.ok(
    stopIndex > Math.max(...defaultGuardEnds),
    'Stop-Process 必须在「默认不 kill 则 return」分支之后',
  );

  // 三个主脚本都不得自己调用 Stop-Process
  for (const name of MAIN_SCRIPTS) {
    assert.ok(
      !/Stop-Process\s+-Id/i.test(scripts[name]?.text ?? ''),
      `${name} 不得直接调用 Stop-Process`,
    );
  }

  // 拒绝强杀的关键措辞
  assert.ok(common.text.includes('拒绝结束 PID'), '拒绝强杀时应给出明确提示');
  assert.ok(common.text.includes('本脚本没有执行 Stop-Process'), '应说明未执行 Stop-Process');
  assert.ok(
    common.text.includes('无法确认它属于 warframe-fissure-monitor'),
    '拒绝强杀时应说明「无法确认该 PID 属于本项目」',
  );
  assert.ok(
    common.text.includes('为避免 PID 重用导致误杀其它程序'),
    '拒绝强杀时应说明是为了避免 PID 重用误杀',
  );
  assert.ok(common.text.includes('无法读取命令行'), '读不到命令行时必须判为 unverified');
  assert.ok(common.text.includes('进程名不是 node'), '进程名不符时必须拒绝');
  assert.ok(common.text.includes('PID 可能已被系统重用'), '启动时间不一致时应提示 PID 重用');
});

test('三个主脚本都不含硬编码用户路径与任何凭据', async () => {
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
  const { 'install-scheduled-task.ps1': install } = await readAll();
  assert.ok(install !== undefined);

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
