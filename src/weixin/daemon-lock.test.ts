/**
 * daemon 锁检查脚本（scripts/weixin-lock-check.sh）测试。
 *
 * launchd 守护脚本每轮循环用它判断"是否有前台实例持锁"，语义必须与
 * node 侧 src/weixin/run-lock.ts 一致：锁文件第一行是 PID，ps 命令行
 * 含 weixin-login/weixin-run 判定为网关实例，否则视为残留（可接管）。
 *
 * 通过 bash 子进程 source 脚本、传独立锁目录参数隔离，不碰真实 ~/.openclaw/。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const SCRIPT = path.resolve(process.cwd(), 'scripts/weixin-lock-check.sh')

let lockDir: string
const children: ReturnType<typeof spawn>[] = []

function writeLockFile(account: string, content: string): void {
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, `run-${account}.lock`), content)
}

/** bash 子进程：source 脚本 → lock_held_by <lockDir> → 输出持锁 PID 与退出码。 */
function runLockCheck(): { held: string; ok: boolean } {
  const script = `
    source "${SCRIPT}"
    if held=$(lock_held_by "${lockDir}"); then
      echo "HELD=$held"
      exit 0
    fi
    echo "HELD="
    exit 1
  `
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  const m = /HELD=(\d*)/.exec(res.stdout ?? '')
  return { held: m?.[1] ?? '', ok: res.status === 0 }
}

/** spawn 一个写锁后常驻的子进程；argv0 伪造网关命令行（ps 可见）。返回其 PID。 */
function spawnHolder(argv0: string, account: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const code = `
      const fs = require('node:fs');
      const p = process.env.LOCK_PATH;
      fs.mkdirSync(require('node:path').dirname(p), { recursive: true });
      fs.writeFileSync(p, String(process.pid));
      process.stdout.write('READY');
      setTimeout(() => {}, 60000);
    `
    const child = spawn(process.execPath, ['-e', code], {
      argv0,
      env: { ...process.env, LOCK_PATH: path.join(lockDir, `run-${account}.lock`) },
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
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-lock-test-'))
})

afterEach(() => {
  for (const c of children) {
    try {
      c.kill()
    } catch {
      // 已退出则忽略
    }
  }
  children.length = 0
  fs.rmSync(lockDir, { recursive: true, force: true })
})

describe('lock_held_by（daemon 侧 bash 实现）', () => {
  it('无锁文件 → 未持有（daemon 正常拉起）', () => {
    expect(runLockCheck()).toEqual({ held: '', ok: false })
  })

  it('存活网关实例持锁 → 返回其 PID（daemon 退避等待）', async () => {
    const pid = await spawnHolder('node --weixin-run holder', 'acct-a')
    const r = runLockCheck()
    expect(r.ok).toBe(true)
    expect(r.held).toBe(String(pid))
  })

  it('login 命令行（--weixin-login）同样视为网关实例', async () => {
    const pid = await spawnHolder('node --weixin-login holder', 'acct-b')
    expect(runLockCheck().held).toBe(String(pid))
  })

  it('多账号任一持锁即返回（daemon 不固定账号，扫描全部）', async () => {
    const pid = await spawnHolder('node --weixin-run holder', 'acct-other')
    expect(runLockCheck().held).toBe(String(pid))
  })

  it('残留锁（PID 已死）→ 未持有（daemon 删除后接管）', () => {
    writeLockFile('acct-dead', '99999999\n')
    expect(runLockCheck()).toEqual({ held: '', ok: false })
  })

  it('存活但非网关进程持锁 → 视为残留（与 node 侧同语义）', async () => {
    await spawnHolder(process.execPath, 'acct-plain')
    expect(runLockCheck()).toEqual({ held: '', ok: false })
  })

  it('损坏锁文件（空/乱内容）→ 未持有', () => {
    writeLockFile('acct-broken', '')
    writeLockFile('acct-broken2', 'not-a-pid\njunk\n')
    expect(runLockCheck()).toEqual({ held: '', ok: false })
  })

  it('默认锁目录 = $HOME/.openclaw/weixin-dsh（与 node 侧默认一致）', () => {
    // 只验证参数缺省时的默认路径解析（不落真实文件）：HOME 指向临时目录
    const script = `
      source "${SCRIPT}"
      export HOME="${lockDir}"
      lock_held_by
      echo "code=$?"
    `
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    // 临时 HOME 下无锁 → 返回 1（未持有），不会因路径错误报错
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('code=1')
  })
})
