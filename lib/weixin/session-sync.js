/**
 * session-sync — 会话文件写前同步的扫描与自愈。
 *
 * 背景：web 端（dsh web profile）与网关共享 __room__ 会话文件时，web 会向
 * 文件追加它自己的事件流（attach 会话时读文件、写 end-seed、聊天写事件）。
 * 网关作为唯一"合法"写者必须每次写前发现外部追加：文件被 web 正确追加时
 * 融入（重建会话），被写坏（seq 错位）时截断到最后有效前缀（自愈）。
 *
 * 校验规则与 dsh-session-persistence-jsonl 的 SessionLogScanner 一致：
 * 事件 seq 必须是文件内位置索引（第 N 条事件的 seq == N），header 行不计。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { decodeStorageRecord } from '@deepseek-ai/dsh-session';
/** zstd 帧 magic（LE）。 */
const ZSTD_MAGIC = 0xfd2fb528;
/**
 * 解析一段 buffer 中所有完整 zstd 帧的字节区间（语义与
 * dsh-session-persistence-jsonl 的 scanZstdFrames 一致：只读帧头/块头推进，
 * 不解块内容；位域以 dsh 实现为准——contentSizeFlag=bits6-7、
 * singleSegment=bit5、checksum=bit2、dictionaryFlag=bits0-1）。
 * @returns 完整帧区间列表；尾部残缺帧（torn）不计入。
 */
function scanZstdFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4)
            break;
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
            break;
        offset += 4;
        if (offset === buffer.length)
            break;
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((descriptor & 24) !== 0)
            break; // reserved 位：帧损坏，停止
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 32) !== 0;
        const checksum = (descriptor & 4) !== 0;
        const dictionaryFlag = descriptor & 3;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes)
            break;
        offset += remainingHeaderBytes;
        for (;;) {
            if (buffer.length - offset < 3)
                return frames;
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 3;
            const blockSize = blockHeader >>> 3;
            if (blockType === 3)
                return frames; // reserved：帧损坏，停止
            const payloadBytes = blockType === 1 ? 1 : blockSize; // rle 块负载恒 1 字节
            if (buffer.length - offset < payloadBytes)
                return frames; // 残缺帧（torn）
            offset += payloadBytes;
            if (lastBlock)
                break;
        }
        if (checksum) {
            if (buffer.length - offset < 4)
                return frames;
            offset += 4;
        }
        frames.push({ start, end: offset });
    }
    return frames;
}
/**
 * 解压 zstd 会话文件全文（导出供测试验证多帧行为）：逐帧解压并拼接——
 * zstdDecompressSync 只解第一帧，而会话文件是"每次 flush 一个完整帧"的多帧拼接。
 */
export function decompressAllFrames(raw) {
    const frames = scanZstdFrames(raw);
    if (frames.length === 0)
        throw new Error('no complete zstd frame found');
    const parts = [];
    for (const frame of frames) {
        parts.push(zstdDecompressSync(raw.subarray(frame.start, frame.end)));
    }
    return Buffer.concat(parts);
}
export async function scanAndRepairSessionLog(file) {
    let raw;
    try {
        raw = await readFile(file);
    }
    catch {
        // 文件不存在/不可读：无事可做，保持现状
        return { outcome: 'unrepairable', validEvents: 0 };
    }
    let plaintext;
    try {
        plaintext = decompressAllFrames(raw);
    }
    catch {
        return { outcome: 'unrepairable', validEvents: 0 };
    }
    const text = plaintext.toString('utf8');
    const lines = text.split('\n');
    // 尾部换行产生一个空元素；空行直接跳过
    let validLines = 1; // header 行恒有效
    let expected = 0;
    let scanError = false;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '')
            continue;
        let events;
        try {
            events = decodeStorageRecord(JSON.parse(line));
        }
        catch {
            scanError = true;
            break;
        }
        let bad = false;
        for (const event of events) {
            if (event.seq !== expected) {
                bad = true;
                break;
            }
            expected += 1;
        }
        if (bad) {
            scanError = true;
            break;
        }
        validLines = i + 1;
    }
    if (!scanError)
        return { outcome: 'ok', validEvents: expected };
    if (validLines < 2) {
        // 连 header 之后的第一条事件都无效：无从修复，保持原文件
        return { outcome: 'unrepairable', validEvents: 0 };
    }
    // 重建：header 单独一帧（reader 把第一帧当 header 记录），有效前缀一帧。
    // 注：node:zlib 的 zstd 忽略 checksum 选项（实测生成无 checksum 帧），
    // dsh 的 reader 同样不要求（其 writer 也走 node:zlib）。
    const headerLine = lines[0];
    const eventsText = lines.slice(1, validLines).join('\n');
    const frame1 = zstdCompressSync(`${headerLine}\n`);
    const frame2 = zstdCompressSync(eventsText.length > 0 ? `${eventsText}\n` : '');
    await writeFile(file, Buffer.concat([frame1, frame2]));
    return { outcome: 'repaired', validEvents: expected };
}
