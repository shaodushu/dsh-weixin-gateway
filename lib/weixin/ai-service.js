/**
 * ai-service — AI 网关（OpenAI 兼容 API）能力调用封装。
 *
 * 四个能力（语音转文字 / 文生图 / 图像理解 / 语音合成），每个能力独立
 * 配置（端点+密钥+模型），凭据与引导逻辑见 ai-config.ts；本模块只负责
 * 把能力调用翻译成 HTTP 请求。
 *
 * 能力说明：
 *  - transcribeAudio：语音转文字（SILK → WAV → ASR）
 *  - generateImage：文生图（保存本地 PNG）
 *  - describeImage：图像理解（base64 传入）
 *  - synthesizeSpeech：文字合成语音（WAV 24000Hz）
 */
import fs from 'node:fs';
import path from 'node:path';
import { decode } from 'silk-wasm';
import { requireCapabilityConfig } from './ai-config.js';
import { resolveStateDir } from './storage/state-dir.js';
import { logger } from './util/logger.js';
/** 微信 SILK 采样率。 */
const SILK_SAMPLE_RATE = 24_000;
/** 生成图片保存目录。 */
const GENERATED_DIR = path.join(resolveStateDir(), 'weixin-dsh', 'media', 'generated');
/** 微信 SILK 缓冲区 → WAV Buffer（16bit 单声道）。 */
export async function silkToWav(silkBuf) {
    const result = await decode(silkBuf, SILK_SAMPLE_RATE);
    const pcm = Buffer.from(result.data);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(SILK_SAMPLE_RATE, 24);
    header.writeUInt32LE(SILK_SAMPLE_RATE * 2, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
/** 语音文件（SILK/WAV）→ 文字。 */
export async function transcribeAudio(filePath) {
    const cfg = requireCapabilityConfig('asr');
    let audio = fs.readFileSync(filePath);
    // 微信语音是 SILK：解码为 WAV 再送 ASR
    if (filePath.endsWith('.silk') || filePath.endsWith('.bin')) {
        audio = await silkToWav(audio);
        filePath = filePath.replace(/\.(silk|bin)$/i, '.wav');
    }
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(filePath) || 'voice.wav');
    form.append('model', cfg.model);
    const resp = await fetch(`${cfg.baseUrl}${cfg.def.endpointPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
    });
    const data = (await resp.json());
    if (!resp.ok || !data.text) {
        throw new Error(`ASR 失败: ${data.error?.message ?? resp.status}`);
    }
    return data.text;
}
/** 文生图：prompt → 本地 PNG 路径。 */
export async function generateImage(prompt, opts = {}) {
    const cfg = requireCapabilityConfig('image');
    const size = opts.size ?? '1024x1024';
    const resp = await fetch(`${cfg.baseUrl}${cfg.def.endpointPath}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: cfg.model, prompt, n: 1, size }),
    });
    const data = (await resp.json());
    if (!resp.ok || !data.data?.[0]) {
        throw new Error(`图像生成失败: ${data.error?.message ?? resp.status}`);
    }
    const b64 = data.data[0].b64_json;
    const url = data.data[0].url;
    let buffer;
    let ext = 'png';
    if (b64) {
        buffer = Buffer.from(b64, 'base64');
        // 从魔数推断扩展名
        if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8)
            ext = 'jpg';
    }
    else if (url) {
        const imgResp = await fetch(url);
        if (!imgResp.ok)
            throw new Error(`图像下载失败: ${imgResp.status}`);
        buffer = Buffer.from(await imgResp.arrayBuffer());
    }
    else {
        throw new Error('图像生成响应缺少数据');
    }
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const outPath = path.join(GENERATED_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(outPath, buffer);
    logger.info(`ai-service: generated image ${buffer.length} bytes -> ${outPath}`);
    return outPath;
}
/** 图像理解：本地图片文件 → 文字描述。 */
export async function describeImage(filePath, prompt = '用中文简要描述这张图片') {
    const cfg = requireCapabilityConfig('vision');
    const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const b64 = fs.readFileSync(filePath).toString('base64');
    const resp = await fetch(`${cfg.baseUrl}${cfg.def.endpointPath}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: cfg.model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
                    ],
                },
            ],
            max_tokens: 300,
        }),
    });
    const data = (await resp.json());
    const content = data.choices?.[0]?.message?.content;
    if (!resp.ok || !content) {
        throw new Error(`图像理解失败: ${data.error?.message ?? resp.status}`);
    }
    return content;
}
/** 文字合成语音 → WAV Buffer（24000Hz 16bit 单声道）。 */
export async function synthesizeSpeech(text, opts = {}) {
    const cfg = requireCapabilityConfig('tts');
    const resp = await fetch(`${cfg.baseUrl}${cfg.def.endpointPath}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: cfg.model,
            input: text,
            voice: opts.voice ?? 'default',
        }),
    });
    if (!resp.ok) {
        let msg = String(resp.status);
        try {
            const err = (await resp.json());
            msg = err.error?.message ?? msg;
        }
        catch {
            // 非 JSON 错误体
        }
        throw new Error(`TTS 失败: ${msg}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0)
        throw new Error('TTS 返回空音频');
    logger.info(`ai-service: synthesized speech ${buf.length} bytes`);
    return buf;
}
