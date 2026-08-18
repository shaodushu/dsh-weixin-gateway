/**
 * run-lock 单元测试（vitest）。
 *
 * 隔离：beforeEach 把 OPENCLAW_STATE_DIR 指到临时目录（锁路径经
 * resolveStateDir() 动态解析），完全不碰真实 ~/.openclaw/ 下的锁。
 *
 * 跨进程用例：spawn 子进程持锁，argv0 伪造网关命令行（ps 可见），
 * 模拟"另一台网关实例正在轮询"的真实场景。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { acquireRunLock, findConflict, findHeldGatewayLocks, lockPath, releaseRunLock } from './run-lock.js'

let stateDir: string
const children: ReturnType<typeof spawn>[] = []

/** 写入锁文件（测试前置：先确保 weixin-dsh 目录存在，与 acquire 行为一致）。 */
function writeLockFile(accountId: string, content: string): void {
  const p = lockPath(accountId)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** spawn 一个写锁后常驻的子进程；stdout 输出 READY 表示已就绪。返回其 PID。 */
function spawnHolder(argv0: string, extraCode = '', accountId = 'acct-conflict'): Promise<number> {
  return new Promise((resolve, reject) => {
    const code = `
      const fs = require('node:fs');
      const p = process.env.LOCK_PATH;
      fs.mkdirSync(require('node:path').dirname(p), { recursive: true });
      fs.writeFileSync(p, String(process.pid));
      process.stdout.write('READY');
      setTimeout(() => {}, 60000);
      ${extraCode}
    `
    const child = spawn(process.execPath, ['-e', code], {
      argv0,
      env: { ...process.env, LOCK_PATH: lockPath(accountId) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    children.push(child)
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d))
    child.on('error', reject)
    const timer = setInterval(() => {
      if (out.includes('READY')) {
        clearInterval(timer)
        resolve(child.pid!)
      }
    }, 10)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error('holder 子进程未在 5s 内就绪'))
    }, 5000).unref()
  })
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lock-test-'))
  process.env.OPENCLAW_STATE_DIR = stateDir
})

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR
  for (const c of children) {
    try {
      c.kill()
    } catch {
      // 已退出则忽略
    }
  }
  children.length = 0
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe('acquireRunLock', () => {
  it('正常获取：ok:true，锁文件内容为自身 PID', () => {
    const r = acquireRunLock('acct-1')
    expect(r).toEqual({ ok: true })
    expect(fs.existsSync(lockPath('acct-1'))).toBe(true)
    const first = fs.readFileSync(lockPath('acct-1'), 'utf8').split('\n')[0]
    expect(first).toBe(String(process.pid))
  })

  it('同账号冲突：存活网关实例持锁时返回其 PID', async () => {
    const holderPid = await spawnHolder('node --weixin-run holder')
    const r = acquireRunLock('acct-conflict')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.pid).toBe(String(holderPid))
    }
    // 冲突不覆盖已有锁
    const first = fs.readFileSync(lockPath('acct-conflict'), 'utf8').split('\n')[0]
    expect(first).toBe(String(holderPid))
  })

  it('不同账号可并行持有锁', () => {
    expect(acquireRunLock('acct-a')).toEqual({ ok: true })
    expect(acquireRunLock('acct-b')).toEqual({ ok: true })
  })

  it('释放后可重新获取', () => {
    expect(acquireRunLock('acct-1')).toEqual({ ok: true })
    releaseRunLock('acct-1')
    expect(fs.existsSync(lockPath('acct-1'))).toBe(false)
    expect(acquireRunLock('acct-1')).toEqual({ ok: true })
  })

  it('残留锁（PID 已不存在）自动覆盖', () => {
    writeLockFile('acct-stale', '99999999\n')
    const r = acquireRunLock('acct-stale')
    expect(r).toEqual({ ok: true })
    const first = fs.readFileSync(lockPath('acct-stale'), 'utf8').split('\n')[0]
    expect(first).toBe(String(process.pid))
  })

  it('存活但非网关进程持锁 → 视为残留覆盖', async () => {
    // argv0 不含 weixin-login/weixin-run：ps 命令行校验不匹配 → 非网关实例
    await spawnHolder(process.execPath)
    const r = acquireRunLock('acct-conflict')
    expect(r).toEqual({ ok: true })
  })

  it('损坏锁文件（空/乱内容）视为残留覆盖', () => {
    writeLockFile('acct-broken', '')
    expect(acquireRunLock('acct-broken')).toEqual({ ok: true })
    writeLockFile('acct-broken2', 'not-a-pid\njunk\n')
    expect(acquireRunLock('acct-broken2')).toEqual({ ok: true })
  })
})

describe('findHeldGatewayLocks', () => {
  it('扫描所有被存活网关实例持有的锁（run/login 两种命令行）', async () => {
    const pidA = await spawnHolder('node --weixin-run holder', '', 'acct-scan-a')
    const pidB = await spawnHolder('node --weixin-login holder', '', 'acct-scan-b')
    const held = findHeldGatewayLocks()
    expect(held).toHaveLength(2)
    expect(held.find((h) => h.accountId === 'acct-scan-a')?.pid).toBe(String(pidA))
    expect(held.find((h) => h.accountId === 'acct-scan-b')?.pid).toBe(String(pidB))
  })

  it('跳过残留锁（PID 已死）与非网关进程持有的锁', async () => {
    writeLockFile('acct-dead', '99999999\n')
    await spawnHolder(process.execPath, '', 'acct-plain')
    expect(findHeldGatewayLocks()).toEqual([])
  })

  it('锁目录不存在时返回空数组', () => {
    expect(findHeldGatewayLocks()).toEqual([])
  })

  it('只认 run-*.lock：忽略目录内其他文件/目录', async () => {
    const dir = path.join(stateDir, 'weixin-dsh')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'accounts-index.json'), '{}')
    fs.writeFileSync(path.join(dir, 'run-no-dot-lock'), 'junk\n')
    fs.mkdirSync(path.join(dir, 'run-dir.lock'))
    const pid = await spawnHolder('node --weixin-run holder', '', 'acct-real')
    const held = findHeldGatewayLocks()
    expect(held).toHaveLength(1)
    expect(held[0]!.accountId).toBe('acct-real')
    expect(held[0]!.pid).toBe(String(pid))
  })
})

describe('findConflict', () => {
  const held = [
    { accountId: 'a@im.bot', pid: '1' },
    { accountId: 'b@im.bot', pid: '2' },
  ]

  it('未指定账号时取任一持锁实例（无参 run/login 一律拦截）', () => {
    expect(findConflict(held)).toEqual({ accountId: 'a@im.bot', pid: '1' })
  })

  it('指定账号时精确匹配该账号', () => {
    expect(findConflict(held, 'b@im.bot')).toEqual({ accountId: 'b@im.bot', pid: '2' })
    expect(findConflict(held, 'c@im.bot')).toBeUndefined()
  })

  it('空列表返回 undefined', () => {
    expect(findConflict([], 'a@im.bot')).toBeUndefined()
    expect(findConflict([])).toBeUndefined()
  })
})
