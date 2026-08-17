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

# 3. 会话路由自动化测试（不依赖微信）
dsh --profile headless --patch ./test.patch.yml --session-test per-user
dsh --profile headless --patch ./test.patch.yml --session-test room
```

## 作为 dsh 插件安装（npm）

```bash
# 发布后：
dsh plugin --profile headless add dsh-weixin-gateway   # 或 pnpm --dir ~/.dsh/profiles/headless add dsh-weixin-gateway

# 本地 tarball：
pnpm --dir ~/.dsh/profiles/headless add ./dsh-weixin-gateway-0.1.0.tgz
```

安装后用包内 patch（包名路径解析）：

```bash
dsh --profile headless --patch node_modules/dsh-weixin-gateway/cordis.patch.yml --weixin-login
dsh --profile headless --patch node_modules/dsh-weixin-gateway/cordis.patch.yml --weixin-run --session-mode per-user
dsh --profile headless --patch node_modules/dsh-weixin-gateway/test.patch.yml --session-test room
```

> 注意：`--patch` 路径相对当前目录解析；从 `~/.dsh/profiles/headless` 目录运行可省略前缀。

## 日常使用手册

### 扫码登录（终端 CLI）

新开终端（或本会话用 `!` 前缀）执行，终端显示 ASCII 二维码，手机微信扫码：

```bash
cd ~/Code/weixin-dsh-gateway
./scripts/weixin-gateway.sh login     # 推荐（等价于 dsh --weixin-login）
```

扫码确认后：登录成功 → **同一进程自动进入网关轮询**（保活，终端挂着运行，Ctrl+C 停止）。
> ⚠️ 登录进程退出后 session 会被服务端回收（-14），所以登录后不要关终端（或用 launchd 服务常驻）。

### 服务管理（开机自启 + 崩溃重启）

```bash
./scripts/weixin-gateway.sh start     # 启动 launchd 服务（登录自启）
./scripts/weixin-gateway.sh stop      # 停止
./scripts/weixin-gateway.sh restart   # 重启
./scripts/weixin-gateway.sh status    # 状态（守护/网关 pid）
./scripts/weixin-gateway.sh logs 50   # 最近日志
```

- 架构：launchd → `scripts/weixin-gateway-daemon.sh`（while 循环守护，崩溃 5s 自动拉起）→ dsh 网关
- 会话模式：改 `scripts/weixin-gateway-daemon.sh` 里的 `MODE=room|per-user` 后 restart

### 换账号 / 重新扫码（token 失效时）

```bash
./scripts/weixin-gateway.sh stop      # 停服务
./scripts/weixin-gateway.sh login     # 重新扫码（新凭据落盘）
# Ctrl+C 退出登录进程后：
./scripts/weixin-gateway.sh start     # 服务用新凭据启动
```

token 失效自动检测：网关检测到 -14（session timeout）连续 3 次会打印醒目报警 + 重新扫码指引。

### 多用户会话模式

```bash
# 统一房间（默认）：所有用户共享一个 agent 会话，上下文互通
./scripts/weixin-gateway.sh start     # 改 MODE=room

# 每用户独立：每个微信用户独立会话（隔离）
# 改 scripts/weixin-gateway-daemon.sh 的 MODE=per-user 后 restart
```

会话持久化：跨进程/重启自动恢复（dsh-base 内置 JSONL 后端，`~/.dsh/sessions/`）。

### 自测（不依赖微信）

```bash
./scripts/weixin-gateway.sh test per-user   # 会话路由测试（断言隔离）
./scripts/weixin-gateway.sh test room       # 断言共享
./scripts/weixin-gateway.sh demo "你好"     # 命令行注入闭环演示
```

## 开机自启（macOS LaunchAgent）

`~/Library/LaunchAgents/com.weixin-dsh.gateway.plist`（仓库 `docs/launchd/com.weixin-dsh.gateway.plist` 有副本）：
- `RunAtLoad` 登录自启 + `KeepAlive` 崩溃重启
- 管理：`launchctl kickstart gui/$(id -u)/com.weixin-dsh.gateway` 启动；`launchctl bootout gui/$(id -u)/com.weixin-dsh.gateway` 停止
- 日志：`~/.openclaw/weixin-dsh/launchd.{out,err}.log`
- 会话模式：改 plist 里 `--session-mode`（room / per-user）

## 关键经验（踩坑记录）

1. **-14 session timeout 的真相**：网关进程的 `getUpdates` 长轮询既是拉消息也是**保活心跳**；登录进程退出后 session 被服务端回收。修复：登录成功后**同一进程立即接轮询**。独立测试请求（curl/node 单发）可能被服务端以并发限制拒绝（-14），**不代表网关状态**——判断网关是否工作要看网关日志，不要用独立请求测试。
2. **重复扫码顶掉旧会话**：每次扫码登录创建新 bot（`xxx@im.bot`），旧会话立即失效。重新登录前删除旧账号文件。
3. **`notifyStart` 是启动顺序的一部分**：原版 channel 启动时先 `notifyStart` 再轮询。
4. **`ilink_appid: "bot"` 必须**在 package.json（`readPackageJsonFromDir` 向上查找）。
5. 微信端 ClawBot 插件需要启用（`我 → 设置 → 插件`），否则消息不路由。
6. **流式发送勿双重发送**：`WeixinStreamingSender.flush()` 曾同时 queueSend 尾文、又把尾文放进返回的 `textParts`，调用方再发一次 → 每条回复重复（实测"问时间回两条"）。修复：尾文只由调用方统一发一次（flush 只返回不发送）。

## 开发状态

- ✅ 文本消息收发闭环（端到端验证通过：微信 → dsh agent → 微信回复）
- ✅ 媒体消息：入站（图片 AI 视觉描述 / 语音转文字 / 文件 / 视频）+ 出站（`[image:]` `[video:]` `[file:]` 标记，按 MIME 路由发送；图片/文件已实测）
- ✅ 流式渐进回复：回复分段实时发送（markdown 安全分片 + 标记剥离，`WeixinStreamingSender`）
- ⚠️ 语音条回复不支持：官方协议不渲染（Issue #78/#254 实测），`[tts:]` 文本并入文字回复
- ⚠️ dsh 为 0.1.0-rc 预发布，接口可能破坏性变更

## 依赖

- dsh 环境：`@deepseek-ai/dsh`（launcher）+ `~/.dsh/profiles/headless`（profile）
- 模型：`llm-pi-ai` provider（`~/.dsh/settings.yaml`，公司网关）
- 微信凭据：`~/.openclaw/openclaw-weixin/accounts/*.json` + `~/.openclaw/weixin-dsh/accounts-index.json`
