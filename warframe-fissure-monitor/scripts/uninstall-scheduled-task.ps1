#Requires -Version 5.1
<#
.SYNOPSIS
    删除「Warframe Fissure Monitor」计划任务。

.DESCRIPTION
    行为：
    - 任务存在且正在运行时：先 Stop-ScheduledTask 停止，再 Unregister-ScheduledTask
    - 任务不存在时：只提示「任务不存在，无需删除。」并以 0 退出（幂等）
    - 默认不删除任何项目文件：.env / data\state.json / data\monitor.lock / logs\ / dist\ / node_modules\ 全部保留
    - 默认不强制结束 Monitor 进程（见下方实测结论）；可用 -StopMonitorProcess 显式要求一并停止

    关于停止语义（本机实测结论，2026-09 于 Windows 11 + PowerShell 5.1）：
    - 任务的 action 是 cmd.exe /d /c run-monitor.cmd，run-monitor.cmd 再启动 node。
    - Stop-ScheduledTask 结束的是 action 进程（cmd.exe），**Windows 不会连带结束子进程**，
      因此 node.exe 会被孤立并继续运行（Monitor 仍在轮询）。
    - 也就是说「任务已停止」不等于「Monitor 已停止」。同时 data\monitor.lock 仍被存活的 node 持有，
      并不是 stale；只有显式结束 node 之后 lock 才会变成 stale，并由项目自身的 single-instance
      逻辑在下次启动时自动清理。
    - 安全影响可控：即使残留一个 node，重新启动任务时项目内 PID lock 会拒绝第二个实例
      （Task Scheduler 的多实例策略是 IgnoreNew，属第一层保护）。
    - 因此默认行为是「只报告 + 给出命令」，需要彻底停止时请加 -StopMonitorProcess。

.PARAMETER StopMonitorProcess
    显式要求：在删除任务后，若 Monitor 进程仍然存活，则结束它。
    **安全性**：结束之前会做身份校验（见 scheduled-task-common.ps1）：
    进程名必须是 node，命令行必须指向本项目的 dist\index.js，
    且进程启动时间必须与 lock.startedAt 一致（默认容忍 10 秒）。
    只有三项全部通过（verified）才会执行 Stop-Process；
    任何一项无法确认时都会拒绝结束进程并以退出码 1 结束，交由人工确认。
    这样即使 Monitor 异常退出留下 stale lock、原 PID 又被其它程序占用，也不会误杀无关进程。
    强制停止时 Node 来不及执行退出清理，data\monitor.lock 会留下 stale，下次启动时由项目自身自动清理。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1 -StopMonitorProcess
#>
[CmdletBinding()]
param(
    [switch]$StopMonitorProcess
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Warframe Fissure Monitor'

function Write-Info {
    param([string]$Message)
    Write-Host "[uninstall] $Message"
}

# ---------------------------------------------------------------- 定位项目根目录（只用于报告，不删除任何文件）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$lockFile = Join-Path $projectRoot 'data\monitor.lock'

# 公共 helper：Monitor 进程身份验证（见 scheduled-task-common.ps1）
$commonScript = Join-Path $scriptDir 'scheduled-task-common.ps1'
if (-not (Test-Path -LiteralPath $commonScript)) {
    Write-Host "错误：缺少公共脚本 $commonScript" -ForegroundColor Red
    exit 1
}
. $commonScript

Write-Host '========================================================='
Write-Host ' Warframe Fissure Monitor - 卸载计划任务'
Write-Host '========================================================='
Write-Info "项目根目录：$projectRoot"
Write-Info '本脚本不会删除任何项目文件（.env / state.json / logs / dist / node_modules 全部保留）。'

# ---------------------------------------------------------------- 残留 Monitor 进程处理
# 默认只报告；只有 -StopMonitorProcess 且身份校验 verified 时才会强停。
# 身份校验（进程名 + 命令行 + 启动时间）见 scheduled-task-common.ps1。
$script:MonitorCleanupResult = ''

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host ''
    Write-Host '任务不存在，无需删除。'
    # 任务已删除时仍然允许用它单独停止残留 Monitor
    if ($StopMonitorProcess) {
        $script:MonitorCleanupResult = Invoke-MonitorProcessCleanup -ProjectRoot $projectRoot -LockFile $lockFile -Enabled
    }
    if ($script:MonitorCleanupResult -eq 'refused') { exit 1 }
    exit 0
}

Write-Info "任务当前 State：$($task.State)"

if ($task.State -eq 'Running') {
    Write-Host ''
    Write-Host '任务正在运行。'
    Write-Host '说明：Stop-ScheduledTask 只结束 action 进程 cmd.exe，Windows 不会连带结束 node 子进程，'
    Write-Host '      因此 Monitor 可能继续运行（见脚本末尾的提示）。'
    Write-Host ''
    Write-Info '正在停止任务...'
    try {
        Stop-ScheduledTask -TaskName $TaskName
    }
    catch {
        Write-Info "停止任务时出现问题（继续尝试删除）：$($_.Exception.Message)"
    }

    # 等待任务真正离开 Running（最多 15 秒），避免 Unregister 因任务仍在运行而失败
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 1000
        $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -eq $current) { break }
        if ($current.State -ne 'Running') { break }
    }
}

Write-Info '正在删除任务定义...'
try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
catch {
    $stillThere = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $stillThere) {
        Write-Host ''
        Write-Host '任务不存在，无需删除。'
        exit 0
    }
    Write-Host "[uninstall] 错误：删除任务失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '可能原因：任务仍在运行。可稍后重新执行本脚本。'
    exit 1
}

$leftover = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Host ''
if ($null -eq $leftover) {
    Write-Host 'Windows 计划任务已删除。'
}
else {
    Write-Host '任务仍然存在，删除可能未生效，请重试或使用任务计划程序界面检查。' -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------- 残留进程处理
# 默认只报告；-StopMonitorProcess 时也只有身份校验 verified 才会真正结束进程
$script:MonitorCleanupResult = Invoke-MonitorProcessCleanup -ProjectRoot $projectRoot -LockFile $lockFile -Enabled:$StopMonitorProcess

Write-Host ''
Write-Host '后续操作：'
Write-Host '  重新安装：powershell -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1'
Write-Host '  查看状态：powershell -ExecutionPolicy Bypass -File .\scripts\status-scheduled-task.ps1'
Write-Host '  彻底停止：powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1 -StopMonitorProcess'

if ($script:MonitorCleanupResult -eq 'refused') {
    Write-Host ''
    Write-Host '注意：由于无法确认该 PID 属于本项目 Monitor，本次没有结束任何进程（退出码 1）。' -ForegroundColor Yellow
    exit 1
}

exit 0
