/**
 * cron-scheduler — 网关常驻进程内的定时任务调度器。
 *
 * 生命周期挂载在 runWeixinGateway 内（router 创建后 start、disposeAll 前 stop），
 * 跑在持有 run-lock 的网关进程里——互斥锁天然保证同一账号只有一份调度器。
 *
 * tick 语义（分钟级，30s 间隔保证覆盖整分边界）：
 *  1. 到期任务（宽限窗口内）逐条串行执行；单条失败不抛、不更新 lastSentAt（下轮重试）
 *  2. 错过宽限窗口的任务：不发送，推进 lastSentAt 到该触发时刻（防同一参照点反复判错过）
 *
 * 依赖全部注入（sendText/generatePrompt/tickMs），测试无需真实 cordis 环境。
 */
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

import { askAgentStreaming } from '../bridge.js'
import { evalJobDue, findDueJobs, loadCronJobs, updateCronJobLastSentAt } from './cron-jobs.js'
import type { CronJob } from './cron-jobs.js'
import { getContextToken, readPersistedContextTokens, restoreContextTokens } from './inbound.js'
import { sendMessageWeixin } from './send.js'
import type { SessionRouter } from './session-router.js'
import { logger } from './util/logger.js'

/** 默认 tick 间隔：30s（分钟级调度，30s 内必覆盖整分边界）。 */
const DEFAULT_TICK_MS = 30_000

export interface CronSchedulerDeps {
  router: SessionRouter
  accountId: string
  baseUrl: string
  token: string | undefined
  /** 发送一条文本消息（测试注入；缺省走 sendMessageWeixin）。 */
  sendText?: (to: string, text: string, contextToken: string | undefined) => Promise<void>
  /** prompt 型任务生成内容（测试注入；缺省走 askAgentStreaming）。 */
  generatePrompt?: (handle: AgentHandle, content: string) => Promise<string>
  /** tick 间隔（测试可缩短/加速）。 */
  tickMs?: number
}

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly router: SessionRouter
  private readonly accountId: string
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly tickMs: number
  private readonly sendText: (to: string, text: string, contextToken: string | undefined) => Promise<void>
  private readonly generatePrompt: (handle: AgentHandle, content: string) => Promise<string>

  constructor(deps: CronSchedulerDeps) {
    this.router = deps.router
    this.accountId = deps.accountId
    this.baseUrl = deps.baseUrl
    this.token = deps.token
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS
    this.sendText =
      deps.sendText ??
      (async (to, text, contextToken) => {
        await sendMessageWeixin({
          to,
          text,
          opts: { baseUrl: this.baseUrl, token: this.token, contextToken },
        })
      })
    this.generatePrompt =
      deps.generatePrompt ??
      (async (handle, content) => {
        const result = await askAgentStreaming(handle, content, {})
        if (result.error !== undefined) throw new Error(result.error)
        return result.text
      })
  }

  /** 启动调度（幂等）：恢复盘上 context token 到内存 store + 起 interval。 */
  start(): void {
    if (this.timer) return
    restoreContextTokens(this.accountId)
    this.timer = setInterval(() => {
      void this.tick()
    }, this.tickMs)
    // 不阻止进程退出（网关轮询退出后调度器无意义）
    this.timer.unref?.()
    logger.info(`cron-scheduler: started for ${this.accountId} (tick ${this.tickMs}ms)`)
  }

  /** 停止调度（幂等）。 */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
    logger.info(`cron-scheduler: stopped for ${this.accountId}`)
  }

  /** 执行一轮调度检查（公开，测试直接调用）。 */
  async tick(): Promise<void> {
    const now = new Date()
    const jobs = loadCronJobs()

    // 1. 到期任务（宽限窗口内）串行执行；成功后更新 lastSentAt = 发送时刻
    const due = findDueJobs(jobs, now, this.accountId)
    for (const { job } of due) {
      try {
        await this.runJob(job)
        updateCronJobLastSentAt(job.id, new Date().toISOString())
        logger.info(`cron-scheduler: job ${job.id} done`)
      } catch (err) {
        // 不更新 lastSentAt → 下轮 tick 重试
        logger.error(`cron-scheduler: job ${job.id} failed, will retry: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 2. 错过宽限窗口的任务：不发送，推进 lastSentAt 到触发时刻防卡死
    for (const job of jobs) {
      const state = evalJobDue(job, new Date(), this.accountId)
      if (state.kind === 'missed') {
        updateCronJobLastSentAt(job.id, state.scheduledFor.toISOString())
        logger.info(`cron-scheduler: job ${job.id} missed trigger at ${state.scheduledFor.toISOString()}, skipped`)
      }
    }
  }

  /** 执行单个任务：展开目标（'all' → 活跃会话用户）→ 生成内容 → 逐目标发送。 */
  private async runJob(job: CronJob): Promise<void> {
    const targets =
      job.to === 'all' ? Object.keys(readPersistedContextTokens(this.accountId)) : [job.to]
    if (targets.length === 0) return
    for (const userId of targets) {
      try {
        let content: string
        if (job.type === 'prompt') {
          // v1：直接注入收件人会话生成（上下文会被任务提示词占据，README 注明；v2 改独立 session）
          const handle = await this.router.getSession(userId)
          content = await this.generatePrompt(handle, job.content)
        } else {
          content = job.content
        }
        if (!content.trim()) {
          logger.warn(`cron-scheduler: job ${job.id} produced empty content for ${userId}, skipped`)
          continue
        }
        // contextToken 缺失仅 warn 照发（send.ts 语义：无入站上下文的活动态推送可能被服务端拒绝）
        await this.sendText(userId, content, getContextToken(this.accountId, userId))
        logger.info(`cron-scheduler: job ${job.id} sent to ${userId} (${content.length} chars)`)
      } catch (err) {
        // 'all' 广播：单用户失败不阻断其余目标（部分成功时任务仍记完成，下次 occurrence 再说）
        // 指定用户失败：上抛 → tick 不更新 lastSentAt → 下轮重试
        if (job.to !== 'all') throw err
        logger.error(`cron-scheduler: job ${job.id} to ${userId} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
