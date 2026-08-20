/**
 * StreamingMarkdownFilter 单元测试（微信不渲染 markdown → 语法剥离保内容）。
 *
 * 背景（0.4.0）：微信端不渲染 markdown——表格/粗体/行内代码等原样放行时，
 * 用户看到裸管道符/星号/反引号（实测天气回复的表格就是裸字符）。过滤器把
 * 所有 markdown 语法剥离为纯文本，保证回复规整；媒体只认 [image:] 标记行。
 */
import { describe, expect, it } from 'vitest'

import { StreamingMarkdownFilter } from './markdown-filter.js'

/** 整个文本过一遍过滤器，返回最终输出。 */
function filter(text: string): string {
  const f = new StreamingMarkdownFilter()
  let out = f.feed(text)
  out += f.flush()
  return out
}

/** 按字符逐片喂入（模拟 text-delta 流式到达），验证跨分片状态机正确。 */
function filterStreaming(text: string, chunkSize = 1): string {
  const f = new StreamingMarkdownFilter()
  let out = ''
  for (let i = 0; i < text.length; i += chunkSize) {
    out += f.feed(text.slice(i, i + chunkSize))
  }
  out += f.flush()
  return out
}

describe('StreamingMarkdownFilter', () => {
  it('普通文本原样通过', () => {
    expect(filter('你好，今天天气不错！\n第二行。')).toBe('你好，今天天气不错！\n第二行。')
  })

  it('表格：表头与分隔行丢弃，数据行转纯文本（单元格"、"连接）', () => {
    const input = '未来 3 天：\n| 日期 | 天气 | 温度 |\n|------|------|------|\n| 8月20日 | 🌦️ 小阵雨 | 21 ~ 26°C |\n| 8月21日 | 🌧️ 中毛毛雨 | 21 ~ 30°C |\n\n总结'
    const out = filter(input)
    expect(out).toBe('未来 3 天：\n8月20日，🌦️ 小阵雨，21 ~ 26°C\n8月21日，🌧️ 中毛毛雨，21 ~ 30°C\n\n总结')
    expect(out).not.toContain('|')
  })

  it('表格流式：逐字符喂入也能正确渲染', () => {
    const input = '| 日期 | 天气 |\n| --- | --- |\n| 今天 | 雨 |\n'
    expect(filterStreaming(input)).toBe('今天，雨\n')
  })

  it('单行管道文本（非表格）原样通过', () => {
    // 没有分隔行确认 → 不是表格，管道符保留（可能是公式/排版）
    expect(filter('| a | b |\n普通行')).toBe('| a | b |\n普通行')
  })

  it('表格后接普通文本行：表格正确结束', () => {
    const input = '| 日期 | 天气 |\n| --- | --- |\n| 今天 | 雨 |\n结束。'
    expect(filter(input)).toBe('今天，雨\n结束。')
  })

  it('粗体/斜体/下划线：标记剥离，内容保留（中英文一致）', () => {
    expect(filter('**加粗** 和 *斜体* 和 ***粗斜***')).toBe('加粗 和 斜体 和 粗斜')
    expect(filter('**bold** and *italic*')).toBe('bold and italic')
    expect(filter('__下划线__ _斜_ ___粗斜___')).toBe('下划线 斜 粗斜')
  })

  it('行内代码：反引号剥离，内容保留', () => {
    expect(filter('工具是 `get_weather`，命令 `dsh --help`')).toBe('工具是 get_weather，命令 dsh --help')
  })

  it('行内代码流式：反引号跨分片也能剥离', () => {
    expect(filterStreaming('用 `get_weather` 查天气')).toBe('用 get_weather 查天气')
  })

  it('代码块：围栏行丢弃，内容保留', () => {
    const input = '命令如下：\n```bash\nls -la\n```\n完成'
    expect(filter(input)).toBe('命令如下：\nls -la\n完成')
  })

  it('代码块流式：围栏跨分片处理正确', () => {
    const input = '```\ncode here\n```'
    expect(filterStreaming(input)).toBe('code here\n')
  })

  it('标题（1-6 级）：井号剥离，内容保留', () => {
    expect(filter('# 一级标题\n## 二级\n##### 五级\n###### 六级\n正文')).toBe('一级标题\n二级\n五级\n六级\n正文')
  })

  it('井号标签（无空格）不误删', () => {
    expect(filter('#tag 和 ##话题')).toBe('#tag 和 ##话题')
  })

  it('分隔线：整行丢弃', () => {
    expect(filter('上\n---\n下\n***\n再下\n___\n末')).toBe('上\n下\n再下\n末')
  })

  it('引用：标记剥离，内容保留', () => {
    expect(filter('> 引用内容\n正文')).toBe('引用内容\n正文')
  })

  it('删除线：波浪号丢弃', () => {
    expect(filter('~~删除线~~ 保留')).toBe('删除线 保留')
  })

  it('markdown 图片整体删除（媒体只用 [image:] 标记）', () => {
    // 图片行连同其后的换行保留（空行由发送器分片时自然吸收）
    expect(filter('看：\n![示意图](/tmp/d.png)\n后面')).toBe('看：\n\n后面')
  })

  it('列表项目符号（- / 1.）保留', () => {
    expect(filter('- 项目一\n- 项目二\n1. 数字一')).toBe('- 项目一\n- 项目二\n1. 数字一')
  })

  it('乘号/空格星号不误判为斜体', () => {
    expect(filter('2 * 3 = 6，a * b')).toBe('2 * 3 = 6，a * b')
  })
})
