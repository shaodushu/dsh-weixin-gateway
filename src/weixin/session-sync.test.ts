/**
 * session-sync 单测：扫描/自愈 zstd 会话文件。
 * 用 dsh-session 的 Session + packChunkRuns 构造真实格式的会话文件。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, SessionId, packChunkRuns } from '@deepseek-ai/dsh-session'
import { decompressAllFrames, scanAndRepairSessionLog } from './session-sync.js'

/** 构造一个 zstd 会话文件：header + 若干 turn/start 事件。 */
function buildSessionFile(dir: string, name: string, turns: number): string {
  const session = Session.create(SessionId('__sync-test__'), undefined, {
    cwd: '/tmp',
    createdAt: Date.now(),
    delegationDepth: 0,
    id: '__sync-test__',
    version: 0,
  })
  for (let i = 0; i < turns; i++) session.append('turn/start', { turn: i })
  const header = {
    type: 'session',
    version: 0,
    id: '__sync-test__',
    createdAt: Date.now(),
    cwd: '/tmp',
    delegationDepth: 0,
  }
  const lines = [JSON.stringify(header)]
  for (const record of packChunkRuns(session.events)) {
    lines.push(JSON.stringify(record))
  }
  const file = join(dir, name)
  writeFileSync(file, zstdCompressSync(lines.join('\n') + '\n'))
  return file
}

/** 读回解压后的行（多帧感知）。 */
function readLines(file: string): string[] {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  return decompressAllFrames(readFileSync(file)).toString('utf8').split('\n')
}

describe('scanAndRepairSessionLog', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-sync-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('有效文件 → ok，事件数正确', async () => {
    const file = buildSessionFile(dir, 'good.zst', 5)
    const result = await scanAndRepairSessionLog(file)
    expect(result.outcome).toBe('ok')
    expect(result.validEvents).toBe(5)
    // 文件未被改写
    const lines = readLines(file)
    expect(lines.filter((l) => l !== '').length).toBe(6) // header + 5
  })

  it('seq 错位（双写损坏）→ repaired，有效前缀保留且连续', async () => {
    const file = buildSessionFile(dir, 'corrupt.zst', 8)
    // 把最后一个事件行的 seq 改成错位值（模拟 web 用陈旧计数追加）
    const lines = readLines(file).filter((l) => l !== '')
    const last = JSON.parse(lines[lines.length - 1])
    last.seq = last.seq - 100 // 回退 → gap
    lines[lines.length - 1] = JSON.stringify(last)
    writeFileSync(file, zstdCompressSync(lines.join('\n') + '\n'))

    const result = await scanAndRepairSessionLog(file)
    expect(result.outcome).toBe('repaired')
    expect(result.validEvents).toBe(7) // 前缀 7 条，坏行被截掉

    // 修复后文件可完整重扫且连续
    const second = await scanAndRepairSessionLog(file)
    expect(second.outcome).toBe('ok')
    expect(second.validEvents).toBe(7)
  })

  it('垃圾字节（帧损坏）→ unrepairable，文件不动', async () => {
    const file = join(dir, 'junk.zst')
    writeFileSync(file, Buffer.from('this is not zstd at all'))
    const result = await scanAndRepairSessionLog(file)
    expect(result.outcome).toBe('unrepairable')
    expect(require('node:fs').readFileSync(file).toString('utf8')).toBe(
      'this is not zstd at all',
    )
  })

  it('文件不存在 → unrepairable', async () => {
    const result = await scanAndRepairSessionLog(join(dir, 'missing.zst'))
    expect(result.outcome).toBe('unrepairable')
  })

  it('header 之后第一条就坏（无有效前缀）→ unrepairable，文件不动', async () => {
    const session = Session.create(SessionId('__sync-test__'))
    session.append('turn/start', { turn: 0 })
    const header = {
      type: 'session',
      version: 0,
      id: '__sync-test__',
      createdAt: Date.now(),
      cwd: '/tmp',
      delegationDepth: 0,
    }
    const lines = [JSON.stringify(header)]
    for (const record of packChunkRuns(session.events)) {
      const r = JSON.parse(JSON.stringify(record)) as { seq?: number }
      if (typeof r.seq === 'number') r.seq += 5 // 第一条事件就错位
      lines.push(JSON.stringify(r))
    }
    const file = join(dir, 'broken-head.zst')
    writeFileSync(file, zstdCompressSync(lines.join('\n') + '\n'))

    const result = await scanAndRepairSessionLog(file)
    expect(result.outcome).toBe('unrepairable')
  })

  it('多帧文件（真实 flush 模式：每批一帧）→ 扫描/修复均正确', async () => {
    const session = Session.create(SessionId('__sync-test__'))
    for (let i = 0; i < 10; i++) session.append('turn/start', { turn: i })
    const header = {
      type: 'session',
      version: 0,
      id: '__sync-test__',
      createdAt: Date.now(),
      cwd: '/tmp',
      delegationDepth: 0,
    }
    const records = packChunkRuns(session.events)
    // header 单独一帧 + 每 3 条事件一帧（模拟多次 flush 追加）
    const frames = [zstdCompressSync(JSON.stringify(header) + '\n')]
    for (let i = 0; i < records.length; i += 3) {
      const batch = records
        .slice(i, i + 3)
        .map((r) => JSON.stringify(r))
        .join('\n')
      frames.push(zstdCompressSync(batch + '\n'))
    }
    const file = join(dir, 'multi-frame.zst')
    writeFileSync(file, Buffer.concat(frames))

    // 有效多帧 → ok，事件数正确
    const result = await scanAndRepairSessionLog(file)
    expect(result.outcome).toBe('ok')
    expect(result.validEvents).toBe(10)

    // 把最后一帧的事件 seq 改坏 → repaired，有效前缀保留
    const lines = readLines(file).filter((l) => l !== '')
    const last = JSON.parse(lines[lines.length - 1])
    last.seq = last.seq - 100
    lines[lines.length - 1] = JSON.stringify(last)
    writeFileSync(
      file,
      Buffer.concat([
        zstdCompressSync(lines[0] + '\n'),
        zstdCompressSync(lines.slice(1).join('\n') + '\n'),
      ]),
    )

    const repaired = await scanAndRepairSessionLog(file)
    expect(repaired.outcome).toBe('repaired')
    expect(repaired.validEvents).toBe(9)
    const second = await scanAndRepairSessionLog(file)
    expect(second.outcome).toBe('ok')
    expect(second.validEvents).toBe(9)
  })
})
