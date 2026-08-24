# dsh-settings-remote

> 独立 npm 包 / [GitHub 仓库](https://github.com/shaodushu/dsh-settings-remote)；与 [dsh-weixin-gateway](https://github.com/shaodushu/dsh-weixin-gateway) 配套，源码副本随其 `plugins/` 维护。

dsh web 客户端插件：让 **settings.\* 配置平面**（`settings.describe` / `settings.update` / `settings.replace` / `settings.mutate` / `settings.openDocument`）在**非 loopback 页面也可读可写**。

修复经域名反向代理访问 dsh web 时，模型/提供方目录页的两个报错：

- `settings are unavailable in this browser`（客户端镜像门控）
- `transport failure for /api/settings.mutate: HTTP 403`（服务端特权方法硬钉 loopback）

## 背景

dsh 的 `dsh-client-connection` 把 `settings.*` 等配置平面方法硬编码在 `PRIVILEGED_METHODS` 中，对它们用**空信任列表**做 `isTrustedApiRequest` 判定——即使通过 `--trusted-host` 配置了域名也强制 loopback（DNS-rebinding 防御设计）。因此经域名访问时：

- `settings.describe` 被客户端镜像门控（`connection.isLoopback` 判定）挡在页面外
- `settings.mutate` 等写操作被服务端 trust fence 直接 403

本插件从两侧绕过（保持信任边界）：

**服务端半边**（`lib/index.js`）：利用 webServer **exact 路由匹配优先于 /api 前缀路由**的特性，为五个 `settings.*` 方法注册 exact 路由，用**与 /api 前缀路由相同的 trustedHosts 信任墙**（Host ∈ loopback ∪ trustedHosts，Origin 同源，sec-fetch-site ≠ cross-site）放行请求，再原样委托 `apiProxy` 分派。`credentials.*` / `host.*` / `agentPreset.*` 等其他特权方法的 loopback 保护不变。

**客户端半边**（`lib/client.js`）：把设置镜像的持久化强制切到 `"host"` 并主动加载一次，使非 loopback 页面真正发起 `settings.describe`。

## 安装

```bash
dsh plugin --profile web add dsh-settings-remote
```

需要服务端以 `--trusted-host <域名>` 启动 dsh web（IP 与域名都加），并在反向代理处透传 `Host` 头。

## 安全边界

- 仅放行 `settings.*` 配置平面五个方法；`credentials.*`、`host.openPath`、`agentPreset.*` 等仍保持 loopback 硬钉
- 放行依赖 trustedHosts 信任墙：管理员显式配置的域名 + 浏览器同源检查（Origin / sec-fetch-site）

## License

MIT
