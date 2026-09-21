#Requires -Version 5.1
<#
.SYNOPSIS
    warframe-fissure-monitor 计划任务脚本的公共 helper（Monitor 进程身份验证）。

.DESCRIPTION
    本文件只定义函数，没有任何副作用，由 install / status / uninstall 三个脚本 dot-source。

    为什么需要身份验证：
    data\monitor.lock 里只有 pid 与 startedAt，而 Windows 的 PID 会被系统重用。
    「PID 存在」并不等于「这个 PID 就是本项目的 Monitor」：
    Monitor 异常退出留下 stale lock 之后，同一个 PID 可能已经被别的程序占用，
    此时如果直接 Stop-Process，就会误杀无关进程。
    因此这里做多重校验：
        1. PID 存在
        2. 进程名是 node / node.exe
        3. 命令行指向本项目的 dist\index.js（支持绝对与相对两种写法）
        4. 进程启动时间与 lock.startedAt 一致（默认容忍 10 秒）
    任何一项无法可靠确认（例如权限不足读不到命令行）都返回 unverified，
    绝不猜测、绝不将就。

    纯判断逻辑被拆成 Test-* 小函数，便于在任意平台（含 CI 的 Linux + PowerShell 7）单测；
    真正访问 Windows CIM 的只有 Get-MonitorProcessIdentity / Invoke-MonitorProcessCleanup。

.NOTES
    目标环境：Windows 11 + Windows PowerShell 5.1（同时兼容 PowerShell 7）。
    本文件保存为 UTF-8 with BOM + CRLF。
#>

# ---------------------------------------------------------------- 常量
$Script:MonitorProcessName = 'node'
$Script:MonitorStartTimeToleranceSeconds = 10

function Get-MonitorExpectedScriptPath {
    <#
    .SYNOPSIS
        返回本项目 Monitor 的入口脚本绝对路径（由调用方动态定位的 $ProjectRoot 推导，绝不硬编码）。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot
    )
    return (Join-Path $ProjectRoot 'dist\index.js')
}

function ConvertTo-NormalizedPathText {
    <#
    .SYNOPSIS
        统一路径文本：/ -> \、合并重复反斜杠，便于做大小写无关的比较。
    #>
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $normalized = $Text.Replace('/', '\')
    $normalized = [regex]::Replace($normalized, '\\{2,}', '\')
    return $normalized
}

function Test-MonitorProcessName {
    <#
    .SYNOPSIS
        判断进程名是否为 node（允许 node 或 node.exe，大小写无关）。
    #>
    param([string]$ProcessName)

    if ([string]::IsNullOrWhiteSpace($ProcessName)) { return $false }
    $name = $ProcessName.Trim().ToLowerInvariant()
    $name = $name -replace '\.exe$', ''
    return ($name -eq $Script:MonitorProcessName)
}

function Test-MonitorCommandLine {
    <#
    .SYNOPSIS
        判断命令行是否指向本项目的 dist\index.js。

    .DESCRIPTION
        处理以下差异：
        - 大小写不同
        - 分隔符 \ 与 / 混用
        - 路径含空格、被引号包裹
        - 绝对路径（"C:\...\dist\index.js"）与相对路径（run-monitor.cmd 实际使用的 node "dist\index.js"）
        匹配要求以引号 / 空白 / 行尾结束，避免把 dist\index.js.bak 之类误判为命中。
    #>
    param(
        [string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$ExpectedScriptPath
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }

    $commandText = ConvertTo-NormalizedPathText -Text $CommandLine
    $expectedPath = ConvertTo-NormalizedPathText -Text $ExpectedScriptPath
    if ([string]::IsNullOrWhiteSpace($expectedPath)) { return $false }

    # 1) 命中本项目绝对路径
    if ($commandText.IndexOf($expectedPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
    }

    # 2) 命令里出现了「别的绝对路径形式的 ...\dist\index.js」时直接拒绝：
    #    避免把另一个项目的 dist\index.js 误认为本项目（相对写法无法区分目录，必须靠这一步排除）
    $foreignPathPattern = '(?i)(?:[a-z]:|\\\\[^\\/]+)[^"'']*\\dist\\index\.js'
    foreach ($match in [regex]::Matches($commandText, $foreignPathPattern)) {
        if (-not $match.Value.Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }

    # 3) 相对路径命中：run-monitor.cmd 使用 `node "dist\index.js"`，
    #    因此接受以 <最后一级目录>\<文件名> 形式出现且后面紧跟引号 / 空白 / 行尾的写法
    $leafName = Split-Path -Leaf $expectedPath
    $parentName = Split-Path -Leaf (Split-Path -Parent $expectedPath)
    if ([string]::IsNullOrWhiteSpace($leafName) -or [string]::IsNullOrWhiteSpace($parentName)) {
        return $false
    }

    $relativeToken = $parentName + '\' + $leafName
    $pattern = [regex]::Escape($relativeToken) + '(?=["'']|\s|$)'
    return [regex]::IsMatch($commandText, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Test-MonitorStartTime {
    <#
    .SYNOPSIS
        判断进程启动时间与 lock.startedAt 是否在容忍范围内一致。

    .DESCRIPTION
        这是对抗 PID 重用的关键信号：即使 PID 被复用，新进程的启动时间通常也明显不同。
        lock.startedAt 是 UTC ISO 字符串；进程启动时间按 UTC 归一化后比较。
        无法解析 lock.startedAt 时返回 false（宁可判为无法确认）。
    #>
    param(
        [string]$LockStartedAt,
        [datetime]$ProcessStartTime,
        [int]$ToleranceSeconds = 10
    )

    if ([string]::IsNullOrWhiteSpace($LockStartedAt)) { return $false }

    $lockTime = [datetime]::MinValue
    $parsed = [datetime]::TryParse(
        $LockStartedAt,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$lockTime
    )
    if (-not $parsed) { return $false }

    $difference = [math]::Abs(($ProcessStartTime.ToUniversalTime() - $lockTime.ToUniversalTime()).TotalSeconds)
    return ($difference -le $ToleranceSeconds)
}

function Read-MonitorLockFile {
    <#
    .SYNOPSIS
        读取 data\monitor.lock（只读，不修改、不删除）。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$LockFile
    )

    $result = [pscustomobject]@{
        Exists    = $false
        Pid       = 0
        StartedAt = ''
        Error     = ''
    }

    if (-not (Test-Path -LiteralPath $LockFile)) { return $result }
    $result.Exists = $true

    try {
        $data = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json
        if ($null -ne $data.pid -and "$($data.pid)" -match '^\d+$') {
            $result.Pid = [int]$data.pid
        }
        if ($null -ne $data.startedAt) {
            $result.StartedAt = [string]$data.startedAt
        }
    }
    catch {
        $result.Error = $_.Exception.Message
    }

    return $result
}

function Get-MonitorProcessIdentity {
    <#
    .SYNOPSIS
        校验 lock 中的 PID 是否确实属于本项目 Monitor。

    .OUTPUTS
        PSCustomObject：
            State        : stale | unverified | verified
            Verified     : bool
            Pid          : int
            ProcessName  : 进程名（可能为空）
            ExecutablePath / CommandLine / StartTime : 诊断信息
            ExpectedPath : 期望的入口脚本路径
            Reason       : 判定原因（中文，可直接展示）
    #>
    param(
        [Parameter(Mandatory = $true)][int]$LockPid,
        [string]$LockStartedAt,
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [int]$StartTimeToleranceSeconds = 10
    )

    $expectedPath = Get-MonitorExpectedScriptPath -ProjectRoot $ProjectRoot

    $result = [pscustomobject]@{
        State          = 'unverified'
        Verified       = $false
        Pid            = $LockPid
        ProcessName    = ''
        ExecutablePath = ''
        CommandLine    = ''
        StartTime      = $null
        ExpectedPath   = $expectedPath
        Reason         = ''
    }

    if ($LockPid -le 0) {
        $result.State = 'stale'
        $result.Reason = 'lock 中的 PID 无效'
        return $result
    }

    # 1) 存在性探测（身份必须再由下面的 CIM 检查确认，不能只看这一步）
    $liveProcess = Get-Process -Id $LockPid -ErrorAction SilentlyContinue
    if ($null -eq $liveProcess) {
        $result.State = 'stale'
        $result.Reason = 'PID 不存在（进程已退出）'
        return $result
    }

    # 2) 通过 CIM 读取进程名 / 命令行 / 启动时间（不使用已弃用的 wmic）
    $cimProcess = $null
    try {
        $cimProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $LockPid" -ErrorAction Stop
    }
    catch {
        $cimProcess = $null
    }

    if ($null -eq $cimProcess) {
        $result.ProcessName = [string]$liveProcess.ProcessName
        $result.Reason = '无法通过 CIM 读取该 PID 的进程信息（权限或系统限制）'
        return $result
    }

    $result.ProcessName = [string]$cimProcess.Name
    $result.CommandLine = [string]$cimProcess.CommandLine
    $result.ExecutablePath = [string]$cimProcess.ExecutablePath
    if ($null -ne $cimProcess.CreationDate) { $result.StartTime = $cimProcess.CreationDate }

    # 3) 进程名必须是 node
    if (-not (Test-MonitorProcessName -ProcessName $result.ProcessName)) {
        $result.Reason = "进程名不是 node（实际：$($result.ProcessName)）"
        return $result
    }

    # 3b) ExecutablePath 可读时做一次附加校验（读不到不作为失败依据）
    if (-not [string]::IsNullOrWhiteSpace($result.ExecutablePath)) {
        $executableLeaf = Split-Path -Leaf (ConvertTo-NormalizedPathText -Text $result.ExecutablePath)
        if (-not (Test-MonitorProcessName -ProcessName $executableLeaf)) {
            $result.Reason = "可执行文件不是 node（实际：$executableLeaf）"
            return $result
        }
    }

    # 4) 命令行必须可读，且指向本项目 dist\index.js
    if ([string]::IsNullOrWhiteSpace($result.CommandLine)) {
        $result.Reason = '无法读取命令行（权限不足），不能确认它属于本项目'
        return $result
    }
    if (-not (Test-MonitorCommandLine -CommandLine $result.CommandLine -ExpectedScriptPath $expectedPath)) {
        $result.Reason = "命令行未指向本项目的 dist\index.js（实际：$($result.CommandLine.Trim())）"
        return $result
    }

    # 5) 启动时间必须与 lock.startedAt 一致
    if ($null -eq $result.StartTime) {
        $result.Reason = '无法获取进程启动时间'
        return $result
    }
    if (-not (Test-MonitorStartTime -LockStartedAt $LockStartedAt -ProcessStartTime $result.StartTime -ToleranceSeconds $StartTimeToleranceSeconds)) {
        $result.Reason = "进程启动时间与 lock.startedAt 不一致（差异超过 $StartTimeToleranceSeconds 秒，PID 可能已被系统重用）"
        return $result
    }

    $result.State = 'verified'
    $result.Verified = $true
    $result.Reason = '进程名、命令行与启动时间均与本项目 Monitor 一致'
    return $result
}

function Invoke-MonitorProcessCleanup {
    <#
    .SYNOPSIS
        根据 lock 与身份校验结果处理残留 Monitor 进程：默认只报告，-Enabled 时才可能强停。

    .DESCRIPTION
        只有身份校验结果为 verified 时才会执行 Stop-Process；
        其余情况（PID 不存在 / 无法确认身份）一律拒绝强停并说明原因，
        目的是避免 Windows PID 重用导致误杀其它进程。

    .OUTPUTS
        字符串状态：no-lock | invalid-lock | stale | reported | refused | stopped | stop-failed
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$LockFile,
        [switch]$Enabled,
        [int]$StartTimeToleranceSeconds = 10
    )

    $lock = Read-MonitorLockFile -LockFile $LockFile

    if (-not $lock.Exists) {
        Write-Host 'Monitor lock    : 不存在（没有发现运行中的 Monitor）'
        return 'no-lock'
    }
    if ($lock.Pid -le 0) {
        Write-Host 'Monitor lock    : 存在但无法解析出有效 PID（属项目自身处理范围，本脚本不删除）'
        return 'invalid-lock'
    }

    $identity = Get-MonitorProcessIdentity -LockPid $lock.Pid -LockStartedAt $lock.StartedAt -ProjectRoot $ProjectRoot -StartTimeToleranceSeconds $StartTimeToleranceSeconds

    if ($identity.State -eq 'stale') {
        Write-Host "Monitor lock    : stale（PID $($identity.Pid) 已不存在），下次启动时项目会自动清理。"
        return 'stale'
    }

    if ($identity.State -ne 'verified') {
        if (-not $Enabled) {
            Write-Host ''
            Write-Host "提示：Monitor 进程仍然存活（PID $($identity.Pid)）。"
            Write-Host '      原因：Stop-ScheduledTask 只结束了 action 进程 cmd.exe，Windows 不会连带结束 node 子进程。'
            Write-Host '      本脚本默认不会强杀它（它仍具备发送 QQ 通知的能力）。如需一并停止，请执行：'
            Write-Host '        powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1 -StopMonitorProcess'
            return 'reported'
        }

        Write-Host ''
        Write-Host "拒绝结束 PID $($identity.Pid)："
        Write-Host '该 PID 当前存在，但无法确认它属于 warframe-fissure-monitor。'
        Write-Host "原因：$($identity.Reason)"
        Write-Host '为避免 PID 重用导致误杀其它程序，本脚本没有执行 Stop-Process。'
        Write-Host '请人工确认后再决定是否处理（例如用任务管理器查看该 PID 的命令行）。'
        Write-Host ''
        Write-Host "  进程名        : $($identity.ProcessName)"
        Write-Host "  命令行        : $($identity.CommandLine)"
        Write-Host "  进程启动时间  : $($identity.StartTime)"
        Write-Host "  lock.startedAt: $($lock.StartedAt)"
        Write-Host "  期望脚本路径  : $($identity.ExpectedPath)"
        return 'refused'
    }

    if (-not $Enabled) {
        Write-Host ''
        Write-Host "提示：Monitor 进程仍然存活（PID $($identity.Pid)，身份已验证）。"
        Write-Host '      本脚本默认不会强杀它。如需一并停止，请执行：'
        Write-Host '        powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1 -StopMonitorProcess'
        return 'reported'
    }

    Write-Host "[uninstall] 身份已验证（node + dist\index.js + 启动时间一致），正在结束 Monitor 进程（PID $($identity.Pid)）..."
    Stop-Process -Id $identity.Pid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1000

    $stillRunning = Get-Process -Id $identity.Pid -ErrorAction SilentlyContinue
    if ($null -ne $stillRunning) {
        Write-Host "警告：PID $($identity.Pid) 仍然存活，请人工检查。" -ForegroundColor Yellow
        return 'stop-failed'
    }

    Write-Host "已结束 Monitor 进程（PID $($identity.Pid)）。"
    Write-Host 'data\monitor.lock 现在是 stale，下次启动时项目自身会自动清理。'
    return 'stopped'
}
