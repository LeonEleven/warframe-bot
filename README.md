# warframe-bot

Warframe 相关小工具的集合，主要用于在 Windows 本地长期运行。

## 包含的项目

| 目录 | 说明 |
|------|------|
| [`warframe-fissure-monitor`](./warframe-fissure-monitor) | 监控 Warframe 国际服 PC 的虚空裂缝，默认直接使用 Digital Extremes 官方 WorldState（`api.warframe.com/cdn/worldState.php` + `warframe-worldstate-parser`，无需代理），命中「Steel Path + Survival + Void + 未过期」时通过本机 NapCatQQ（OneBot 11 HTTP API）私聊发送中文通知，带持久化去重、单实例保护与心跳日志。 |

## 快速开始

```powershell
cd warframe-fissure-monitor
npm install
Copy-Item .env.example .env      # 填写 TARGET_QQ（一般无需代理）
npm run check                     # 真实读取官方 WorldState（不发送 QQ）
npm run test:notification         # 验证 NapCat 通路
npm run build; npm start
```

完整的安装、配置、长期运行与排查说明见 [warframe-fissure-monitor/README.md](./warframe-fissure-monitor/README.md)。

## 关于敏感信息

- 各子项目自带 `.gitignore`，根目录也有一份；本仓库**不包含任何 token、QQ 号等敏感信息**。
- 本地 `.env`、`data/`（去重状态）、`node_modules/`、`dist/` 均已被忽略。
