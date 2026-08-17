/**
 * weixin-driver — 微信常驻驱动。
 *
 * 职责：
 *  1. 扫码登录（weixinLoginWithQr）
 *  2. 长轮询 getUpdates 收消息
 *  3. 文本消息 → AgentBridge（dsh 执行层）→ 回复发回微信
 *
 * 垂直切片：文本消息收发；媒体消息暂忽略（后续扩展）。
 * 多轮对话：一个账号对应一个常驻 agent 会话（createGatewayAgent 只调一次）。
 */
import fs from 'node:fs'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

import { resolveStateDir } from './storage/state-dir.js'
import {
  DEFAULT_BASE_URL,
  loadWeixinAccount,
  saveWeixinAccount,
  triggerWeixinChannelReload,
} from './accounts.js'
import {
  displayQRCode,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from './login-qr.js'
import { getUpdates, notifyStart, sendTyping } from './api/api.js'
import { WeixinConfigManager } from './api/config-cache.js'
import { sendMessageWeixin } from './send.js'
import { weixinMessageToMsgContext, getContextTokenFromMsgContext } from './inbound.js'
import { logger } from './util/logger.js'
import { createGatewayAgent, askAgent } from '../bridge.js'

/** 微信账号状态目录（本地，与 OpenClaw 隔离）。 */
const WEIXIN_STATE_DIR = path.join(resolveStateDir(), 'weixin-dsh')

/** 本地状态目录下的账号索引（替代 OpenClaw 的账号索引文件）。 */
function accountIndexPath(): string {
  return path.join(WEIXIN_STATE_DIR, 'accounts-index.json')
}

/** 交互式扫码登录，返回可用账号。 */
export async function weixinLoginWithQr(accountId?: string): Promise<ResolvedAccount> {
  logger.info('weixin-login: starting QR login')
  const start = await startWeixinLoginWithQr({
    apiBaseUrl: DEFAULT_BASE_URL,
    accountId,
    verbose: true,
  })
  if (start.qrcodeUrl) {
    await displayQRCode(start.qrcodeUrl)
  }
  console.log(start.message)

  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
  })
  if (!wait.connected && !wait.alreadyConnected) {
    throw new Error(`微信登录失败: ${wait.message}`)
  }
  if (!wait.botToken || !wait.accountId) {
    throw new Error(`微信登录结果缺少凭据: ${wait.message}`)
  }

  // 持久化账号 + 记录账号索引（与 OpenClaw 版 saveWeixinAccount 对齐）
  saveWeixinAccount(wait.accountId, {
    token: wait.botToken,
    baseUrl: wait.baseUrl ?? DEFAULT_BASE_URL,
  })
  indexAccount(wait.accountId)
  await triggerWeixinChannelReload().catch(() => undefined)

  logger.info(`weixin-login: account ${wait.accountId} connected`)
  return resolveAccount(wait.accountId)
}

/** 账号解析（本地配置 + 存储凭据）。 */
export function resolveAccount(accountId: string): ResolvedAccount {
  const stored = loadWeixinAccount(accountId)
  return {
    accountId,
    baseUrl: stored?.baseUrl?.trim() || DEFAULT_BASE_URL,
    token: stored?.token?.trim() || undefined,
  }
}

/** 把 accountId 记入本地索引（账号列表/恢复用）。 */
function indexAccount(accountId: string): void {
  const indexPath = accountIndexPath()
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  let list: string[] = []
  try {
    list = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as string[]
    if (!Array.isArray(list)) list = []
  } catch {
    list = []
  }
  if (!list.includes(accountId)) {
    list.push(accountId)
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2))
  }
}

/** 列出本地已登录账号。 */
export function listWeixinAccounts(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(accountIndexPath(), 'utf8')) as string[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 运行中的微信网关账号。 */
export interface ResolvedAccount {
  accountId: string
  baseUrl: string
  token?: string
}

/**
 * 常驻微信网关：轮询收消息 → dsh agent 回复 → 发回微信。
 * 直到 abortSignal 触发或进程退出。
 */
export async function runWeixinGateway(
  ctx: Context,
  account: ResolvedAccount,
  opts: { abortSignal?: AbortSignal; verbose?: boolean } = {},
): Promise<void> {
  const { abortSignal } = opts
  const accountId = account.accountId
  const baseUrl = account.baseUrl
  const token = account.token
  if (!token) {
    throw new Error(`账号 ${accountId} 未登录，请先运行 weixin-login`)
  }

  // 通知微信侧本 client 启动（建立 session；原版 OpenClaw channel 启动顺序）
  try {
    const resp = await notifyStart({ baseUrl, token })
    if (resp.ret !== undefined && resp.ret !== 0) {
      logger.warn(`weixin-gateway: notifyStart ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`)
    }
  } catch (err) {
    logger.warn(`weixin-gateway: notifyStart failed (ignored): ${String(err)}`)
  }

  // 常驻 agent 会话（多轮对话）
  logger.info(`weixin-gateway: creating agent session for account ${accountId}`)
  const agentHandle: AgentHandle = await createGatewayAgent(ctx)

  // 每用户配置缓存（typing ticket 等）
  const configManager = new WeixinConfigManager(
    { baseUrl, token },
    (msg) => logger.debug(msg),
  )

  let getUpdatesBuf = ''
  logger.info(`weixin-gateway: polling started for ${accountId}`)
  while (abortSignal?.aborted !== true) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: 30_000,
        abortSignal,
      })
      getUpdatesBuf = resp.get_updates_buf ?? getUpdatesBuf

      for (const msg of resp.msgs ?? []) {
        await handleIncoming(ctx, agentHandle, account, msg, baseUrl, token, configManager)
      }
    } catch (err) {
      if (abortSignal?.aborted) break
      logger.error(`weixin-gateway: poll error: ${String(err)}`)
      // 短暂退避后继续（避免异常风暴）
      await sleep(2_000)
    }
  }

  await agentHandle.dispose().catch(() => undefined)
  logger.info(`weixin-gateway: stopped for ${accountId}`)
}

/** 处理一条入站消息：文本消息 → askAgent → 回复。 */
async function handleIncoming(
  ctx: Context,
  agentHandle: AgentHandle,
  account: ResolvedAccount,
  msg: import('./api/types.js').WeixinMessage,
  baseUrl: string,
  token: string | undefined,
  configManager: WeixinConfigManager,
): Promise<void> {
  const msgCtx = weixinMessageToMsgContext(msg, account.accountId)
  const text = msgCtx.Body.trim()
  const to = msgCtx.From
  const contextToken = getContextTokenFromMsgContext(msgCtx)

  if (!text) {
    // 垂直切片：媒体/空消息暂不处理
    logger.debug(`weixin-gateway: ignoring non-text message from ${to}`)
    return
  }

  logger.info(`weixin-gateway: [${account.accountId}] ${to}: ${text.slice(0, 100)}`)
  try {
    // "正在输入"状态：需要先向 getConfig 要 typing ticket
    const cached = await configManager.getForUser(to, contextToken)
    if (cached.typingTicket) {
      await sendTyping({
        baseUrl,
        token,
        body: { ilink_user_id: to, typing_ticket: cached.typingTicket, status: 1 },
      }).catch(() => undefined)
    }

    const result = await askAgent(agentHandle, text)
    if (result.error !== undefined) {
      await sendMessageWeixin({
        to,
        text: `抱歉，处理失败：${result.error}`,
        opts: { baseUrl, token, contextToken },
      }).catch((err) => logger.error(`weixin-gateway: send error reply: ${String(err)}`))
      return
    }
    const reply = result.text.trim()
    if (!reply) return

    // 回复可能很长：微信单条有长度限制，先完整发送（后续用 markdown 分片/流式渐进）
    await sendMessageWeixin({
      to,
      text: reply,
      opts: { baseUrl, token, contextToken },
    })
    logger.info(`weixin-gateway: replied to ${to} (${reply.length} chars)`)
  } catch (err) {
    logger.error(`weixin-gateway: handle message error: ${String(err)}`)
    await sendMessageWeixin({
      to,
      text: `服务开小差了：${err instanceof Error ? err.message : String(err)}`,
      opts: { baseUrl, token, contextToken },
    }).catch(() => undefined)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
