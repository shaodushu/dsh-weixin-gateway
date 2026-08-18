/**
 * pickDefaultAccount 单元测试（网关 run 默认账号）。
 *
 * 背景：accounts-index.json 按登录顺序 append，扫码登录会创建新 bot
 * 账号（旧账号立即失效）——默认必须取末位（最新登录），否则网关空转
 * 失效账号（-14、消息无人处理，实测过 daemon 服务已失效的旧账号）。
 */
import { describe, expect, it } from 'vitest'

import { pickDefaultAccount } from './account-select.js'

describe('pickDefaultAccount', () => {
  it('空列表返回 undefined（调用方据此报"未登录"）', () => {
    expect(pickDefaultAccount([])).toBeUndefined()
  })

  it('取末位 = 最新登录（索引按登录顺序 append）', () => {
    expect(pickDefaultAccount(['old@im.bot', 'newer@im.bot', 'newest@im.bot'])).toBe(
      'newest@im.bot',
    )
  })

  it('单账号返回该账号', () => {
    expect(pickDefaultAccount(['only@im.bot'])).toBe('only@im.bot')
  })

  it('只读输入，不修改原数组', () => {
    const accounts = ['a@im.bot', 'b@im.bot']
    pickDefaultAccount(accounts)
    expect(accounts).toEqual(['a@im.bot', 'b@im.bot'])
  })
})
