# weixin-dsh-gateway

**微信消息网关：dsh (deepseek-harness) 作为执行层，微信协议层复用腾讯 openclaw-weixin。**

```
微信 ←→ openclaw-weixin 协议层（扫码登录 / getUpdates / sendMessage）
         ↓ 文本消息
      AgentBridge（ctx.agents.create + agent.followup）
         ↓
      dsh agent（DeepSeek-V4-Flash）
         ↓ 回复（聚合/流式）→ 微信
```

## 快速开始

```bash
npx dsh-weixin-gateway@latest quickstart    # 一键：环境准备 + 扫码登录
```

开发者：`git clone <repo>` → `pnpm install && pnpm build` → `pnpm test`

📖 [使用手册](docs/usage.md) · [开发文档](docs/development.md) · [功能清单](docs/features.md) · [排障记录](docs/troubleshooting.md)

## 配套插件

独立 npm 包，随本仓库 `plugins/` 维护：

| 插件 | 用途 | npm |
|---|---|---|
| **dsh-weather-cn** | 中文天气查询工具（Open-Meteo，免 key） | `dsh-weixin-gateway setup` 自动随装 |
| **dsh-settings-remote** | dsh web 设置平面（settings.\*）经域名反向代理可读可写（[独立仓库](https://github.com/shaodushu/dsh-settings-remote)） | `dsh plugin --profile web add dsh-settings-remote` |

## 关键经验

- **-14 session timeout**：getUpdates 长轮询既是拉消息也是**保活心跳**——登录后必须同一进程立即接轮询。
- **实例互斥**：同一账号同时只能一个网关实例；`dsh-weixin run` 冲突自动拦截，`login` 自动让路/交回。
- **ClawBot 插件**（最容易漏）：微信 → 我 → 设置 → 插件 → 启用 ClawBot，否则收不到消息。
- **回复模式（0.5.1+）**：默认聚合（一条成文 + 25s 占位保底）；`DSH_WEIXIN_REPLY_MODE=stream` 回退流式。

## 依赖

- dsh launcher + headless profile；对话模型走 `llm-pi-ai` provider
- AI 能力凭据（ASR/视觉/文生图/TTS）可独立配置（`AI_*_` 前缀）或全局 `AI_GATEWAY_*` 共用，`dsh-weixin setup` 引导写入
- 微信凭据：`~/.openclaw/openclaw-weixin/accounts/` + `~/.openclaw/weixin-dsh/accounts-index.json`
