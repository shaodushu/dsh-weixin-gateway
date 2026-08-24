/**
 * streaming-sender — 流式回复发送器（从 driver.ts 抽出，独立可测）。
 *
 * - agent 的 assistant/chunk 文本增量 → StreamingMarkdownFilter 安全分片
 * - 完整标记行（[image:]/[video:]/[file:]/[tts:]）剥离收集，不当作文本发送
 * - 普通文本累积到阈值（或 flush 时）增量发送——用户在微信看到"逐步生成"
 *
 * 回复模式（构造参数 mode）：
 * - stream（默认）：文本达 80 字符阈值即增量发送（历史行为；长回复被切成
 *   多条小消息，且同 context 高频连发易被服务端拒绝 ret=-2——见
 *   docs/reply-consolidation-research.html 调研）
 * - aggregate：生成期间只累积（+"正在输入"状态），flush 时统一发送——
 *   总长 ≤1500 码点一条成文；超长按段落切（每段 ≤500 码点、Unicode 安全），
 *   段间 500ms 串行防限流。同行经验（chatgpt-on-wechat / wechaty 社区）
 *   验证的"聚合 + 语义分片 + 节流"路线。
 *
 * 背景：工具调用后的最终文本块无 text-delta（只有 block-end 聚合文本，
 * 见 bridge.ts applyStreamChunk 的兜底），这里只负责把收到的文本增量
 * 正确拆分为 媒体标记 + 文本。
 */
import { StreamingMarkdownFilter } from './markdown-filter.js'
import { SendMessageError } from './api/api.js'
import { logger } from './util/logger.js'

/** 收集到的媒体（[image:]/[video:]/[file:] 或 markdown ![..](..)）。 */
export interface MediaPart {
  path: string
  caption?: string
}

/** flush 的返回：媒体 + TTS 文本 + 普通文本段。 */
export interface FlushResult {
  mediaParts: MediaPart[]
  ttsText: string | undefined
  textParts: string[]
}

/** 连续发送失败达到该次数时触发 onStuck（发送通道异常兜底提示）。 */
export const STUCK_THRESHOLD = 3

/** 限流（rate limited）指数退避重试：初始间隔 1s，最多 3 次（1s/2s/4s）。 */
export const RETRY_BASE_MS = 1000
export const RETRY_MAX_ATTEMPTS = 3

/** onStuck 触发原因（driver 按原因给不同提示文案）。 */
export type StuckReason = 'rate' | 'context' | 'other'

/** 聚合模式单条上限（码点）：留 2048 字符协议上限余量，中文/emoji 场景安全。 */
export const AGGREGATE_SINGLE_MAX = 1500

/** 聚合模式分段粒度（码点）：与 AGENTS.md"每段 500 字"及 chatgpt-on-wechat 一致。 */
export const AGGREGATE_SEGMENT_MAX = 500

/** 聚合模式段间发送间隔（ms）：CoW 实测 0.5~1s 防"操作频繁"。 */
export const AGGREGATE_INTERVAL_MS = 500

export type ReplyMode = 'stream' | 'aggregate'

/** 流式回复发送器。 */
export class WeixinStreamingSender {
  /** 待发送的普通文本累积（含不完整行）。 */
  private pending = ''
  /** markdown 安全分片过滤器。 */
  private readonly filter = new StreamingMarkdownFilter()
  /** 收集的媒体标记。 */
  private readonly mediaParts: MediaPart[] = []
  /** 收集的 [tts:] 文本。 */
  private readonly ttsLines: string[] = []
  /** 发送阈值（字符）。仅 stream 模式生效。 */
  private readonly threshold = 80
  /** 发送串行化链。 */
  private sendChain: Promise<void> = Promise.resolve()
  private sentCount = 0
  /** 连续发送失败计数（成功后归零）。 */
  private consecutiveFailures = 0
  /** 本次会话是否已触发过兜底提示（每个 sender 实例最多一次）。 */
  private stuckNotified = false
  /** 回复模式：aggregate=累积后统一发送（防碎片/防限流），stream=阈值增量发送。 */
  private readonly mode: ReplyMode
  /** 聚合模式段间发送间隔。 */
  private readonly intervalMs: number
  /** 限流重试初始间隔（测试注入 0）。 */
  private readonly retryBaseMs: number
  /** context/会话级冻结（prepare failed / 裸 -2）：后续分片跳过，不再打 API。 */
  private contextFrozen = false

  constructor(
    private readonly sendText: (text: string) => Promise<void>,
    /** 连续发送失败 ≥STUCK_THRESHOLD 次时回调一次——调用方给用户发通道异常提示（实测：微信服务端拒绝发送时所有分片全失败，用户静默无感知）。reason 区分：rate=限流重试仍失败 / context=会话失效（重试无意义）/ other。 */
    private readonly onStuck?: (reason: StuckReason) => void,
    opts: { mode?: ReplyMode; intervalMs?: number; retryBaseMs?: number } = {},
  ) {
    this.mode = opts.mode ?? 'stream'
    this.intervalMs = opts.intervalMs ?? AGGREGATE_INTERVAL_MS
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS
  }

  /** 已通过 queueSend 发出的文本条数（供调用方判断是否发过流式内容）。 */
  get sent(): number {
    return this.sentCount
  }

  /** 接收一个文本增量（assistant/chunk text-delta 或 block-end 兜底文本）。 */
  feed(delta: string): void {
    const safe = this.filter.feed(delta)
    if (!safe) return
    this.pending += safe

    // 提取完整标记行，剩余普通文本达到阈值即发送（仅 stream 模式）。
    // 注意：阈值检查前 pending 末尾可能是不完整标记行（如 "[image:/..." 路径
    // 还没闭合），必须留在 pending 等闭合提取，不能当普通文本发出去。
    this.extractMarkers()
    if (this.mode !== 'aggregate' && this.pending.length >= this.threshold) {
      const { text, rest } = this.splitSendable()
      this.queueSend(text)
      this.pending = rest
    }
  }

  /** 阈值发送拆分：末尾未闭合的标记行留在 pending，其余文本返回发送。 */
  private splitSendable(): { text: string; rest: string } {
    const nl = this.pending.lastIndexOf('\n')
    let text: string
    let rest: string
    if (nl !== -1) {
      const lastLine = this.pending.slice(nl + 1)
      if (this.looksLikeIncompleteMarker(lastLine)) {
        text = this.pending.slice(0, nl + 1)
        rest = lastLine
      } else {
        text = this.pending
        rest = ''
      }
    } else if (this.looksLikeIncompleteMarker(this.pending)) {
      // 单行且是未闭合标记（如长路径累积超阈值）→ 全部留 pending
      text = ''
      rest = this.pending
    } else {
      text = this.pending
      rest = ''
    }

    // 防单词截断：文本以不完整单词结尾（如 "km" 而 "/h" 未到）时把单词尾巴
    // 留 pending。实测：模型在 "km" 与 "/h" 间停顿 670ms（两个 token 分开
    // 输出），阈值触发把 "微风 1.6 km" 发出，"/h" 落到下一条消息开头。
    const tail = text.match(/([A-Za-z0-9][A-Za-z0-9./+-]*)$/)
    const wordTail = tail?.[1] ?? ''
    if (wordTail) {
      const boundary = tail!.index ?? 0
      // 整行都是单词（如纯英文长词/数字）则不拆：避免把整条留 pending
      if (boundary > 0 || /[^A-Za-z0-9./+-]/.test(text)) {
        text = text.slice(0, boundary)
        rest = wordTail + rest
      }
    }
    return { text, rest }
  }

  /** 处理结束：flush 剩余文本，返回收集的媒体/TTS/文本。 */
  async flush(): Promise<FlushResult> {
    // 剩余过滤缓冲 + 待发送文本
    const tail = this.filter.flush()
    this.pending += tail
    this.extractMarkers()

    if (this.mode === 'aggregate') {
      // 聚合模式：合并 TTS + 剩余文本，统一分段发送（调用方不再发 textParts，
      // 否则同段尾文会被发送两次）。短文本一条成文；超长按段落切，段间
      // intervalMs 间隔串行发送防高频限流。
      const textReply = [this.ttsLines.join('\n'), this.pending].filter(Boolean).join('\n').trim()
      this.pending = ''
      this.ttsLines.length = 0
      if (textReply) {
        for (const part of splitAggregate(textReply)) {
          this.queueSend(part, true)
        }
      }
      await this.sendChain
      logger.info(
        `weixin-gateway: aggregate reply sent (${this.sentCount} messages, ${textReply.length} chars)`,
      )
      logger.debug(
        `weixin-gateway: streaming sender flushed (${this.sentCount} messages, ${this.mediaParts.length} media)`,
      )
      return { mediaParts: this.mediaParts, ttsText: undefined, textParts: [] }
    }

    // 尾文只在 textParts 中返回，由调用方（handleIncoming）统一发送一次；
    // 这里不再 queueSend，否则同一段尾文会被发送两次（重复回复）。
    // 按行分段（去空行）：多轮 turn / 多个段落在调用方各自成段。
    const textParts: string[] = []
    if (this.pending.trim()) {
      textParts.push(...this.pending.trim().split('\n').filter((s) => s.trim().length > 0))
      this.pending = ''
    }
    await this.sendChain
    logger.debug(`weixin-gateway: streaming sender flushed (${this.sentCount} messages, ${this.mediaParts.length} media, ${this.ttsLines.length} tts)`)
    return {
      mediaParts: this.mediaParts,
      ttsText: this.ttsLines.length > 0 ? this.ttsLines.join('\n') : undefined,
      textParts,
    }
  }

  /** 从 pending 中剥离完整标记行（[image:]/[video:]/[file:]/[tts:] 与 ![..](..)）。 */
  private extractMarkers(): void {
    const lines = this.pending.split('\n')
    this.pending = ''
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1
      const line = lines[i]
      const bracket = line.match(/^\[(image|video|file|tts):\s*([^\]]+)\]\s*(.*)$/)
      const md = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*(.*)$/)
      if (bracket) {
        const kind = bracket[1]
        if (kind === 'tts') {
          this.ttsLines.push(bracket[2].trim())
        } else {
          this.mediaParts.push({ path: bracket[2].trim(), caption: bracket[3] })
        }
      } else if (md) {
        this.mediaParts.push({ path: md[2].trim(), caption: md[1] })
      } else if (isLast && this.looksLikeIncompleteMarker(line)) {
        // 行尾可能是未完成的标记行（如 "[image:/tmp/xxx.p"）：延迟到下一 delta。
        // 追加而不是替换：this.pending 已包含之前的文本；覆盖会丢掉前缀文本
        // （实测"画杯子"：前缀"再画了一版：\n\n"被仅剩的标记行替换，flush 后
        // 媒体 textParts 只剩 "]"）
        this.pending += line
      } else {
        this.pending += line
        if (!isLast) this.pending += '\n'
      }
    }
  }

  /** 判断是否为"可能未完成"的标记行。 */
  private looksLikeIncompleteMarker(line: string): boolean {
    if (/^!\[[^\]]*$/.test(line)) return true // ![xxx 未闭合
    if (/^\[(image|video|file|tts):\s*[^\]]*$/.test(line)) return true // [image:xxx 未闭合
    return false
  }

  /**
   * 串行发送一条文本消息。withDelay=true 时发送前等待 intervalMs（聚合模式段间节流）。
   *
   * 失败分流（SendMessageError）：
   * - rate limited → 指数退避重试（1s/2s/4s，最多 3 次）——瞬态限流，重试成功即自然补发
   * - prepare failed / 裸 -2 → context 冻结：首次触发立即通知用户，后续分片跳过
   *   （账号级冻结重发无效，须用户先发一条消息刷新 context 或重新扫码）
   * - 其他 → 计入连续失败计数，≥STUCK_THRESHOLD 触发 onStuck
   */
  private queueSend(text: string, withDelay = false): void {
    const t = text.trim()
    if (!t) return
    this.sendChain = this.sendChain.then(async () => {
      if (withDelay) await sleep(this.intervalMs)
      if (this.contextFrozen) {
        // context/会话级冻结：不再尝试发送（重试无意义），内容跳过
        logger.warn(`weixin-gateway: skip send (context frozen): ${t.slice(0, 60)}`)
        return
      }
      try {
        await this.sendWithRetry(t)
        this.sentCount++
        this.consecutiveFailures = 0
      } catch (err) {
        const reason = classifyError(err)
        if (reason === 'context' && !this.stuckNotified) {
          // context 冻结首次即提示（不等 3 次失败），并停止后续发送
          this.contextFrozen = true
          this.stuckNotified = true
          this.onStuck?.('context')
        } else if (reason !== 'context') {
          this.consecutiveFailures++
          if (this.consecutiveFailures >= STUCK_THRESHOLD && !this.stuckNotified) {
            this.stuckNotified = true
            this.onStuck?.(reason)
          }
        }
        logger.warn(`weixin-gateway: streaming send failed: ${String(err)}`)
      }
    })
  }

  /** 限流错误指数退避重试；context/其他错误直接抛（不重试）。 */
  private async sendWithRetry(text: string): Promise<void> {
    let lastErr: unknown
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        await this.sendText(text)
        return
      } catch (err) {
        lastErr = err
        if (!(err instanceof SendMessageError) || !err.retryable) throw err
        await sleep(this.retryBaseMs * 2 ** attempt)
      }
    }
    throw lastErr
  }
}

/** 按 SendMessageError 分类失败原因（无 ret 信息的普通错误 → other）。 */
function classifyError(err: unknown): StuckReason {
  if (err instanceof SendMessageError) {
    if (err.contextFrozen) return 'context'
    if (err.retryable) return 'rate'
  }
  return 'other'
}

/** 最小 sleep（发间隔用；单独函数便于测试注入替换）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 聚合回复分段（纯函数，可单测）：
 * - 总长 ≤AGGREGATE_SINGLE_MAX 码点 → 一条成文（不拆）
 * - 超长 → 优先在 \n 段落边界切，每段 ≤AGGREGATE_SEGMENT_MAX 码点；
 *   无换行的超长单段按码点硬切（Unicode 安全，不劈 emoji/中文）
 * - 段间不补分隔符，每段 trim
 */
export function splitAggregate(text: string): string[] {
  const textReply = text.trim()
  if (!textReply) return []
  if (Array.from(textReply).length <= AGGREGATE_SINGLE_MAX) return [textReply]

  const lines = textReply.split('\n')
  const parts: string[] = []
  let cur = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue // 忽略空行，段落间以单 \n 重连
    const lineLen = Array.from(line).length
    if (lineLen > AGGREGATE_SEGMENT_MAX) {
      // 超长单行（无换行长文本）：先结算当前段，再按码点硬切
      if (cur) {
        parts.push(cur)
        cur = ''
      }
      const chars = Array.from(line)
      for (let i = 0; i < chars.length; i += AGGREGATE_SEGMENT_MAX) {
        parts.push(chars.slice(i, i + AGGREGATE_SEGMENT_MAX).join(''))
      }
      continue
    }
    const merged = cur ? `${cur}\n${line}` : line
    if (Array.from(merged).length > AGGREGATE_SEGMENT_MAX) {
      parts.push(cur)
      cur = line
    } else {
      cur = merged
    }
  }
  if (cur) parts.push(cur)
  return parts
}
