#Requires -Version 5.1
<#
.SYNOPSIS
    查看「Warframe Fissure Monitor」计划任务与 Monitor 运行状态（只读，不做任何修改）。

.DESCRIPTION
    输出内容：
    - 任务是否存在、State、LastRunTime、LastTaskResult、NextRunTime
    - Trigger（登录触发 + 延迟）、运行用户、Action（cmd -> run-monitor.cmd）、工作目录
    - 项目侧状态：data\monitor.lock 中的 PID 对应进程是否存活（stale 只报告，不删除）
    - logs\monitor.log 是否存在、大小、最后写入时间（不打印日志内容）

    本脚本不会注册 / 停止 / 删除任何任务，也不会删除任何文件。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\status-scheduled-task.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$TaskName = 'Warframe Fissure Monitor'

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host "===== $Title ====="
}

# Task Scheduler 常见退出码 -> 可读文本（只用于显示）
function Get-TaskResultText {
    param($Code)
    $map = @{
        '0'      = '(成功)'
        '267009' = '(任务正在运行)'
        '267011' = '(尚未运行)'
        '267014' = '(被用户终止)'
    }
    $key = [string]$Code
    if ($map.ContainsKey($key)) { return $map[$key] }
    return ''
}

# ---------------------------------------------------------------- 定位项目根目录
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$lockFile = Join-Path $projectRoot 'data\monitor.lock'
$logFile = Join-Path $projectRoot 'logs\monitor.log'

Write-Host '========================================================='
Write-Host ' Warframe Fissure Monitor - 计划任务状态（只读）'
Write-Host '========================================================='
Write-Host "项目根目录：$projectRoot"

# ---------------------------------------------------------------- 任务侧
Write-Section '计划任务'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskInstalled = $null -ne $task

if (-not $taskInstalled) {
    Write-Host "任务是否存在 : 否（未安装）"
    Write-Host "任务名称     : $TaskName"
    Write-Host ''
    Write-Host '安装命令：powershell -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1'
}
else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue

    Write-Host "任务是否存在 : 是"
    Write-Host "任务名称     : $($task.TaskName)"
    Write-Host "任务路径     : $($task.TaskPath)"
    Write-Host "State        : $($task.State)"

    if ($null -ne $info) {
        Write-Host "LastRunTime  : $($info.LastRunTime)"
        Write-Host "LastTaskResult: $($info.LastTaskResult) $((Get-TaskResultText $info.LastTaskResult))"
        Write-Host "NextRunTime  : $($info.NextRunTime)"
        Write-Host "MissedRuns   : $($info.NumberOfMissedRuns)"
    }

    Write-Host ''
    Write-Host '触发器：'
    foreach ($t in $task.Triggers) {
        $delayText = ''
        if ($null -ne $t.Delay -and "$($t.Delay)" -ne '') { $delayText = "延迟=$($t.Delay)" }
        Write-Host ("  - 类型=$($t.CimClass.CimClassName) 用户=$($t.UserId) 启用=$($t.Enabled) $delayText")
    }

    Write-Host '执行动作：'
    foreach ($a in $task.Actions) {
        Write-Host "  - 程序    =$($a.Execute)"
        Write-Host "    参数    =$($a.Arguments)"
        Write-Host "    工作目录=$($a.WorkingDirectory)"
    }

    Write-Host '运行身份：'
    Write-Host "  - 用户    =$($task.Principal.UserId)"
    Write-Host "  - 登录方式=$($task.Principal.LogonType)（Interactive = 仅在用户登录时运行）"
    Write-Host "  - 权限    =$($task.Principal.RunLevel)"

    Write-Host '关键设置：'
    Write-Host "  - 多实例策略=$($task.Settings.MultipleInstances)"
    Write-Host "  - 执行时限  =$($task.Settings.ExecutionTimeLimit)（PT0S = 无限制）"
    Write-Host "  - 电池启动  =$(-not $task.Settings.DisallowStartIfOnBatteries)"
    Write-Host "  - 电池不停止=$(-not $task.Settings.StopIfGoingOnBatteries)"
    Write-Host "  - 错过后补启=$($task.Settings.StartWhenAvailable)"
    Write-Host "  - 失败重启次数=$($task.Settings.RestartCount) 间隔=$($task.Settings.RestartInterval)"
}

# ---------------------------------------------------------------- 项目侧
Write-Section 'Monitor 进程（依据 data\monitor.lock）'

if (-not (Test-Path -LiteralPath $lockFile)) {
    Write-Host 'Monitor lock    : 不存在（Monitor 未在运行）'
    Write-Host "Lock 文件路径   : $lockFile"
}
else {
    $lockReadOk = $true
    $lockPid = $null
    try {
        $lockData = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
        $lockPid = $lockData.pid
    }
    catch {
        $lockReadOk = $false
    }

    if (-not $lockReadOk -or $null -eq $lockPid) {
        Write-Host 'Monitor lock    : 存在但无法解析（属于项目自身处理范围，本脚本不删除）'
    }
    else {
        $process = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
        if ($null -ne $process) {
            Write-Host 'Monitor process : running'
            Write-Host "PID             : $lockPid"
            Write-Host "进程名          : $($process.ProcessName)"
            Write-Host "启动时间        : $($process.StartTime)"
            Write-Host "Lock startedAt  : $($lockData.startedAt)"
        }
        else {
            Write-Host 'Monitor lock    : stale'
            Write-Host "PID             : $lockPid（该进程已不存在）"
            Write-Host '说明            : 属正常现象（异常退出 / 任务被停止后留下），下次启动时由项目自身自动清理，无需手工删除。'
        }
    }
}

Write-Section '日志文件'

if (-not (Test-Path -LiteralPath $logFile)) {
    Write-Host '日志文件        : 不存在（尚未通过 run-monitor.cmd 运行过）'
}
else {
    $logItem = Get-Item -LiteralPath $logFile
    Write-Host "日志文件        : $($logItem.FullName)"
    Write-Host "大小            : $($logItem.Length) 字节"
    Write-Host "最后写入        : $($logItem.LastWriteTime)"
}

# ---------------------------------------------------------------- 提示
Write-Section '常用命令'
Write-Host '手动启动测试：Start-ScheduledTask -TaskName "Warframe Fissure Monitor"'
Write-Host '查看日志      ：Get-Content .\logs\monitor.log -Encoding UTF8 -Tail 50'
Write-Host '实时日志      ：Get-Content .\logs\monitor.log -Encoding UTF8 -Tail 20 -Wait'
Write-Host '卸载任务      ：powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1'
exit 0
