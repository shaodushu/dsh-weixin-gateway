/**
 * streaming-sender — 流式回复发送器（从 driver.ts 抽出，独立可测）。
 *
 * - agent 的 assistant/chunk 文本增量 → StreamingMarkdownFilter 安全分片
 * - 完整标记行（[image:]/[video:]/[file:]/[tts:]）剥离收集，不当作文本发送
 * - 普通文本累积到阈值（或 flush 时）增量发送——用户在微信看到"逐步生成"
 *
 * 背景：工具调用后的最终文本块无 text-delta（只有 block-end 聚合文本，
 * 见 bridge.ts applyStreamChunk 的兜底），这里只负责把收到的文本增量
 * 正确拆分为 媒体标记 + 文本。
 */
import { StreamingMarkdownFilter } from './markdown-filter.js';
import { logger } from './util/logger.js';
/** 流式回复发送器。 */
export class WeixinStreamingSender {
    sendText;
    /** 待发送的普通文本累积（含不完整行）。 */
    pending = '';
    /** markdown 安全分片过滤器。 */
    filter = new StreamingMarkdownFilter();
    /** 收集的媒体标记。 */
    mediaParts = [];
    /** 收集的 [tts:] 文本。 */
    ttsLines = [];
    /** 发送阈值（字符）。 */
    threshold = 80;
    /** 发送串行化链。 */
    sendChain = Promise.resolve();
    sentCount = 0;
    constructor(sendText) {
        this.sendText = sendText;
    }
    /** 已通过 queueSend 发出的文本条数（供调用方判断是否发过流式内容）。 */
    get sent() {
        return this.sentCount;
    }
    /** 接收一个文本增量（assistant/chunk text-delta 或 block-end 兜底文本）。 */
    feed(delta) {
        const safe = this.filter.feed(delta);
        if (!safe)
            return;
        this.pending += safe;
        // 提取完整标记行，剩余普通文本达到阈值即发送。
        // 注意：阈值检查前 pending 末尾可能是不完整标记行（如 "[image:/..." 路径
        // 还没闭合），必须留在 pending 等闭合提取，不能当普通文本发出去。
        this.extractMarkers();
        if (this.pending.length >= this.threshold) {
            const { text, rest } = this.splitSendable();
            this.queueSend(text);
            this.pending = rest;
        }
    }
    /** 阈值发送拆分：末尾未闭合的标记行留在 pending，其余文本返回发送。 */
    splitSendable() {
        const nl = this.pending.lastIndexOf('\n');
        if (nl !== -1) {
            const lastLine = this.pending.slice(nl + 1);
            if (this.looksLikeIncompleteMarker(lastLine)) {
                return { text: this.pending.slice(0, nl + 1), rest: lastLine };
            }
            return { text: this.pending, rest: '' };
        }
        // 单行且是未闭合标记（如长路径累积超阈值）→ 全部留 pending
        if (this.looksLikeIncompleteMarker(this.pending)) {
            return { text: '', rest: this.pending };
        }
        return { text: this.pending, rest: '' };
    }
    /** 处理结束：flush 剩余文本，返回收集的媒体/TTS/文本。 */
    async flush() {
        // 剩余过滤缓冲 + 待发送文本
        const tail = this.filter.flush();
        this.pending += tail;
        this.extractMarkers();
        // 尾文只在 textParts 中返回，由调用方（handleIncoming）统一发送一次；
        // 这里不再 queueSend，否则同一段尾文会被发送两次（重复回复）。
        // 按行分段（去空行）：多轮 turn / 多个段落在调用方各自成段。
        const textParts = [];
        if (this.pending.trim()) {
            textParts.push(...this.pending.trim().split('\n').filter((s) => s.trim().length > 0));
            this.pending = '';
        }
        await this.sendChain;
        logger.debug(`weixin-gateway: streaming sender flushed (${this.sentCount} messages, ${this.mediaParts.length} media, ${this.ttsLines.length} tts)`);
        return {
            mediaParts: this.mediaParts,
            ttsText: this.ttsLines.length > 0 ? this.ttsLines.join('\n') : undefined,
            textParts,
        };
    }
    /** 从 pending 中剥离完整标记行（[image:]/[video:]/[file:]/[tts:] 与 ![..](..)）。 */
    extractMarkers() {
        const lines = this.pending.split('\n');
        this.pending = '';
        for (let i = 0; i < lines.length; i++) {
            const isLast = i === lines.length - 1;
            const line = lines[i];
            const bracket = line.match(/^\[(image|video|file|tts):\s*([^\]]+)\]\s*(.*)$/);
            const md = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*(.*)$/);
            if (bracket) {
                const kind = bracket[1];
                if (kind === 'tts') {
                    this.ttsLines.push(bracket[2].trim());
                }
                else {
                    this.mediaParts.push({ path: bracket[2].trim(), caption: bracket[3] });
                }
            }
            else if (md) {
                this.mediaParts.push({ path: md[2].trim(), caption: md[1] });
            }
            else if (isLast && this.looksLikeIncompleteMarker(line)) {
                // 行尾可能是未完成的标记行（如 "[image:/tmp/xxx.p"）：延迟到下一 delta。
                // 追加而不是替换：this.pending 已包含之前的文本；覆盖会丢掉前缀文本
                // （实测"画杯子"：前缀"再画了一版：\n\n"被仅剩的标记行替换，flush 后
                // 媒体 textParts 只剩 "]"）
                this.pending += line;
            }
            else {
                this.pending += line;
                if (!isLast)
                    this.pending += '\n';
            }
        }
    }
    /** 判断是否为"可能未完成"的标记行。 */
    looksLikeIncompleteMarker(line) {
        if (/^!\[[^\]]*$/.test(line))
            return true; // ![xxx 未闭合
        if (/^\[(image|video|file|tts):\s*[^\]]*$/.test(line))
            return true; // [image:xxx 未闭合
        return false;
    }
    /** 串行发送一条文本消息。 */
    queueSend(text) {
        const t = text.trim();
        if (!t)
            return;
        this.sendChain = this.sendChain.then(async () => {
            try {
                await this.sendText(t);
                this.sentCount++;
            }
            catch (err) {
                logger.warn(`weixin-gateway: streaming send failed: ${String(err)}`);
            }
        });
    }
}
