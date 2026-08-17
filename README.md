# weixin-dsh-gateway

**微信消息网关：dsh (deepseek-harness) 作为执行层，微信协议层复用腾讯 openclaw-weixin。**

```
微信 ←→ 腾讯 openclaw-weixin 协议层（扫码登录/getUpdates 轮询/sendMessage）
         ↓ 文本消息
      AgentBridge（ctx.agents.create + agent.followup）
         ↓
      dsh agent（DeepSeek-V4-Flash，公司网关 ai-platform.xwfintech.com）
         ↓ 回复
      sendMessageWeixin → 微信
```

## 架构

| 模块 | 说明 |
|---|---|
| `src/bridge.ts` | AgentBridge：创建 agent 会话、`followup` 注入消息、聚合回复（与消息来源解耦） |
| `src/runner.ts` | CLI 驱动（`gateway.patch.yml`）：headless 任务的注入闭环演示 |
| `src/weixin/` | 微信协议层（移植自 `Tencent/openclaw-weixin`，MIT）：api / auth / cdn / media / messaging / storage |
| `src/weixin/driver.ts` | 微信驱动：扫码登录 → `notifyStart` → `getUpdates` 长轮询 → 消息→agent→回复 |
| `src/weixin/entry.ts` / `gateway.ts` | 命令行解析（`--weixin-login` / `--weixin-run`）与网关应用插件 |

## 快速开始

```bash
pnpm install && pnpm build

# 1. 扫码登录（登录成功后同一进程自动进入保活轮询）
dsh --profile headless --patch ./weixin.patch.yml --weixin-login

# 2. 已登录账号启动网关（长轮询收消息）
dsh --profile headless --patch ./weixin.patch.yml --weixin-run <accountId>
```

## 关键经验（踩坑记录）

1. **-14 session timeout 的真相**：网关进程的 `getUpdates` 长轮询既是拉消息也是**保活心跳**；登录进程退出后 session 被服务端回收。修复：登录成功后**同一进程立即接轮询**。独立测试请求（curl/node 单发）可能被服务端以并发限制拒绝（-14），**不代表网关状态**——判断网关是否工作要看网关日志，不要用独立请求测试。
2. **重复扫码顶掉旧会话**：每次扫码登录创建新 bot（`xxx@im.bot`），旧会话立即失效。重新登录前删除旧账号文件。
3. **`notifyStart` 是启动顺序的一部分**：原版 channel 启动时先 `notifyStart` 再轮询。
4. **`ilink_appid: "bot"` 必须**在 package.json（`readPackageJsonFromDir` 向上查找）。
5. 微信端 ClawBot 插件需要启用（`我 → 设置 → 插件`），否则消息不路由。

## 开发状态

- ✅ 文本消息收发闭环（端到端验证通过：微信 → dsh agent → 微信回复）
- 🔜 媒体消息（图片/语音，协议层已移植，驱动未接）
- 🔜 流式渐进回复（`reply-progress-sender` 已移植，未接入）
- ⚠️ dsh 为 0.1.0-rc 预发布，接口可能破坏性变更

## 依赖

- dsh 环境：`@deepseek-ai/dsh`（launcher）+ `~/.dsh/profiles/headless`（profile）
- 模型：`llm-pi-ai` provider（`~/.dsh/settings.yaml`，公司网关）
- 微信凭据：`~/.openclaw/openclaw-weixin/accounts/*.json` + `~/.openclaw/weixin-dsh/accounts-index.json`
