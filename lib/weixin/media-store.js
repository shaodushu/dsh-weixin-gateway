/**
 * media-store — 微信媒体本地存储。
 *
 * 替代 OpenClaw 的 channelRuntime.media.saveMediaBuffer：
 * 下载解密的入站媒体保存到本地目录，返回文件路径。
 * 扩展名按文件魔数（magic bytes）推断，避免依赖 content-type 参数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from './storage/state-dir.js';
import { logger } from './util/logger.js';
/** 入站媒体根目录：<state>/weixin-dsh/media/inbound */
const MEDIA_ROOT = path.join(resolveStateDir(), 'weixin-dsh', 'media', 'inbound');
/** 魔数 → 扩展名（PNG/JPEG/GIF/WebP/BMP/MP4/MP3/WAV/SILK）。 */
const MAGIC_EXT = [
    { bytes: [0x89, 0x50, 0x4e, 0x47], ext: '.png' },
    { bytes: [0xff, 0xd8, 0xff], ext: '.jpg' },
    { bytes: [0x47, 0x49, 0x46, 0x38], ext: '.gif' },
    { bytes: [0x52, 0x49, 0x46, 0x46], ext: '.webp' }, // RIFF....WEBP
    { bytes: [0x42, 0x4d], ext: '.bmp' },
    { bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], ext: '.mp4' },
    { bytes: [0x49, 0x44, 0x33], ext: '.mp3' },
    { bytes: [0x52, 0x49, 0x46, 0x46], ext: '.wav' }, // RIFF....WAVE（与 webp 冲突，按内容再判）
    { bytes: [0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b], ext: '.silk' }, // \x02#!SILK（微信 SILK 带长度前缀）
    { bytes: [0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b], ext: '.silk' }, // #!SILK
];
/** 从缓冲区推断扩展名（含 RIFF 的 webp/wav 区分）。 */
function inferExtension(buf) {
    for (const { bytes, ext } of MAGIC_EXT) {
        if (buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b)) {
            // RIFF: 偏移 8 处的四字符码区分 WEBP / WAVE
            if (ext === '.webp' && buf.length >= 12 && buf.toString('ascii', 8, 12) !== 'WEBP')
                continue;
            if (ext === '.wav' && buf.length >= 12 && buf.toString('ascii', 8, 12) !== 'WAVE')
                continue;
            return ext;
        }
    }
    return '.bin';
}
/**
 * 保存媒体缓冲区到本地，返回 { path }（与原版 SaveMediaFn 契约一致）。
 */
export async function saveMediaBuffer(buffer, _contentType, subdir, _maxBytes) {
    const dir = subdir ? path.join(MEDIA_ROOT, subdir) : MEDIA_ROOT;
    fs.mkdirSync(dir, { recursive: true });
    const ext = inferExtension(buffer);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, buffer);
    logger.debug(`media-store: saved ${buffer.length} bytes -> ${filePath}`);
    return { path: filePath };
}
/** 入站媒体目录（给 agent 提示用）。 */
export function getMediaRoot() {
    return MEDIA_ROOT;
}
