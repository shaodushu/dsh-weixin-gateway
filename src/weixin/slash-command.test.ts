/**
 * slash-command 单元测试：解析、授权矩阵、路由、管理员列表解析、执行器。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  handleSlashMessage,
  isSlashCommandAuthorized,
  parseAdminUserIds,
  parseSlashCommand,
  resolveAdminUserIds,
  routeSlashCommand,
} from './slash-command.js'
import type { SessionRouter } from './session-router.js'

describe('parseSlashCommand', () => {
  it('解析 /help 与带参数命令', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: [] })
    expect(parseSlashCommand('/cron list')).toEqual({ name: 'cron', args: ['list'] })
    expect(parseSlashCommand('/cron list  extra ')).toEqual({ name: 'cron', args: ['list', 'extra'] })
  })

  it('非 / 开头或纯 / 返回 null', () => {
    expect(parseSlashCommand('你好')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('/  ')).toBeNull()
  })

  it("未命中命令表的名（'/tmp 目录'）也能解析出名字（路由层决定放行）", () => {
    expect(parseSlashCommand('/tmp 目录说明')).toEqual({ name: 'tmp', args: ['目录说明'] })
  })
})

describe('isSlashCommandAuthorized', () => {
  const admin = new Set(['admin-user'])

  it('管理员恒有权限', () => {
    for (const name of ['help', 'reset', 'status', 'cron']) {
      expect(
        isSlashCommandAuthorized({ name }, { userId: 'admin-user', adminUserIds: admin, sessionMode: 'room' }),
      ).toBe(true)
    }
  })

  it('help 所有人可用', () => {
    expect(
      isSlashCommandAuthorized({ name: 'help' }, { userId: 'nobody', adminUserIds: new Set(), sessionMode: 'room' }),
    ).toBe(true)
  })

  it('reset 在 per-user 模式免授权（重置自己会话）', () => {
    expect(
      isSlashCommandAuthorized({ name: 'reset' }, { userId: 'nobody', adminUserIds: new Set(), sessionMode: 'per-user' }),
    ).toBe(true)
  })

  it('reset 在 room 模式需授权（共享会话）', () => {
    expect(
      isSlashCommandAuthorized({ name: 'reset' }, { userId: 'nobody', adminUserIds: new Set(), sessionMode: 'room' }),
    ).toBe(false)
  })

  it('status / cron 非管理员拒绝', () => {
    expect(
      isSlashCommandAuthorized({ name: 'status' }, { userId: 'nobody', adminUserIds: new Set(), sessionMode: 'per-user' }),
    ).toBe(false)
    expect(
      isSlashCommandAuthorized({ name: 'cron' }, { userId: 'nobody', adminUserIds: new Set(), sessionMode: 'per-user' }),
    ).toBe(false)
  })
})

describe('routeSlashCommand', () => {
  const base = {
    userId: 'nobody',
    adminUserIds: new Set<string>(),
    sessionMode: 'per-user' as const,
  }

  it('非命令消息 → not-command', () => {
    expect(routeSlashCommand({ text: '你好呀', ...base })).toEqual({ kind: 'not-command' })
  })

  it('命中已授权命令 → handled', () => {
    expect(routeSlashCommand({ text: '/help', ...base })).toEqual({
      kind: 'handled',
      command: 'help',
      args: [],
    })
    expect(routeSlashCommand({ text: '/cron list', ...base })).toEqual({
      kind: 'not-authorized',
    })
  })

  it('未命中命令表 → unknown（放行给 agent，不误伤 "/tmp 目录"）', () => {
    expect(routeSlashCommand({ text: '/tmp 目录在哪', ...base })).toEqual({ kind: 'unknown' })
  })

  it('需要授权的命令且非管理员 → not-authorized', () => {
    expect(routeSlashCommand({ text: '/status', ...base })).toEqual({ kind: 'not-authorized' })
    expect(routeSlashCommand({ text: '/reset', ...base })).toEqual({
      kind: 'handled',
      command: 'reset',
      args: [],
    }) // per-user 下 reset 免授权
  })
})

describe('parseAdminUserIds', () => {
  it('逗号分隔、trim、去空', () => {
    expect(parseAdminUserIds({ WECHAT_ADMIN_IDS: 'a, b ,,c,' })).toEqual(new Set(['a', 'b', 'c']))
  })

  it('空 env → 空集', () => {
    expect(parseAdminUserIds({})).toEqual(new Set())
  })
})

describe('handleSlashMessage（执行器）', () => {
  const fakeRouter = {
    size: 2,
    reset: vi.fn(async () => undefined),
  } as unknown as SessionRouter

  function makeDeps(over: { loadJobs?: () => unknown } = {}) {
    const send = vi.fn(async () => undefined)
    const deps = {
      accountId: 'acct@im.bot',
      sessionMode: 'per-user' as const,
      router: fakeRouter,
      send,
      ...over,
    }
    return { deps, send }
  }

  it('/help 回复帮助文本并消费消息', async () => {
    const { deps, send } = makeDeps()
    expect(await handleSlashMessage(deps, { text: '/help', userId: 'u1' })).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toContain('/help')
  })

  it('/reset per-user 调用 router.reset 并消费', async () => {
    const { deps, send } = makeDeps()
    fakeRouter.reset.mockClear()
    expect(await handleSlashMessage(deps, { text: '/reset', userId: 'u1' })).toBe(true)
    expect(fakeRouter.reset).toHaveBeenCalledWith('u1')
    expect(send.mock.calls[0][0]).toContain('会话已重置')
  })

  it('/status 输出账号/模式/会话数并消费', async () => {
    const before = process.env.WECHAT_ADMIN_IDS
    process.env.WECHAT_ADMIN_IDS = 'admin' // handleSlashMessage 授权读 env（resolveAdminUserIds）
    try {
      const { deps, send } = makeDeps()
      expect(await handleSlashMessage(deps, { text: '/status', userId: 'admin' })).toBe(true)
      const text = send.mock.calls[0][0]
      expect(text).toContain('acct@im.bot')
      expect(text).toContain('per-user')
    } finally {
      if (before !== undefined) process.env.WECHAT_ADMIN_IDS = before
      else delete process.env.WECHAT_ADMIN_IDS
    }
  })

  it('未授权命令 → 提示权限并消费（不给 agent）', async () => {
    const { deps, send } = makeDeps()
    // 无 WECHAT_ADMIN_IDS 环境变量时 status 需授权
    expect(await handleSlashMessage(deps, { text: '/status', userId: 'u1' })).toBe(true)
    expect(send.mock.calls[0][0]).toContain('管理员权限')
  })

  it('未命中命令表 → 返回 false 放行给 agent', async () => {
    const { deps, send } = makeDeps()
    expect(await handleSlashMessage(deps, { text: '/tmp 目录在哪', userId: 'u1' })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('命令执行异常 → 回复错误并仍消费消息', async () => {
    const router = {
      size: 0,
      reset: vi.fn(async () => {
        throw new Error('dispose boom')
      }),
    } as unknown as SessionRouter
    const send = vi.fn(async () => undefined)
    const { handleSlashMessage: handle } = await import('./slash-command.js')
    const { deps } = makeDeps()
    expect(
      await handle(
        { ...deps, router, send },
        { text: '/reset', userId: 'u1' },
      ),
    ).toBe(true)
    expect(send.mock.calls[0][0]).toContain('命令执行失败')
  })
})

describe('resolveAdminUserIds', () => {
  it('无配置时返回空集（不抛错）', () => {
    const before = process.env.WECHAT_ADMIN_IDS
    delete process.env.WECHAT_ADMIN_IDS
    try {
      expect(resolveAdminUserIds().size).toBe(0)
    } finally {
      if (before !== undefined) process.env.WECHAT_ADMIN_IDS = before
    }
  })
})
