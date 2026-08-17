/**
 * session-router — 微信用户 ↔ dsh agent 会话路由。
 *
 * 两种模式：
 *  - per-user：每个微信用户一个独立 agent 会话（互不干扰，多用户隔离）
 *  - room：所有用户共享同一个 agent 会话（统一房间，上下文互通）
 *
 * 注意：当前 dsh headless profile 无会话持久化后端（sessionPersistence），
 * 会话仅存于进程内存，网关重启后会话丢失。
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

  constructor(
    private readonly ctx: Context,
    mode: SessionMode,
  ) {
    this.mode = mode
    logger.info(`session-router: mode=${mode}`)
  }

  /** 取某用户的 agent 会话：优先恢复持久化会话，否则新建。 */
  async getSession(userId: string): Promise<AgentHandle> {
    const key = this.mode === 'room' ? ROOM_KEY : userId
    let handle = this.handles.get(key)
    if (!handle) {
      const label = this.mode === 'room' ? 'room' : `user ${userId}`
      // 有持久化后端时尝试恢复（stable sessionId = key）
      try {
        handle = await resumeGatewayAgent(this.ctx, key)
        logger.info(`session-router: resumed persisted session for ${label}`)
      } catch {
        handle = await createGatewayAgent(this.ctx, undefined, key)
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
