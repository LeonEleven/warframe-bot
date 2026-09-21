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

## 5. 正式运行

```powershell
npm run typecheck
npm test
npm run build

npm start                       # 手工前台运行
scripts\run-monitor.cmd         # 或用启动脚本（自动写 logs\monitor.log）
```

### Windows 任务计划程序（推荐）

1. 触发器：**用户登录时**，建议延迟 **30~60 秒**（等网络与 NapCat 就绪）。
2. 操作：程序填 `scripts\run-monitor.cmd` 的完整路径，起始于项目根目录。
3. 设置：
   - **如果任务已在运行，则不启动新实例**（配合程序自身的单实例锁双保险）
   - **任务失败后：1 分钟后重新启动**
   - **不要**勾选"运行超过 N 天自动停止"
4. `scripts\run-monitor.cmd` 会自动 `cd` 到项目根目录、创建 `logs\`、把 stdout/stderr 追加写入 `logs\monitor.log`；脚本内**不含任何 QQ 号 / token / 代理密码**（全部来自 `.env`）。

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
├─ scripts/run-monitor.cmd        # 任务计划程序用启动脚本（无敏感信息）
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
└─ tests/                         # 133 个用例（含最小 WorldState fixture）
   └─ fixtures/worldstate.fissures.json
```

---

## 8. 测试覆盖

`npm test`（133 个用例，全部离线、不需要真实 .env / NapCat / QQ / Warframe API / 代理）：

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
| 接口字段变了 | 解析层已做兼容（`missionTypeKey ?? missionKey ?? missionType`、`nodeKey ?? node`、unknown 保持 null），单条脏数据只跳过该条并记 `warn` 日志。 |
