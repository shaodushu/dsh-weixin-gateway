/**
 * ai-service — AI 网关（OpenAI 兼容 API）能力封装。
 *
 * 三个能力：
 *  - transcribeAudio：语音转文字（SILK → WAV → SenseVoiceSmall ASR）
 *  - generateImage：文生图（gpt-image-2，保存本地 PNG）
 *  - describeImage：图像理解（qwen2.5-vl，base64 传入）
 *
 * 凭据：环境变量 AI_GATEWAY_BASE_URL（必填，网关地址不含组织信息，由使用者
 *       显式配置）+ AI_GATEWAY_KEY（必填）；支持仓库 .env 文件（gitignored）。
 *       两者缺一即视为未配置（requireConfig 抛错提示）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decode } from 'silk-wasm'

import { resolveStateDir } from './storage/state-dir.js'
import { logger } from './util/logger.js'

/** 微信 SILK 采样率。 */
const SILK_SAMPLE_RATE = 24_000

/** 生成图片保存目录。 */
const GENERATED_DIR = path.join(resolveStateDir(), 'weixin-dsh', 'media', 'generated')

/** 仓库根目录（找 .env 用）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface AiGatewayConfig {
  baseUrl: string
  apiKey: string
}

/** 从环境变量 + 仓库 .env 读取凭据（baseUrl 与 apiKey 均必填）。 */
export function loadAiGatewayConfig(): AiGatewayConfig | null {
  loadEnvFile()
  const apiKey = process.env.AI_GATEWAY_KEY?.trim()
  const baseUrl = process.env.AI_GATEWAY_BASE_URL?.trim()
  if (!apiKey || !baseUrl) return null
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
  }
}

/** 极简 .env 加载（KEY=VALUE 逐行，不覆盖已存在的环境变量）。 */
function loadEnvFile(): void {
  const envPath = path.join(REPO_ROOT, '.env')
  try {
    const raw = fs.readFileSync(envPath, 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    // .env 不存在时静默
  }
}

/** 微信 SILK 缓冲区 → WAV Buffer（16bit 单声道）。 */
export async function silkToWav(silkBuf: Buffer): Promise<Buffer> {
  const result = await decode(silkBuf, SILK_SAMPLE_RATE)
  const pcm = Buffer.from(result.data)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SILK_SAMPLE_RATE, 24)
  header.writeUInt32LE(SILK_SAMPLE_RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** 语音文件（SILK/WAV）→ 文字。 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const cfg = requireConfig()
  let audio = fs.readFileSync(filePath)
  // 微信语音是 SILK：解码为 WAV 再送 ASR
  if (filePath.endsWith('.silk') || filePath.endsWith('.bin')) {
    audio = await silkToWav(audio)
    filePath = filePath.replace(/\.(silk|bin)$/i, '.wav')
  }
  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(filePath) || 'voice.wav')
  form.append('model', 'SenseVoiceSmall')
  const resp = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  })
  const data = (await resp.json()) as { text?: string; error?: { message?: string } }
  if (!resp.ok || !data.text) {
    throw new Error(`ASR 失败: ${data.error?.message ?? resp.status}`)
  }
  return data.text
}

/** 文生图：prompt → 本地 PNG 路径。 */
export async function generateImage(prompt: string, opts: { size?: string } = {}): Promise<string> {
  const cfg = requireConfig()
  const size = opts.size ?? '1024x1024'
  const resp = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, n: 1, size }),
  })
  const data = (await resp.json()) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } }
  if (!resp.ok || !data.data?.[0]) {
    throw new Error(`图像生成失败: ${data.error?.message ?? resp.status}`)
  }
  const b64 = data.data[0].b64_json
  const url = data.data[0].url
  let buffer: Buffer
  let ext = 'png'
  if (b64) {
    buffer = Buffer.from(b64, 'base64')
    // 从魔数推断扩展名
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) ext = 'jpg'
  } else if (url) {
    const imgResp = await fetch(url)
    if (!imgResp.ok) throw new Error(`图像下载失败: ${imgResp.status}`)
    buffer = Buffer.from(await imgResp.arrayBuffer())
  } else {
    throw new Error('图像生成响应缺少数据')
  }
  fs.mkdirSync(GENERATED_DIR, { recursive: true })
  const outPath = path.join(GENERATED_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  fs.writeFileSync(outPath, buffer)
  logger.info(`ai-service: generated image ${buffer.length} bytes -> ${outPath}`)
  return outPath
}

/** 图像理解：本地图片文件 → 文字描述。 */
export async function describeImage(filePath: string, prompt = '用中文简要描述这张图片'): Promise<string> {
  const cfg = requireConfig()
  const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
  const b64 = fs.readFileSync(filePath).toString('base64')
  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen2.5-vl',
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
  })
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string }
  }
  const content = data.choices?.[0]?.message?.content
  if (!resp.ok || !content) {
    throw new Error(`图像理解失败: ${data.error?.message ?? resp.status}`)
  }
  return content
}

function requireConfig(): AiGatewayConfig {
  const cfg = loadAiGatewayConfig()
  if (!cfg) {
    throw new Error('缺少 AI_GATEWAY_BASE_URL 或 AI_GATEWAY_KEY：请在仓库 .env 或环境变量中显式配置 AI 网关')
  }
  return cfg
}

/** 文字合成语音（IndexTTS-1.5）→ WAV Buffer（24000Hz 16bit 单声道）。 */
export async function synthesizeSpeech(text: string, opts: { voice?: string } = {}): Promise<Buffer> {
  const cfg = requireConfig()
  const resp = await fetch(`${cfg.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'IndexTTS-1.5',
      input: text,
      voice: opts.voice ?? 'default',
    }),
  })
  if (!resp.ok) {
    let msg = String(resp.status)
    try {
      const err = (await resp.json()) as { error?: { message?: string } }
      msg = err.error?.message ?? msg
    } catch {
      // 非 JSON 错误体
    }
    throw new Error(`TTS 失败: ${msg}`)
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length === 0) throw new Error('TTS 返回空音频')
  logger.info(`ai-service: synthesized speech ${buf.length} bytes`)
  return buf
}
