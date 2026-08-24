/**
 * dsh-settings-remote — 服务端半边。
 *
 * dsh-client-connection 把 "settings.describe" 等配置平面方法硬编码在
 * PRIVILEGED_METHODS 里，即使 --trusted-host 配置了域名也强制 loopback。
 * 本插件为 settings.* 配置平面（describe/update/replace/mutate/
 * openDocument）注册 exact 路由（webServer 匹配是 exact 优先于 /api
 * 前缀路由），用**与 /api 前缀路由相同的 trustedHosts 信任墙**（而非空
 * 信任列表）放行请求，然后原样委托给 apiProxy 分派。其他特权方法
 * （credentials.*、host.openPath、agentPreset.* 等）的 loopback 保护不变。
 *
 * 0.0.3：settings.mutate 加入放行——模型/提供方目录页"添加模型"经域名
 * 访问报 "transport failure for /api/settings.mutate: HTTP 403"。
 */
import { toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";

export const name = "dsh-settings-remote";

export const inject = ["webServer", "apiProxy", "loader", "webRuntime"];

const DEFAULT_MAX_REQUEST_BODY_BYTES = 167772160;

/** 配置平面（非 loopback 放行的特权方法；与 dsh-client-connection 的 PRIVILEGED_METHODS 对应）。
 * settings.*：模型/提供方目录页的配置读写；credentials.*：模型页添加模型的 API key 保存（set）、
 * 密钥配置状态探测（describe）、删除（unset）。全部有 dsh-auth-gate 登录层保护。 */
const SETTINGS_METHODS = [
  "settings.describe",
  "settings.update",
  "settings.replace",
  "settings.mutate",
  "settings.openDocument",
  "credentials.set",
  "credentials.describe",
  "credentials.unset",
];

/** 复刻 dsh-client-connection 的 isLoopbackHostname。 */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** 复刻 dsh-client-connection 的 parseAuthority。 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/** 复刻 dsh-client-connection 的 canonicalAuthority。 */
function canonicalAuthority(entry, entryUrl) {
  const port =
    entryUrl.port !== ""
      ? entryUrl.port
      : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/** 复刻 dsh-client-connection 的 isTrustedAuthority。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/**
 * 复刻 dsh-client-connection 的 isTrustedApiRequest（trustedHosts 版）。
 * 语义必须与 /api 前缀路由一致：Host ∈ loopback ∪ trustedHosts，且
 * sec-fetch-site ≠ cross-site，且 Origin 与 Host 同源。
 */
function isTrustedApiRequest(request, trustedHosts) {
  const host = request.headers.host;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts))
    return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * 复刻 dsh-client-connection 的 bridge：node:http 请求 → fetch 形态的
 * apiHandler → node:http 响应。
 */
async function bridge(req, res, apiHandler, maxRequestBodyBytes) {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const declaredLength = req.headers["content-length"];
  if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    received += buffer.byteLength;
    if (received > maxRequestBodyBytes) {
      res.writeHead(413, { connection: "close" });
      res.end();
      req.destroy();
      return;
    }
    chunks.push(buffer);
  }
  const request = new Request(new URL(req.url ?? "/", "http://dsh.internal"), {
    method: req.method ?? "GET",
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, value]) => typeof value === "string")
    ),
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    signal: abort.signal
  });
  const response = await apiHandler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
      });
    }
  }
  res.end();
}

/** 解析 trustedHosts：优先 webRuntime（dsh-web-app 提供的运行时服务，CLI --trusted-host 的解析结果），loader 树兜底。 */
function resolveTrustedHosts(ctx) {
  try {
    const runtime = ctx.get("webRuntime");
    if (runtime !== undefined && Array.isArray(runtime.trustedHosts)) return runtime.trustedHosts;
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-settings-remote] webRuntime lookup failed: ${error}`);
  }
  try {
    for (const entry of ctx.loader.entries()) {
      const name = entry.options?.name;
      if (name !== "@deepseek-ai/dsh-client-connection") continue;
      const hosts = entry.options?.config?.trustedHosts;
      if (Array.isArray(hosts)) return hosts;
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-settings-remote] resolveTrustedHosts failed: ${error}`);
  }
  return [];
}

export function apply(ctx) {
  const trustedHosts = resolveTrustedHosts(ctx);
  const apiProxy = ctx.get("apiProxy");
  if (apiProxy === undefined) {
    ctx.logger?.warn?.("[dsh-settings-remote] apiProxy unavailable — route not registered");
    return;
  }
  const fetchHandler = toFetchHandler(apiProxy);
  for (const path of SETTINGS_METHODS.map((method) => `/api/${method}`)) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "exact",
          path,
          handler: async (req, res) => {
            // 信任墙：与 /api 前缀路由相同（trustedHosts），但不做 PRIVILEGED 的 loopback 硬钉。
            if (!isTrustedApiRequest(req, trustedHosts)) {
              res.writeHead(403);
              res.end("forbidden");
              return;
            }
            await bridge(req, res, fetchHandler, DEFAULT_MAX_REQUEST_BODY_BYTES);
          }
        }),
      `dsh-settings-remote: ${path} exact route`
    );
  }
  console.log(`[dsh-settings-remote] exact routes registered (${SETTINGS_METHODS.length}), trustedHosts=${JSON.stringify(trustedHosts)}`);
}
