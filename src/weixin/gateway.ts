/**
 * weixin-gateway — 微信网关应用插件。
 *
 * 从 weixinStartup 服务读模式，执行：
 *   - login：扫码登录并持久化凭据
 *   - run：解析账号 → 常驻轮询 getUpdates → dsh agent 回复 → 发回微信
 *
 * run 模式为常驻进程：SIGINT/SIGTERM 时优雅退出（dispose agent 会话）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'

import {
  listWeixinAccounts,
  resolveAccount,
  runWeixinGateway,
  weixinLoginWithQr,
} from './driver.js'

export const name = 'weixin-gateway'

/** 需要 weixinStartup 提供命令后（懒配置）才启动。 */
export const inject = ['weixinStartup', 'agentDefaultModel', 'agents', 'sessions']

/** 插件配置：由 weixin.patch.yml 从 weixinStartup 注入。 */
export interface Config {
  mode: 'login' | 'run'
  accountId?: string
}

export function apply(ctx: Context, config: Config): void {
  void (async () => {
    try {
      if (config.mode === 'login') {
        // 登录成功后必须同一进程立即开始轮询：getupdates 长轮询既是拉消息
        // 也是会话保活心跳，登录进程退出会导致服务端回收 session（-14）。
        const account = await weixinLoginWithQr(config.accountId)
        console.log(`✅ 微信登录成功，账号: ${account.accountId}`)
        console.log(`🚀 会话已建立，同一进程启动网关轮询（保活），Ctrl+C 停止...`)
        const abort = new AbortController()
        const onSignal = () => abort.abort()
        process.once('SIGINT', onSignal)
        process.once('SIGTERM', onSignal)
        await runWeixinGateway(ctx, account, { abortSignal: abort.signal })
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
        const exit = ctx.get('appExit') as ((code: number) => void) | undefined
        exit?.(0)
        return
      }

      // run 模式：解析账号并常驻
      let accountId = config.accountId
      if (!accountId) {
        const accounts = listWeixinAccounts()
        if (accounts.length === 0) {
          throw new Error('没有已登录的微信账号，请先运行: --weixin-login')
        }
        accountId = accounts[0]
        console.log(`使用已登录账号: ${accountId}`)
      }

      const account = resolveAccount(accountId)
      const abort = new AbortController()
      const onSignal = () => abort.abort()
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)

      console.log(`🚀 微信网关启动（账号 ${account.accountId}），Ctrl+C 停止...`)
      await runWeixinGateway(ctx, account, { abortSignal: abort.signal })
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      const exit = ctx.get('appExit') as ((code: number) => void) | undefined
      exit?.(0)
    } catch (error) {
      console.error(`[weixin-gateway] ${error instanceof Error ? error.message : String(error)}`)
      const exit = ctx.get('appExit') as ((code: number) => void) | undefined
      exit?.(1)
    }
  })()
}
