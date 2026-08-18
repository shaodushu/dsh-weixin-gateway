# weixin-dsh-gateway

**微信消息网关：dsh (deepseek-harness) 作为执行层，微信协议层复用腾讯 openclaw-weixin。**

```
微信 ←→ 腾讯 openclaw-weixin 协议层（扫码登录/getUpdates 轮询/sendMessage）
         ↓ 文本消息
      AgentBridge（ctx.agents.create + agent.followup）
         ↓
      dsh agent（DeepSeek-V4-Flash，AI 网关）
         ↓ 回复
      sendMessageWeixin → 微信
```

## 快速开始

| 你是 | 走哪条 |
|---|---|
| **使用者**：只想把微信接入 dsh 当机器人跑 | [使用手册 →](docs/usage.md) 安装 → 登录 → 启动 |
| **开发者**：clone 仓库改代码 / 调试 | [开发文档 →](docs/development.md) 构建 → 测试 → 部署 |

### 使用者 3 步

```bash
npm install -g dsh-weixin-gateway     # 安装
dsh-weixin setup                      # 准备环境（一次性）
dsh-weixin login                      # 扫码登录（自动进入保活）
```

详细步骤、前置条件、常见问题见 **[使用手册](docs/usage.md)**。

### 开发者 3 步

```bash
git clone <repo>
pnpm install && pnpm build             # 构建
pnpm test                              # 单元测试（35 用例）
```

工程细节、管理脚本、launchd 部署见 **[开发文档](docs/development.md)**。

## 关键经验

- **-14 session timeout**：`getUpdates` 长轮询既是拉消息也是**保活心跳**；登录进程退出后 session 被服务端回收。修复：登录成功后**同一进程立即接轮询**。
- **实例互斥**：同一账号同时只能一个网关实例（`dsh-weixin run` 遇冲突自动拦截；`dsh-weixin login` 会停 daemon 让路，登录结束自动交回）。
- **启用 ClawBot 插件**（最容易漏）：微信 → 我 → 设置 → 插件 → 启用 ClawBot；否则网关在跑但收不到任何消息。

更多症状排查与实测踩坑见 **[排障记录 →](docs/troubleshooting.md)**。

## 依赖

- dsh launcher（`@deepseek-ai/dsh`）+ headless profile
- `llm-pi-ai` provider（`~/.dsh/settings.yaml`，对话模型）
- AI 能力凭据：语音转文字/图像理解/文生图/语音合成可**各自独立配置**（`AI_ASR_`/`AI_VISION_`/`AI_IMAGE_`/`AI_TTS_` 三件套），或只配全局 `AI_GATEWAY_BASE_URL`+`AI_GATEWAY_KEY` 共用；`dsh-weixin setup` 可交互引导写入 `~/.openclaw/weixin-dsh/.env`
- 微信凭据：`~/.openclaw/openclaw-weixin/accounts/` + `~/.openclaw/weixin-dsh/accounts-index.json`
