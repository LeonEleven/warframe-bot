# warframe-fissure-monitor

监控 **Warframe 国际服 PC** 的虚空裂缝，当出现符合条件的裂缝时，通过本机 **NapCatQQ（OneBot 11 HTTP API）** 给指定 QQ 私聊发送一条中文通知（带持久化去重、单实例保护、心跳日志）。

## 数据链路（默认路径）

```
Digital Extremes 官方 WorldState
  https://api.warframe.com/cdn/worldState.php
        ↓
warframe-worldstate-parser（WFCD 维护的解析库，locale = en）
        ↓
本项目筛选：Steel Path + Void + Survival + 非 Void Storm + 未过期
        ↓
NapCatQQ (OneBot 11: POST /send_private_msg)
        ↓
QQ 私聊（简体中文通知）
```

**官方 WorldState 是默认、首选数据源，正常情况下无需 Clash / 代理，也不需要配置任何 HTTP_PROXY 环境变量。**
WarframeStat.us 作为备用源保留（`WARFRAME_SOURCE=auto` 时才会在 official 失败后使用）。

## 通知条件（必须同时满足）

| # | 条件 | 说明 |
|---|------|------|
| 1 | `isHard === true` | 钢铁之路（Steel Path） |
| 2 | `isStorm === false` | 非虚空风暴（Void Storm） |
| 3 | `missionType === "Survival"` | 生存任务（英文规范值） |
| 4 | 节点名以 `(Void)` 结尾 | 虚空节点，**动态判断，不硬编码 Ani / Mot** |
| 5 | `expiry > 当前时间` | 尚未过期 |

要点：

- 匹配**永远**使用英文规范数据（`Survival` / `Void` / Steel Path 布尔值）；中文（阿尼 / 默特 / 生存 / 虚空）只属于展示层，不参与判断。
- 上游没有给出 `isHard` / `isStorm` 时保持 **unknown（null）**，unknown 一律**不通知**（绝不把 unknown 当成 `false`）。
- 以后 DE 若新增 Void 生存节点，程序会自动匹配，不会因为不在 Ani/Mot 白名单而漏报。

## 通知示例

```
【Warframe 钢铁裂缝提醒】

发现新的虚空钢铁之路生存裂缝！

节点：默特（Mot）
星系：虚空（Void）
任务：生存（Survival）
模式：钢铁之路（Steel Path）
裂缝：后纪（Axi）
剩余：1 小时 24 分
结束：2026-09-21 11:26:18

检测：2026-09-21 10:02:04
```

一次轮询发现多个新裂缝时会合并成一条消息，并用 ①②③ 编号。
QQ 文案中**不包含 tierNum**（tierNum 只用于 `npm run check` / debug / 测试）。

---

## 1. Windows 安装

### 1.1 环境要求

- **Node.js `^22.18.0 || >=24.11.0`**（`warframe-worldstate-parser` 的 engines 要求；本项目在 Node 24.21.0 + npm 11.19.0 验证）。
- 本机已安装并登录 **NapCatQQ**（或兼容 OneBot 11 的框架）。

```powershell
node --version
npm --version
```

### 1.2 安装依赖

```powershell
cd C:\Users\lvsy\Documents\Projects\warframe-bot\warframe-fissure-monitor
npm install
```

### 1.3 创建配置文件

```powershell
Copy-Item .env.example .env
notepad .env
```

至少填写 `TARGET_QQ`；NapCat 若配置了 token，再填 `NAPCAT_TOKEN`。
**默认情况下不需要填 `WARFRAME_PROXY_URL`，也不需要代理。**

> `.env` 已在 `.gitignore` 中，不会被提交；仓库里只有不含敏感信息的 `.env.example`。
> 日志与 `npm run check` 输出都会脱敏：不会打印 QQ 号、NapCat token、带用户名密码的代理地址。

### 1.4 配置 NapCat

1. NapCatQQ WebUI → **网络配置** → 新建 **HTTP 服务器**：Host `127.0.0.1`、端口 `3000`（与 `NAPCAT_BASE_URL` 一致）。
2. 如需鉴权，设置 Token 并填到 `.env` 的 `NAPCAT_TOKEN`（程序会发送 `Authorization: Bearer <token>`）。
3. 确保 **TARGET_QQ 是机器人账号的好友**（非好友无法私聊）。

### 1.5 验证

```powershell
npm run typecheck
npm test
npm run build

npm run check             # 真实拉取 official WorldState 并显示匹配结果，绝不发送 QQ
npm run test:notification # 用假裂缝真实调用 NapCat 发一条测试通知
```

---

## 2. 如何测试官方 WorldState 是否可以直连

不依赖本项目、不依赖 Node，直接确认这台机器能否访问 DE 官方数据：

```powershell
curl.exe --noproxy "*" -L -sS `
  -o "$env:TEMP\wf-worldstate.json" `
  -w "HTTP %{http_code}`n" `
  "https://api.warframe.com/cdn/worldState.php"

Get-Item "$env:TEMP\wf-worldstate.json" | Select-Object Length
```

判读标准：

- **HTTP 200 且文件非空（约 100~200 KB）** → 官方 WorldState 可直连，`WARFRAME_SOURCE=official` 开箱可用，不需要代理。
- `HTTP 000` / 连接被重置 / 文件 0 字节 → 本机网络无法直连官方源；可改用 `WARFRAME_SOURCE=warframestat`（或 `auto`），或按需设置 `WARFRAME_PROXY_URL`。

想快速看一眼这份 JSON 里的裂缝字段（可选）：

```powershell
(Get-Content "$env:TEMP\wf-worldstate.json" -Raw | ConvertFrom-Json).ActiveMissions | Select-Object -First 3
```

---

## 3. 配置项（全部来自 `.env`）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `WARFRAME_SOURCE` | 否 | `official` | `official` / `auto` / `warframestat` |
| `WARFRAME_WORLDSTATE_URL` | 否 | `https://api.warframe.com/cdn/worldState.php` | 官方 WorldState 地址 |
| `WARFRAMESTAT_API_URL` | 否 | `https://api.warframestat.us/pc/fissures?language=en` | 备用源地址 |
| `WARFRAME_PROXY_URL` | 否 | 空 | **只作用于 Warframe 请求**；留空即不用代理 |
| `POLL_INTERVAL_MS` | 否 | `60000` | 轮询间隔（≥5000）；上一轮结束后才计时 |
| `HTTP_TIMEOUT_MS` | 否 | `10000` | Warframe 请求超时 |
| `HEARTBEAT_INTERVAL_MS` | 否 | `21600000` | 心跳日志间隔（6 小时，≥60000） |
| `NAPCAT_BASE_URL` | 否 | `http://127.0.0.1:3000` | NapCat HTTP 服务 |
| `NAPCAT_TOKEN` | 否 | 空 | 留空则不发送 `Authorization` 头 |
| `NAPCAT_TIMEOUT_MS` | 否 | `15000` | NapCat 请求超时 |
| `TARGET_QQ` | **是** | 无 | 接收通知的 QQ 号（5~12 位数字） |
| `DRY_RUN` | 否 | `false` | `true` = 只检测并打印，不发送、不写状态 |
| `STATE_FILE` | 否 | `data/state.json` | 去重状态文件 |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |

补充说明：

- `WARFRAME_SOURCE=auto`：先 official，**只有**请求或解析失败才回退 WarframeStat.us，并打印 `official 获取失败 -> fallback 到 warframestat` 警告。fallback 只写日志，绝不会因为数据源故障给 QQ 发通知。
- 布尔值接受 `true/false`、`1/0`、`yes/no`、`on/off`（不区分大小写）。
- **进程环境变量优先于 `.env`**，临时覆盖无需改文件：`$env:DRY_RUN='true'; npm start`。
- **旧变量 `WARFRAME_API_URL` 已废弃**：若仍设置，它会被当作 `WARFRAMESTAT_API_URL` 的兼容别名并打印一条废弃警告；若两者同时设置，以 `WARFRAMESTAT_API_URL` 为准（不会静默互相覆盖）。建议直接改名为 `WARFRAMESTAT_API_URL`。
- 单实例锁文件固定为 `STATE_FILE` 同目录下的 `monitor.lock`，无需配置。

---

## 4. 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 开发模式（`tsx watch`）运行 `src/index.ts` |
| `npm run build` | 用 `tsc` 编译到 `dist/`（**正式运行前必须执行**） |
| `npm start` | 运行编译产物 `node dist/index.js`（长期运行用这个） |
| `npm test` | 运行全部单元测试（`node:test` + `tsx`，不联网、不需要真实配置） |
| `npm run typecheck` | 对 `src` 与 `tests` 做类型检查（不产出文件） |
| `npm run check` | **真实调用** Warframe 数据源，打印 provider / 数量 / 匹配项开发者信息 / 消息预览；**绝不发送 QQ，也不修改 notified state** |
| `npm run test:notification` | 构造假裂缝（Mot (Void) / Survival / Axi / isHard=true）通过真实 NapCat 发给 `TARGET_QQ`；不写 `state.json` |

> 长期部署（Windows 计划任务）用的是 `scripts\` 下的 4 个脚本，不是 npm 命令，见 [第 5 节](#5-正式运行windows-长期部署)：
> `install-scheduled-task.ps1` / `status-scheduled-task.ps1` / `uninstall-scheduled-task.ps1`（+ 被任务调用的 `run-monitor.cmd`）。

### `npm run check` 会打印什么

```
数据源配置 : WARFRAME_SOURCE=official
provider   : official
数据 URL   : official <- https://api.warframe.com/cdn/worldState.php

获取裂缝数量      : 28
Steel Path 数量   : 12
最终符合数量      : 1（Steel Path + Void + Survival + 非 VoidStorm + 未过期）
其中未通知过      : 1（npm start 时会通知）

----- 最终匹配项（开发者信息） -----
  node           : Mot (Void)
  missionType    : Survival
  tier           : Axi
  tierNum        : 4
  isHard         : true
  isStorm        : false
  expiry         : 2026-09-21 10:24:42
  remaining      : 17 分 29 秒
  id             : 6ab08642c9707fa2eb1e9425
```

---

## 5. 正式运行（Windows 长期部署）

### 5.1 首次准备

```powershell
npm run typecheck
npm test
npm run build
```

### 5.2 安装「登录自动启动」计划任务（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-scheduled-task.ps1
```

脚本会创建一个名为 **`Warframe Fissure Monitor`** 的计划任务：

| 项目 | 值 |
|---|---|
| 触发器 | **用户登录时**（仅当前用户），**延迟 60 秒**（Task Scheduler 原生 Trigger Delay，不是脚本里的 sleep） |
| 运行身份 | 当前登录用户（`Interactive` = 仅在用户登录时运行），`Limited` 普通权限，**不需要管理员、不保存密码、不使用 SYSTEM** |
| 执行程序 | `%SystemRoot%\System32\cmd.exe`，参数 `/d /c ""<项目根>\scripts\run-monitor.cmd""`，工作目录为项目根 |
| 多实例策略 | **IgnoreNew**（任务已运行时不启动第二个实例；项目内 PID lock 为第二层保护） |
| 执行时限 | **PT0S = 无限制**（不会因为「运行超过 3 天」被停止） |
| 失败重启 | 每 **1 分钟**，最多 **3** 次（`run-monitor.cmd` 会把 Node 退出码返回给调用方，Task Scheduler 据此判定失败） |
| 电池策略 | 允许电池供电时启动；切换到电池**不停止** |
| 其他 | `StartWhenAvailable=true`（错过启动机会可补启）；不要求空闲、不依赖网络配置与电源模式 |

安装脚本是**幂等**的：重复执行只会把同名任务更新为当前项目配置，不会产生第二个任务，也不会启动第二个 Monitor。
安装前会检查 `scripts\run-monitor.cmd`、`dist\index.js`（缺失会直接报错并提示 `npm run build`；不会静默创建一个必然失败的任务）、`.env` 是否存在（不存在只警告，因为配置也可以来自系统环境变量）、以及 `node` 是否可用（并打印解析到的 `node.exe` 路径，便于排查计划任务的 PATH 问题）。脚本不会读取或打印 `.env` 中的任何内容。

想先预览不注册：加 `-DryRun`。

### 5.3 查看状态

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\status-scheduled-task.ps1
```

只读输出：任务是否存在、`State`、`LastRunTime`、`LastTaskResult`、`NextRunTime`、触发器/用户/动作、关键设置；项目侧会读取 `data\monitor.lock` 的 PID 并**校验它是否确实属于本项目 Monitor**，以及 `logs\monitor.log` 的大小与最后写入时间（不打印日志内容）。

`data\monitor.lock` 的判定有三种结果（**不再只看 PID 是否存在**）：

| 输出 | 含义 |
|---|---|
| `Monitor lock : stale` | PID 已不存在（Monitor 已退出），下次启动时由项目自身清理 |
| `Monitor process : running (verified)` + `Identity : verified` | PID 存在，且进程名是 `node`、命令行指向本项目 `dist\index.js`、进程启动时间与 `lock.startedAt` 一致（容忍 10 秒） |
| `Monitor lock : suspicious / unverified` | PID 存在但无法确认属于本项目 —— **很可能是 Windows 把该 PID 重用给了别的程序**；脚本只报告，不会结束该进程，也不会删除 lock |

> 为什么要做身份校验：`monitor.lock` 里只有 `pid` 与 `startedAt`，而 Windows 的 PID 会被重复使用。
> 如果 Monitor 异常退出留下 stale lock、原 PID 又恰好被别的程序占用，只看「PID 存在」就会把无关进程当成 Monitor。
> 因此 `status` 与 `uninstall` 都会调用 `scripts/scheduled-task-common.ps1` 中的
> `Get-MonitorProcessIdentity`（基于 `Get-CimInstance Win32_Process`，不使用已弃用的 `wmic`）做三重校验。

### 5.4 手动启动测试

```powershell
Start-ScheduledTask -TaskName "Warframe Fissure Monitor"
```

手工启动**不需要**等 60 秒 —— `Delay` 只属于登录触发器。

### 5.5 查看日志

```powershell
# Windows PowerShell 5.1：显式指定 UTF8，避免中文显示为乱码
Get-Content .\logs\monitor.log -Encoding UTF8 -Tail 50

# 实时跟踪
Get-Content .\logs\monitor.log -Encoding UTF8 -Tail 20 -Wait
```

### 5.6 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1
```

- 默认**不删除任何项目文件**（`.env` / `data\state.json` / `data\monitor.lock` / `logs\` / `dist\` / `node_modules\` 全部保留），也**不会**强杀 Monitor 进程。
- 任务不存在时只提示「任务不存在，无需删除。」并以 0 退出（幂等）。
- **重要（实测结论）**：任务的 action 是 `cmd.exe /d /c run-monitor.cmd`，`run-monitor.cmd` 再启动 `node`。
  `Stop-ScheduledTask` 结束的是 action 进程 `cmd.exe`，**Windows 不会连带结束子进程**，因此卸载后 `node.exe` 可能仍在运行（Monitor 仍在轮询、仍具备发送通知的能力）。
  「任务已停止」≠「Monitor 已停止」。需要彻底停止时加开关：

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-scheduled-task.ps1 -StopMonitorProcess
  ```

  **`-StopMonitorProcess` 不会只看 PID，它会先做身份校验**（`scripts/scheduled-task-common.ps1`）：

  1. `data\monitor.lock` 的 PID 只是第一步 —— 单凭它**不足以**认定该进程属于本项目；
  2. 必须同时满足：进程名是 `node`；命令行（`Get-CimInstance Win32_Process` 的 `CommandLine`）指向本项目的 `dist\index.js`；进程启动时间与 `lock.startedAt` 一致（容忍 10 秒）；
  3. 只有三项全部通过（`verified`）才会执行 `Stop-Process`；
  4. **任何一项无法确认就拒绝强杀**，打印拒绝原因并以退出码 1 结束，交由人工确认 —— 这是为了防止 Windows 的 PID 重用导致误结束无关进程（宁可留下一个进程让你检查，也不能杀错）；
  5. 路径判断基于脚本动态定位的项目根目录，不硬编码任何用户路径；对大小写、`\` 与 `/`、空格、引号、以及绝对/相对两种写法都做了处理。

  强制停止时 Node 来不及执行退出清理，`data\monitor.lock` 会留下 stale，下次启动时由项目自身自动清理。
  即使残留了 monitor，安全性也有保障：重新启动任务时 Task Scheduler 的 `IgnoreNew` 与项目内 PID lock 都会拒绝第二个实例。

### 5.7 启动顺序说明

```
Windows 用户登录
    ↓
NapCatQQ-Desktop 自启动
    ↓
NapCat 自动拉起 Bot
    ↓
约 60 秒后，Task Scheduler 启动 Monitor（scripts\run-monitor.cmd → node dist\index.js）
```

Monitor **不会主动等待 NapCat ready**（没有这类业务逻辑，也不需要）：

- 只有真正需要发通知时才会调用 NapCat；
- 如果目标裂缝出现时 NapCat 还不可用：发送失败 → **不写 `state.json`** → 下一轮（60 秒后）会重新尝试；
- 因此即使 Monitor 比 NapCat 早启动，也不会永久漏掉裂缝；
- 登录后延迟 60 秒的目的只是降低启动竞态与无意义的错误日志。

### 5.8 备用手工方法：任务计划程序 GUI

不想用脚本时，可以手工创建（与上面脚本等价）：

1. 触发器：**用户登录时**，延迟 **60 秒**。
2. 操作：程序 `cmd.exe`，参数 `/d /c "<项目根>\scripts\run-monitor.cmd"`，起始于项目根目录。
3. 设置：**如果任务已在运行，则不启动新实例**；**任务失败后：1 分钟后重新启动**；**不要**勾选"运行超过 N 天自动停止"；勾选"不管用户是否登录都运行"**不要**勾，勾选"使用电池供电时**允许**启动/不停止"。

> **`scripts\run-monitor.cmd` 故意保持 ASCII-only**（纯英文注释与 echo、CRLF 换行、不使用 `%DATE%` / `%TIME%`）。
> 原因：传统 Windows `cmd.exe` 按**系统本地代码页**解析批处理文件，脚本里出现 UTF-8 中文时会报出
> `'嬪簭璋冪敤锛?rem' 不是内部或外部命令` 之类的乱码错误导致启动失败；而 `%DATE%` / `%TIME%` 会写出
> 「周一」这类本地化文本，与 Node 写出的 UTF-8 日志混在同一个文件里造成混合编码。
> 因此**不要**给这个脚本加中文注释、中文 echo 或本地化日期时间；时间戳统一由 Node logger 输出。
> `tests/run-monitor-cmd.test.ts` 会守护这条约束（ASCII-only / CRLF / 无 `%DATE%` / 无绝对路径 / 无凭据）。
>
> 计划任务脚本本身（`scripts\*.ps1`）使用中文提示，因此保存为 **UTF-8 with BOM + CRLF**，
> 这样 Windows PowerShell 5.1 才能正确解析中文；`tests/scheduled-task-scripts.test.ts` 会守护这些约束。

关于唤醒：

- **PowerToys Awake 可防止笔记本睡眠**（用于长时间挂机）。
- 但 **Windows 重启后仍需要任务计划程序把 monitor 重新拉起来** —— PowerToys Awake 不负责重启进程。

### 单实例保护

- 启动时会在 `data/monitor.lock` 写入 `{ version, pid, startedAt }`。
- 若该 **PID 仍然存活**：认为已有实例，打印明确提示并以退出码 1 结束，**不会**同时轮询、不会重复发 QQ。
- 若 PID 已不存在 / 锁文件损坏：识别为 **stale lock**，自动清理后正常启动（崩溃、断电、强杀后都能自愈）。
- 正常退出（Ctrl+C / SIGTERM / 正常结束）会删除锁文件。

### 日志

- 无匹配裂缝 → `debug`（避免 60 秒一条的噪音）。
- 发现新的待通知裂缝 → `info`；QQ 发送成功 → `info`。
- provider 回退 → `warn`；HTTP / 解析异常 → `error`。
- **心跳**：默认每 6 小时一条 `info`：
  `监控运行正常 provider=official 累计轮询=57 最近成功获取=2026-09-21T02:00:00.000Z 最近一次裂缝数量=30`
  心跳**只写日志，绝不发送 QQ**。
  `最近成功获取` 只表示「Warframe 数据获取成功」，与 QQ 是否发送成功无关：
  NapCat 发送失败会记 `error` 日志并在下一轮重试，但不会把这一轮算成「获取失败」。
- **parser 噪音**：`warframe-worldstate-parser` 默认会把
  `No defined kuva data, skipping data` / `No outpost data, skipping` 直接输出到 `console.debug`。
  本项目已通过 parser 官方的 logger 注入点把这类信息转成 `[worldstate-parser]` 前缀的 `debug` 日志，
  因此 `logs\monitor.log` 在 `info` 级别下不会再被每 60 秒一次的无害提示刷屏；
  需要排查时把 `LOG_LEVEL` 设为 `debug` 即可看到（parser 的真实诊断信息不会被吞掉）。

### 日志编码与查看方式

`logs\monitor.log` 里的内容是**两种来源、编码分工明确**的：

| 写入方 | 内容 | 编码 |
|---|---|---|
| `run-monitor.cmd` | `[run-monitor] ===== START =====`、`===== EXIT code=N =====` | **纯 ASCII**（刻意不含日期时间与中文字符） |
| Node logger | 监控日志（含中文文案与 ISO 时间戳） | **UTF-8** |

cmd 写入的那几行是纯 ASCII，UTF-8 与本地代码页对它们的字节解释完全一致，所以整个文件不会再出现混合编码乱码；
所有中文都来自 Node，始终是 UTF-8。时间戳也统一由 Node logger 输出，cmd 不再生成本地化时间。

查看日志：

```powershell
# Windows PowerShell 5.1：显式指定 UTF8，避免中文显示为乱码
Get-Content .\logs\monitor.log -Encoding UTF8 -Tail 50

# 实时跟踪
Get-Content .\logs\monitor.log -Encoding UTF8 -Tail 20 -Wait
```

> PowerShell 7 默认就是 UTF-8，行为通常更友好（`Get-Content .\logs\monitor.log -Tail 50` 即可）；
> 但本项目**不要求**你安装 PowerShell 7，Windows 自带的 5.1 配合 `-Encoding UTF8` 完全够用。
> 用记事本 / VS Code 打开日志时请选择 UTF-8 编码。

---

## 6. 去重状态 `data/state.json`

```json
{
  "version": 1,
  "notified": {
    "6ab08642c9707fa2eb1e9425": {
      "id": "6ab08642c9707fa2eb1e9425",
      "expiry": "2026-09-21T02:24:42.576Z",
      "notifiedAt": "2026-09-21T02:07:28.252Z"
    }
  }
}
```

- 写入时机：**仅当 NapCat 返回 `status === "ok"` 且 `retcode === 0`** 之后（发送失败不写，下一轮重试）。
- 写入方式：先写 `.tmp` 再 `rename`，原子替换。
- 加载：文件不存在 → 空状态；文件损坏 → 备份为 `state.json.corrupt-<时间戳>.bak` 后从空状态开始。
- 清理：每轮开始删除 `expiry` 早于「当前时间 − 2 小时」的历史 ID。
- 想重新通知历史裂缝：停止程序后删 `data/state.json`（**不要**为了修锁去删它）。

---

## 7. 项目结构

```
warframe-fissure-monitor/
├─ scripts/
│  ├─ run-monitor.cmd                 # 计划任务启动脚本（ASCII-only + CRLF，无敏感信息）
│  ├─ scheduled-task-common.ps1       # 公共 helper：Monitor 进程身份校验（PID/进程名/命令行/启动时间）
│  ├─ install-scheduled-task.ps1      # 安装「登录后延迟 60 秒」计划任务（幂等，支持 -DryRun）
│  ├─ status-scheduled-task.ps1       # 只读状态检查（任务 + 身份校验后的 lock/PID + 日志大小）
│  └─ uninstall-scheduled-task.ps1    # 删除任务（默认不删文件、不强杀；-StopMonitorProcess 需通过身份校验）
├─ data/                          # state.json + monitor.lock（运行时生成，已 gitignore）
├─ logs/                          # run-monitor.cmd 的日志（已 gitignore）
├─ src/
│  ├─ index.ts                    # 入口：配置 → 锁 → 状态 → 顺序轮询（心跳 / 优雅退出）
│  ├─ app.ts                      # 依赖装配（代理只注入 Warframe 侧，NapCat 绝不带代理）
│  ├─ config.ts                   # .env 加载 + zod 校验 + 旧变量兼容
│  ├─ lock.ts                     # 单实例锁（PID + stale 自愈）
│  ├─ heartbeat.ts                # 心跳统计与日志（只写日志）
│  ├─ redact.ts                   # URL/凭据脱敏
│  ├─ logger.ts  types.ts  filter.ts  poller.ts  runner.ts
│  ├─ localization/zh-cn.ts       # 中文展示层（节点/星系/tier/任务，仅用于显示）
│  ├─ notify/
│  │  ├─ napcat.ts                # OneBot 11 客户端（status=ok 且 retcode=0 才算成功）
│  │  └─ message.ts               # 中文通知文案 + 开发者向输出
│  ├─ state/store.ts              # state.json 去重 + 2 小时清理 + 原子写入
│  ├─ warframe/
│  │  ├─ provider.ts              # FissureProvider 抽象 + auto fallback
│  │  ├─ official-provider.ts     # DE WorldState + warframe-worldstate-parser
│  │  ├─ warframestat-provider.ts # WarframeStat.us（备用）
│  │  ├─ schema.ts  mapping.ts    # zod 校验 + 归一化（unknown 不猜测）
│  │  ├─ http.ts  proxy.ts        # 内置超时 + 可选 undici ProxyAgent
│  │  └─ defaults.ts
│  └─ scripts/{check,test-notification}.ts
└─ tests/                         # 171 个用例（含最小 WorldState fixture 与部署脚本守护/行为测试）
   └─ fixtures/worldstate.fissures.json
```

---

## 8. 测试覆盖

`npm test`（171 个用例，全部离线、不需要真实 .env / NapCat / QQ / Warframe API / 代理 / 计划任务）：

- 匹配规则：5 个条件的正例与各种反例（含 `isHard`/`isStorm` 为 unknown 时不匹配）
- **Official provider**：从保存的最小 WorldState fixture 解析、`Hard=true → isHard=true`、`ActiveMissionTier → isStorm=true`、普通裂缝 `isStorm=false`、请求失败 / HTTP 500 / HTML 拦截 / 缺少字段 / 单条脏数据只跳过该条
- **auto fallback**：official 成功时不请求备用源；official 失败时回退并告警；两者都失败时抛出聚合错误且**不给 QQ 发任何消息**
- **WarframeStat**：`missionTypeKey ?? missionKey ?? missionType`、unknown 保持 null、403 / 非法 JSON / 脏数据
- 中文展示层：Ani→阿尼、Mot→默特、未知节点回退英文、tier 映射、节点/星系可靠拆分
- QQ 文案：包含 `默特（Mot）/虚空（Void）/生存（Survival）/钢铁之路（Steel Path）/后纪（Axi）`，**不含 tierNum**，多裂缝合并
- 去重：发送成功才记录、失败下一轮重试、重启加载后不重复、2 小时清理
- **单实例锁**：存活 PID 拒绝第二实例、stale lock 自愈、损坏锁文件自愈、release 不删他人锁
- **心跳**：间隔控制与内容，反复触发心跳**绝不调用 NapCat**
- **代理隔离**：启用代理时 Warframe 请求带 dispatcher、NapCat 请求绝无 dispatcher；日志与配置描述不含代理凭据
- 长期运行：顺序轮询不重叠、单轮异常不终止循环
- **计划任务脚本静态守护**（`tests/scheduled-task-scripts.test.ts`，15 个用例）：四个脚本同名任务、
  原生 `PT60S` 延迟（禁止 sleep/timeout 模拟）、`IgnoreNew`、`PT0S` 无限执行时限、`PT1M×3` 失败重启、
  电池/空闲/网络策略、当前用户 + `Interactive` + `Limited`（禁止 SYSTEM / 密码）、action 指向
  `run-monitor.cmd` 且工作目录为项目根、status 只读且必须走身份校验、uninstall 默认不强杀且不删文件、
  **`Stop-Process` 只允许出现在「身份未通过就 return」与「默认不 kill 就 return」两个 guard 之后**、
  无硬编码用户路径与凭据、UTF-8 with BOM + CRLF
- **进程身份校验行为测试**（`tests/monitor-identity-logic.test.ts`，4 组共 26 个用例）：
  真实执行 PowerShell 并 dot-source `scheduled-task-common.ps1`，直接验证判断逻辑 ——
  只认 `node`/`node.exe`（拒绝 `notepad.exe`、`explorer.exe`、`nodejs-helper.exe`）；
  命令行必须指向本项目 `dist\index.js`（覆盖绝对/相对写法、`/` 与 `\`、大小写、空格与引号；
  拒绝 `dist\index.js.bak`、别的项目的 `dist\index.js` 与无关进程）；
  启动时间必须与 `lock.startedAt` 一致（±9 秒通过、±11 秒与明显不同则拒绝、无法解析也拒绝）
- **`run-monitor.cmd` 守护**（`tests/run-monitor-cmd.test.ts`，10 个用例）：ASCII-only / CRLF / 无 `%DATE%`、`%TIME%` / 无绝对路径 / 无凭据

---

## 9. 继续集成（GitHub Actions）

`.github/workflows/ci.yml` 在 push / pull_request 时执行 `npm ci` → `npm run typecheck` → `npm test` → `npm run build`。
CI **不读取真实 `.env`，不需要 `TARGET_QQ` / `NAPCAT_TOKEN`，不调用真实 NapCat，不依赖实时 Warframe API 与代理**。

---

## 10. 故障排查

| 现象 | 处理 |
|------|------|
| `official WorldState 请求失败` | 先按第 2 节用 `curl.exe` 验证能否直连。若确实不通：改 `WARFRAME_SOURCE=auto`（会回退 WarframeStat.us），或设置 `WARFRAME_PROXY_URL`（只影响 Warframe 请求）。 |
| `HTTP 403 Forbidden`（仅 WarframeStat.us） | 该站点在部分网络被 Cloudflare 拦截，属正常现象；保持默认 `official` 即可。 |
| `已有监控实例正在运行（pid=...）` | 已有实例在跑（任务计划程序或另一个窗口）。确认后停止旧实例；若确认进程已死，重新启动会自动清理 stale lock。 |
| `NapCat 发送失败: status=failed, retcode=...` | 检查 NapCat HTTP 服务是否启用、端口/token 是否与 `.env` 一致、`TARGET_QQ` 是否为机器人好友。失败不会写状态，下一轮会自动重试。 |
| `ConfigError: 缺少 TARGET_QQ` | `.env` 未填 `TARGET_QQ`（`npm run check` 不需要，`npm start` / `npm run test:notification` 需要）。 |
| 收不到通知但 `check` 显示有匹配 | 看 `data/state.json` 是否已记录该裂缝，或 `DRY_RUN=true`。 |
| 想先观察不发送 | `$env:DRY_RUN='true'; npm start`（日志会打印本应发送的完整消息）。 |
| 日志文件在哪 | `logs\monitor.log`（用 `scripts\run-monitor.cmd` 启动时）；前台运行则直接输出到控制台。 |
| 运行 `scripts\run-monitor.cmd` 报 `'嬪簭璋冪敤锛?rem' 不是内部或外部命令` 之类乱码 | 说明批处理文件里被写入了非 ASCII 字符。`run-monitor.cmd` 必须保持 ASCII-only + CRLF，不要添加中文注释/echo；先跑 `npm test`（`tests/run-monitor-cmd.test.ts` 会指出问题）。 |
| 任务 State 显示 `Running`，但日志不再更新 | 用 `status-scheduled-task.ps1` 看 `data\monitor.lock` 的 PID 是否存活。若 Monitor 已死而任务仍显示 Running，重启任务：`Stop-ScheduledTask -TaskName "Warframe Fissure Monitor"; Start-ScheduledTask -TaskName "Warframe Fissure Monitor"`。 |
| 任务 `LastTaskResult` = `2147946720`（0x800710E0） | 正常现象：任务已在运行，多实例策略 `IgnoreNew` 拒绝了这次启动（不会产生第二个 Monitor）。 |
| 卸载后 Monitor 仍在运行 / `npm start` 提示已有实例 | 见 5.6：`Stop-ScheduledTask` 不会结束 `node` 子进程。用 `uninstall-scheduled-task.ps1 -StopMonitorProcess`，或按 `data\monitor.lock` 里的 PID 手工 `Stop-Process -Id <PID>`。 |
| `uninstall -StopMonitorProcess` 输出 `拒绝结束 PID ...` 并返回 1 | 这是**保护机制**：该 PID 存在但无法确认属于本项目（进程名不是 node / 命令行不指向本项目 `dist\index.js` / 启动时间与 `lock.startedAt` 差超过 10 秒），可能是 Windows 把 PID 重用了。脚本不会杀它；用任务管理器按 PID 核对命令行，确认后再自行处理。 |
| `status` 显示 `suspicious / unverified` | 同上。若确认本项目的 Monitor 其实没在运行，可以删除 `data\monitor.lock`（仅当你确定没有 Monitor 在跑），下次启动会重新生成。 |
| 登录后任务没有自动启动 | 确认任务 State 为 `Ready` 且触发器用户是当前用户（`status-scheduled-task.ps1`）；`StartWhenAvailable` 会在条件恢复后补启动。也可以手工 `Start-ScheduledTask` 立即验证。 |
| 计划任务里 `node` 找不到 / 立即失败 | 计划任务使用登录用户的环境变量。`install-scheduled-task.ps1` 会打印它解析到的 `node.exe` 路径；请确认该路径来自持久化的用户/系统 PATH（脚本不会修改 PATH）。 |
| 改了 `.env` 后想马上生效 | 重启任务：`Stop-ScheduledTask -TaskName "Warframe Fissure Monitor"; Start-ScheduledTask -TaskName "Warframe Fissure Monitor"`，然后用 `-StopMonitorProcess` 或 `Stop-Process` 结束可能残留的旧 Monitor。 |
| 接口字段变了 | 解析层已做兼容（`missionTypeKey ?? missionKey ?? missionType`、`nodeKey ?? node`、unknown 保持 null），单条脏数据只跳过该条并记 `warn` 日志。 |
