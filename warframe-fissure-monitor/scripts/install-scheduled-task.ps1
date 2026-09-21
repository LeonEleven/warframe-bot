#Requires -Version 5.1
<#
.SYNOPSIS
    为当前 Windows 用户安装「Warframe Fissure Monitor」计划任务。

.DESCRIPTION
    任务行为：
        用户登录 -> 等待 60 秒（Task Scheduler 原生 Trigger Delay）-> 运行
        scripts\run-monitor.cmd -> 长期运行 Node monitor。

    设计要点：
    - 幂等：重复执行不会产生多个任务，同名任务会被更新为当前项目配置
    - 只对当前登录用户生效（Interactive），不需要管理员权限，不使用 SYSTEM，不保存密码
    - 失败重启：RestartInterval 1 分钟，最多 3 次；多实例策略 IgnoreNew
    - 执行时限无限制（PT0S），不会因为「运行超过 3 天」被停止
    - 笔记本切换到电池供电不停止任务，也允许在电池供电时启动
    - 不依赖任何网络配置 / 空闲条件 / 电源模式
    - 脚本内不含任何凭据（QQ 号 / token / 代理），配置全部来自项目 .env 或系统环境变量

.PARAMETER DryRun
    只打印将要注册的任务定义与摘要，不实际注册（用于预览和排查）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 常量
$TaskName = 'Warframe Fissure Monitor'
$LogonDelay = 'PT60S'                 # Task Scheduler 原生 trigger delay（不是 action 里的 sleep）
$RestartIntervalMinutes = 1
$RestartCount = 3

function Write-Info {
    param([string]$Message)
    Write-Host "[install] $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[install] 警告：$Message" -ForegroundColor Yellow
}

function Stop-WithError {
    param([string]$Message)
    Write-Host "[install] 错误：$Message" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 定位项目根目录
# 依据脚本自身位置定位：<projectRoot>\scripts\install-scheduled-task.ps1
# 不写死任何用户目录或绝对路径，也不依赖当前工作目录
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$runMonitorCmd = Join-Path $projectRoot 'scripts\run-monitor.cmd'
$distEntry = Join-Path $projectRoot 'dist\index.js'
$envFile = Join-Path $projectRoot '.env'
$logFile = Join-Path $projectRoot 'logs\monitor.log'
$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'

Write-Info "项目根目录：$projectRoot"

# ---------------------------------------------------------------- 安装前检查
if (-not (Test-Path -LiteralPath $runMonitorCmd)) {
    Stop-WithError "找不到启动脚本：$runMonitorCmd"
}
if (-not (Test-Path -LiteralPath $distEntry)) {
    Stop-WithError "找不到 dist\index.js，请先运行：npm run build（否则任务启动后必然失败）"
}
if (-not (Test-Path -LiteralPath $envFile)) {
    Write-Warn '未找到 .env：请确认接收通知的 QQ 号与 NapCat token 已通过 .env 或系统环境变量提供。'
    Write-Warn '本脚本不会读取、也不会打印其中的任何内容。'
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Stop-WithError '当前环境找不到 node。请先安装 Node.js（^22.18.0 或 >=24.11.0），并确保 node 在用户/系统 PATH 中。'
}
Write-Info "node 可执行文件：$($nodeCommand.Source)"
Write-Info '提示：计划任务以登录用户身份运行，node 必须位于该用户可见的 PATH 中（本脚本不会修改 PATH）。'

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($currentUser)) {
    Stop-WithError '无法确定当前 Windows 登录用户，已停止安装。'
}
Write-Info "运行用户：$currentUser"

# ---------------------------------------------------------------- 任务定义
# Action：用 cmd.exe /d /c 调用 run-monitor.cmd（路径含空格时用双层引号包裹）
$actionArgument = '/d /c ""{0}""' -f $runMonitorCmd
$action = New-ScheduledTaskAction -Execute $cmdExe -Argument $actionArgument -WorkingDirectory $projectRoot

# Trigger：用户登录时，延迟 60 秒（原生 Trigger Delay）
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$trigger.Delay = $LogonDelay

# Settings：常驻程序所需的全部设置
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount $RestartCount `
    -RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes)

# Principal：当前用户、仅在用户登录时运行、普通权限（不需要管理员，也不需要密码）
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

$description = "warframe-fissure-monitor: runs scripts\run-monitor.cmd at user logon (60s delay). project: $projectRoot"

function Show-TaskSummary {
    Write-Host ''
    Write-Host '--------------------------------------------------------'
    Write-Host ' Windows 计划任务配置摘要'
    Write-Host '--------------------------------------------------------'
    Write-Host "任务名称    ：$TaskName"
    Write-Host "运行用户    ：$currentUser（仅在该用户登录时运行，普通权限，不需要密码）"
    Write-Host "触发器      ：用户登录后延迟 60 秒（Task Scheduler 原生 Trigger Delay）"
    Write-Host "执行程序    ：$cmdExe"
    Write-Host "参数        ：$actionArgument"
    Write-Host "启动脚本    ：$runMonitorCmd"
    Write-Host "工作目录    ：$projectRoot"
    Write-Host "失败重启    ：每 $RestartIntervalMinutes 分钟，最多 $RestartCount 次"
    Write-Host "多实例策略  ：IgnoreNew（任务已运行时不再启动第二个实例）"
    Write-Host "执行时限    ：无限制（PT0S）"
    Write-Host "电池策略    ：允许电池供电时启动，切换到电池不停止"
    Write-Host "空闲/网络   ：无要求（不依赖空闲状态、电源模式与网络配置）"
    Write-Host "日志文件    ：$logFile"
    Write-Host '--------------------------------------------------------'
}

# ---------------------------------------------------------------- 幂等处理
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Write-Info "任务已存在（当前 State：$($existingTask.State)），将更新为当前项目配置，不会产生重复任务。"
    Write-Info '注意：更新任务定义不会启动第二个 Monitor；多实例策略为 IgnoreNew。'
}
else {
    Write-Info '任务不存在，将新建。'
}

if ($DryRun) {
    Show-TaskSummary
    Write-Host ''
    Write-Info 'DryRun：以上为将要注册的定义，未对系统做任何修改。'
    exit 0
}

# ---------------------------------------------------------------- 注册
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description $description `
    -Force | Out-Null

$installedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $installedTask) {
    Stop-WithError '注册后未能读取到任务，安装可能失败，请检查任务计划程序。'
}

Show-TaskSummary
Write-Host ''
Write-Info 'Windows 计划任务已安装。'
Write-Info "任务 State：$($installedTask.State)（用户下次登录后约 60 秒会自动启动）"
Write-Host ''
Write-Host '后续操作：'
Write-Host '  查看状态：powershell -ExecutionPolicy Bypass -File .\scripts\status-scheduled-task.ps1'
Write-Host '  立即测试：Start-ScheduledTask -TaskName "Warframe Fissure Monitor"'
Write-Host '  查看日志：Get-Content .\logs\monitor.log -Encoding UTF8 -Tail 50'
Write-Host '  卸载任务：powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1'
exit 0
