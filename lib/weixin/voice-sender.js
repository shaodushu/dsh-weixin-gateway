/**
 * voice-sender — 微信语音回复发送。
 *
 * 实测结论（2026-08-17）：voice_item 语音条消息在微信客户端**不显示**
 * （上传/发送都成功但界面零反馈；腾讯原版 openclaw-weixin 也未实现语音发送）。
 * 变通方案：TTS 音频以**文件消息**形式发送（微信文件消息已验证可靠），
 * 用户点开文件即可播放。
 *
 * 保留 silk 编码路径的代码结构，但实际走 sendWeixinMediaFile 文件分支。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendWeixinMediaFile } from './send-media.js';
import { logger } from './util/logger.js';
/**
 * 发送一条语音回复（以音频文件消息形式）。
 * @param params.wavBuffer - TTS 输出 WAV（公司 IndexTTS-1.5）
 * @param params.text - 语音对应的文字（作文件名/说明）
 */
export async function sendVoiceMessageWeixin(params) {
    const { to, wavBuffer, text, opts, cdnBaseUrl } = params;
    // TTS WAV → 临时文件（音频文件消息发送）
    const tmpPath = path.join(os.tmpdir(), `weixin-voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
    fs.writeFileSync(tmpPath, wavBuffer);
    try {
        const caption = text ? `🎤 ${text}` : '';
        const sent = await sendWeixinMediaFile({
            filePath: tmpPath,
            to,
            text: caption,
            opts,
            cdnBaseUrl,
        });
        logger.info(`voice-sender: voice sent as file message to ${to} (${wavBuffer.length} bytes)`);
        return sent;
    }
    finally {
        fs.rmSync(tmpPath, { force: true });
    }
}
