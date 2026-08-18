/**
 * weixin-driver — 微信常驻驱动。
 *
 * 职责：
 *  1. 扫码登录（weixinLoginWithQr）
 *  2. 长轮询 getUpdates 收消息
 *  3. 文本消息 → AgentBridge（dsh 执行层）→ 回复发回微信
 *
 * 垂直切片：文本消息收发；媒体消息暂忽略（后续扩展）。
 * 多轮对话：一个账号对应一个常驻 agent 会话（createGatewayAgent 只调一次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from './storage/state-dir.js';
import { CDN_BASE_URL, DEFAULT_BASE_URL, loadWeixinAccount, saveWeixinAccount, triggerWeixinChannelReload, } from './accounts.js';
import { displayQRCode, startWeixinLoginWithQr, waitForWeixinLogin, } from './login-qr.js';
import { getUpdates, notifyStart, sendTyping } from './api/api.js';
import { MessageItemType } from './api/types.js';
import { WeixinConfigManager } from './api/config-cache.js';
import { sendMessageWeixin } from './send.js';
import { sendWeixinMediaFile } from './send-media.js';
import { WeixinStreamingSender } from './streaming-sender.js';
import { weixinMessageToMsgContext, } from './inbound.js';
import { downloadMediaFromItem } from './media/media-download.js';
import { saveMediaBuffer } from './media-store.js';
import { logger } from './util/logger.js';
import { askAgentStreaming } from '../bridge.js';
import { SessionRouter } from './session-router.js';
/** 微信账号状态目录（本地，与 OpenClaw 隔离）。 */
const WEIXIN_STATE_DIR = path.join(resolveStateDir(), 'weixin-dsh');
/** 本地状态目录下的账号索引（替代 OpenClaw 的账号索引文件）。 */
function accountIndexPath() {
    return path.join(WEIXIN_STATE_DIR, 'accounts-index.json');
}
/** 交互式扫码登录，返回可用账号。 */
export async function weixinLoginWithQr(accountId) {
    logger.info('weixin-login: starting QR login');
    const start = await startWeixinLoginWithQr({
        apiBaseUrl: DEFAULT_BASE_URL,
        accountId,
        verbose: true,
    });
    if (start.qrcodeUrl) {
        await displayQRCode(start.qrcodeUrl);
    }
    console.log(start.message);
    const wait = await waitForWeixinLogin({
        sessionKey: start.sessionKey,
        apiBaseUrl: DEFAULT_BASE_URL,
    });
    if (!wait.connected && !wait.alreadyConnected) {
        throw new Error(`微信登录失败: ${wait.message}`);
    }
    if (!wait.botToken || !wait.accountId) {
        throw new Error(`微信登录结果缺少凭据: ${wait.message}`);
    }
    // 持久化账号 + 记录账号索引（与 OpenClaw 版 saveWeixinAccount 对齐）
    saveWeixinAccount(wait.accountId, {
        token: wait.botToken,
        baseUrl: wait.baseUrl ?? DEFAULT_BASE_URL,
    });
    indexAccount(wait.accountId);
    await triggerWeixinChannelReload().catch(() => undefined);
    logger.info(`weixin-login: account ${wait.accountId} connected`);
    return resolveAccount(wait.accountId);
}
/** 账号解析（本地配置 + 存储凭据）。 */
export function resolveAccount(accountId) {
    const stored = loadWeixinAccount(accountId);
    return {
        accountId,
        baseUrl: stored?.baseUrl?.trim() || DEFAULT_BASE_URL,
        token: stored?.token?.trim() || undefined,
        cdnBaseUrl: CDN_BASE_URL,
    };
}
/** 把 accountId 记入本地索引（账号列表/恢复用）。 */
function indexAccount(accountId) {
    const indexPath = accountIndexPath();
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    let list = [];
    try {
        list = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (!Array.isArray(list))
            list = [];
    }
    catch {
        list = [];
    }
    if (!list.includes(accountId)) {
        list.push(accountId);
        fs.writeFileSync(indexPath, JSON.stringify(list, null, 2));
    }
}
/** 列出本地已登录账号。 */
export function listWeixinAccounts() {
    try {
        const list = JSON.parse(fs.readFileSync(accountIndexPath(), 'utf8'));
        return Array.isArray(list) ? list : [];
    }
    catch {
        return [];
    }
}
/**
 * 常驻微信网关：轮询收消息 → dsh agent 回复 → 发回微信。
 * 直到 abortSignal 触发或进程退出。
 */
export async function runWeixinGateway(ctx, account, opts = {}) {
    const { abortSignal } = opts;
    const sessionMode = opts.sessionMode ?? 'room';
    const accountId = account.accountId;
    const baseUrl = account.baseUrl;
    const token = account.token;
    if (!token) {
        throw new Error(`账号 ${accountId} 未登录，请先运行 weixin-login`);
    }
    // 通知微信侧本 client 启动（建立 session；原版 OpenClaw channel 启动顺序）
    try {
        const resp = await notifyStart({ baseUrl, token });
        if (resp.ret !== undefined && resp.ret !== 0) {
            logger.warn(`weixin-gateway: notifyStart ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`);
        }
    }
    catch (err) {
        logger.warn(`weixin-gateway: notifyStart failed (ignored): ${String(err)}`);
    }
    // 会话路由：per-user（每用户独立会话）/ room（统一房间）
    const router = new SessionRouter(ctx, sessionMode);
    // 每用户配置缓存（typing ticket 等）
    const configManager = new WeixinConfigManager({ baseUrl, token }, (msg) => logger.debug(msg));
    let getUpdatesBuf = '';
    let sessionTimeoutCount = 0;
    logger.info(`weixin-gateway: polling started for ${accountId}`);
    while (abortSignal?.aborted !== true) {
        try {
            const resp = await getUpdates({
                baseUrl,
                token,
                get_updates_buf: getUpdatesBuf,
                timeoutMs: 30_000,
                abortSignal,
            });
            getUpdatesBuf = resp.get_updates_buf ?? getUpdatesBuf;
            // -14（session timeout）检测：token 失效/会话被回收
            // 连续 3 次 → 醒目报警 + 长退避（等用户重新扫码后重启网关）
            if (resp.errcode === -14) {
                sessionTimeoutCount++;
                if (sessionTimeoutCount >= 3) {
                    console.error('⚠️⚠️  微信会话已失效（-14 session timeout）⚠️⚠️');
                    console.error('   可能原因：token 过期 / 重复扫码顶掉会话 / 服务端回收');
                    console.error('   处理：重新扫码后重启网关：');
                    console.error('     dsh --profile headless --patch ./weixin.patch.yml --weixin-login');
                    logger.error('weixin-gateway: session invalid (-14) x3, backing off 5min');
                    await sleep(300_000);
                    sessionTimeoutCount = 0; // 退避后重置计数再试
                }
                else {
                    logger.warn(`weixin-gateway: session timeout (-14) x${sessionTimeoutCount}, retrying`);
                    await sleep(5_000);
                }
                continue;
            }
            sessionTimeoutCount = 0;
            for (const msg of resp.msgs ?? []) {
                const userId = msg.from_user_id ?? '';
                if (!userId)
                    continue;
                // 按用户路由会话（per-user 独立 / room 共享）
                const handle = await router.getSession(userId);
                await handleIncoming(ctx, handle, account, msg, baseUrl, token, configManager);
            }
        }
        catch (err) {
            if (abortSignal?.aborted)
                break;
            logger.error(`weixin-gateway: poll error: ${String(err)}`);
            // 短暂退避后继续（避免异常风暴）
            await sleep(2_000);
        }
    }
    await router.disposeAll();
    logger.info(`weixin-gateway: stopped for ${accountId} (${router.size} sessions)`);
}
/** 处理一条入站消息：文本/媒体 → askAgent → 回复。 */
async function handleIncoming(ctx, agentHandle, account, msg, baseUrl, token, configManager) {
    const to = msg.from_user_id ?? '';
    const contextToken = msg.context_token;
    // 媒体下载：mainMediaItem 选取（与原版 process-message 一致）
    const mainMediaItem = pickMediaItem(msg);
    const mediaOpts = {};
    if (mainMediaItem) {
        try {
            const downloaded = await downloadMediaFromItem(mainMediaItem, {
                cdnBaseUrl: account.cdnBaseUrl,
                saveMedia: saveMediaBuffer,
                log: (m) => logger.debug(m),
                errLog: (m) => logger.warn(m),
                label: 'inbound',
            });
            Object.assign(mediaOpts, downloaded);
        }
        catch (err) {
            logger.warn(`weixin-gateway: media download failed: ${String(err)}`);
        }
    }
    const msgCtx = weixinMessageToMsgContext(msg, account.accountId, mediaOpts);
    const text = msgCtx.Body.trim();
    // 注入 agent 的文本：文本消息用原文；媒体消息附 AI 解析结果或路径
    let prompt;
    if (mediaOpts.decryptedVoicePath) {
        // 调试：记录入站语音消息的 voice_item 原始结构（对比发送格式）
        const voiceItem = msg.item_list?.find((i) => i.type === MessageItemType.VOICE)?.voice_item;
        logger.info(`weixin-gateway: inbound voice_item=${JSON.stringify({
            encode_type: voiceItem?.encode_type,
            sample_rate: voiceItem?.sample_rate,
            playtime: voiceItem?.playtime,
            text: voiceItem?.text,
            media: voiceItem?.media ? { encrypt_type: voiceItem.media.encrypt_type, has_aes: Boolean(voiceItem.media.aes_key), has_eqp: Boolean(voiceItem.media.encrypt_query_param) } : undefined,
        })}`);
        // 语音 → silk-wasm 转 WAV → SenseVoiceSmall ASR 转文字
        const transcript = await transcribeVoice(mediaOpts.decryptedVoicePath);
        if (transcript) {
            prompt = `[收到一条语音消息，语音转文字结果: "${transcript}"] ${text}`;
        }
        else {
            prompt = `[收到一条语音消息，已保存到: ${mediaOpts.decryptedVoicePath}（转写失败）] ${text}`;
        }
    }
    else if (mediaOpts.decryptedPicPath) {
        // 图片 → qwen2.5-vl 视觉理解描述
        const description = await describeInboundImage(mediaOpts.decryptedPicPath);
        if (description) {
            prompt = `[收到一张图片，AI 视觉描述: "${description}"。图片已保存到: ${mediaOpts.decryptedPicPath}，需要时可以读取] ${text}`;
        }
        else {
            prompt = `[收到一张图片，已保存到: ${mediaOpts.decryptedPicPath}] ${text}`;
        }
    }
    else if (mediaOpts.decryptedVideoPath) {
        prompt = `[收到一个视频，已保存到: ${mediaOpts.decryptedVideoPath}] ${text}`;
    }
    else if (mediaOpts.decryptedFilePath) {
        prompt = `[收到一个文件，已保存到: ${mediaOpts.decryptedFilePath}（${mediaOpts.fileMediaType ?? 'unknown'}）] ${text}`;
    }
    else {
        prompt = text;
    }
    if (!prompt) {
        logger.debug(`weixin-gateway: ignoring empty message from ${to}`);
        return;
    }
    logger.info(`weixin-gateway: [${account.accountId}] ${to}: ${prompt.slice(0, 120)}`);
    try {
        // 流式发送器：agent 生成 → 增量发微信（markdown 安全分片 + 标记剥离）
        const sender = new WeixinStreamingSender(async (text) => {
            await sendMessageWeixin({
                to,
                text,
                opts: { baseUrl, token, contextToken },
            });
        });
        // "正在输入"状态：需要先向 getConfig 要 typing ticket
        const cached = await configManager.getForUser(to, contextToken);
        if (cached.typingTicket) {
            await sendTyping({
                baseUrl,
                token,
                body: { ilink_user_id: to, typing_ticket: cached.typingTicket, status: 1 },
            }).catch(() => undefined);
        }
        const result = await askAgentStreaming(agentHandle, prompt, {
            onDelta: (delta) => {
                logger.info(`weixin-gateway: stream delta ${delta.length} chars: ${delta.slice(0, 80).replace(/\n/g, '\\n')}`);
                void sender.feed(delta);
            },
        });
        if (result.error !== undefined) {
            await sendMessageWeixin({
                to,
                text: `抱歉，处理失败：${result.error}`,
                opts: { baseUrl, token, contextToken },
            }).catch((err) => logger.error(`weixin-gateway: send error reply: ${String(err)}`));
            return;
        }
        // flush 流式发送器：剩余文本 + 收集的媒体标记
        const { mediaParts, ttsText, textParts } = await sender.flush();
        logger.info(`weixin-gateway: flush media=${mediaParts.length} textParts=${textParts.map((t) => t.slice(0, 60).replace(/\n/g, '\\n'))}`);
        for (const part of mediaParts) {
            try {
                await sendWeixinMediaFile({
                    filePath: part.path,
                    to,
                    text: part.caption ?? '',
                    opts: { baseUrl, token, contextToken },
                    cdnBaseUrl: account.cdnBaseUrl,
                });
                logger.info(`weixin-gateway: sent media ${part.path} to ${to}`);
            }
            catch (err) {
                logger.error(`weixin-gateway: send media failed: ${String(err)}`);
                await sendMessageWeixin({
                    to,
                    text: `媒体发送失败（${part.path}）：${err instanceof Error ? err.message : String(err)}`,
                    opts: { baseUrl, token, contextToken },
                }).catch(() => undefined);
            }
        }
        // 语音条发送：官方协议不支持（Issue #78/#254，实测客户端不渲染）——[tts:] 文本并入文字回复
        const textReply = [ttsText, ...textParts].filter(Boolean).join('\n').trim();
        if (textReply) {
            await sendMessageWeixin({
                to,
                text: textReply,
                opts: { baseUrl, token, contextToken },
            });
            logger.info(`weixin-gateway: replied to ${to} (${textReply.length} chars)`);
        }
    }
    catch (err) {
        logger.error(`weixin-gateway: handle message error: ${String(err)}`);
        await sendMessageWeixin({
            to,
            text: `服务开小差了：${err instanceof Error ? err.message : String(err)}`,
            opts: { baseUrl, token, contextToken },
        }).catch(() => undefined);
    }
}
/** 选取主媒体 item（与原版 process-message 的 mainMediaItem 逻辑一致）。 */
function pickMediaItem(full) {
    const hasDownloadableMedia = (m) => Boolean(m?.encrypt_query_param || m?.full_url);
    return (full.item_list?.find((i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media)) ??
        full.item_list?.find((i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media)) ??
        full.item_list?.find((i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media)) ??
        full.item_list?.find((i) => i.type === MessageItemType.VOICE && i.voice_item?.media));
}
/** 语音转文字（AI 网关 ASR；失败返回 null，不阻塞主流程）。 */
async function transcribeVoice(filePath) {
    try {
        const { transcribeAudio } = await import('./ai-service.js');
        const text = await transcribeAudio(filePath);
        logger.info(`weixin-gateway: voice transcript: ${text.slice(0, 100)}`);
        return text;
    }
    catch (err) {
        logger.warn(`weixin-gateway: voice transcribe failed: ${String(err)}`);
        return null;
    }
}
/** 图片视觉描述（AI 网关 qwen2.5-vl；失败返回 null，不阻塞主流程）。 */
async function describeInboundImage(filePath) {
    try {
        const { describeImage } = await import('./ai-service.js');
        const desc = await describeImage(filePath);
        logger.info(`weixin-gateway: image description: ${desc.slice(0, 100)}`);
        return desc;
    }
    catch (err) {
        logger.warn(`weixin-gateway: image describe failed: ${String(err)}`);
        return null;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
