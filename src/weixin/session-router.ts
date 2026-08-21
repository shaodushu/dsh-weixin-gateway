/**
 * session-router — 微信用户 ↔ dsh agent 会话路由。
 *
 * 两种模式：
 *  - per-user：每个微信用户一个独立 agent 会话（互不干扰，多用户隔离）
 *  - room：所有用户共享同一个 agent 会话（统一房间，上下文互通）
 *
 * 注意：会话持久化已生效——headless profile 装配了 dsh-session-persistence-jsonl
 * （~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd），getSession 按
 * 稳定 id（room key / userId）resume、按 id 跨根定位，网关重启后上下文延续
 * （实测 2026-08-20：daemon 重启后日志 "resumed persisted session for room"）。
 * resume 失败（后端不可用/会话不存在）时回退新建。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

import { createGatewayAgent, resumeGatewayAgent } from '../bridge.js'
import { logger } from './util/logger.js'

export type SessionMode = 'per-user' | 'room'

/** 房间模式的统一会话 key。 */
const ROOM_KEY = '__room__'

export class SessionRouter {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly mode: SessionMode
  private readonly roomKey: string

  constructor(
    private readonly ctx: Context,
    mode: SessionMode,
    /** 会话 cwd（缺省 process.cwd()）。测试注入独立 cwd 以隔离持久化根目录。 */
    private readonly cwd?: string,
    /** 是否尝试恢复持久化会话。测试禁用：persistence 按 id 跨根扫描，恢复/创建都可能撞上真实网关的同名会话。 */
    private readonly resume = true,
    /** 房间模式会话 key（缺省 __room__）。测试用专属 key：persistence 按 id 跨根定位，与线上共用 __room__ 必撞。 */
    roomKey = ROOM_KEY,
  ) {
    this.mode = mode
    this.roomKey = roomKey
    logger.info(`session-router: mode=${mode}`)
  }

  /** 取某用户的 agent 会话：优先恢复持久化会话，否则新建。 */
  async getSession(userId: string): Promise<AgentHandle> {
    const key = this.mode === 'room' ? this.roomKey : userId
    let handle = this.handles.get(key)
    if (!handle) {
      const label = this.mode === 'room' ? 'room' : `user ${userId}`
      if (this.resume) {
        // 有持久化后端时尝试恢复（stable sessionId = key）
        try {
          handle = await resumeGatewayAgent(this.ctx, key)
          logger.info(`session-router: resumed persisted session for ${label}`)
        } catch {
          handle = undefined
        }
      }
      if (!handle) {
        handle = await createGatewayAgent(this.ctx, this.cwd, key)
        logger.info(`session-router: created fresh agent session for ${label}`)
      }
      this.handles.set(key, handle)
    }
    return handle
  }

  /** 当前会话数。 */
  get size(): number {
    return this.handles.size
  }

  /**
   * 关闭并移除某用户的会话句柄（per-user 模式 key=userId；room 模式 key=roomKey）。
   * dispose 失败仅告警不抛；下次 getSession 自动重建（`/reset` 命令用）。
   * 安全性：轮询串行处理消息，reset 发生时不存在该会话正在流式生成消息的并发窗口。
   */
  async reset(userId: string): Promise<void> {
    const key = this.mode === 'room' ? this.roomKey : userId
    const handle = this.handles.get(key)
    if (!handle) return
    await handle.dispose().catch((err) => {
      logger.warn(`session-router: reset ${key} failed: ${String(err)}`)
    })
    this.handles.delete(key)
    logger.info(`session-router: reset session for ${this.mode === 'room' ? 'room' : `user ${userId}`}`)
  }

  /** 关闭全部会话。 */
  async disposeAll(): Promise<void> {
    for (const [key, handle] of this.handles) {
      await handle.dispose().catch((err) => {
        logger.warn(`session-router: dispose ${key} failed: ${String(err)}`)
      })
    }
    this.handles.clear()
  }
}
