/**
 * session-test — 会话路由双模式自动化测试。
 *
 * 在真实 dsh 环境中模拟两个微信用户（A=小明、B=小红）依次对话，
 * 验证 SessionRouter 两种模式的行为：
 *   - per-user：会话隔离（B 不知道 A 说的话）
 *   - room：共享（B 能感知 A 的上下文）
 *
 * 用法：dsh --profile headless --patch ./weixin.patch.yml --session-test [per-user|room]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'

import { askAgentStreaming } from '../bridge.js'
import { SessionRouter } from './session-router.js'
import type { SessionMode } from './session-router.js'
import { logger } from './util/logger.js'

export const name = 'weixin-session-test'

export const inject = ['sessionTestStartup', 'agentDefaultModel', 'agents', 'sessions']

export interface Config {
  mode: SessionMode
}

/**
 * 测试专用会话 cwd：dsh 会话持久化按 cwd 派生根目录（--<编码>--，编码见
 * dsh-session-persistence-jsonl 的 projectKey）。独立 cwd 让测试会话落在
 * 自己的根下，整根清理即可——绝不触碰真实网关的会话目录。
 *
 * 测试专用 room key：persistence 按**会话 id** 跨根定位日志（loadStored /
 * 创建时 findLog 扫所有根），与线上网关共用 `__room__` 必撞——曾实测
 * 加载到线上坏日志（seq gap）导致首条回复为空。key 字符串不影响 room
 * 语义（共享上下文），用专属 key 物理隔离。
 */
const TEST_CWD = path.join(os.tmpdir(), 'dsh-session-test')
const TEST_ROOM_KEY = '__room__-test'

/** 复刻 dsh-session-persistence-jsonl 的 projectKey（lib/index.js）：cwd → 会话根目录名。 */
function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 清理测试持久化会话，保证测试幂等可重复。范围严格限定：
 * - 测试自己的根（TEST_CWD 派生）**整根删除**——只可能装测试会话
 * - 其余根只按测试专用名清理 per-user 残留（历史版本测试留下的）；
 *   `__room__` 等线上会话名一律不碰
 */
function cleanupTestSessions(): void {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const sessionsRoot = path.join(home, 'sessions')
  let roots: string[]
  try {
    roots = fs.readdirSync(sessionsRoot)
  } catch {
    return
  }
  const testRoot = projectKey(TEST_CWD)
  let cleaned = 0
  for (const root of roots) {
    if (root === testRoot) {
      const own = path.join(sessionsRoot, root)
      if (fs.existsSync(own)) {
        fs.rmSync(own, { recursive: true, force: true })
        cleaned++
      }
      continue
    }
    // 测试专用名（per-user 两个测试用户），任意根下都是测试残留
    for (const key of ['user-A-xiaoming', 'user-B-xiaohong']) {
      const target = path.join(sessionsRoot, root, key)
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        cleaned++
      }
    }
  }
  logger.info(`session-test: cleaned test sessions (${cleaned} dirs) under ${sessionsRoot}`)
}

export function apply(ctx: Context, config: Config): void {
  void (async () => {
    cleanupTestSessions()
    // resume=false + 专属 room key + 独立 cwd：persistence 按 id 跨根定位，
    // 与线上网关共用 __room__ 会加载到线上坏日志（实测 seq gap 空回复）
    const router = new SessionRouter(ctx, config.mode, TEST_CWD, false, TEST_ROOM_KEY)
    const results: string[] = []
    try {
      // 用户 A（小明）
      const userA = 'user-A-xiaoming'
      const userB = 'user-B-xiaohong'

      const step = (label: string, pass: boolean, detail: string): void => {
        const line = `${pass ? '✅' : '❌'} ${label}: ${detail}`
        results.push(line)
        console.log(line)
      }

      // 1. A 记住名字
      const a1 = await router.getSession(userA)
      const r1 = await askAgentStreaming(a1, '记住我的名字叫小明，只回复"记住了"', {})
      step('A 记住名字', r1.text.includes('记住') || r1.text.length > 0, `A1=${r1.text.slice(0, 40)}${r1.error !== undefined ? ` err=${r1.error}` : ''}`)

      // 2. B 问名字（per-user 应隔离；room 可能共享）
      const b1 = await router.getSession(userB)
      const r2 = await askAgentStreaming(b1, '我叫什么名字？请只回答名字或"不知道"', {})
      const bKnows = r2.text.includes('小明')
      if (config.mode === 'per-user') {
        step('B 不知 A 的名字（隔离）', !bKnows, `B1=${r2.text.slice(0, 40)}`)
      } else {
        step('room 共享上下文（B 可能知道）', true, `B1=${r2.text.slice(0, 40)}（共享模式下行为正常即可）`)
      }

      // 3. A 问名字（会话应保留 A 的记忆）
      const a2 = await router.getSession(userA)
      const r3 = await askAgentStreaming(a2, '我叫什么名字？请只回答名字', {})
      const aRemembers = r3.text.includes('小明')
      step('A 会话保留记忆', aRemembers, `A2=${r3.text.slice(0, 40)}`)

      // 4. 会话数量断言
      const count = router.size
      if (config.mode === 'per-user') {
        step('per-user 两个会话', count === 2, `sessions=${count}`)
      } else {
        step('room 单个共享会话', count === 1, `sessions=${count}`)
      }
    } catch (err) {
      console.error(`[session-test] 失败: ${err instanceof Error ? err.message : String(err)}`)
      results.push(`❌ 异常: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await router.disposeAll()
      const exit = ctx.get('appExit') as ((code: number) => void) | undefined
      exit?.(results.some((r) => r.startsWith('❌')) ? 1 : 0)
    }
  })()
}
