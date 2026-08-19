# 开发文档（仓库内开发与部署）

> 面向**开发者**：clone 仓库改代码 / 调试 / 部署 launchd 服务。README 的快速开始之外的一切工程细节都在这里。

## 构建

```bash
pnpm install && pnpm build
```

## 单元测试

```bash
pnpm test        # vitest（实例互斥锁等纯逻辑，不依赖微信/网络）
```

发布前跑 `./scripts/test-publish.sh`（单测 → 构建 → 打包 → 隔离安装 → bin → 会话路由 → setup 链路）。

## 管理脚本（`scripts/weixin-gateway.sh`）

仓库内日常操作统一走这个脚本（npm 安装的 `dsh-weixin` CLI 提供等价命令：`dsh-weixin start/stop/restart/status`，launchd 标签相同）：

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

## launchd 部署（服务常驻）

架构：launchd → `scripts/weixin-gateway-daemon.sh`（while 循环守护，崩溃 5s 自动拉起）→ dsh 网关。

- **换机器必改**：`weixin-gateway-daemon.sh` 顶部 `DSH` / `PATCH` / `MODE`、`docs/launchd/com.weixin-dsh.gateway.plist` 里的 daemon 脚本绝对路径，目前硬编码了作者本机值。
- 会话模式：改 daemon 脚本里 `MODE=room|per-user` 后 restart。
- launchd 日志：`~/.openclaw/weixin-dsh/launchd.{out,err}.log`；管理命令 `launchctl kickstart|bootout gui/$(id -u)/com.weixin-dsh.gateway`。

## 架构

| 模块 | 说明 |
|---|---|
| `src/bridge.ts` | AgentBridge：创建 agent 会话、`followup` 注入消息、流式事件转发（onDelta 文本增量 / onToolCall 工具调用）、聚合回复（与消息来源解耦） |
| `src/runner.ts` | CLI 驱动（`gateway.patch.yml`）：headless 任务的注入闭环演示 |
| `src/weixin/` | 微信协议层（移植自 `Tencent/openclaw-weixin`，MIT）：api / auth / cdn / media / messaging / storage |
| `src/weixin/driver.ts` | 微信驱动：扫码登录 → `notifyStart` → `getUpdates` 长轮询 → 消息→agent→回复（generate_image 占位回复） |
| `src/weixin/ai-service.ts` | AI 能力 HTTP 封装（ASR/文生图/视觉/TTS）：fetch 超时保护（图像 150s、其余 60s）、SILK→WAV、base64 传图 |
| `src/weixin/entry.ts` / `gateway.ts` | 命令行解析（`--weixin-login` / `--weixin-run`）与网关应用插件（注册 generate_image 工具） |
| `src/weixin/run-lock.ts` | 实例互斥锁（账号级 pidfile，见[使用手册](usage.md#实例互斥同一账号只能一个网关)） |
| `src/weixin/ai-config.ts` | AI 能力配置中枢：能力级独立配置（端点+密钥+模型）解析、.env upsert、setup 引导问题构建 |
| `src/weixin/dialog-config.ts` | 对话模型 provider 配置（`~/.dsh/settings.yaml` + `.credentials.yaml`）：两种 YAML 风格检测（dsh flow 保存格式 / 简化块）、块级 upsert、setup 引导问题构建 |
| `src/cli.ts` | `dsh-weixin` 引导 CLI（bin 入口）：setup / login / run / update / stop / start / restart / status |

> 微信机器人**回复约定**（媒体标记、回复风格）见 [AGENTS.md](../AGENTS.md)——它是网关作为机器人时的行为规范，不是模块说明。

## 开发状态

- 文本消息收发闭环（微信 → dsh agent → 微信回复）：已完成
- 媒体消息：已完成。入站（图片 AI 视觉描述 / 语音转文字 / 文件 / 视频）+ 出站（`[image:]` `[video:]` `[file:]` 标记按 MIME 路由发送，图片/文件已实测）
- AI 能力独立配置 + setup 交互引导：已完成。新增 AI 能力时在 `src/weixin/ai-config.ts` 的 `AI_CAPABILITIES` 注册一组定义（前缀/默认模型/端点路径）即可，cli 引导与摘要自动覆盖
- 对话模型 provider 交互引导（`dsh-weixin setup` 内）：已完成。写 `~/.dsh/settings.yaml` 的 `llm-pi-ai`（flow 多行格式，与 dsh 保存输出逐字符一致）+ `agent-default-model` 与 `~/.dsh/.credentials.yaml` 的 `COMPANY_API_KEY`，两种 llm-pi-ai 风格均可识别（0.3.6）
- launchd 启停命令（`dsh-weixin stop/start/restart/status`）：已完成（0.3.6）
- 流式渐进回复（回复分段实时发送，markdown 安全分片 + 标记剥离）：已完成
- 文生图体验（generate_image 工具调用时占位回复 + 各能力 fetch 超时保护 + 工具调用耗时日志）：已完成（0.3.5）
- 限制：语音条回复不支持——官方协议不渲染（Issue #78/#254 实测），`[tts:]` 文本并入文字回复
- 注意：dsh 为 0.1.0-rc 预发布，接口可能破坏性变更
