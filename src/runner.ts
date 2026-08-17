/**
 * weixin-gateway-runner — dsh 微信网关的应用插件（当前为 CLI 驱动演示形态）。
 *
 * 从 headlessStartup 服务读取任务文本（dsh --profile headless 的命令行参数），
 * 通过 AgentBridge 驱动 dsh 执行层，打印回复。
 *
 * 接入微信时：把任务来源从 headlessStartup 换成微信 inbound 消息，
 * 回复输出从 stdout 换成 sendMessageWeixin，其余桥接逻辑不变。
 */
import type { Context } from '@deepseek-ai/cordis'
// 空类型导入携带依赖包的 Context merge（agents / sessions / agentDefaultModel / loader）
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'

import { askAgent, createGatewayAgent } from './bridge.js'

/** 稳定插件名。 */
export const name = 'weixin-gateway-runner'

/** 需要 headlessStartup 提供任务后（懒配置）才启动。 */
export const inject = ['headlessStartup', 'agentDefaultModel', 'agents', 'sessions']

/** 插件配置：由 gateway.patch.yml 从 headlessStartup 注入。 */
export interface Config {
  /** 本次要执行的任务文本。 */
  task: string
}

export function apply(ctx: Context, config: Config): void {
  // appExit 是 launcher 提供的可选 host 值，必须通过 ctx.get 读取（不是注入依赖）
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) {
    throw new Error('weixin-gateway-runner: 需要 launcher 在装载树前提供 ctx.appExit')
  }
  void (async () => {
    try {
      const handle = await createGatewayAgent(ctx)
      const result = await askAgent(handle, config.task)
      await handle.dispose()
      if (result.error !== undefined) {
        console.error(`[gateway] 任务失败: ${result.error}`)
        exit(1)
      } else {
        console.log(result.text)
        exit(0)
      }
    } catch (error) {
      console.error(`[gateway] ${error instanceof Error ? error.message : String(error)}`)
      exit(1)
    }
  })()
}
