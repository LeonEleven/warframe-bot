# warframe-fissure-monitor

监控 **Warframe 国际服 PC** 的当前虚空裂缝，当出现符合条件的裂缝时，通过本机 **NapCatQQ（OneBot 11 HTTP API）** 给指定 QQ 私聊发送一条通知（带持久化去重）。

## 通知条件（必须同时满足）

| # | 条件 | 说明 |
|---|------|------|
| 1 | `isHard === true` | 钢铁之路（Steel Path） |
| 2 | `isStorm === false` | 非虚空风暴（Void Storm） |
| 3 | `missionType === "Survival"` | 生存任务 |
| 4 | 节点名以 `(Void)` 结尾 | 虚空节点，**动态判断，不硬编码 Ani / Mot** |
| 5 | `expiry > 当前时间` | 尚未过期 |

命中后按 `fissure.id` 去重：**同一个裂缝只会通知一次**，程序重启也不会重复通知（状态保存在 `data/state.json`）。
一轮检查发现多个新裂缝时，会**合并成一条 QQ 消息**发送。

数据源：`GET https://api.warframestat.us/pc/fissures`（可用 `WARFRAME_API_URL` 覆盖）。

字段兼容处理（API 轻微变化不影响运行）：

```
missionType = fissure.missionTypeKey ?? fissure.missionType
node        = fissure.nodeKey        ?? fissure.node
```

---

## 1. Windows 安装

### 1.1 环境要求

- **Node.js ≥ 20.12**（用到了 `process.loadEnvFile`；推荐 20.19+ / 22 LTS / 24）。本项目在 **Node 24.21.0 + npm 11.19.0** 上开发与验证。
- 本机已安装并登录 **NapCatQQ**（或其它兼容 OneBot 11 的 QQ 机器人框架）。

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

至少填写 `TARGET_QQ`（接收通知的 QQ 号，纯数字）。若 NapCat 配置了 token，再填写 `NAPCAT_TOKEN`。

> `.env` 已在 `.gitignore` 中，**不会被提交**；仓库里只有不含敏感信息的 `.env.example`。
> 代码中没有硬编码任何 QQ 号或 token。

### 1.4 配置 NapCat

1. 打开 NapCatQQ 的 WebUI → **网络配置** → 新建 **HTTP 服务器**。
2. Host 填 `127.0.0.1`，端口填 `3000`（要和 `.env` 里的 `NAPCAT_BASE_URL` 一致）。
3. 如需鉴权，设置 Token，并把同样的值填到 `.env` 的 `NAPCAT_TOKEN`（程序会发送 `Authorization: Bearer <token>`）。
4. 启用该 HTTP 服务；确保 **TARGET_QQ 是机器人账号的好友**（非好友无法私聊）。

### 1.5 验证

```powershell
npm run check             # 真实拉取裂缝并显示匹配结果，绝不发送 QQ
npm run test:notification # 用假裂缝真实调用 NapCat 发一条测试通知
```

---

## 2. 配置项（全部来自 `.env`）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `WARFRAME_API_URL` | 否 | `https://api.warframestat.us/pc/fissures` | 裂缝数据源 |
| `POLL_INTERVAL_MS` | 否 | `60000` | 轮询间隔（毫秒），允许 5000 ~ 86400000 |
| `NAPCAT_BASE_URL` | 否 | `http://127.0.0.1:3000` | NapCat HTTP 服务地址 |
| `NAPCAT_TOKEN` | 否 | 空 | 留空则不发送 `Authorization` 头 |
| `TARGET_QQ` | **是** | 无 | 接收通知的 QQ 号（5~12 位数字） |
| `DRY_RUN` | 否 | `false` | `true` = 只检测并打印，不发送 QQ 消息，也不写状态 |
| `HTTP_TIMEOUT_MS` | 否 | `10000` | Warframe 请求超时 |
| `NAPCAT_TIMEOUT_MS` | 否 | `15000` | NapCat 请求超时 |
| `STATE_FILE` | 否 | `data/state.json` | 去重状态文件（相对路径基于项目根目录） |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |

布尔值接受 `true/false`、`1/0`、`yes/no`、`on/off`（不区分大小写）。
**进程环境变量优先于 `.env` 文件**，临时覆盖时无需改文件：

```powershell
$env:DRY_RUN='true'; npm start
```

---

## 3. 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 开发模式，`tsx watch` 热重启运行 `src/index.ts` |
| `npm run build` | 用 `tsc` 编译到 `dist/` |
| `npm start` | 运行编译产物 `node dist/index.js`（长期运行用这个） |
| `npm test` | 运行全部单元测试（`node:test` + `tsx`） |
| `npm run typecheck` | 对 `src` 与 `tests` 做 TypeScript 类型检查（不产出文件） |
| `npm run check` | **真实调用** Warframe API，打印当前裂缝与匹配结果，**绝不发送 QQ** |
| `npm run test:notification` | 构造一条假的 `Mot (Void) / Survival / Axi / isHard=true` 裂缝，通过真实 NapCat 给 `TARGET_QQ` 发一条测试通知 |

`npm run check` 与 `npm run test:notification` 都**不会写 `data/state.json`**，因此不会影响真实去重。
`npm run test:notification` 受 `DRY_RUN` 影响：若为 `true`，只打印不发送。

首次上手推荐流程：

```powershell
npm install
Copy-Item .env.example .env      # 填 TARGET_QQ / NAPCAT_TOKEN，先保持 DRY_RUN=true
npm run check                    # 看匹配结果是否正确
npm run test:notification        # 确认 NapCat 通路
# 把 .env 里 DRY_RUN 改成 false
npm start                        # 正式开始监控（或 npm run build 后 node dist/index.js）
```

---

## 4. 长期运行（Windows）

### 方式 A：任务计划程序（推荐）

1. `npm run build` 生成 `dist/`。
2. 任务计划程序 → 创建任务：
   - 触发器：**登录时**（或开机时）
   - 操作：程序 `node`，参数 `dist\index.js`，起始于 `...\warframe-fissure-monitor`
   - 设置：勾选"如果任务失败，按以下频率重新启动"
3. 或用一个批处理包装（保留日志）：

```bat
@echo off
cd /d C:\Users\lvsy\Documents\Projects\warframe-bot\warframe-fissure-monitor
node dist\index.js >> logs\monitor.log 2>&1
```

### 方式 B：pm2

```powershell
npm install -g pm2
pm2 start dist/index.js --name warframe-fissure
pm2 save
pm2 logs warframe-fissure
```

停止：`Ctrl+C`（前台）/ `pm2 stop warframe-fissure`。程序会捕获 `SIGINT` / `SIGTERM`，在当前轮检查结束后优雅退出。

### 运行状态

- 每轮检查间隔 60 秒（可配）：**上一轮检查完成后才开始计时**，内部不使用 `setInterval`，不会出现任务重叠。
- Warframe 接口失败只记录错误日志并跳过本轮，**不会因为接口错误给 QQ 发消息**，下一轮自动重试。
- NapCat 发送失败时**不写入**已通知状态，下一轮会重新尝试。

---

## 5. 去重状态 `data/state.json`

```json
{
  "version": 1,
  "notified": {
    "66c1f0f0a1b2c3d4e5f60718": {
      "id": "66c1f0f0a1b2c3d4e5f60718",
      "expiry": "2026-09-21T01:24:41.000Z",
      "notifiedAt": "2026-09-21T00:59:48.623Z"
    }
  }
}
```

- 写入时机：**仅当 NapCat 返回 `status === "ok"` 且 `retcode === 0`** 之后。
- 写入方式：先写 `state.json.tmp` 再 `rename`，避免断电/崩溃产生半截文件。
- 加载行为：文件不存在 → 空状态；文件损坏（JSON 或结构非法）→ 备份为 `state.json.corrupt-<时间戳>.bak` 后从空状态开始。
- 清理：每轮开始时删除 `expiry` 早于「当前时间 − 2 小时」的历史 ID。
- 想重新通知历史裂缝：停止程序后删除 `data/state.json`（或删掉对应 ID）。

---

## 6. 项目结构

```
warframe-fissure-monitor/
├─ .env / .env.example / .gitignore
├─ package.json / tsconfig.json / tsconfig.test.json
├─ data/state.json                 # 运行时生成（已 gitignore）
├─ src/
│  ├─ index.ts                     # 入口：装配依赖 + 优雅退出
│  ├─ config.ts                    # .env 加载 + zod 校验（不硬编码敏感信息）
│  ├─ logger.ts                    # 结构化日志
│  ├─ types.ts                     # Fissure 领域模型
│  ├─ filter.ts                    # 匹配规则（纯函数，易测）
│  ├─ poller.ts                    # 单轮：拉取 → 匹配 → 去重 → 发送 → 记录
│  ├─ runner.ts                    # 顺序主循环（上一轮结束后再等待）
│  ├─ state/store.ts               # state.json 持久化去重 + 2 小时清理
│  ├─ notify/
│  │  ├─ napcat.ts                 # OneBot 11 /send_private_msg 客户端
│  │  └─ message.ts                # 通知文案（节点/tier/Steel Path/剩余时间）
│  ├─ warframe/
│  │  ├─ client.ts                 # 内置 fetch + 超时
│  │  └─ schema.ts                 # zod 校验 + 字段兼容归一化
│  └─ scripts/
│     ├─ check.ts                  # npm run check
│     └─ test-notification.ts      # npm run test:notification
└─ tests/                          # node:test 单元测试
   ├─ filter.test.ts  ├─ schema.test.ts   ├─ config.test.ts
   ├─ state.test.ts   ├─ napcat.test.ts   ├─ message.test.ts
   ├─ poller.test.ts  ├─ runner.test.ts   └─ helpers.ts
```

---

## 7. 测试覆盖

`npm test` 覆盖以下场景（共 66 个用例）：

- 普通 Survival（非 Steel Path）**不匹配**
- Steel Path 非 Survival **不匹配**
- Steel Path Survival 但**非 Void 节点不匹配**
- Void Survival 但**非 Steel Path 不匹配**
- Steel Path + Void + Survival **正确匹配**（含大小写/空格容错、`expiry` 边界）
- 已通知的 fissure **不重复通知**（同轮、跨轮）
- **程序重启加载 `state.json` 后仍然不重复通知**
- **NapCat 发送失败时不得写入已通知状态**，且下一轮允许重试
- 只有 `status === "ok"` 且 `retcode === 0` 才算成功（HTTP 500 / 非法 JSON / 缺字段 / 网络异常均判失败）
- Warframe 请求失败时只记日志、绝不发 QQ 消息
- 一轮多个新裂缝**合并为一条消息**
- `DRY_RUN` 不发送、不写状态
- 过期 ≥ 2 小时的历史 ID 被清理并持久化
- 主循环**顺序执行、不重叠**，单轮异常不会终止循环

---

## 8. 故障排查

| 现象 | 处理 |
|------|------|
| `npm run check` 报 `HTTP 403 Forbidden` | 数据源被 Cloudflare 拦截（常见于部分网络/地区，与代码无关）。换网络或走代理：`$env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:7890'; npm run check`（Node 24 支持 `--use-env-proxy`）；也可把 `WARFRAME_API_URL` 指向自建镜像。程序会记录错误并自动重试，不会误发 QQ。 |
| `NapCat 发送失败: status=failed, retcode=...` | 检查 NapCat HTTP 服务是否启用、端口是否一致；`NAPCAT_TOKEN` 与 NapCat 配置是否相同；`TARGET_QQ` 是否为机器人好友。 |
| `ConfigError: 缺少 TARGET_QQ` | `.env` 里 `TARGET_QQ` 未填写（`npm run check` 不需要，`npm start` / `npm run test:notification` 需要）。 |
| 收不到通知但 `npm run check` 显示有匹配 | 可能是该裂缝已通知过（看 `data/state.json`），或 `DRY_RUN=true`。 |
| 想先观察不发送 | `.env` 设 `DRY_RUN=true`，日志会打印本应发送的完整消息。 |
| 同一裂缝收到两次 | 通常是发送成功但状态文件写入失败（日志会提示）。检查 `data/` 目录写权限。 |
| 接口字段变了 | 解析层已做兼容（`missionTypeKey ?? missionType`、`nodeKey ?? node`），单条脏数据只跳过该条并记 `warn` 日志。 |
