/**
 * streaming-sender 单元测试（vitest）。
 *
 * 背景：流式发送器把 agent 文本增量拆分为 媒体标记（[image:]/[video:]/
 * [file:]/[tts:] 与 markdown ![..](..)）+ 普通文本。曾因事件流只订阅
 * text-delta 漏掉工具调用后的聚合文本块（见 bridge.ts applyStreamChunk
 * 兜底），本测试覆盖发送器自身的拆分/延迟/幂等语义。
 */
import { describe, expect, it } from 'vitest'

import { SendMessageError } from './api/api.js'
import {
  AGGREGATE_SEGMENT_MAX,
  AGGREGATE_SINGLE_MAX,
  STUCK_THRESHOLD,
  WeixinStreamingSender,
  splitAggregate,
} from './streaming-sender.js'

/** 构造发送器：收集 sendText 发出的文本，返回 { sender, sent }。 */
function makeSender(opts?: { mode?: 'stream' | 'aggregate' }) {
  const sent: string[] = []
  const sender = new WeixinStreamingSender(
    async (text) => {
      sent.push(text)
    },
    undefined,
    { ...opts, intervalMs: 0, retryBaseMs: 0 }, // 测试中段间隔/重试间隔置 0，避免慢测
  )
  return { sender, sent }
}

describe('WeixinStreamingSender', () => {
  it('完整文本：媒体标记行剥离收集，文本单独返回（杯子场景）', async () => {
    const { sender, sent } = makeSender()
    sender.feed('画好了，和你发的那个保温杯对应的：\n\n[image:/tmp/cup.png]')
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([{ path: '/tmp/cup.png', caption: '' }])
    expect(r.textParts).toEqual(['画好了，和你发的那个保温杯对应的：'])
    expect(sent).toEqual([]) // 未达阈值，不增量发送
  })

  it('增量切分：标记跨多个 delta 也能完整提取', async () => {
    const { sender } = makeSender()
    sender.feed('好的，图片：\n\n[image:/tmp/xx')
    sender.feed('xx.png]')
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([{ path: '/tmp/xxxx.png', caption: '' }])
    expect(r.textParts).toEqual(['好的，图片：'])
  })

  it('未完成标记在中间 delta 不误提取、不误发', async () => {
    const { sender } = makeSender()
    sender.feed('等等[image:/tmp/partial.pn')
    // 尚未闭合 → 保留 pending，不产生 media
    const r1 = await sender.flush()
    expect(r1.mediaParts).toEqual([])
    // flush 时未闭合的标记行按文本输出（不丢内容）
    expect(r1.textParts).toEqual(['等等[image:/tmp/partial.pn'])
  })

  it('[tts:] 标记收集为 ttsText，不作为媒体', async () => {
    const { sender } = makeSender()
    sender.feed('[tts:你好呀]\n文字回复')
    const r = await sender.flush()
    expect(r.ttsText).toBe('你好呀')
    expect(r.mediaParts).toEqual([])
    expect(r.textParts).toEqual(['文字回复'])
  })

  it('完整 markdown 图片 ![..](..) 被 filter 安全过滤删除（不产生媒体）', async () => {
    // StreamingMarkdownFilter 会整体删除完整 markdown 图片（微信不渲染 markdown 图片，
    // 防乱码）；extractMarkers 的 ![..](..) 分支只处理 filter 未删净的残缺边界。
    // 注意：AGENTS.md 声称支持 markdown 图片语法，与实现矛盾，待决策。
    const { sender, sent } = makeSender()
    sender.feed('看这张：\n\n![示意图](/tmp/diagram.png)\n后面的话')
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([])
    expect(r.textParts).toEqual(['看这张：', '后面的话'])
    expect(sent).toEqual([])
  })

  it('非行首的 [image:] 当普通文本（标记必须独立行首）', async () => {
    const { sender } = makeSender()
    sender.feed('文字[image:/tmp/a.png]更多文字')
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([])
    expect(r.textParts).toEqual(['文字[image:/tmp/a.png]更多文字'])
  })

  it('标记行尾随文字作为 caption', async () => {
    const { sender } = makeSender()
    sender.feed('[image:/tmp/a.png] 这是生成的图片')
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([{ path: '/tmp/a.png', caption: '这是生成的图片' }])
    expect(r.textParts).toEqual([])
  })

  it('累积超过阈值（80 字符）时增量发送', async () => {
    const { sender, sent } = makeSender()
    sender.feed('一'.repeat(50))
    sender.feed('二'.repeat(50))
    await sender.flush()
    // 100 字符超过阈值 → 第二次 feed 后累积 100 → queueSend
    expect(sent.join('')).toBe('一'.repeat(50) + '二'.repeat(50))
  })

  it('阈值发送与标记提取互不干扰（长文本中段出现独立标记行）', async () => {
    const { sender, sent } = makeSender()
    const prefix = '前'.repeat(60)
    const suffix = '后'.repeat(40)
    sender.feed(prefix + '\n[image:/tmp/mid.png]\n' + suffix)
    const r = await sender.flush()
    // 标记被剥离；剩余文本超阈值 → 增量发送
    expect(r.mediaParts).toEqual([{ path: '/tmp/mid.png', caption: '' }])
    expect(sent.join('')).toBe(prefix + '\n' + suffix)
  })

  it('空输入 flush → 全空', async () => {
    const { sender } = makeSender()
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([])
    expect(r.ttsText).toBeUndefined()
    expect(r.textParts).toEqual([])
  })

  it('sendText 失败不中断 flush（队列吞错）', async () => {
    const sender = new WeixinStreamingSender(async () => {
      throw new Error('send fail')
    })
    sender.feed('一'.repeat(100)) // 触发 queueSend
    const r = await sender.flush()
    expect(r.textParts).toEqual([])
    expect(sender.sent).toBe(0) // 失败不计入 sent
  })

  it(`连续失败 ${STUCK_THRESHOLD} 次 → onStuck 回调一次（发送通道兜底提示）`, async () => {
    let stuck = 0
    const sender = new WeixinStreamingSender(
      async () => {
        throw new Error('send fail')
      },
      () => stuck++,
    )
    for (let i = 0; i < STUCK_THRESHOLD + 1; i++) {
      sender.feed(`第${i}段` + '一'.repeat(100)) // 每段触发一次 queueSend
    }
    await sender.flush()
    expect(stuck).toBe(1) // 触发一次，不重复
  })

  it('发送成功打断连续失败计数：跨过阈值不误报，后续连续失败仍触发', async () => {
    let stuck = 0
    let fail = true
    const sender = new WeixinStreamingSender(
      async () => {
        if (fail) throw new Error('send fail')
      },
      () => stuck++,
    )
    // 失败 2 次 → 成功 1 次（计数清零）→ 再失败 3 次 → 触发
    for (let i = 0; i < 2; i++) {
      sender.feed('一'.repeat(100))
      await sender.flush()
    }
    fail = false
    sender.feed('一'.repeat(100))
    await sender.flush()
    fail = true
    for (let i = 0; i < STUCK_THRESHOLD; i++) {
      sender.feed('一'.repeat(100))
      await sender.flush()
    }
    expect(stuck).toBe(1)
  })

  it('全部发送成功 → onStuck 不触发', async () => {
    let stuck = 0
    const sender = new WeixinStreamingSender(
      async () => undefined,
      () => stuck++,
    )
    for (let i = 0; i < 10; i++) sender.feed('一'.repeat(100))
    await sender.flush()
    expect(stuck).toBe(0)
  })

  it('单词跨 delta 停顿不被阈值截断（km 与 /h 分两次到达）', async () => {
    // 实测（2026-08-20）：模型在 "km" 与 "/h" 间停顿 670ms，80 字阈值在
    // "km" 处触发，把 "微风 1.6 km" 发出、"/h" 落到下一条开头。
    const { sender, sent } = makeSender()
    const prefix = 'x'.repeat(70) + '微风 1.6 ' // 78 字符，与 "km" 凑够 80 触发阈值
    sender.feed(prefix)
    sender.feed('km') // 阈值触发点：单词尾巴必须留在 pending
    sender.feed('/h')
    sender.feed('\n\n未来 3 天预报。')
    const r = await sender.flush()
    // 阈值分片不包含不完整单词尾巴（旧行为 sent=['…km']，"/h" 甩到下一段）；
    // queueSend 会 trim 尾随空格
    expect(sent.join('')).toBe(prefix.trimEnd())
    // 尾巴与后续内容在 flush 完整合并，"km/h" 不被劈开（flush 按行分段）
    expect(r.textParts).toEqual(['km/h', '未来 3 天预报。'])
  })

  it('中文文本（无空格）不触发单词尾巴规则，内容完整', async () => {
    const { sender, sent } = makeSender()
    const text = '这是一段完全没有空格的中文长文本，用于验证阈值切分在 CJK 场景不受影响。'.repeat(3)
    sender.feed(text)
    const r = await sender.flush()
    expect(sent.join('') + r.textParts.join('')).toBe(text)
  })
})

describe('splitAggregate 聚合分段（纯函数）', () => {
  it('短文本（≤1500 码点）一条成文不拆', () => {
    const text = '结论：成都今天阴天。'.repeat(50) // 700 字 < 1500
    expect(splitAggregate(text)).toEqual([text])
  })

  it('空输入 → 空数组', () => {
    expect(splitAggregate('')).toEqual([])
    expect(splitAggregate('   \n ')).toEqual([])
  })

  it('超长无换行文本按 500 码点硬切，不劈 emoji/中文', () => {
    const seg = '🌧️成都'.repeat(75) // 300 码点
    const long = seg.repeat(6) // 1800 码点 > 1500
    const parts = splitAggregate(long)
    expect(parts.length).toBeGreaterThan(1)
    // 拼接无损
    expect(parts.join('')).toBe(long)
    // 每段 ≤ 500 码点（按 Unicode 码点计，不劈 emoji）
    for (const p of parts) expect(Array.from(p).length).toBeLessThanOrEqual(AGGREGATE_SEGMENT_MAX)
    // 不以半个 emoji 开头/结尾（🌧️ 是 U+1F327 + U+FE0F，被劈开时 join 会乱）
    expect(parts[0]).toMatch(/^🌧️/)
  })

  it('段落边界优先：含换行文本在段落间切', () => {
    const line = '结论：这条消息有点长，按段落切开。'.repeat(4) // ~160 码点
    const text = [line, line, line, line].join('\n') // 4 段 ~640 码点,>500
    const parts = splitAggregate(text)
    expect(parts.join('\n')).toBe(text) // 段落结构保留
    expect(parts.every((p) => Array.from(p).length <= AGGREGATE_SEGMENT_MAX)).toBe(true)
  })

  it('段内 trim：首尾空白不残留', () => {
    const text = '  '.concat('a'.repeat(AGGREGATE_SINGLE_MAX + 100), '  ')
    const parts = splitAggregate(text)
    expect(parts.join('')).toBe('a'.repeat(AGGREGATE_SINGLE_MAX + 100))
  })
})

describe('WeixinStreamingSender 聚合模式', () => {
  it('feed 只累积不发送，flush 后一条成文发出（textParts 空防重复）', async () => {
    const { sender, sent } = makeSender({ mode: 'aggregate' })
    sender.feed('结论：成都今天阴天，')
    sender.feed('湿度 87%，')
    sender.feed('出门记得带伞 ☔')
    // 累积超过 80 字符阈值也不发
    expect(sent).toEqual([])
    const r = await sender.flush()
    expect(sent).toEqual(['结论：成都今天阴天，湿度 87%，出门记得带伞 ☔'])
    expect(r.textParts).toEqual([])
    expect(r.ttsText).toBeUndefined()
  })

  it('聚合模式媒体标记仍正常提取（前缀文本 flush 统一发出）', async () => {
    const { sender, sent } = makeSender({ mode: 'aggregate' })
    sender.feed('画好了：\n[image:/tmp/a.png]')
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([{ path: '/tmp/a.png', caption: '' }])
    expect(sent).toEqual(['画好了：'])
  })

  it('聚合模式超长回复分段发送（多段且内容无损）', async () => {
    const { sender, sent } = makeSender({ mode: 'aggregate' })
    const text = '这是一段用于验证聚合分段的中文内容，确保超长回复不会变成碎片也不会被截断。'.repeat(25) // ~1375 码点
    sender.feed(text)
    const r = await sender.flush()
    expect(sent.join('')).toBe(text)
    expect(r.textParts).toEqual([])
    // 与 splitAggregate 结果一致（≤1500 一条成文）
    expect(sent).toEqual([text])
  })

  it('聚合模式超长（>1500）按 splitAggregate 分多条', async () => {
    const { sender, sent } = makeSender({ mode: 'aggregate' })
    const text = '超长内容'.repeat(AGGREGATE_SINGLE_MAX) // 6000 码点
    sender.feed(text)
    const r = await sender.flush()
    expect(sent.join('')).toBe(text)
    expect(r.textParts).toEqual([])
    expect(sent.length).toBeGreaterThan(1)
    for (const p of sent) expect(Array.from(p).length).toBeLessThanOrEqual(AGGREGATE_SEGMENT_MAX)
  })

  it('[tts:] 在聚合模式并入文本统一发送（不单独返回）', async () => {
    const { sender, sent } = makeSender({ mode: 'aggregate' })
    sender.feed('[tts:你好呀]\n文字回复')
    const r = await sender.flush()
    expect(r.ttsText).toBeUndefined()
    expect(r.textParts).toEqual([])
    expect(sent).toEqual(['你好呀\n文字回复'])
  })
})

describe('发送失败分流（阶段2：ret=-2 分流 + 重试）', () => {
  it('rate limited 限流错误指数退避重试，恢复后内容完整补发', async () => {
    let attempts = 0
    const sent: string[] = []
    const sender = new WeixinStreamingSender(
      async (text) => {
        attempts++
        if (attempts < 3) throw new SendMessageError(-2, 'rate limited')
        sent.push(text)
      },
      () => {
        throw new Error('onStuck 不应触发')
      },
      { retryBaseMs: 0 },
    )
    sender.feed('一'.repeat(100))
    await sender.flush()
    expect(attempts).toBe(3) // 2 次重试 + 1 次成功
    expect(sent.join('')).toBe('一'.repeat(100))
  })

  it('限流重试 3 次耗尽后计入失败，连续 3 次触发 onStuck(rate)', async () => {
    const reasons: string[] = []
    const sender = new WeixinStreamingSender(
      async () => {
        throw new SendMessageError(-2, 'rate limited')
      },
      (reason) => reasons.push(reason),
      { retryBaseMs: 0 },
    )
    for (let i = 0; i < STUCK_THRESHOLD; i++) {
      sender.feed('一'.repeat(100))
      await sender.flush()
    }
    expect(reasons).toEqual(['rate'])
  })

  it('context 冻结（prepare failed）首次即触发 onStuck(context)，后续分片跳过发送', async () => {
    const reasons: string[] = []
    let sendCalls = 0
    const sender = new WeixinStreamingSender(
      async () => {
        sendCalls++
        throw new SendMessageError(-2, 'prepare failed')
      },
      (reason) => reasons.push(reason),
      { retryBaseMs: 0 },
    )
    for (let i = 0; i < 5; i++) {
      sender.feed('一'.repeat(100))
      await sender.flush()
    }
    // 首次失败即提示，后续不再打 API（不盲目重试）
    expect(reasons).toEqual(['context'])
    expect(sendCalls).toBe(1)
  })

  it('裸 -2（errmsg 空）同样判为 context 冻结', async () => {
    const reasons: string[] = []
    const sender = new WeixinStreamingSender(
      async () => {
        throw new SendMessageError(-2, '')
      },
      (reason) => reasons.push(reason),
      { retryBaseMs: 0 },
    )
    sender.feed('一'.repeat(100))
    await sender.flush()
    expect(reasons).toEqual(['context'])
  })

  it('普通错误（无 ret 信息）→ reason=other，按 3 次计数触发', async () => {
    const reasons: string[] = []
    const sender = new WeixinStreamingSender(
      async () => {
        throw new Error('network down')
      },
      (reason) => reasons.push(reason),
      { retryBaseMs: 0 },
    )
    for (let i = 0; i < STUCK_THRESHOLD; i++) {
      sender.feed('一'.repeat(100))
      await sender.flush()
    }
    expect(reasons).toEqual(['other'])
  })

  it('SendMessageError 分类：rate limited=retryable，prepare failed/裸-2=contextFrozen', () => {
    expect(new SendMessageError(-2, 'rate limited').retryable).toBe(true)
    expect(new SendMessageError(-2, 'rate limited').contextFrozen).toBe(false)
    expect(new SendMessageError(-2, 'prepare failed').retryable).toBe(false)
    expect(new SendMessageError(-2, 'prepare failed').contextFrozen).toBe(true)
    expect(new SendMessageError(-2, '').contextFrozen).toBe(true)
    expect(new SendMessageError(-14, '').contextFrozen).toBe(false)
  })
})

describe('端到端：真实工具调用事件流 → 发送器', () => {
  it('turn 6 杯子场景：block-end 兜底文本 → 媒体+文本正确分离', async () => {
    // 与 bridge-stream.test.ts 的场景同源：模拟 applyStreamChunk 的输出
    // （工具调用后的最终文本块由 block-end 聚合兜底，无 text-delta）
    const delta = '又画了一张对应的保温杯：\n\n[image:/Users/baymax/.openclaw/weixin-dsh/media/generated/1787033343119-3mpxzw.png]'
    const { sender, sent } = makeSender()
    sender.feed(delta)
    const r = await sender.flush()
    expect(r.mediaParts).toHaveLength(1)
    expect(r.mediaParts[0]!.path).toBe('/Users/baymax/.openclaw/weixin-dsh/media/generated/1787033343119-3mpxzw.png')
    expect(r.textParts).toEqual(['又画了一张对应的保温杯：'])
    expect(sent).toEqual([])
  })

  it('多轮 turn 共享发送器：媒体各自收集、文本分段返回', async () => {
    const { sender } = makeSender()
    sender.feed('第一轮：\n[image:/tmp/1.png]')
    sender.feed('\n第二轮：\n[image:/tmp/2.png]')
    const r = await sender.flush()
    expect(r.mediaParts).toEqual([
      { path: '/tmp/1.png', caption: '' },
      { path: '/tmp/2.png', caption: '' },
    ])
    expect(r.textParts).toEqual(['第一轮：', '第二轮：'])
  })

  it('真实"画杯子"回归：37 个逐 token delta（路径被切开）前缀不丢、标记不误发', async () => {
    // 0.3.3 后 text-delta 逐 token 到达，[image:] 路径被切成几十片。曾有两个
    // 叠加 bug：①extractMarkers 对不完整标记行 this.pending = line 覆盖，
    // 前缀文本丢失；②阈值发送把未闭合的标记行当普通文本发到微信，图片丢失。
    const deltas = [
      '再', '画', '了一', '版', '：\n\n', '[', 'image', ':/', 'Users', '/b', 'ay', 'max', '/.',
      'open', 'cl', 'aw', '/', 'we', 'ixin', '-d', 'sh', '/media', '/g', 'enerated', '/',
      '178', '703', '373', '814', '3', '-', 'ts', 'yi', '5', 'd', '.png', ']',
    ]
    const { sender, sent } = makeSender()
    for (const d of deltas) sender.feed(d)
    const r = await sender.flush()
    // 媒体完整提取（旧行为 media=0）
    expect(r.mediaParts).toEqual([
      { path: '/Users/baymax/.openclaw/weixin-dsh/media/generated/1787033738143-tsyi5d.png', caption: '' },
    ])
    // 前缀文本经阈值流式发送，不丢（旧行为整体丢失，只剩 "]" 当文本）
    expect(sent).toEqual(['再画了一版：'])
    // 不完整标记行没有被当普通文本发送（旧行为 raw "[image:/..." 发出）
    expect(sent.join('')).not.toContain('[image:')
    expect(r.textParts).toEqual([])
    expect(r.ttsText).toBeUndefined()
  })
})
