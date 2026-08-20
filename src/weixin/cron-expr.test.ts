/**
 * cron-expr 单元测试：解析（范围/步长/归一化）与 nextRunAt（整分对齐/OR 语义/永不匹配）。
 */
import { describe, expect, it } from 'vitest'

import { CronParseError, nextRunAt, parseCronExpr } from './cron-expr.js'

describe('parseCronExpr', () => {
  it('解析合法 5 段表达式', () => {
    const expr = parseCronExpr('*/5 9 1 * 1')
    expect(expr.minute).toEqual({ values: new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]), any: false })
    expect(expr.hour).toEqual({ values: new Set([9]), any: false })
    expect(expr.dayOfMonth).toEqual({ values: new Set([1]), any: false })
    expect(expr.month.any).toBe(true)
    expect(expr.dayOfWeek).toEqual({ values: new Set([1]), any: false })
  })

  it('通配符 * 为任意值', () => {
    const expr = parseCronExpr('* * * * *')
    for (const f of [expr.minute, expr.hour, expr.dayOfMonth, expr.month, expr.dayOfWeek]) {
      expect(f.any).toBe(true)
    }
  })

  it('段数不足 / 超出 5 段抛 CronParseError', () => {
    expect(() => parseCronExpr('0 9 * *')).toThrow(CronParseError)
    expect(() => parseCronExpr('0 9 * * * *')).toThrow(CronParseError)
  })

  it('步长 0 抛错', () => {
    expect(() => parseCronExpr('*/0 * * * *')).toThrow(CronParseError)
  })

  it('越界值抛错（分钟 60 / 小时 24 / 月份 13 / 星期 8）', () => {
    expect(() => parseCronExpr('60 * * * *')).toThrow(CronParseError)
    expect(() => parseCronExpr('* 24 * * *')).toThrow(CronParseError)
    expect(() => parseCronExpr('* * * 13 *')).toThrow(CronParseError)
    expect(() => parseCronExpr('* * * * 8')).toThrow(CronParseError)
  })

  it('dayOfWeek 7 归一化为 0（周日等价）', () => {
    const a = parseCronExpr('0 0 * * 0')
    const b = parseCronExpr('0 0 * * 7')
    expect(b.dayOfWeek.values).toEqual(a.dayOfWeek.values)
    expect(b.dayOfWeek.values).toEqual(new Set([0]))
  })

  it('非法 token 抛错（区间 1-5 / 逗号 / 字母）', () => {
    expect(() => parseCronExpr('1-5 * * * *')).toThrow(CronParseError)
    expect(() => parseCronExpr('1,2 * * * *')).toThrow(CronParseError)
    expect(() => parseCronExpr('a * * * *')).toThrow(CronParseError)
  })

  it('错误消息含字段名', () => {
    try {
      parseCronExpr('0 25 * * *')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CronParseError)
      expect((err as CronParseError).field).toBe('hour')
      expect((err as CronParseError).message).toContain('hour')
    }
  })
})

describe('nextRunAt', () => {
  it('每分钟表达式 → from 之后第一个整分', () => {
    const expr = parseCronExpr('* * * * *')
    const from = new Date(2026, 7, 20, 10, 30, 45) // 2026-08-20 10:30:45
    const next = nextRunAt(expr, from)!
    expect(next.getTime()).toBe(new Date(2026, 7, 20, 10, 31, 0).getTime())
  })

  it('from 恰在整分 → 严格下一个整分（不返回 from 本身）', () => {
    const expr = parseCronExpr('* * * * *')
    const from = new Date(2026, 7, 20, 10, 30, 0, 0)
    const next = nextRunAt(expr, from)!
    expect(next.getTime()).toBe(new Date(2026, 7, 20, 10, 31, 0).getTime())
  })

  it('每天 09:00，from 在当日 14:00 → 次日 09:00', () => {
    const expr = parseCronExpr('0 9 * * *')
    const from = new Date(2026, 7, 20, 14, 0)
    const next = nextRunAt(expr, from)!
    expect(next.getTime()).toBe(new Date(2026, 7, 21, 9, 0).getTime())
  })

  it('*/5 分钟对齐 5 分格', () => {
    const expr = parseCronExpr('*/5 * * * *')
    const from = new Date(2026, 7, 20, 10, 3)
    const next = nextRunAt(expr, from)!
    expect(next.getTime()).toBe(new Date(2026, 7, 20, 10, 5).getTime())
  })

  it('DOM/DOW 双受限用 OR 语义（`0 0 1 * 1` = 1 号或周一）', () => {
    const expr = parseCronExpr('0 0 1 * 1')
    // 2026-08-20 是周四：下一个周一 8/24 早于 9/1 → 应命中 8/24
    const from = new Date(2026, 7, 20, 12, 0)
    const next = nextRunAt(expr, from)!
    expect(next.getTime()).toBe(new Date(2026, 7, 24, 0, 0).getTime())
    // 从 8/31（周一）当天起算：下一个匹配是 9/1（1 号，早于 9/7 周一）
    const from2 = new Date(2026, 7, 31, 12, 0)
    const next2 = nextRunAt(expr, from2)!
    expect(next2.getTime()).toBe(new Date(2026, 8, 1, 0, 0).getTime())
  })

  it('闰年 2 月 29 日命中（2028 闰年）', () => {
    const expr = parseCronExpr('0 0 29 2 *')
    const from = new Date(2027, 2, 1, 0, 0) // 2027-03-01（2027 非闰年已过）
    const next = nextRunAt(expr, from)!
    expect(next.getTime()).toBe(new Date(2028, 1, 29, 0, 0).getTime())
  })

  it('永不匹配（2 月 30 日）→ null', () => {
    const expr = parseCronExpr('0 0 30 2 *')
    expect(nextRunAt(expr, new Date(2026, 0, 1))).toBeNull()
  })

  it('月份与日协同：`0 12 1 * *` 跨月命中', () => {
    const expr = parseCronExpr('0 12 1 * *')
    const from = new Date(2026, 7, 20) // 8 月 20 日 → 9 月 1 日 12:00
    const next = nextRunAt(expr, from)!
    expect(next.getTime()).toBe(new Date(2026, 8, 1, 12, 0).getTime())
  })
})
