/**
 * push 单元测试：账号解析（索引 + 账号文件）、目标展开（'all'/单用户）、发送统计。
 * 用 OPENCLAW_STATE_DIR 指向临时目录隔离真实 state dir。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { pushMessage, resolvePushAccount, resolvePushTargets } from './push.js'
import { clearContextTokensForAccount, setContextToken } from './inbound.js'

const ACCOUNT = 'push-acct@im.bot'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-'))
  process.env.OPENCLAW_STATE_DIR = tmpDir
})

beforeEach(() => {
  // 清掉上个用例 setContextToken 残留的内存 Map 与磁盘 token 文件
  clearContextTokensForAccount(ACCOUNT)
})

afterAll(() => {
  delete process.env.OPENCLAW_STATE_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** 预置账号索引 + 账号凭据文件（token/baseUrl 传 undefined 则不写该字段）。 */
function seedAccount(accountId: string, data: { token?: string; baseUrl?: string } = {}) {
  const indexDir = path.join(tmpDir, 'weixin-dsh')
  fs.mkdirSync(indexDir, { recursive: true })
  const indexPath = path.join(indexDir, 'accounts-index.json')
  let arr: string[] = []
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as unknown
    if (Array.isArray(parsed)) arr = parsed as string[]
  } catch {
    // 索引不存在 → 空列表
  }
  if (!arr.includes(accountId)) arr.push(accountId)
  fs.writeFileSync(indexPath, JSON.stringify(arr, null, 2))

  const accountsDir = path.join(tmpDir, 'openclaw-weixin', 'accounts')
  fs.mkdirSync(accountsDir, { recursive: true })
  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.json`),
    // token 传空串 ''（falsy）模拟"缺 token"；不传则给默认值
    JSON.stringify({ token: data.token ?? 'tok-abc', baseUrl: data.baseUrl ?? 'https://ilinkai.weixin.qq.com' }),
  )
}

describe('resolvePushAccount', () => {
  it('缺省取最新登录账号（索引末位），读账号文件拿 token/baseUrl', () => {
    seedAccount('old@im.bot')
    seedAccount('newest@im.bot', { token: 'tok-new', baseUrl: 'https://gw.example' })
    const acct = resolvePushAccount()
    expect(acct.accountId).toBe('newest@im.bot')
    expect(acct.token).toBe('tok-new')
    expect(acct.baseUrl).toBe('https://gw.example')
  })

  it('显式 accountId 优先', () => {
    seedAccount('old@im.bot')
    seedAccount('newest@im.bot')
    const acct = resolvePushAccount('old@im.bot')
    expect(acct.accountId).toBe('old@im.bot')
  })

  it('无索引（未登录任何账号）→ 抛错', () => {
    fs.rmSync(path.join(tmpDir, 'weixin-dsh', 'accounts-index.json'), { force: true })
    expect(() => resolvePushAccount()).toThrow(/login/)
  })

  it('账号文件缺 token → 抛错', () => {
    seedAccount('notoken@im.bot', { token: '' })
    expect(() => resolvePushAccount('notoken@im.bot')).toThrow(/login/)
  })
})

describe('resolvePushTargets', () => {
  it("'all' 展开为账号下所有活跃会话用户（盘上 token）", () => {
    setContextToken(ACCOUNT, 'user-1', 't1')
    setContextToken(ACCOUNT, 'user-2', 't2')
    const targets = resolvePushTargets(ACCOUNT, 'all')
    expect(targets).toEqual([
      { userId: 'user-1', contextToken: 't1' },
      { userId: 'user-2', contextToken: 't2' },
    ])
  })

  it('具体 userId：有 token 带上，无 token 返回 undefined', () => {
    setContextToken(ACCOUNT, 'user-1', 't1')
    expect(resolvePushTargets(ACCOUNT, 'user-1')).toEqual([
      { userId: 'user-1', contextToken: 't1' },
    ])
    expect(resolvePushTargets(ACCOUNT, 'nobody')).toEqual([
      { userId: 'nobody', contextToken: undefined },
    ])
  })

  it('无任何 token → all 返回空数组（调用方抛"无可推送目标"）', () => {
    expect(resolvePushTargets(ACCOUNT, 'all')).toEqual([])
  })
})

describe('pushMessage', () => {
  it('逐目标发送，返回 sent/failed 统计', async () => {
    seedAccount(ACCOUNT)
    setContextToken(ACCOUNT, 'user-1', 't1')
    setContextToken(ACCOUNT, 'user-2', 't2')
    const sendFn = vi.fn(async () => undefined)
    const result = await pushMessage({ accountId: ACCOUNT, to: 'all', text: '通知', sendFn })
    expect(result).toEqual({ sent: 2, failed: 0 })
    expect(sendFn).toHaveBeenCalledWith('user-1', '通知', 't1')
    expect(sendFn).toHaveBeenCalledWith('user-2', '通知', 't2')
  })

  it('单个目标失败不阻断其余，failed 计数正确', async () => {
    seedAccount(ACCOUNT)
    setContextToken(ACCOUNT, 'user-1', 't1')
    setContextToken(ACCOUNT, 'user-2', 't2')
    const sendFn = vi.fn(async (to: string) => {
      if (to === 'user-1') throw new Error('boom')
    })
    const result = await pushMessage({ accountId: ACCOUNT, to: 'all', text: '通知', sendFn })
    expect(result).toEqual({ sent: 1, failed: 1 })
  })

  it('无活跃会话用户 → 抛错', async () => {
    seedAccount(ACCOUNT)
    await expect(
      pushMessage({ accountId: ACCOUNT, to: 'all', text: 'x', sendFn: vi.fn(async () => undefined) }),
    ).rejects.toThrow(/没有可推送的目标/)
  })
})
