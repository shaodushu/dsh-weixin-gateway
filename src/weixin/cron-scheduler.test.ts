/**
 * cron-scheduler 单元测试：tick 到期执行（text/prompt）、失败重试语义、
 * 错过推进、interval 生命周期。依赖注入 fake 发送/生成，无需真实 cordis。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addCronJob, cronJobsPath, loadCronJobs } from './cron-jobs.js'
import { CronScheduler } from './cron-scheduler.js'
import { clearContextTokensForAccount, setContextToken } from './inbound.js'
import type { SessionRouter } from './session-router.js'

const ACCOUNT = 'acct@im.bot'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-scheduler-test-'))
  process.env.OPENCLAW_STATE_DIR = tmpDir
})

beforeEach(() => {
  fs.rmSync(cronJobsPath(), { force: true })
  clearContextTokensForAccount(ACCOUNT)
})

afterAll(() => {
  delete process.env.OPENCLAW_STATE_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** 构造"已到点"的每分钟任务：lastSentAt = now-45s → 下一整分 <= now，窗口内 due。 */
function dueEveryMinute(content: string, over: Record<string, unknown> = {}) {
  return addCronJob({
    cron: '* * * * *',
    content,
    type: 'text',
    to: 'user-a',
    ...over,
  })
}

const fakeRouter = {
  getSession: vi.fn(async () => ({})),
} as unknown as SessionRouter

function makeScheduler(over: Partial<Parameters<typeof CronScheduler.prototype.constructor>[0]> = {}) {
  const sendText = vi.fn(async () => undefined)
  const generatePrompt = vi.fn(async () => '生成的内容')
  const scheduler = new CronScheduler({
    router: fakeRouter,
    accountId: ACCOUNT,
    baseUrl: 'https://example.invalid',
    token: 'tok',
    sendText,
    generatePrompt,
    ...over,
  })
  return { scheduler, sendText, generatePrompt }
}

describe('CronScheduler.tick', () => {
  it('text 任务到点 → sendText 收到目标/内容/contextToken', async () => {
    const now = Date.now()
    const job = addCronJob({
      cron: '* * * * *',
      content: '早上好',
      type: 'text',
      to: 'user-a',
    })
    // 任务已执行过一次（lastSentAt = now-45s）→ 下一整分已到 → due
    const jobs = loadCronJobs()
    jobs[0].lastSentAt = new Date(now - 45_000).toISOString()
    fs.writeFileSync(cronJobsPath(), JSON.stringify(jobs))
    setContextToken(ACCOUNT, 'user-a', 'token-a')

    const { scheduler, sendText } = makeScheduler()
    await scheduler.tick()

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith('user-a', '早上好', 'token-a')
    // lastSentAt 更新 → 同一任务不再重复触发
    expect(loadCronJobs()[0].lastSentAt).toBeTruthy()
    expect(job.id).toBe(loadCronJobs()[0].id)
  })

  it('prompt 任务 → 内容经 generatePrompt 生成后发给目标', async () => {
    const now = Date.now()
    addCronJob({ cron: '* * * * *', content: '查今天天气', type: 'prompt', to: 'user-b' })
    const jobs = loadCronJobs()
    jobs[0].lastSentAt = new Date(now - 45_000).toISOString()
    fs.writeFileSync(cronJobsPath(), JSON.stringify(jobs))

    const { scheduler, sendText, generatePrompt } = makeScheduler()
    await scheduler.tick()

    expect(generatePrompt).toHaveBeenCalledTimes(1)
    expect(generatePrompt).toHaveBeenCalledWith(expect.anything(), '查今天天气')
    expect(sendText).toHaveBeenCalledWith('user-b', '生成的内容', undefined)
  })

  it('未到点任务不发送', async () => {
    addCronJob({ cron: '* * * * *', content: '未到', type: 'text', to: 'user-a' })
    // 新任务 lastSentAt = 创建时刻 → 下一整分未到 → 不发送
    const { scheduler, sendText } = makeScheduler()
    await scheduler.tick()
    expect(sendText).not.toHaveBeenCalled()
  })

  it('发送失败 → 不抛、lastSentAt 不变、下轮 tick 重试', async () => {
    const now = Date.now()
    addCronJob({ cron: '* * * * *', content: '重试', type: 'text', to: 'user-a' })
    const jobs = loadCronJobs()
    const before = new Date(now - 45_000).toISOString()
    jobs[0].lastSentAt = before
    fs.writeFileSync(cronJobsPath(), JSON.stringify(jobs))

    const sendText = vi.fn(async () => {
      throw new Error('send failed')
    })
    const scheduler = new CronScheduler({
      router: fakeRouter,
      accountId: ACCOUNT,
      baseUrl: 'https://example.invalid',
      token: 'tok',
      sendText,
    })

    await expect(scheduler.tick()).resolves.toBeUndefined() // 失败不抛
    expect(loadCronJobs()[0].lastSentAt).toBe(before) // 未更新 → 下轮重试

    // 下一轮 tick（sendText 恢复成功）→ 发送成功
    sendText.mockImplementation(async () => undefined)
    await scheduler.tick()
    expect(sendText).toHaveBeenCalledTimes(2)
    expect(loadCronJobs()[0].lastSentAt).not.toBe(before) // 已更新
  })

  it("'all' 广播 → 发给账号下所有活跃会话用户（盘上 token）", async () => {
    const now = Date.now()
    addCronJob({ cron: '* * * * *', content: '全员通知', type: 'text', to: 'all' })
    const jobs = loadCronJobs()
    jobs[0].lastSentAt = new Date(now - 45_000).toISOString()
    fs.writeFileSync(cronJobsPath(), JSON.stringify(jobs))
    // 两个活跃用户（盘上有 token；内存 store 不必——'all' 枚举走盘）
    setContextToken(ACCOUNT, 'user-1', 't1')
    setContextToken(ACCOUNT, 'user-2', 't2')

    const { scheduler, sendText } = makeScheduler()
    await scheduler.tick()

    expect(sendText).toHaveBeenCalledTimes(2)
    expect(sendText).toHaveBeenCalledWith('user-1', '全员通知', 't1')
    expect(sendText).toHaveBeenCalledWith('user-2', '全员通知', 't2')
  })

  it('错过宽限窗口的任务 → 不发送，lastSentAt 推进到触发时刻（防卡死）', async () => {
    // 每天 08:30 任务，上次执行 08-19 08:31 → 触发点 08-20 08:30 已过 2h → missed
    const now = new Date(2026, 7, 20, 10, 30, 45)
    addCronJob({ cron: '30 8 * * *', content: '日报', type: 'text', to: 'user-a' })
    const jobs = loadCronJobs()
    jobs[0].lastSentAt = new Date(2026, 7, 19, 8, 31).toISOString()
    fs.writeFileSync(cronJobsPath(), JSON.stringify(jobs))

    const { scheduler, sendText } = makeScheduler()
    await scheduler.tick()

    expect(sendText).not.toHaveBeenCalled()
    const after = loadCronJobs()[0].lastSentAt
    expect(after).toBe(new Date(2026, 7, 20, 8, 30).toISOString()) // 推进到触发时刻
  })
})

describe('CronScheduler 生命周期', () => {
  it('start 启动 interval 并恢复盘上 token；stop 幂等', () => {
    vi.useFakeTimers()
    try {
      setContextToken(ACCOUNT, 'user-a', 'token-a') // 落盘
      clearContextTokensForAccount(ACCOUNT) // 清内存，模拟重启
      const { scheduler, sendText } = makeScheduler()

      scheduler.start()
      scheduler.start() // 幂等：不重复起 interval

      vi.advanceTimersByTime(30_000) // 触发一次 tick（无任务，无副作用）
      expect(sendText).not.toHaveBeenCalled()

      scheduler.stop()
      scheduler.stop() // 幂等
    } finally {
      vi.useRealTimers()
    }
  })
})
