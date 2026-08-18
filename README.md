# weixin-dsh-gateway

**微信消息网关：dsh (deepseek-harness) 作为执行层，微信协议层复用腾讯 openclaw-weixin。**

```
微信 ←→ 腾讯 openclaw-weixin 协议层（扫码登录/getUpdates 轮询/sendMessage）
         ↓ 文本消息
      AgentBridge（ctx.agents.create + agent.followup）
         ↓
      dsh agent（DeepSeek-V4-Flash，公司内部 AI 网关）
         ↓ 回复
      sendMessageWeixin → 微信
```

## 谁用哪条路

| 你是 | 走哪条 | 说明 |
|---|---|---|
| **使用者**：只想把微信接入 dsh 当机器人用 | [一、安装 npm 包](#一-使用者从零安装) | 无需 clone 仓库；`dsh-weixin-gateway` 包内自带命令 |
| **开发者**：clone 仓库改代码 / 调试 / 部署服务 | [二、仓库内开发](#二-开发者仓库内开发) | 用 `scripts/` 管理脚本，需要本地构建 |

两者共用扫码登录、会话路由与踩坑经验，见文末。

---

## 一、使用者：从零安装

> 本项目是 dsh（deepseek-harness）的**插件**，不是独立 CLI：不能 `npx dsh-weixin-gateway` 单独运行，必须由 dsh launcher 作为宿主加载。装进 profile 后即随 profile 自动生效，**无需每次 `--patch`**。

### 前置条件（必须全部满足）

1. **Node.js**（dsh 运行环境）
2. **模型 provider**：在 `~/.dsh/settings.yaml` 配置 `llm-pi-ai`（公司网关）
3. **微信端启用 ClawBot 插件（最容易漏）**：微信 → 我 → 设置 → 插件 → 启用 ClawBot；不启用则消息不会路由到网关，表现为"网关在跑但收不到任何消息"
4. **（媒体 AI 功能）公司 AI 网关凭据**：环境变量 `COMPANY_AI_BASE_URL` 与 `COMPANY_AI_KEY`（或包安装根目录的 `.env`），两者缺一即报错提示。未配置时图片视觉描述 / 语音转文字 / 文生图 / TTS 静默降级，收发消息不受影响

### 0. 安装 dsh-weixin 并准备环境（一次性）

```bash
# 1) 安装插件（自带 dsh-weixin 引导命令）
npm install -g dsh-weixin-gateway

# 2) 一键准备环境：检测/装 dsh → 创建 headless profile → 安装插件 → 验证
dsh-weixin setup
```

`setup` 幂等，环境已就绪时重跑只是复查。它会提示最后两步手动项：配置模型 provider、微信端启用 ClawBot 插件。

> 不装 bin 时的等价手动方式（可选）：
> ```bash
> npm install -g @deepseek-ai/dsh
> dsh plugin --profile headless add dsh-weixin-gateway@<版本号>   # 只装 dsh-weixin-gateway
> ```
>
> 注意：**不要** `add @deepseek-ai/dsh-headless`——它是 dsh 自带的 in-box bundle，
> 显式 add 会触发 pnpm 解析其依赖的私有包 `@deepseek-ai/dsh-code-runtime-worker`
> （公共 registry 不存在）而失败。版本号建议显式指定，否则 pnpm 的 minor 范围
> / minimumReleaseAge 可能装到旧版。

### 1. 扫码登录

```bash
dsh-weixin login
```

（等价：`dsh --profile headless --weixin-login`）

终端显示 ASCII 二维码，手机微信扫码（需要配对码时按提示在终端输入手机显示的数字）。

登录成功后：

- 凭据落盘 `~/.openclaw/openclaw-weixin/accounts/<账号id>.json`
- **同一进程自动进入网关轮询（保活）**。此时不要 Ctrl+C——登录进程退出后服务端会回收会话（-14），需重新扫码。

### 2. 启动网关（常驻收消息 → dsh 回复）

```bash
dsh-weixin run
```

（等价：`dsh --profile headless --weixin-run`）

- **不带参数**：自动使用第一个已登录账号（推荐）。
- **指定账号**：`--weixin-run <accountId>`。
- 账号 id 从哪来：扫码登录成功的输出会打印 `✅ 微信登录成功，账号: <id>`；也可查看 `~/.openclaw/weixin-dsh/accounts-index.json`。

启动后网关会 `getUpdates` 长轮询收消息，消息交给 dsh agent 回复并实时发回微信。

### 换账号 / 重新扫码

网关检测到 token 失效（getUpdates 返回 -14）连续 3 次会打印醒目报警和重新扫码指引。手动换账号：

1. 停掉正在跑的网关进程（Ctrl+C）。
2. 重新扫码：`dsh-weixin login`（新凭据落盘）。
3. 再启动：`dsh-weixin run`。

> 每次扫码登录会创建新 bot（`xxx@im.bot`），旧账号立即失效；如需清理，删除 `~/.openclaw/openclaw-weixin/accounts/` 下旧账号文件即可。

### 关于服务常驻

npm 包只包含 `lib/`（编译产物）和 `cordis.patch.yml` / `test.patch.yml`，**不含** `scripts/` 管理脚本和 launchd 配置。需要开机自启、崩溃自动重启时：

- 从本仓库拷贝 `scripts/weixin-gateway.sh`、`scripts/weixin-gateway-daemon.sh`、`docs/launchd/com.weixin-dsh.gateway.plist`；
- 把 daemon 脚本顶部的 `DSH` / `PATCH` / `ACCOUNT` / `MODE` 变量改成你的本机值（见[开发者路径](#二-开发者仓库内开发)）。

### 实例互斥（同一账号只能一个网关）

同一账号同一时刻**只能有一个网关实例**——`getupdates` 长轮询既是收消息也是会话保活心跳，两个实例同时轮询会互相顶掉对方会话（`-14 session timeout`，重新扫码也无效）。网关启动（`run` / `login` 保活）时会对账号取互斥锁（`~/.openclaw/weixin-dsh/run-<accountId>.lock`）：

- **冲突**：`run` 遇已有实例时立即报错退出，提示停掉旧实例（前台实例 Ctrl+C；launchd 守护 `./scripts/weixin-gateway.sh stop`）；
- **`login` 例外**：登录 = 主动换会话，`dsh-weixin login` 会自动停掉 launchd 守护释放锁（停不掉的才是前台实例，需要手动 Ctrl+C），登录结束后自动交回 daemon 常驻；
- **后台守护**：launchd daemon 检测到前台实例持锁时退避 60s 重试，待其退出后自动接管；
- **残留恢复**：实例崩溃（kill -9 / OOM）留下的锁会在下次启动时自动识别并覆盖，无需手工清理。

典型用法二选一，不要同时开：

```bash
# 方式一：后台常驻（推荐，开机自启 + 崩溃重启）
./scripts/weixin-gateway.sh start

# 方式二：前台占一个终端
dsh-weixin run
```

---

## 二、开发者：仓库内开发

### 构建

```bash
pnpm install && pnpm build
```

### 单元测试

```bash
pnpm test        # vitest（实例互斥锁等纯逻辑，不依赖微信/网络）
```

发布前跑 `./scripts/test-publish.sh`（单测 → 构建 → 打包 → 隔离安装 → bin → 会话路由 → setup 链路）。

### 管理脚本（`scripts/weixin-gateway.sh`）

仓库内日常操作统一走这个脚本：

```bash
./scripts/weixin-gateway.sh login            # 扫码登录（等价 dsh --weixin-login，登录后自动进保活轮询）
./scripts/weixin-gateway.sh relogin          # 一步重登：停 daemon → 扫码 → Ctrl+C 后自动交回 daemon
./scripts/weixin-gateway.sh start            # 启动 launchd 服务（登录自启 + 崩溃重启）
./scripts/weixin-gateway.sh stop             # 停止服务
./scripts/weixin-gateway.sh restart          # 重启
./scripts/weixin-gateway.sh status           # 状态（守护/网关 pid）
./scripts/weixin-gateway.sh logs 50          # 最近日志
./scripts/weixin-gateway.sh test per-user    # 会话路由测试（断言隔离）
./scripts/weixin-gateway.sh test room        # 会话路由测试（断言共享）
./scripts/weixin-gateway.sh demo "你好"      # 命令行注入闭环演示
```

> **会话失效（-14）后恢复**：直接 `dsh-weixin login` 一条命令——自动停掉后台守护释放锁、出二维码扫码，Ctrl+C 后自动交回 daemon 常驻，全程不用手动启停。仓库内也可以用 `./scripts/weixin-gateway.sh relogin`（等价流程）。

- 架构：launchd → `scripts/weixin-gateway-daemon.sh`（while 循环守护，崩溃 5s 自动拉起）→ dsh 网关。
- **换机器必改**：`weixin-gateway-daemon.sh` 顶部 `DSH` / `PATCH` / `ACCOUNT` / `MODE`、`docs/launchd/com.weixin-dsh.gateway.plist` 里的 daemon 脚本绝对路径，目前硬编码了作者本机值。
- 会话模式：改 daemon 脚本里 `MODE=room|per-user` 后 restart。
- launchd 日志：`~/.openclaw/weixin-dsh/launchd.{out,err}.log`；管理命令 `launchctl kickstart|bootout gui/$(id -u)/com.weixin-dsh.gateway`。

---

## 会话模式（room / per-user）

| 模式 | 行为 | 适合 |
|---|---|---|
| `room`（默认） | 所有微信用户共享一个 agent 会话，上下文互通 | 单机器人公共号 |
| `per-user` | 每个微信用户独立会话，完全隔离 | 多用户各自上下文 |

命令行：`--session-mode per-user|room`（与 `--weixin-run` 同用）。会话跨进程/重启自动恢复（dsh-base 内置 JSONL 后端，`~/.dsh/sessions/`）。

## 架构

| 模块 | 说明 |
|---|---|
| `src/bridge.ts` | AgentBridge：创建 agent 会话、`followup` 注入消息、聚合回复（与消息来源解耦） |
| `src/runner.ts` | CLI 驱动（`gateway.patch.yml`）：headless 任务的注入闭环演示 |
| `src/weixin/` | 微信协议层（移植自 `Tencent/openclaw-weixin`，MIT）：api / auth / cdn / media / messaging / storage |
| `src/weixin/driver.ts` | 微信驱动：扫码登录 → `notifyStart` → `getUpdates` 长轮询 → 消息→agent→回复 |
| `src/weixin/entry.ts` / `gateway.ts` | 命令行解析（`--weixin-login` / `--weixin-run`）与网关应用插件 |

## 关键经验（踩坑记录）

1. **-14 session timeout 的真相**：网关进程的 `getUpdates` 长轮询既是拉消息也是**保活心跳**；登录进程退出后 session 被服务端回收。修复：登录成功后**同一进程立即接轮询**。独立测试请求（curl/node 单发）可能被服务端以并发限制拒绝（-14），**不代表网关状态**——判断网关是否工作要看网关日志，不要用独立请求测试。
2. **`notifyStart` 是启动顺序的一部分**：原版 channel 启动时先 `notifyStart` 再轮询。
3. **`ilink_appid: "bot"` 必须**在 package.json（`readPackageJsonFromDir` 向上查找）。
4. **流式发送勿双重发送**：`WeixinStreamingSender.flush()` 曾同时 queueSend 尾文、又把尾文放进返回的 `textParts`，调用方再发一次 → 每条回复重复（实测"问时间回两条"）。修复：尾文只由调用方统一发一次（flush 只返回不发送）。

## 开发状态

- 文本消息收发闭环（微信 → dsh agent → 微信回复）：已完成
- 媒体消息：已完成。入站（图片 AI 视觉描述 / 语音转文字 / 文件 / 视频）+ 出站（`[image:]` `[video:]` `[file:]` 标记按 MIME 路由发送，图片/文件已实测）
- 流式渐进回复（回复分段实时发送，markdown 安全分片 + 标记剥离）：已完成
- 限制：语音条回复不支持——官方协议不渲染（Issue #78/#254 实测），`[tts:]` 文本并入文字回复
- 注意：dsh 为 0.1.0-rc 预发布，接口可能破坏性变更

## 依赖

- dsh 环境：`@deepseek-ai/dsh`（launcher）+ `~/.dsh/profiles/headless`（profile）
- 模型：`llm-pi-ai` provider（`~/.dsh/settings.yaml`，公司网关）
- 媒体 AI 增强：`COMPANY_AI_BASE_URL` + `COMPANY_AI_KEY`（环境变量或包安装根目录 `.env`，公司网关，两者必填）
- 微信凭据：`~/.openclaw/openclaw-weixin/accounts/*.json` + `~/.openclaw/weixin-dsh/accounts-index.json`
