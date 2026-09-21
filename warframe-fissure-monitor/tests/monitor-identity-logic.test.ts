/**
 * Monitor 进程身份校验的**行为**测试（不是文本检查）。
 *
 * 做法：把真实的 scripts/scheduled-task-common.ps1 dot-source 进一个 PowerShell 进程，
 * 直接调用其中的纯判断函数（不依赖 Windows / CIM），用真实输入验证结果：
 *   - Test-MonitorProcessName  ：进程名必须是 node
 *   - Test-MonitorCommandLine  ：命令行必须指向本项目 dist\index.js
 *   - Test-MonitorStartTime    ：进程启动时间必须与 lock.startedAt 一致（默认 10 秒容忍）
 *
 * 这些正是「PID 被系统重用时不误杀无关进程」所依赖的判断。
 * 需要 PowerShell（Windows PowerShell 5.1 或 PowerShell 7）；CI 的 ubuntu-latest 自带 pwsh。
 * 若环境里完全没有 PowerShell，则跳过（不会让 CI 失败）。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const COMMON_SCRIPT = fileURLToPath(new URL('../scripts/scheduled-task-common.ps1', import.meta.url));

/** 测试用的期望入口脚本路径（含空格，覆盖引号/空格场景） */
const EXPECTED_SCRIPT_PATH = 'C:\\demo project\\warframe-fissure-monitor\\dist\\index.js';

type CaseKind = 'name' | 'cmdline' | 'starttime';

interface IdentityCase {
  name: string;
  kind: CaseKind;
  input?: string;
  lock?: string;
  process?: string;
  expected: boolean;
}

function resolvePowerShell(): string | null {
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell']
    : ['pwsh'];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // 继续尝试下一个
    }
  }
  return null;
}

const POWERSHELL = resolvePowerShell();

const HARNESS = `
$ErrorActionPreference = 'Stop'
. $env:MONITOR_COMMON_PS1
$cases = Get-Content -LiteralPath $env:MONITOR_CASES -Raw | ConvertFrom-Json
$results = foreach ($c in $cases) {
    $actual = $false
    switch ($c.kind) {
        'name'      { $actual = Test-MonitorProcessName -ProcessName $c.input }
        'cmdline'   { $actual = Test-MonitorCommandLine -CommandLine $c.input -ExpectedScriptPath $env:MONITOR_EXPECTED }
        'starttime' { $actual = Test-MonitorStartTime -LockStartedAt $c.lock -ProcessStartTime ([System.DateTime]::Parse($c.process, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)) -ToleranceSeconds 10 }
        default     { throw "unknown kind: $($c.kind)" }
    }
    [pscustomobject]@{ name = $c.name; expected = [bool]$c.expected; actual = [bool]$actual }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 5
`;

interface HarnessResult {
  name: string;
  expected: boolean;
  actual: boolean;
}

function runIdentityCases(cases: IdentityCase[]): HarnessResult[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'wfm-identity-'));
  const casesFile = path.join(dir, 'cases.json');

  try {
    // 用例内容保持 ASCII，避免不同代码页下的读取差异
    writeFileSync(casesFile, JSON.stringify(cases), 'utf8');

    const stdout = execFileSync(
      POWERSHELL as string,
      ['-NoProfile', '-NonInteractive', '-Command', HARNESS],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          MONITOR_COMMON_PS1: COMMON_SCRIPT,
          MONITOR_CASES: casesFile,
          MONITOR_EXPECTED: EXPECTED_SCRIPT_PATH,
        },
      },
    );

    const parsed: unknown = JSON.parse(stdout.trim());
    return (Array.isArray(parsed) ? parsed : [parsed]) as HarnessResult[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertCases(cases: IdentityCase[]): void {
  const results = runIdentityCases(cases);
  assert.equal(results.length, cases.length, 'PowerShell 返回的用例数量应与输入一致');

  for (const result of results) {
    assert.equal(
      result.actual,
      result.expected,
      `用例「${result.name}」期望 ${result.expected}，实际 ${result.actual}`,
    );
  }
}

test('Test-MonitorProcessName：只认 node（大小写与 .exe 无关）', { skip: POWERSHELL === null ? '未找到 PowerShell' : false }, () => {
  assertCases([
    { name: 'node 小写', kind: 'name', input: 'node', expected: true },
    { name: 'node.exe', kind: 'name', input: 'node.exe', expected: true },
    { name: 'NODE.EXE 大写', kind: 'name', input: 'NODE.EXE', expected: true },
    { name: 'notepad.exe 必须拒绝', kind: 'name', input: 'notepad.exe', expected: false },
    { name: 'explorer.exe 必须拒绝', kind: 'name', input: 'explorer.exe', expected: false },
    { name: 'chromium 前缀相似但不是 node', kind: 'name', input: 'nodejs-helper.exe', expected: false },
    { name: '空进程名必须拒绝', kind: 'name', input: '', expected: false },
  ]);
});

test('Test-MonitorCommandLine：必须指向本项目 dist\\index.js', { skip: POWERSHELL === null ? '未找到 PowerShell' : false }, () => {
  assertCases([
    {
      name: '绝对路径 + 引号（典型 node 启动）',
      kind: 'cmdline',
      input: '"C:\\nvm4w\\nodejs\\node.exe" "C:\\demo project\\warframe-fissure-monitor\\dist\\index.js"',
      expected: true,
    },
    {
      name: 'run-monitor.cmd 的相对写法 node "dist\\index.js"',
      kind: 'cmdline',
      input: 'node  "dist\\index.js" ',
      expected: true,
    },
    {
      name: '正斜杠写法 dist/index.js',
      kind: 'cmdline',
      input: 'node "dist/index.js"',
      expected: true,
    },
    {
      name: '大小写不同也算命中',
      kind: 'cmdline',
      input: '"C:\\NVM4W\\NODEJS\\node.exe" "C:\\DEMO PROJECT\\WARFRAME-FISSURE-MONITOR\\DIST\\INDEX.JS"',
      expected: true,
    },
    {
      name: 'dist\\index.js.bak 不算命中（边界要求）',
      kind: 'cmdline',
      input: 'node "dist\\index.js.bak"',
      expected: false,
    },
    {
      name: '另一个项目的 dist\\index.js 必须拒绝',
      kind: 'cmdline',
      input: '"C:\\other project\\dist\\index.js"',
      expected: false,
    },
    {
      name: '与本项目无关的进程必须拒绝',
      kind: 'cmdline',
      input: '"C:\\Windows\\System32\\notepad.exe" "C:\\temp\\notes.txt"',
      expected: false,
    },
    {
      name: '空的命令行必须拒绝',
      kind: 'cmdline',
      input: '',
      expected: false,
    },
    {
      name: 'node 但没有入口脚本必须拒绝',
      kind: 'cmdline',
      input: '"C:\\nvm4w\\nodejs\\node.exe" -e "console.log(1)"',
      expected: false,
    },
  ]);
});

test('Test-MonitorStartTime：启动时间必须与 lock.startedAt 一致（10 秒容忍）', { skip: POWERSHELL === null ? '未找到 PowerShell' : false }, () => {
  assertCases([
    {
      name: '完全一致',
      kind: 'starttime',
      lock: '2026-09-21T06:53:39.815Z',
      process: '2026-09-21T06:53:39Z',
      expected: true,
    },
    {
      name: '差 2.8 秒（真实观测到的差值）',
      kind: 'starttime',
      lock: '2026-09-21T06:53:39.815Z',
      process: '2026-09-21T06:53:37Z',
      expected: true,
    },
    {
      name: '差 9 秒仍在容忍范围内',
      kind: 'starttime',
      lock: '2026-09-21T06:53:39.000Z',
      process: '2026-09-21T06:53:30Z',
      expected: true,
    },
    {
      name: '差 11 秒超出容忍范围，必须拒绝',
      kind: 'starttime',
      lock: '2026-09-21T06:53:39.000Z',
      process: '2026-09-21T06:53:28Z',
      expected: false,
    },
    {
      name: 'PID 被重用（启动时间晚很多）必须拒绝',
      kind: 'starttime',
      lock: '2026-09-21T06:53:39.815Z',
      process: '2026-09-21T09:30:00Z',
      expected: false,
    },
    {
      name: 'lock.startedAt 无法解析必须拒绝',
      kind: 'starttime',
      lock: 'not-a-timestamp',
      process: '2026-09-21T06:53:39Z',
      expected: false,
    },
    {
      name: 'lock.startedAt 缺失必须拒绝',
      kind: 'starttime',
      lock: '',
      process: '2026-09-21T06:53:39Z',
      expected: false,
    },
  ]);
});

test('身份校验三项全部通过才算 verified（组合验证）', { skip: POWERSHELL === null ? '未找到 PowerShell' : false }, () => {
  assertCases([
    { name: 'node + 本项目入口 + 时间一致', kind: 'name', input: 'node.exe', expected: true },
    {
      name: '命令行命中',
      kind: 'cmdline',
      input: 'node "dist\\index.js"',
      expected: true,
    },
    {
      name: '时间一致',
      kind: 'starttime',
      lock: '2026-09-21T06:53:39.815Z',
      process: '2026-09-21T06:53:37Z',
      expected: true,
    },
    { name: '但进程名不是 node 时整体必须判为不可信', kind: 'name', input: 'java.exe', expected: false },
  ]);
});
