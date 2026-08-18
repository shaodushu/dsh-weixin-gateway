/**
 * ai-config 单元测试（vitest）。
 *
 * 背景：4 个 AI 能力（语音转文字/图像理解/文生图/语音合成）可独立配置
 * （各自 端点+密钥+模型），未单独配置回退全局 AI_GATEWAY_*。setup 的
 * 交互引导逻辑（问题清单构建、.env upsert）也在此模块，纯函数便于单测。
 *
 * 隔离：resolveCapabilityConfig/summarizeAiConfig 直接传合成 env（纯函数，
 * 不碰真实 .env）；loadEnvFile 传 mkdtemp 临时路径；涉及 process.env 的
 * 入口（isCapabilityConfigured/requireCapabilityConfig）先 stub 掉本机
 * .env 中存在的键（空串非 undefined，loadEnvFile 不会覆盖），防真实
 * .env 污染断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AI_CAPABILITIES,
  applyAiEnvAnswers,
  buildAiConfigQuestions,
  envPath,
  isCapabilityConfigured,
  loadEnvFile,
  reloadAiEnv,
  requireCapabilityConfig,
  resolveCapabilityConfig,
  summarizeAiConfig,
} from './ai-config.js'

let tmpDir: string

/** 生成合成 env（默认全空，按需覆盖键）。 */
function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-test-'))
  // 防真实仓库 .env 注入：把 .env 可能出现的键预置为空串（loadEnvFile 不覆盖已存在键）
  for (const d of AI_CAPABILITIES) {
    vi.stubEnv(`${d.prefix}BASE_URL`, '')
    vi.stubEnv(`${d.prefix}KEY`, '')
    vi.stubEnv(`${d.prefix}MODEL`, '')
  }
  vi.stubEnv('AI_GATEWAY_BASE_URL', '')
  vi.stubEnv('AI_GATEWAY_KEY', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveCapabilityConfig（纯解析）', () => {
  it('能力级三件套齐全 → baseUrl 去尾斜杠、model 用显式值', () => {
    const cfg = resolveCapabilityConfig('asr', makeEnv({
      AI_ASR_BASE_URL: 'https://gw.example.com/v1/ ',
      AI_ASR_KEY: 'sk-abc',
      AI_ASR_MODEL: 'MyASR',
    }))
    expect(cfg).not.toBeNull()
    expect(cfg!.baseUrl).toBe('https://gw.example.com/v1')
    expect(cfg!.apiKey).toBe('sk-abc')
    expect(cfg!.model).toBe('MyASR')
  })

  it('能力级只有 BASE_URL 缺 KEY → 回退全局；无全局 → null', () => {
    expect(resolveCapabilityConfig('vision', makeEnv({ AI_VISION_BASE_URL: 'https://x/v1' }))).toBeNull()
    const cfg = resolveCapabilityConfig('vision', makeEnv({
      AI_VISION_BASE_URL: 'https://cap/v1',
      AI_GATEWAY_BASE_URL: 'https://global/v1',
      AI_GATEWAY_KEY: 'sk-global',
    }))
    expect(cfg!.baseUrl).toBe('https://global/v1')
  })

  it('仅全局凭据 → 4 个能力全部解析成功（fallback），model 用各自默认值', () => {
    const env = makeEnv({ AI_GATEWAY_BASE_URL: 'https://g/v1', AI_GATEWAY_KEY: 'sk-g' })
    for (const d of AI_CAPABILITIES) {
      const cfg = resolveCapabilityConfig(d.id, env)
      expect(cfg, `${d.id} 应经全局 fallback 解析`).not.toBeNull()
      expect(cfg!.baseUrl).toBe('https://g/v1')
    }
  })

  it('MODEL 缺省 → 4 组各自默认模型', () => {
    const defaults: Record<string, string> = { asr: 'SenseVoiceSmall', vision: 'qwen2.5-vl', image: 'gpt-image-2', tts: 'IndexTTS-1.5' }
    const env = makeEnv({ AI_GATEWAY_BASE_URL: 'https://g/v1', AI_GATEWAY_KEY: 'sk-g' })
    for (const d of AI_CAPABILITIES) {
      expect(resolveCapabilityConfig(d.id, env)!.model).toBe(defaults[d.id])
    }
  })

  it('能力级 MODEL 显式 → 用显式值；值为空串时用默认', () => {
    const env = makeEnv({ AI_IMAGE_BASE_URL: 'https://i/v1', AI_IMAGE_KEY: 'sk-i', AI_IMAGE_MODEL: 'gpt-image-3' })
    expect(resolveCapabilityConfig('image', env)!.model).toBe('gpt-image-3')
    const env2 = makeEnv({ AI_IMAGE_BASE_URL: 'https://i/v1', AI_IMAGE_KEY: 'sk-i', AI_IMAGE_MODEL: '  ' })
    expect(resolveCapabilityConfig('image', env2)!.model).toBe('gpt-image-2')
  })

  it('能力级优先于全局（能力级配齐时不用全局地址）', () => {
    const env = makeEnv({
      AI_TTS_BASE_URL: 'https://cap/v1',
      AI_TTS_KEY: 'sk-cap',
      AI_GATEWAY_BASE_URL: 'https://global/v1',
      AI_GATEWAY_KEY: 'sk-global',
    })
    const cfg = resolveCapabilityConfig('tts', env)
    expect(cfg!.baseUrl).toBe('https://cap/v1')
    expect(cfg!.apiKey).toBe('sk-cap')
  })

  it('全局对只有其一 → 未配置', () => {
    expect(resolveCapabilityConfig('asr', makeEnv({ AI_GATEWAY_BASE_URL: 'https://g/v1' }))).toBeNull()
    expect(resolveCapabilityConfig('asr', makeEnv({ AI_GATEWAY_KEY: 'sk-g' }))).toBeNull()
  })

  it('requireCapabilityConfig 未配置 → 抛错且消息含能力名与所需变量名', () => {
    expect(() => requireCapabilityConfig('asr')).toThrow(/AI_ASR_BASE_URL/)
    expect(() => requireCapabilityConfig('asr')).toThrow(/语音转文字/)
  })

  it('isCapabilityConfigured 三分支：能力级 / 仅全局 / 都无', () => {
    vi.stubEnv('AI_ASR_BASE_URL', 'https://a/v1')
    vi.stubEnv('AI_ASR_KEY', 'sk-a')
    expect(isCapabilityConfigured('asr')).toBe(true)
    vi.stubEnv('AI_ASR_BASE_URL', '')
    vi.stubEnv('AI_ASR_KEY', '')
    expect(isCapabilityConfigured('asr')).toBe(false)
    vi.stubEnv('AI_GATEWAY_BASE_URL', 'https://g/v1')
    vi.stubEnv('AI_GATEWAY_KEY', 'sk-g')
    expect(isCapabilityConfigured('asr')).toBe(true)
  })
})

describe('loadEnvFile', () => {
  it('默认路径 = 固定位置 <stateDir>/weixin-dsh/.env（不随 lib 副本漂移）', () => {
    // OPENCLAW_STATE_DIR → resolveStateDir → envPath() 指向临时目录（函数内动态求值）
    vi.stubEnv('OPENCLAW_STATE_DIR', tmpDir)
    expect(envPath()).toBe(path.join(tmpDir, 'weixin-dsh', '.env'))
    vi.stubEnv('AI_ASR_KEY', undefined)
    fs.mkdirSync(path.join(tmpDir, 'weixin-dsh'), { recursive: true })
    fs.writeFileSync(envPath(), 'AI_ASR_KEY=sk-fixed-location\n')
    loadEnvFile() // 无参 → 固定位置
    expect(process.env.AI_ASR_KEY).toBe('sk-fixed-location')
  })

  it('从临时 .env 注入；已存在的环境变量不被覆盖', () => {
    const envPath = path.join(tmpDir, '.env')
    fs.writeFileSync(envPath, 'AI_ASR_BASE_URL=https://from-file/v1\nAI_ASR_KEY=sk-file\n')
    vi.stubEnv('AI_ASR_BASE_URL', 'https://from-env/v1')
    vi.stubEnv('AI_ASR_KEY', undefined) // 置空以便 .env 注入（不覆盖已存在的键）
    loadEnvFile(envPath)
    expect(process.env.AI_ASR_BASE_URL).toBe('https://from-env/v1') // env 优先
    expect(process.env.AI_ASR_KEY).toBe('sk-file') // .env 注入
  })

  it('文件不存在静默；重复调用幂等', () => {
    expect(() => loadEnvFile(path.join(tmpDir, 'missing.env'))).not.toThrow()
    const envPath = path.join(tmpDir, '.env')
    vi.stubEnv('AI_IMAGE_KEY', undefined)
    fs.writeFileSync(envPath, 'AI_IMAGE_KEY=sk-1\n')
    loadEnvFile(envPath)
    expect(process.env.AI_IMAGE_KEY).toBe('sk-1')
    fs.writeFileSync(envPath, 'AI_IMAGE_KEY=sk-2\n')
    loadEnvFile(envPath) // 已存在不覆盖
    expect(process.env.AI_IMAGE_KEY).toBe('sk-1')
  })

  it('reloadAiEnv：重载后反映 .env 最新内容（清除/新增均生效），真实环境变量不受影响', () => {
    vi.stubEnv('OPENCLAW_STATE_DIR', tmpDir)
    const p = envPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    vi.stubEnv('AI_ASR_KEY', undefined)
    vi.stubEnv('AI_ASR_MODEL', undefined)
    vi.stubEnv('AI_TTS_MODEL', undefined)
    fs.writeFileSync(p, 'AI_ASR_KEY=sk-first\n')
    loadEnvFile()
    expect(process.env.AI_ASR_KEY).toBe('sk-first')
    // 磁盘内容变化：asr 被清除、tts 新增；真实环境变量（export 的）不受影响
    vi.stubEnv('AI_IMAGE_KEY', 'sk-exported') // 模拟用户 export
    fs.writeFileSync(p, 'AI_TTS_MODEL=MyTTS\n')
    reloadAiEnv()
    expect(process.env.AI_ASR_KEY).toBeUndefined() // 清除生效
    expect(process.env.AI_TTS_MODEL).toBe('MyTTS') // 新增生效
    expect(process.env.AI_IMAGE_KEY).toBe('sk-exported') // export 的值不被动
  })
})

describe('buildAiConfigQuestions（引导问题构建）', () => {
  it('未配置能力 → 无 action、fields 三问、model 默认值为默认模型', () => {
    const [asr] = buildAiConfigQuestions(makeEnv())
    expect(asr.configured).toBe(false)
    expect(asr.action).toBeUndefined()
    expect(asr.fields).toHaveLength(3)
    expect(asr.fields[0]!.id).toBe('asr.url')
    expect(asr.fields[1]!.required).toBe(true)
    expect(asr.fields[2]!.defaultValue).toBe('SenseVoiceSmall')
  })

  it('能力级已配置 → 有 action 三选一、fields 预填当前值', () => {
    const [asr] = buildAiConfigQuestions(makeEnv({
      AI_ASR_BASE_URL: 'https://a/v1',
      AI_ASR_KEY: 'sk-abc1234',
      AI_ASR_MODEL: 'MyASR',
    }))
    expect(asr.configured).toBe(true)
    expect(asr.action).toBeDefined()
    expect(asr.action!.prompt).toContain('已配置')
    expect(asr.fields[0]!.defaultValue).toBe('https://a/v1')
    expect(asr.fields[2]!.defaultValue).toBe('MyASR')
  })

  it('仅全局兜底 → configured=true、current 来自全局凭据', () => {
    const [vision] = buildAiConfigQuestions(makeEnv({
      AI_GATEWAY_BASE_URL: 'https://g/v1',
      AI_GATEWAY_KEY: 'sk-g',
    }))
    expect(vision.configured).toBe(true)
    expect(vision.current!.baseUrl).toBe('https://g/v1')
  })

  it('key 打码：prompt 含 **** 且不含完整密钥', () => {
    const [asr] = buildAiConfigQuestions(makeEnv({
      AI_ASR_BASE_URL: 'https://a/v1',
      AI_ASR_KEY: 'sk-super-secret-key-8888',
    }))
    const prompt = asr.action!.prompt + asr.fields[1]!.prompt
    expect(prompt).toContain('****')
    expect(prompt).not.toContain('sk-super-secret-key-8888')
    expect(prompt).toContain('8888') // 末 4 位可见
  })
})

describe('applyAiEnvAnswers（.env upsert）', () => {
  it('从空文本写入新组 → 行齐全且以换行结尾（model 未答不写行）', () => {
    const out = applyAiEnvAnswers('', { 'asr.url': 'https://a/v1', 'asr.key': 'sk-a' })
    expect(out).toBe('AI_ASR_BASE_URL=https://a/v1\nAI_ASR_KEY=sk-a\n')
  })

  it('保留无关变量/注释/空行（涉及行以外逐字节不变）', () => {
    const existing = '# 注释\n\nAI_GATEWAY_BASE_URL=https://g/v1\nX=keep\n'
    const out = applyAiEnvAnswers(existing, { 'asr.url': 'https://a/v1', 'asr.key': 'sk-a' })
    expect(out).toContain('# 注释\n\n')
    expect(out).toContain('AI_GATEWAY_BASE_URL=https://g/v1\n')
    expect(out).toContain('X=keep\n')
  })

  it('更新已存在值 → 替换首个出现行，无重复行', () => {
    const existing = 'AI_ASR_BASE_URL=old\nAI_ASR_KEY=k\n'
    const out = applyAiEnvAnswers(existing, { 'asr.url': 'new' })
    expect(out).toBe('AI_ASR_BASE_URL=new\nAI_ASR_KEY=k\n')
    expect(out.match(/AI_ASR_BASE_URL=/g)).toHaveLength(1)
  })

  it('部分更新（只写 url）→ 仅该行变化，key/model 行不动', () => {
    const existing = 'AI_VISION_BASE_URL=old\nAI_VISION_KEY=k\nAI_VISION_MODEL=m\n'
    const out = applyAiEnvAnswers(existing, { 'vision.url': 'https://new/v1' })
    expect(out).toBe('AI_VISION_BASE_URL=https://new/v1\nAI_VISION_KEY=k\nAI_VISION_MODEL=m\n')
  })

  it("action='x' → 删除该组三行，其余不动", () => {
    const existing = 'AI_TTS_BASE_URL=a\nAI_TTS_KEY=b\nAI_TTS_MODEL=m\nX=1\n'
    const out = applyAiEnvAnswers(existing, { 'tts.action': 'x' })
    expect(out).toBe('X=1\n')
  })

  it('幂等：同一 answers 应用两次结果一致；无变更时输出 === 输入', () => {
    const existing = '# c\nAI_GATEWAY_BASE_URL=g\n'
    const answers = { 'asr.url': 'https://a/v1', 'asr.key': 'sk-a' }
    const once = applyAiEnvAnswers(existing, answers)
    expect(applyAiEnvAnswers(once, answers)).toBe(once)
    // 无变更（answers 为空）→ 原样返回（包括无尾换行文件不补 \n）
    expect(applyAiEnvAnswers('# c\nAI_GATEWAY_BASE_URL=g', {})).toBe('# c\nAI_GATEWAY_BASE_URL=g')
  })

  it('空字符串值不写该键', () => {
    const out = applyAiEnvAnswers('', { 'asr.url': 'https://a/v1', 'asr.key': '', 'asr.model': '' })
    expect(out).toBe('AI_ASR_BASE_URL=https://a/v1\n')
  })

  it('同键重复行 → 替换首个、删除其余', () => {
    const existing = 'AI_ASR_BASE_URL=old1\nAI_ASR_BASE_URL=old2\nAI_ASR_KEY=k\n'
    const out = applyAiEnvAnswers(existing, { 'asr.url': 'new' })
    expect(out).toBe('AI_ASR_BASE_URL=new\nAI_ASR_KEY=k\n')
  })
})

describe('summarizeAiConfig', () => {
  it('混合配置：能力级/未配置状态标记（无全局凭据时未配置能力降级）', () => {
    const env = makeEnv({
      AI_ASR_BASE_URL: 'https://asr/v1',
      AI_ASR_KEY: 'sk-asr',
      AI_IMAGE_BASE_URL: 'https://img/v1',
      AI_IMAGE_KEY: 'sk-img',
    })
    const text = summarizeAiConfig(env)
    expect(text).toContain('✅ 语音转文字: https://asr/v1（SenseVoiceSmall，能力级）')
    expect(text).toContain('✅ 文生图: https://img/v1（gpt-image-2，能力级）')
    expect(text).toContain('⚪ 图像理解: 未配置 → 静默降级')
    expect(text).toContain('⚪ 语音合成: 未配置 → 静默降级')
  })

  it('全局凭据兜底：未单独配置的能力显示全局来源', () => {
    const env = makeEnv({
      AI_GATEWAY_BASE_URL: 'https://g/v1',
      AI_GATEWAY_KEY: 'sk-g',
    })
    const text = summarizeAiConfig(env)
    expect(text).toContain('✅ 图像理解: https://g/v1（qwen2.5-vl，全局）')
    expect(text).toContain('✅ 语音合成: https://g/v1（IndexTTS-1.5，全局）')
    expect(text).not.toContain('⚪')
  })
})
