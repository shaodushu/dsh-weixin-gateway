/**
 * versionGt 单元测试（dsh-weixin update 判断是否有新版本）。
 *
 * 历史坑：早期用字符串比较，"0.2.10" < "0.2.9" → 永远提示已是最新，
 * 更新命令失效。现按数字段逐段比较。
 */
import { describe, expect, it } from 'vitest'

import { versionGt } from './version.js'

describe('versionGt', () => {
  it('同版本号不视为更新', () => {
    expect(versionGt('0.2.6', '0.2.6')).toBe(false)
  })

  it('任一层级更大即视为更新', () => {
    expect(versionGt('0.3.0', '0.2.9')).toBe(true)
    expect(versionGt('1.0.0', '0.99.99')).toBe(true)
    expect(versionGt('0.2.9', '0.2.8')).toBe(true)
  })

  it('位数不同的版本按数值段比较（0.2.10 > 0.2.9，非字符串序）', () => {
    expect(versionGt('0.2.10', '0.2.9')).toBe(true)
    expect(versionGt('0.2.9', '0.2.10')).toBe(false)
    expect(versionGt('0.2.10.1', '0.2.10')).toBe(true)
    expect(versionGt('0.2', '0.1.9')).toBe(true)
    expect(versionGt('0.2', '0.2.1')).toBe(false)
  })

  it('非数字段不抛错（防御，结果为 false）', () => {
    expect(() => versionGt('0.2.x', '0.2.6')).not.toThrow()
    expect(versionGt('0.2.x', '0.2.6')).toBe(false)
  })
})
