/**
 * accounts 单元测试（vitest）。
 *
 * 覆盖 clearStaleAccountsForUserId（扫码登录后的旧账号清理）：
 * 同一微信用户（userId）下的旧账号应从索引移除、token 文件删除；
 * 其他 userId 的账号与新账号自身必须保留。
 *
 * 隔离：beforeEach 把 OPENCLAW_STATE_DIR / OPENCLAW_OAUTH_DIR 指到临时目录
 * （resolveStateDir() 动态解析 env），完全不碰真实 ~/.openclaw/ 下的账号。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearStaleAccountsForUserId,
  listIndexedWeixinAccountIds,
  registerWeixinAccountId,
  saveWeixinAccount,
} from './accounts.js'

let stateDir: string
let prevStateDir: string | undefined
let prevOAuthDir: string | undefined

/** 账号文件路径（与 accounts.ts 内部实现一致）。 */
function accountFilePath(accountId: string): string {
  return path.join(stateDir, 'openclaw-weixin', 'accounts', `${accountId}.json`)
}

/** 构造一个已登录账号：写 token 文件 + 注册进索引。 */
function makeAccount(accountId: string, userId: string): void {
  saveWeixinAccount(accountId, { token: `tok-${accountId}`, baseUrl: 'https://ilinkai.weixin.qq.com', userId })
  registerWeixinAccountId(accountId)
}

beforeEach(() => {
  prevStateDir = process.env.OPENCLAW_STATE_DIR
  prevOAuthDir = process.env.OPENCLAW_OAUTH_DIR
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-accounts-test-'))
  process.env.OPENCLAW_STATE_DIR = stateDir
  process.env.OPENCLAW_OAUTH_DIR = path.join(stateDir, 'credentials')
})

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR
  else process.env.OPENCLAW_STATE_DIR = prevStateDir
  if (prevOAuthDir === undefined) delete process.env.OPENCLAW_OAUTH_DIR
  else process.env.OPENCLAW_OAUTH_DIR = prevOAuthDir
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe('clearStaleAccountsForUserId', () => {
  it('清除同一 userId 的旧账号（索引 + token 文件），保留新账号与其他 userId', () => {
    // 三个同 userId 旧账号 + 一个新账号 + 一个不同 userId 账号
    makeAccount('aaa111@im.bot', 'user-common')
    makeAccount('bbb222@im.bot', 'user-common')
    makeAccount('ccc333@im.bot', 'user-common')
    makeAccount('ddd444@im.bot', 'user-other')

    expect(listIndexedWeixinAccountIds()).toHaveLength(4)

    clearStaleAccountsForUserId('new999@im.bot', 'user-common')

    // 索引：同 userId 旧账号被移除，仅剩不同 userId 的账号
    //（新账号入索引由调用方在清理后单独 indexAccount —— 见 weixinLoginWithQr）
    const indexed = listIndexedWeixinAccountIds()
    expect(indexed).toEqual(['ddd444@im.bot'])
    // 同 userId 旧账号的 token 文件已删除
    expect(fs.existsSync(accountFilePath('aaa111@im.bot'))).toBe(false)
    expect(fs.existsSync(accountFilePath('bbb222@im.bot'))).toBe(false)
    expect(fs.existsSync(accountFilePath('ccc333@im.bot'))).toBe(false)
    // 新账号（未入索引前由调用方负责保存）与其他 userId 账号不受影响
    expect(fs.existsSync(accountFilePath('ddd444@im.bot'))).toBe(true)
  })

  it('userId 为空时不删除任何账号', () => {
    makeAccount('aaa111@im.bot', 'user-common')
    clearStaleAccountsForUserId('new999@im.bot', '')
    expect(listIndexedWeixinAccountIds()).toEqual(['aaa111@im.bot'])
    expect(fs.existsSync(accountFilePath('aaa111@im.bot'))).toBe(true)
  })

  it('新账号自身（即使已注册进索引）不会被删除', () => {
    makeAccount('new999@im.bot', 'user-common')
    makeAccount('old888@im.bot', 'user-common')

    clearStaleAccountsForUserId('new999@im.bot', 'user-common')

    expect(listIndexedWeixinAccountIds()).toEqual(['new999@im.bot'])
    expect(fs.existsSync(accountFilePath('new999@im.bot'))).toBe(true)
    expect(fs.existsSync(accountFilePath('old888@im.bot'))).toBe(false)
  })
})
