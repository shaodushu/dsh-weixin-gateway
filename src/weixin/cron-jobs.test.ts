/**
 * cron-jobs 单元测试：任务文件读写、CRUD 校验、到期判定（宽限窗口/错过推进/防重复）。
 * 用 OPENCLAW_STATE_DIR 指向临时目录隔离真实 state dir。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CronParseError } from './cron-expr.js'
import {
  addCronJob,
  cronJobsPath,
  evalJobDue,
  findDueJobs,
  formatCronJobList,
  loadCronJobs,
  removeCronJob,
  saveCronJobs,
  updateCronJobLastSentAt,
} from './cron-jobs.js'
import type { CronJob } from './cron-jobs.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-jobs-test-'))
  process.env.OPENCLAW_STATE_DIR = tmpDir
})

afterAll(() => {
  delete process.env.OPENCLAW_STATE_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const baseJob = (over: Partial<CronJob>): CronJob => ({
  id: 'cron:test-00000000',
  cron: '30 8 * * *',
  content: '早上好',
  type: 'text',
  to: 'user@im.bot',
  createdAt: '2026-08-20T00:00:00.000Z',
  ...over,
})

describe('cron-jobs CRUD', () => {
  it('addCronJob 落盘并返回带 id/createdAt 的任务', () => {
    const job = addCronJob({ cron: '0 9 * * *', content: '日报', type: 'text', to: 'u1' })
    expect(job.id).toMatch(/^cron:/)
    expect(job.createdAt).toBeTruthy()
    expect(loadCronJobs()).toEqual([job])
    expect(fs.existsSync(cronJobsPath())).toBe(true)
  })

  it('非法 cron 表达式透传 CronParseError，不落盘', () => {
    expect(() =>
      addCronJob({ cron: '0 9 * *', content: 'x', type: 'text', to: 'u1' }),
    ).toThrow(CronParseError)
    expect(loadCronJobs().length).toBe(1) // 仍是上一个
  })

  it('prompt 型广播抛错', () => {
    expect(() =>
      addCronJob({ cron: '0 9 * * *', content: '查天气', type: 'prompt', to: 'all' }),
    ).toThrow(/广播/)
  })

  it('removeCronJob 删除并返回是否找到', () => {
    const job = addCronJob({ cron: '0 9 * * *', content: '删我', type: 'text', to: 'u1' })
    expect(removeCronJob(job.id)).toBe(true)
    expect(removeCronJob(job.id)).toBe(false)
    expect(loadCronJobs().find((j) => j.id === job.id)).toBeUndefined()
  })

  it('updateCronJobLastSentAt 持久化', () => {
    const job = addCronJob({ cron: '0 9 * * *', content: '更新', type: 'text', to: 'u1' })
    updateCronJobLastSentAt(job.id, '2026-08-20T01:00:00.000Z')
    expect(loadCronJobs().find((j) => j.id === job.id)?.lastSentAt).toBe(
      '2026-08-20T01:00:00.000Z',
    )
  })

  it('损坏的任务文件 → loadCronJobs 返回 []', () => {
    fs.writeFileSync(cronJobsPath(), 'not json{{{')
    expect(loadCronJobs()).toEqual([])
    fs.rmSync(cronJobsPath(), { force: true })
  })

  it('saveCronJobs 直写且容错加载', () => {
    const jobs = [baseJob({}), baseJob({ id: 'cron:two-00000000' })]
    saveCronJobs(jobs)
    expect(loadCronJobs()).toEqual(jobs)
  })
})

describe('evalJobDue / findDueJobs', () => {
  const now = new Date(2026, 7, 20, 10, 30, 45) // 2026-08-20 10:30:45

  it('addCronJob 初始化 lastSentAt = createdAt（新任务参照点固定，防"永不触发"）', () => {
    const job = addCronJob({ cron: '0 9 * * *', content: 'x', type: 'text', to: 'u1' })
    expect(job.lastSentAt).toBe(job.createdAt)
  })

  it('新任务首次触发：参照点 = 创建时刻，下一个匹配整分才 due（不立即触发、不补发历史）', () => {
    // 任务 10:30:45 创建（lastSentAt = 创建时刻），cron 每分钟
    const job = baseJob({ cron: '* * * * *', lastSentAt: new Date(2026, 7, 20, 10, 30, 45).toISOString() })
    // 创建后 5s：下一整分 10:31 未到 → not-due
    expect(evalJobDue(job, new Date(2026, 7, 20, 10, 30, 50), 'acct')).toEqual({ kind: 'not-due' })
    // 10:31:15：10:31:00 已到且窗口内 → due
    expect(evalJobDue(job, new Date(2026, 7, 20, 10, 31, 15), 'acct').kind).toBe('due')
  })

  it('无 lastSentAt 的任务（任务文件被手改）→ 参照点 = 当前时刻，不触发', () => {
    // 每分钟任务：ref=now → 下一整分 10:31 在 now 之后
    const job = baseJob({ cron: '* * * * *', lastSentAt: undefined })
    expect(evalJobDue(job, now, 'acct')).toEqual({ kind: 'not-due' })
  })

  it('lastSentAt 存在且已到触发点（窗口内）→ due', () => {
    // 每天 08:30；上次 08-19 08:31 发送 → 参照点后下一触发 = 今天 08:30，
    // now 10:30:45 距 08:30 超过 10 分钟 → 实际应 missed？不——这里用每分钟任务验证窗口内
    const everyMinute = baseJob({
      cron: '* * * * *',
      lastSentAt: new Date(2026, 7, 20, 10, 29, 45).toISOString(),
    })
    // ref=10:29:45 → 下一整分 10:30:00，now 10:30:45 差 45s < 10min → due
    const state = evalJobDue(everyMinute, now, 'acct')
    expect(state.kind).toBe('due')
    if (state.kind === 'due') {
      expect(state.scheduledFor.getTime()).toBe(new Date(2026, 7, 20, 10, 30, 0).getTime())
    }
  })

  it('错过宽限窗口（>10min）→ missed（不发送，由调度器推进 lastSentAt）', () => {
    // 每天 08:30；上次 08-19 08:31 → 下一触发今天 08:30，now 10:30 差 2h > 10min → missed
    const daily = baseJob({
      cron: '30 8 * * *',
      lastSentAt: new Date(2026, 7, 19, 8, 31).toISOString(),
    })
    expect(evalJobDue(daily, now, 'acct')).toEqual({
      kind: 'missed',
      scheduledFor: new Date(2026, 7, 20, 8, 30),
    })
  })

  it('accountId 不匹配 → not-due（任务归属其他账号）', () => {
    const job = baseJob({ accountId: 'other@im.bot' })
    expect(evalJobDue(job, now, 'acct')).toEqual({ kind: 'not-due' })
  })

  it('无 accountId 的任务归当前执行账号', () => {
    const job = baseJob({ lastSentAt: new Date(2026, 7, 20, 10, 29, 45).toISOString() })
    expect(evalJobDue(baseJob({ ...job, cron: '* * * * *' }), now, 'acct').kind).toBe('due')
  })

  it('missed 推进 lastSentAt 后不再重复判定错过（防卡死）', () => {
    const job = baseJob({
      cron: '30 8 * * *',
      lastSentAt: new Date(2026, 7, 19, 8, 31).toISOString(),
    })
    // 第一次判定 missed（触发点 08-20 08:30）→ 调度器推进 lastSentAt = scheduledFor
    const first = evalJobDue(job, now, 'acct')
    expect(first.kind).toBe('missed')
    if (first.kind !== 'missed') return
    job.lastSentAt = first.scheduledFor.toISOString()
    // 推进后参照点 = 08-20 08:30 → 下一触发 = 08-21 08:30，在 now 之后 → not-due
    expect(evalJobDue(job, now, 'acct')).toEqual({ kind: 'not-due' })
  })

  it('findDueJobs 只返回窗口内到期任务', () => {
    const due = baseJob({
      id: 'cron:due-00000001',
      cron: '* * * * *',
      lastSentAt: new Date(2026, 7, 20, 10, 29, 45).toISOString(),
    })
    const missed = baseJob({
      id: 'cron:missed-00000002',
      cron: '30 8 * * *',
      lastSentAt: new Date(2026, 7, 19, 8, 31).toISOString(),
    })
    const other = baseJob({ id: 'cron:other-00000003', accountId: 'other@im.bot' })
    const fresh = baseJob({ id: 'cron:fresh-00000004', cron: '* * * * *' })
    const result = findDueJobs([due, missed, other, fresh], now, 'acct')
    expect(result.map((r) => r.job.id)).toEqual(['cron:due-00000001'])
  })

  it('最后一次触发后不再重复（lastSentAt 更新后 not-due）', () => {
    const job = baseJob({ cron: '30 8 * * *' })
    // 先构造已发送状态：lastSentAt = 今天 08:30 → 下一触发 08-21 08:30 → not-due
    job.lastSentAt = new Date(2026, 7, 20, 8, 30).toISOString()
    expect(evalJobDue(job, now, 'acct')).toEqual({ kind: 'not-due' })
  })
})

describe('formatCronJobList', () => {
  it('空列表提示', () => {
    expect(formatCronJobList([])).toContain('暂无')
  })

  it('包含 id / cron / 下次执行时间 / 内容预览', () => {
    const now = new Date(2026, 7, 20, 10, 0)
    const job = baseJob({
      id: 'cron:fmt-00000001',
      cron: '30 8 * * *',
      content: '很长很长的内容预览超过二十个字符就会被截断显示',
    })
    const text = formatCronJobList([job], now)
    expect(text).toContain('cron:fmt-00000001')
    expect(text).toContain('30 8 * * *')
    expect(text).toContain('08-21 08:30') // 下次触发
    expect(text).toContain('…') // 长内容截断
  })
})
