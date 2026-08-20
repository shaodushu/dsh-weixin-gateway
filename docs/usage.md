# 使用手册（dsh-weixin 完整指南）

> 面向**使用者**：只想把微信接入 dsh 当机器人跑。快速上手看 README，完整细节看这里。

## 前置条件（必须全部满足）

1. **Node.js**（dsh 运行环境）
2. **模型 provider**：在 `~/.dsh/settings.yaml` 配置 `llm-pi-ai`（AI 网关）
3. **微信端启用 ClawBot 插件（最容易漏）**：微信 → 我 → 设置 → 插件 → 启用 ClawBot；不启用则消息不会路由到网关，表现为"网关在跑但收不到任何消息"
4. **（媒体 AI 功能）AI 能力凭据**：语音转文字 / 图像理解 / 文生图 / 语音合成**每个能力可独立配置**（各自的端点+密钥+模型，见文末[凭据表](#依赖与凭据位置)），也可只配全局一组 `AI_GATEWAY_BASE_URL` + `AI_GATEWAY_KEY` 让 4 个能力共用。未配置的能力静默降级，收发消息不受影响。**`dsh-weixin setup` 会交互式引导逐项配置并写入 `~/.openclaw/weixin-dsh/.env`，无需手动编辑**。

## 0. 安装 dsh-weixin 并准备环境（一次性）

```bash
# 1) 安装插件（自带 dsh-weixin 引导命令）
npm install -g dsh-weixin-gateway

# 2) 一键准备环境：检测/装 dsh → 创建 headless profile → 安装插件 → 验证
dsh-weixin setup
```

`setup` 幂等，环境已就绪时重跑只是复查。它包含两段**交互式配置引导**（终端下问答）：

- **AI 能力**（语音转文字 / 图像理解 / 文生图 / 语音合成）：逐能力问答。已配置的显示当前值，回车保持 / `r` 重配 / `x` 清除；未配置的问网关地址（回车跳过）、密钥（必填）、模型（回车用默认）。结果写入固定位置 `~/.openclaw/weixin-dsh/.env`（所有运行模式共用，保留原有内容）。
- **对话模型 provider**：问答 provider 名 / API 风格 / 网关地址（必填）/ 模型 id / API 密钥（默认复用 `AI_GATEWAY_KEY`）。结果写入 `~/.dsh/settings.yaml`（`llm-pi-ai` + `agent-default-model`）与 `~/.dsh/.credentials.yaml`（`COMPANY_API_KEY`）。已配置时回车保持 / `r` 重配 / `x` 清除。

非交互终端（管道/CI）跳过问答，改为打印手动配置指引。结束时按实际状态提示剩余手动项（对话模型未配置时才会提示配置步骤；微信端启用 ClawBot 插件始终提示）。

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

## 1. 扫码登录

```bash
dsh-weixin login
```

（等价：`dsh --profile headless --weixin-login`）

终端显示 ASCII 二维码，手机微信扫码（需要配对码时按提示在终端输入手机显示的数字）。

登录成功后：

- 凭据落盘 `~/.openclaw/openclaw-weixin/accounts/<账号id>.json`
- **同一进程自动进入网关轮询（保活）**。此时不要 Ctrl+C——登录进程退出后服务端会回收会话（-14），需重新扫码。

## 2. 启动网关（常驻收消息 → dsh 回复）

```bash
dsh-weixin run
```

（等价：`dsh --profile headless --weixin-run`）

- **不带参数**：自动使用**最新登录**的账号（推荐）。
- **指定账号**：`--weixin-run <accountId>`。
- 账号 id 从哪来：扫码登录成功的输出会打印 `✅ 微信登录成功，账号: <id>`；也可查看 `~/.openclaw/weixin-dsh/accounts-index.json`。

启动后网关会 `getUpdates` 长轮询收消息，消息交给 dsh agent 回复并实时发回微信。

## 文生图（画图）行为

收到"帮我画…"类请求时，agent 会调用 `generate_image` 工具（默认模型 gpt-image-2，1024x1024）：

- **先收到占位回复**："好的，正在生成图片，大概需要 1 分钟左右，请稍候～"——生成期间没有文本增量，占位是为避免无反馈干等
- **实际耗时约 1 分钟**（实测 45-143s 波动，取决于图像网关排队），生成后图片连同说明文字一起发出
- **超时保护**：图像 API 单次请求 150s 超时（其余 AI 能力 60s），超时会回复明确错误而非无限等待

## 消息处理超时（两层保护）

单条消息的处理（可能含多轮"LLM 推理 + 工具调用"往返）受两层超时保护，超时会回复"服务开小差了：…"并继续接收下一条消息：

- **空闲超时**（默认 180s）：LLM 推理/工具执行连续 180s 无任何输出时触发——防 AI 网关挂起卡死整个网关。活动事件（文本增量、工具调用等）会刷新计时，多轮工具往返的长时间任务不会误杀
- **整轮超时**（默认 900s / 15 分钟）：单条消息处理的总预算——防 agent 工具循环失控

默认值可用环境变量覆盖（改后重启网关生效）：`OPENCLAW_ASK_IDLE_TIMEOUT_SEC`（空闲）、`OPENCLAW_ASK_TIMEOUT_SEC`（整轮）。

## 回复格式（规整性保障，0.4.0+）

微信**不渲染 markdown**（表格、粗体、代码块等会显示为裸字符）。两层保障：

1. **格式契约**（[AGENTS.md](../AGENTS.md) 自动注入 agent 指令）：回复一律纯文本 + emoji，不用 markdown 语法；常用任务（天气/画图/问答）有固定模板
2. **渲染器兜底**：无论模型输出什么 markdown，网关发送前都会剥离语法标记（表格转纯文本行、粗体/斜体/行内代码/代码块/标题/分隔线/引用全部剥离，内容保留）

另外：
- 流式发送连续失败 ≥3 次时，网关会主动回复"⚠️ 消息发送通道出现异常，回复可能未送达"——不会静默丢回复（0.4.0+）。
- **单词截断保护**（0.4.1+）：流式回复按 80 字符阈值分段发送，当文本末尾以不完整拉丁单词（如 "km" 等待 "/h" 到达）结尾时，会把单词尾巴留在缓存中等待后续内容，防止"km/h"被劈成两段发到微信（实测模型在 "km" 与 "/h" 间停顿 670ms 触发阈值）。中文文本不受影响。

## 换账号 / 重新扫码

网关检测到 token 失效（getUpdates 返回 -14）连续 3 次会打印醒目报警和重新扫码指引。手动换账号：

1. 停掉正在跑的网关进程（Ctrl+C）。
2. 重新扫码：`dsh-weixin login`（新凭据落盘）。
3. 再启动：`dsh-weixin run`。

> -14 的成因与排查见[排障记录](troubleshooting.md)。
> 每次扫码登录会创建新 bot（`xxx@im.bot`），旧账号立即失效；如需清理，删除 `~/.openclaw/openclaw-weixin/accounts/` 下旧账号文件即可。

## 关于服务常驻

npm 包只包含 `lib/`（编译产物）和 `cordis.patch.yml` / `test.patch.yml`，**不含** `scripts/` 管理脚本和 launchd 配置。launchd 常驻服务的启停直接由 CLI 管理，无需拷贝任何文件：

```bash
dsh-weixin start       # 启动后台守护（launchd 常驻，崩溃自动重启）
dsh-weixin stop        # 停止后台守护
dsh-weixin restart     # 重启后台守护
dsh-weixin status      # 查看守护与网关实例状态（谁在跑、哪个账号）
```

需要自定义 daemon 行为（换账号模式 / 改 DSH 路径）时，才从本仓库拷贝 `scripts/weixin-gateway.sh`、`scripts/weixin-gateway-daemon.sh`、`docs/launchd/com.weixin-dsh.gateway.plist` 自行部署（本仓库脚本也提供 start/stop/restart/status）：

- 把 daemon 脚本顶部的 `DSH` / `PATCH` / `MODE` 变量改成你的本机值（见[开发文档](development.md)）。账号不固定：扫码登录会创建新账号（`xxx@im.bot`），daemon 自动取最新已登录账号。

## 实例互斥（同一账号只能一个网关）

同一账号同一时刻**只能有一个网关实例**——`getupdates` 长轮询既是收消息也是会话保活心跳，两个实例同时轮询会互相顶掉对方会话（`-14 session timeout`，重新扫码也无效）。网关启动（`run` / `login` 保活）时会对账号取互斥锁（`~/.openclaw/weixin-dsh/run-<accountId>.lock`）：

- **冲突**：`run` 遇已有实例时立即报错退出，提示停掉旧实例（前台实例 Ctrl+C；后台守护 `dsh-weixin stop`，仓库开发模式也可用 `./scripts/weixin-gateway.sh stop`）；
- **`login` 例外**：登录 = 主动换会话，`dsh-weixin login` 会自动停掉 launchd 守护释放锁（停不掉的才是前台实例，需要手动 Ctrl+C），登录结束后自动交回 daemon 常驻；
- **后台守护**：launchd daemon 检测到前台实例持锁时退避 60s 重试，待其退出后自动接管；
- **残留恢复**：实例崩溃（kill -9 / OOM）留下的锁会在下次启动时自动识别并覆盖，无需手工清理。

典型用法二选一，不要同时开：

```bash
# 方式一：后台常驻（推荐，开机自启 + 崩溃重启）
dsh-weixin start

# 方式二：前台占一个终端
dsh-weixin run
```

## 会话模式（room / per-user）

| 模式 | 行为 | 适合 |
|---|---|---|
| `room`（默认） | 所有微信用户共享一个 agent 会话，上下文互通 | 单机器人公共号 |
| `per-user` | 每个微信用户独立会话，完全隔离 | 多用户各自上下文 |

命令行：`--session-mode per-user|room`（与 `--weixin-run` 同用）。会话跨进程/重启自动恢复（dsh-base 内置 JSONL 后端，`~/.dsh/sessions/`）。

## 依赖与凭据位置

- dsh 环境：`@deepseek-ai/dsh`（launcher）+ `~/.dsh/profiles/headless`（profile）
- 对话模型：`llm-pi-ai` provider（`~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`，AI 网关，anthropic-messages API、baseURL 不带 `/v1`）。`dsh-weixin setup` 引导配置，密钥存在 `.credentials.yaml`（键 `COMPANY_API_KEY`，0600）
- AI 能力凭据（固定位置 `~/.openclaw/weixin-dsh/.env`，所有运行模式共用；或环境变量；**每个能力独立配置**，模型缺省用默认值；也可只配全局一组让全部能力共用）：

| 能力 | 端点变量 | 密钥变量 | 模型变量 | 默认模型 |
|---|---|---|---|---|
| 语音转文字 | `AI_ASR_BASE_URL` | `AI_ASR_KEY` | `AI_ASR_MODEL` | SenseVoiceSmall |
| 图像理解 | `AI_VISION_BASE_URL` | `AI_VISION_KEY` | `AI_VISION_MODEL` | qwen2.5-vl |
| 文生图 | `AI_IMAGE_BASE_URL` | `AI_IMAGE_KEY` | `AI_IMAGE_MODEL` | gpt-image-2 |
| 语音合成 | `AI_TTS_BASE_URL` | `AI_TTS_KEY` | `AI_TTS_MODEL` | IndexTTS-1.5 |

- 全局兜底凭据（能力级未单独配置时共用，模型用各自默认）：`AI_GATEWAY_BASE_URL` + `AI_GATEWAY_KEY`
- 优先级：能力级（端点+密钥齐全）→ 全局 → 未配置（静默降级）；`.env` 里可省略 `MODEL` 行
- 微信凭据：`~/.openclaw/openclaw-weixin/accounts/*.json` + `~/.openclaw/weixin-dsh/accounts-index.json`
