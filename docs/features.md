# 功能清单（已实现 / 待实现）

> 汇总微信网关包含的功能：**已实现**按功能域组织，标注引入版本与关键模块（模块路径相对 `src/`）；
> **待实现**列出代码注释 / 文档已知限制中明确指向的后续项，标注原因与计划方向。
> 使用方式见 [使用手册](usage.md)，工程细节见 [开发文档](development.md)。

## 一、已实现功能

### 1. 安装与引导 CLI（`dsh-weixin`，bin 入口 `src/cli.ts`）

| 功能 | 说明 | 版本 |
|---|---|---|
| `setup` | 一键环境准备：检测/装 dsh → 创建 headless profile → 安装插件 → 验证；幂等可重跑。含两段交互式引导：AI 能力（四项）+ 对话模型 provider；非 TTY 降级为打印手动配置指引，结束时按实际状态提示剩余手动项 | 0.2.0 → 0.3.6 |
| `quickstart` | 合并 setup（跳过 AI 配置问答）+ login，最快看到二维码；AI 配置可稍后 `setup` 补充 | 0.4.2 |
| `login` | 扫码登录（二维码 + 配对码输入）；自动停掉 launchd 守护让路，Ctrl+C/结束后自动交回常驻；内置 SIGINT/SIGHUP 屏蔽 | 0.2.0 |
| `run` | 前台启动网关（`--session-mode room\|per-user`）；启动前实例互斥预检 | 0.2.0 |
| `start` / `stop` / `restart` / `status` | launchd 后台守护管理（常驻 + 崩溃自动重启）；status 显示守护与网关实例（账号、PID） | 0.3.6 |
| `update` | 自动更新：npm view 查最新版 → 全局安装 → 刷新 profile 插件；显式 npmjs registry + `--prefer-online` 规避缓存装旧版 | 0.3.x |
| `push` | 一次性主动推送（见 §6） | 0.5.0 |
| `cron` | 定时任务管理 `add/list/rm`（见 §6） | 0.5.0 |

### 2. 登录与账号管理（`src/weixin/login-qr.ts`、`accounts.ts`、`account-select.ts`、`driver.ts`）

| 功能 | 说明 | 版本 |
|---|---|---|
| 扫码登录 | 轮询二维码状态（wait/scaned/confirmed/expired/need_verifycode 等），配对码输入；凭据落盘 `~/.openclaw/openclaw-weixin/accounts/<id>.json` | 0.1.x |
| 登录后保活 | 登录成功**同一进程立即进入 getUpdates 轮询**（长轮询既是拉消息也是会话保活心跳，进程退出会被服务端回收会话 -14） | 0.1.x |
| 账号索引 | 本地索引 `accounts-index.json`，登录顺序 append；`run` 无参数默认取**最新登录**账号（扫码会创建新 bot，旧账号立即失效） | 0.2.x → 0.3.x |
| 同用户旧账号清理 | 扫码登录成功后自动清除同一微信用户下的旧账号，本地索引仅保留最新账号，防网关误连过期账号空转 | 0.4.3 |
| -14 会话失效检测 | getUpdates 返回 -14 连续 3 次 → 醒目报警 + 5 分钟退避 + 重新扫码指引 | 0.1.x |
| 实例互斥锁 | 账号级 pidfile（`run-lock.ts`）：同一账号同时只能一个网关实例；daemon 冲突时退避 60s 重试；崩溃残留锁自动识别覆盖 | 0.1.x |

### 3. 消息收发与对话（`src/weixin/driver.ts`、`bridge.ts`、`session-router.ts`、`streaming-sender.ts`、`markdown-filter.ts`）

| 功能 | 说明 | 版本 |
|---|---|---|
| 文本消息收发闭环 | getUpdates 长轮询收消息 → AgentBridge 注入 dsh agent → 回复流式发回微信 | 0.1.x |
| 多轮对话 | 一个账号对应常驻 agent 会话（`createGatewayAgent` 只建一次，可多次 `followup`） | 0.1.x |
| 会话模式 | `room`（默认，所有用户共享一个会话）/ `per-user`（每用户独立隔离）；CLI `--session-mode`、daemon 脚本 `MODE` 可配 | 0.1.x |
| 会话跨重启恢复 | `SessionRouter.getSession` 优先 `resume` 持久化会话（stable sessionId = room key / userId，按 id 跨根定位），失败回退新建；headless profile 装配 `dsh-session-persistence-jsonl`（`~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`），daemon 重启后实测恢复成功（日志 `resumed persisted session for room`） | 0.1.x |
| 流式渐进回复 | 文本增量按阈值（80 字符）分段实时发送，用户在微信看到"逐步生成"；markdown 安全分片（不劈开结构标记） | 0.1.x → 0.3.4 |
| 聚合回复模式 | 默认 `aggregate`：生成期间只累积+"正在输入"，完成后统一发送（≤1500 字符一条成文；超长按段落切 500 字/段 + 段间 500ms 节流），防碎片与高频连发被拒；`DSH_WEIXIN_REPLY_MODE=stream` 回退流式 | 0.5.1 |
| 聚合超时占位 | 聚合模式 25s 未完成发一次"还在生成，请稍候～"（最多一次，文生图占位不重复） | 0.5.1 |
| 单词截断保护 | 分段阈值触发时，不完整拉丁单词（如 "km" 等待 "/h"）留在缓存，防止 "km/h" 被劈成两段 | 0.4.1 |
| markdown 全剥离 | 发送前 StreamingMarkdownFilter 剥离全部 markdown 语法（表格→纯文本行、粗体/斜体/行内代码/代码块/标题/分隔线/引用，内容保留）——微信不渲染 markdown | 0.4.0 |
| 格式契约 | AGENTS.md 自动注入 agent：纯文本 + emoji、结论先行、常用模板（天气/画图/问答）few-shot | 0.4.0 |
| 发送失败兜底 | 流式发送连续失败 ≥3 次 → 主动回复"⚠️ 消息发送通道出现异常"，不静默丢回复 | 0.4.0 |
| 发送失败分流 | `ret=-2` 按 errmsg 分流：`rate limited` → 指数退避重试（1s/2s/4s，恢复后自动补发）；`prepare failed`/裸 -2（context 失效）→ 首次即提示"请先给机器人发一条消息刷新会话"并停止重试；其他 → 连续失败 ≥3 次兜底提示 | 0.5.1 |
| 消息处理两层超时 | 空闲超时（默认 180s，活动事件刷新计时，防 AI 网关挂起卡死）+ 整轮超时（默认 900s，防工具循环失控）；`OPENCLAW_ASK_IDLE_TIMEOUT_SEC` / `OPENCLAW_ASK_TIMEOUT_SEC` 可配 | 0.3.8 |
| 正在输入提示 | 回复前经 getConfig 取 typing ticket 发送"正在输入"状态 | 0.1.x |
| 文生图占位回复 | 工具调用时立即回"正在生成图片，大概需要 1 分钟"（生成期间无文本增量，避免干等） | 0.3.5 |

### 4. 媒体消息（`src/weixin/media/`、`media-store.ts`、`cdn/`、`send-media.ts`、`send.ts`、`ai-service.ts`）

| 功能 | 说明 | 版本 |
|---|---|---|
| 入站：图片 | 下载解密（AES-ECB + CDN 参数解密）→ 本地保存（魔数推断扩展名）→ AI 视觉描述（qwen2.5-vl）附给 agent | 0.1.x |
| 入站：语音 | SILK → silk-wasm 转 WAV → ASR 转文字（SenseVoiceSmall），转写结果附给 agent | 0.1.x |
| 入站：视频 / 文件 | 下载解密保存，路径 + 类型附给 agent | 0.1.x |
| 出站：媒体发送 | 回复中的 `[image:]` / `[video:]` / `[file:]` 独立标记行剥离收集，按 MIME 路由：图片→CDN 上传+图片消息、视频→视频上传+视频消息、其余→附件上传+文件消息（图片/文件已实测） | 0.1.x |
| 文生图工具 | agent 可调用 `generate_image`（默认 gpt-image-2，1024x1024）生成图片，返回本地路径用 `[image:]` 发出；未配置凭据时不注册工具 | 0.3.x |

### 5. AI 能力配置（`src/weixin/ai-config.ts`、`dialog-config.ts`、`ai-service.ts`）

| 功能 | 说明 | 版本 |
|---|---|---|
| 四项能力独立配置 | 语音转文字（`AI_ASR_*`）/ 图像理解（`AI_VISION_*`）/ 文生图（`AI_IMAGE_*`）/ 语音合成（`AI_TTS_*`）：各自端点+密钥+模型，模型缺省用默认值 | 0.3.0 |
| 全局兜底凭据 | 能力级未配置时回退 `AI_GATEWAY_BASE_URL` + `AI_GATEWAY_KEY` 共用；优先级 能力级 → 全局 → 未配置（静默降级） | 0.3.0 |
| .env 固定位置 | 所有运行模式共用 `~/.openclaw/weixin-dsh/.env`；`setup` 交互引导逐能力问答（回车保持 / `r` 重配 / `x` 清除）并 upsert 写入 | 0.3.2 |
| 对话模型引导 | `setup` 内交互引导写 `~/.dsh/settings.yaml` 的 `llm-pi-ai` provider + `agent-default-model`（flow 多行格式，与 dsh 保存输出逐字符一致）与 `~/.dsh/.credentials.yaml` 的 `COMPANY_API_KEY`；识别 flow / 简化块两种 YAML 风格 | 0.3.6 |
| 能力调用封装 | OpenAI 兼容 HTTP：ASR（FormData）、文生图（b64/url 下载）、视觉（base64）、TTS（WAV 24000Hz）；fetch 超时保护（图像 150s、其余 60s） | 0.3.0 |

### 6. 主动推送与定时任务（0.5.0，`src/weixin/push.ts`、`cron-expr.ts`、`cron-jobs.ts`、`cron-scheduler.ts`、`inbound.ts`）

| 功能 | 说明 |
|---|---|
| `dsh-weixin push --to <userId\|all> "内容"` | 一次性主动发送；`all` = 账号下所有活跃会话用户（盘上有 context token 的用户）；缺省最新登录账号 |
| context token 持久化 | 入站消息的 context token 落盘（`<accountId>.context-tokens.json`），独立进程推送/定时任务据此携带发送凭证；**前提**：用户先给机器人发过消息 |
| `cron add <content> --cron "30 8 * * *" --to <userId> [--type text\|prompt]` | 5 字段 cron（分 时 日 月 周，`*` / 数字 / `*/步长`），基于本机时区；text = 静态内容直接发，prompt = 到时走 agent 生成再发（不支持 `--to all`） |
| `cron list` / `cron rm <id>` | 任务列表（含下次执行时间）/ 删除 |
| 调度语义 | daemon 内 30s tick（覆盖整分边界）；**错过触发点不补发**，10 分钟宽限窗口内仍执行（容忍 daemon 短重启）；`lastSentAt` 防重复发送（at-least-once 偏向，崩溃于已发未持久化窗口会补发一次）；执行失败下轮重试 |

### 7. 微信内斜杠命令（0.5.0，`src/weixin/slash-command.ts`）

| 命令 | 权限 | 说明 |
|---|---|---|
| `/help` | 所有人 | 列出可用命令 |
| `/reset` | per-user 免授权（重置自己）；room 需管理员（重置共享会话） | 重置会话上下文 |
| `/status` | 管理员 | 网关账号 / 会话模式 / 活跃会话数 |
| `/cron list` | 管理员 | 定时任务列表 |

- 管理员白名单：`.env` 的 `WECHAT_ADMIN_IDS`（逗号分隔微信 userId），改后重启守护生效
- 未命中命令表的消息（如 `/tmp 目录在哪`）放行给 agent，不误伤正常对话

### 8. 部署与运维

| 功能 | 说明 |
|---|---|
| launchd 常驻 | `docs/launchd/com.weixin-dsh.gateway.plist` + `scripts/weixin-gateway-daemon.sh`（while 循环，崩溃 5s 自动拉起）；launchctl kickstart/bootout 管理；日志 `~/.openclaw/weixin-dsh/launchd.{out,err}.log` |
| 管理脚本 | `scripts/weixin-gateway.sh`：login / relogin（停 daemon→扫码→Ctrl+C 自动交回）/ start / stop / restart / status / logs / test（per-user\|room）/ demo |
| 真日志位置 | `$TMPDIR/openclaw-YYYY-MM-DD.log`（launchd 日志只有横幅；测试与网关共用此文件） |
| 状态目录 | `~/.openclaw/weixin-dsh/`：accounts-index.json、run-<account>.lock、media/（inbound/generated）、cron-jobs.json、.env |

### 9. 测试与质量保障

| 功能 | 说明 |
|---|---|
| 单元测试 | vitest，35 用例（实例互斥锁、cron 解析/调度、slash 命令、markdown 剥离、流式发送器、AI 配置解析、版本比对等纯逻辑，不依赖微信/网络） |
| 会话路由自动化测试 | `--session-test per-user\|room`（`session-test.ts`）：真实 dsh 环境模拟两个用户对话，断言隔离/共享；三层物理隔离（独立 cwd 根 + 专属 room key + resume 禁用）防撞线上会话 |
| 工具冒烟探针 | `tool-probe.ts`：发布前/部署后快速验证工具执行链路（dsh-tools 双实例崩溃问题的回归探针） |
| 发布前测试 | `scripts/test-publish.sh`：单测 → 构建 → 打包 → 隔离安装 → bin → 会话路由 → setup 链路 |
| CI | GitHub Actions：typecheck + build（main 分支 + PR） |
| 配套插件 | `plugins/dsh-weather-cn`（0.1.2）：天气查询工具插件，随网关安装（修复 dsh-tools 双实例崩溃） |
| 配套插件 | `plugins/dsh-settings-remote`（0.0.6）：web 设置页 loopback 门控绕过（settings.* 与 credentials.* 放行，见 troubleshooting） |
| 配套插件 | `plugins/dsh-room-projection-sync`（0.0.1）：web 端 __room__ 投影缓存实时刷新（seq 信号 + fs.watch） |

### 10. 会话共享与实时同步（0.5.1-0.5.13）

| 功能 | 说明 |
|---|---|
| 写前同步（0.5.1） | 网关每次处理消息前扫描会话文件 revision，被 web 端修改则重建会话融入新事件；损坏自动截断修复（`session-sync.ts`） |
| 定时自愈（0.5.10） | 网关每 30s 扫描会话文件，损坏即截断重建（web attach 写入与网关写入的竞态兜底） |
| 昵称引导（0.5.3-0.5.9） | `dsh-weixin setup` 引导配置微信用户昵称（WEIXIN_USER_NICKNAME），网关自动设为 __room__ 会话标题（web 端可识别） |
| web 查看微信历史 | __room__ 会话经 bind mount 挂入 web 会话目录；列表层投影缓存由插件实时刷新（seq 信号，秒级） |
| 消息层同步 | 10 分钟定时重启 web（systemd timer dsh-web-refresh）重建会话对象；"打开状态下自动推送"受 dsh 内核限制（见边界表） |

## 二、待实现功能

> 以下来自代码注释 / 文档已知限制中明确指向的后续项。未标注版本 = 尚无计划版本。

| 功能 | 现状 | 原因 / 阻塞 | 计划方向 |
|---|---|---|---|
| cron prompt 型任务 v2：独立会话生成 | v1 直接注入**收件人**的会话生成内容——任务提示词会占据用户对话上下文（`/reset` 可清） | 无独立 session 语义 | v2 改为独立会话生成，生成结果再发用户（`cron-scheduler.ts` 注释） |
| cron 任务文件并发写加锁 | `cron add` 与守护进程并发读写 `cron-jobs.json` 未加锁 | 单用户场景风险低，故 v1 未做 | 复用 `pairing.ts` 的文件锁机制 |
| CLI `push` 支持 prompt 型内容 | `dsh-weixin push` 仅支持 text 内容；prompt 型只能走 cron 由 daemon 调度 | CLI 独立进程无 cordis 环境，无法创建 agent | 提供配套服务/简化 agent 调用路径（`push.ts` 注释） |
| 语音条回复 | 官方协议不支持语音条渲染（Issue #78/#254 实测），`[tts:]` 标记文本目前并入文字回复 | 腾讯协议层限制 | 协议支持后接线 `synthesizeSpeech`（TTS 能力封装已就绪） |
| 出站视频发送实测确认 | `[video:]` 按 MIME 路由实现（上传+发送代码完备），但文档仅标注图片/文件已实测 | 缺真实链路验证 | 补一次实测并更新本文档 |

## 三、已确认的边界与限制（非待办）

| 限制 | 说明 |
|---|---|
| 微信不渲染 markdown | 设计决定：回复走纯文本 + emoji 契约 + 渲染器兜底剥离，**不是**待实现项 |
| 主动推送需先建立会话 | 用户需先给机器人发过消息（context token 落盘）；`--to all` 只发给活跃用户 |
| cron 错过不补发 | 触发点错过 10 分钟宽限窗口即跳过（网关停机期间），设计如此 |
| dsh 为 0.1.0-rc 预发布 | 上游接口可能破坏性变更，升级 dsh 后需回归测试 |
| web 打开状态下自动推送新消息 | dsh 内核无跨进程事件注入通道（前端 WebSocket 推送源=宿主进程内事件流），插件侧拿不到会话对象引用（detach 不可行）——"打开即最新"靠 10 分钟定时重启 web；调研与后续方向见 `docs/archive/realtime-session-sync-research.md` |
