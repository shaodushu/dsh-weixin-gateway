/**
 * nickname-config 单测：setup 引导"微信用户昵称"的纯逻辑。
 */
import { describe, expect, it } from 'vitest'

import { applyNicknameText, currentNickname, NICKNAME_ENV_KEY } from './nickname-config.js'

describe('currentNickname', () => {
  it('未配置返回 undefined', () => {
    expect(currentNickname({})).toBeUndefined()
  })

  it('读取配置并 trim', () => {
    expect(currentNickname({ [NICKNAME_ENV_KEY]: '  小明  ' })).toBe('小明')
  })

  it('空值视为未配置', () => {
    expect(currentNickname({ [NICKNAME_ENV_KEY]: '   ' })).toBeUndefined()
  })
})

describe('applyNicknameText', () => {
  it('无 .env（空文本）时追加键', () => {
    expect(applyNicknameText('', '小明')).toBe(`${NICKNAME_ENV_KEY}=小明\n`)
  })

  it('已有键替换值，保留无关行', () => {
    const existing = 'AI_IMAGE_KEY=abc\nWEIXIN_USER_NICKNAME=旧名\nAI_TTS_KEY=def\n'
    const next = applyNicknameText(existing, '小明')
    expect(next).toBe('AI_IMAGE_KEY=abc\nWEIXIN_USER_NICKNAME=小明\nAI_TTS_KEY=def\n')
  })

  it('重复行去重（保留首个位置）', () => {
    const existing = 'WEIXIN_USER_NICKNAME=旧名\nOTHER=1\nWEIXIN_USER_NICKNAME=重复\n'
    const next = applyNicknameText(existing, '小明')
    expect(next).toBe('WEIXIN_USER_NICKNAME=小明\nOTHER=1\n')
  })

  it('空昵称不修改', () => {
    const existing = 'A=1\n'
    expect(applyNicknameText(existing, '  ')).toBe(existing)
  })

  it('与配置相同值时不改动（幂等）', () => {
    const existing = `${NICKNAME_ENV_KEY}=小明\n`
    expect(applyNicknameText(existing, '小明')).toBe(existing)
  })
})
