/**
 * streaming-sender 单元测试（vitest）。
 *
 * 背景：流式发送器把 agent 文本增量拆分为 媒体标记（[image:]/[video:]/
 * [file:]/[tts:] 与 markdown ![..](..)）+ 普通文本。曾因事件流只订阅
 * text-delta 漏掉工具调用后的聚合文本块（见 bridge.ts applyStreamChunk
 * 兜底），本测试覆盖发送器自身的拆分/延迟/幂等语义。
 */
import { describe, expect, it } from 'vitest'

import { STUCK_THRESHOLD, WeixinStreamingSender } from './streaming-sender.js'

/** 构造发送器：收集 sendText 发出的文本，返回 { sender, sent }。 */
function makeSender() {
  const sent: string[] = []
  const sender = new WeixinStreamingSender(async (text) => {
    sent.push(text)
  })
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
