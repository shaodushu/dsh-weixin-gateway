/**
 * dialog-config 单元测试（对话模型 provider 配置的纯逻辑）。
 *
 * 覆盖：已配置/未配置检测（flow 多行与简化块两种格式）、settings.yaml
 * 顶层块替换/追加/删除、.credentials.yaml 键值 upsert、模型展示名生成、
 * key 默认值回退。文件写入用 DSH_HOME 临时目录隔离，不碰真实 ~/.dsh。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  applyDialogModelAnswers,
  buildDialogModelQuestions,
  credentialsPath,
  extractCredentialValue,
  modelDisplayName,
  resolveDialogModelConfig,
  settingsPath,
  summarizeDialogModel,
  upsertCredentialKey,
  writeCredentialsFile,
  writeSettingsFile,
} from './dialog-config.js'

/** dsh 保存时实际写出的格式（2026-08-19 本机实测）：providers 为 flow 多行，字段 10 空格带尾逗号。 */
const FLOW_SETTINGS = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    {
      company:
        {
          displayName: company,
          apiKeyEnv: COMPANY_API_KEY,
          api: anthropic-messages,
          baseURL: https://ai-platform.xwfintech.com,
          models: [ { id: deepseek/DeepSeek-V4-Flash, name: deepseek-v4-flash } ]
        }
    }
agent-default-model:
  provider: company
  model: deepseek/DeepSeek-V4-Flash
`

/** 简化块格式（早期手动/工具写入，解析需兼容；写回会归一化为 flow 格式）。 */
const SAMPLE_SETTINGS = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    company:
      displayName: company
      apiKeyEnv: COMPANY_API_KEY
      api: anthropic-messages
      baseURL: https://ai-platform.xwfintech.com
      models: [ { id: deepseek/DeepSeek-V4-Flash, name: deepseek-v4-flash } ]
agent-default-model:
  provider: company
  model: deepseek/DeepSeek-V4-Flash
`

const SAMPLE_CRED = '{ COMPANY_API_KEY: sk-xNl2VY5y4LvtcBZ6wNvut4ptt1SnOdTz21gb3Ag6JXowOxmJ }\n'

describe('resolveDialogModelConfig', () => {
  it('flow 格式（dsh 保存输出）：提取 provider / baseURL / model / apiKeyEnv', () => {
    expect(resolveDialogModelConfig(FLOW_SETTINGS)).toEqual({
      provider: 'company',
      apiKeyEnv: 'COMPANY_API_KEY',
      baseURL: 'https://ai-platform.xwfintech.com',
      model: 'deepseek/DeepSeek-V4-Flash',
    })
  })

  it('简化块格式：同样提取成功', () => {
    expect(resolveDialogModelConfig(SAMPLE_SETTINGS)).toEqual({
      provider: 'company',
      apiKeyEnv: 'COMPANY_API_KEY',
      baseURL: 'https://ai-platform.xwfintech.com',
      model: 'deepseek/DeepSeek-V4-Flash',
    })
  })

  it('缺 llm-pi-ai 或 agent-default-model 任一 → null', () => {
    expect(resolveDialogModelConfig('ui-onboarding:\n  welcomeNoticeVersion: 1\n')).toBeNull()
    expect(resolveDialogModelConfig('llm-pi-ai:\n  providers:\n    company:\n      baseURL: https://x\n')).toBeNull()
  })

  it('空文本 → null', () => {
    expect(resolveDialogModelConfig('')).toBeNull()
  })
})

describe('modelDisplayName', () => {
  it('deepseek/DeepSeek-V4-Flash → deepseek-v4-flash', () => {
    expect(modelDisplayName('deepseek/DeepSeek-V4-Flash')).toBe('deepseek-v4-flash')
  })
  it('无前缀 id 原样小写化', () => {
    expect(modelDisplayName('gpt-4o')).toBe('gpt-4o')
  })
})

describe('upsertCredentialKey', () => {
  it('已存在 → 替换值，保留其他键', () => {
    expect(upsertCredentialKey('{ A: x, COMPANY_API_KEY: sk-old }\n', 'COMPANY_API_KEY', 'sk-new')).toBe(
      '{ A: x, COMPANY_API_KEY: sk-new }\n',
    )
  })
  it('空文本 → 新建 flow map', () => {
    expect(upsertCredentialKey('', 'COMPANY_API_KEY', 'sk-new')).toBe('{ COMPANY_API_KEY: sk-new }\n')
  })
  it('flow map 追加（有 inner）', () => {
    expect(upsertCredentialKey('{ A: x }\n', 'COMPANY_API_KEY', 'sk-new')).toBe('{ A: x, COMPANY_API_KEY: sk-new }\n')
  })
  it('空 flow map {} → 填键', () => {
    expect(upsertCredentialKey('{}\n', 'COMPANY_API_KEY', 'sk-new')).toBe('{ COMPANY_API_KEY: sk-new }\n')
  })
  it('多行 map → 末尾追加', () => {
    const multi = 'A: x\nB: y\n'
    expect(upsertCredentialKey(multi, 'COMPANY_API_KEY', 'sk-new')).toBe('A: x\nB: y\nCOMPANY_API_KEY: sk-new\n')
  })
})

describe('applyDialogModelAnswers', () => {
  const answers = {
    'dialog.provider': 'company',
    'dialog.api': 'anthropic-messages',
    'dialog.url': 'https://ai-platform.xwfintech.com',
    'dialog.model': 'deepseek/DeepSeek-V4-Flash',
    'dialog.key': 'sk-new-key',
  }

  it('空文件 → 生成 flow 格式块与 flow cred，可被 resolve 读回', () => {
    const { settingsNext, credNext } = applyDialogModelAnswers('', '', answers)
    expect(resolveDialogModelConfig(settingsNext)).toEqual({
      provider: 'company',
      apiKeyEnv: 'COMPANY_API_KEY',
      baseURL: 'https://ai-platform.xwfintech.com',
      model: 'deepseek/DeepSeek-V4-Flash',
    })
    expect(settingsNext).toContain('  providers:\n    {')
    expect(settingsNext).toContain('          api: anthropic-messages,')
    expect(settingsNext).toContain('models: [ { id: deepseek/DeepSeek-V4-Flash, name: deepseek-v4-flash } ]')
    expect(settingsNext).toContain('agent-default-model:\n  provider: company\n  model: deepseek/DeepSeek-V4-Flash')
    expect(credNext).toBe('{ COMPANY_API_KEY: sk-new-key }\n')
  })

  it('flow 格式已存在 → 整块替换（换地址/模型），保留 ui-onboarding 等其他顶层键', () => {
    const { settingsNext } = applyDialogModelAnswers(
      FLOW_SETTINGS,
      SAMPLE_CRED,
      { 'dialog.url': 'https://new.example.com', 'dialog.model': 'gpt-4o' },
    )
    expect(settingsNext).toContain('ui-onboarding:')
    expect(settingsNext).toContain('baseURL: https://new.example.com,')
    expect(settingsNext).toContain('model: gpt-4o')
    // 原有内容不应残留
    expect(settingsNext).not.toContain('https://ai-platform.xwfintech.com')
    expect(resolveDialogModelConfig(settingsNext)?.model).toBe('gpt-4o')
  })

  it('简化块已存在 → 重写时归一化为 flow 格式，旧内容不残留', () => {
    const { settingsNext } = applyDialogModelAnswers(
      SAMPLE_SETTINGS,
      SAMPLE_CRED,
      { 'dialog.model': 'qwen-max' },
    )
    expect(settingsNext).toContain('  providers:\n    {')
    expect(settingsNext).not.toContain('      displayName: company\n')
    expect(resolveDialogModelConfig(settingsNext)?.model).toBe('qwen-max')
  })

  it('action=x → 删除两个块，保留其他顶层键', () => {
    const { settingsNext, credNext } = applyDialogModelAnswers(FLOW_SETTINGS, SAMPLE_CRED, { 'dialog.action': 'x' })
    expect(settingsNext).toContain('ui-onboarding:')
    expect(settingsNext).not.toContain('llm-pi-ai')
    expect(settingsNext).not.toContain('agent-default-model')
    expect(resolveDialogModelConfig(settingsNext)).toBeNull()
    expect(credNext).toBe(SAMPLE_CRED)
  })

  it('缺 url/key → 原样返回（防御）', () => {
    const r = applyDialogModelAnswers('', '', { 'dialog.url': 'https://x' })
    expect(r.settingsNext).toBe('')
    expect(r.credNext).toBe('')
  })

  it('flow 格式只改 key → settings 保持逐字节不变（幂等）、cred 值替换', () => {
    const { settingsNext, credNext } = applyDialogModelAnswers(
      FLOW_SETTINGS,
      SAMPLE_CRED,
      { 'dialog.key': 'sk-rotated' },
    )
    expect(settingsNext).toBe(FLOW_SETTINGS)
    expect(credNext).toContain('sk-rotated')
    expect(credNext).not.toContain('sk-xNl2')
  })
})

describe('buildDialogModelQuestions', () => {
  it('已配置 → 摘要 action + 5 字段，key 默认值取现有凭据', () => {
    const q = buildDialogModelQuestions({} as NodeJS.ProcessEnv, SAMPLE_SETTINGS, SAMPLE_CRED)
    expect(q.configured).toBe(true)
    expect(q.action?.prompt).toContain('已配置')
    expect(q.fields.map((f) => f.id)).toEqual(['dialog.provider', 'dialog.api', 'dialog.url', 'dialog.model', 'dialog.key'])
    expect(q.fields[0].defaultValue).toBe('company')
    expect(q.fields[3].defaultValue).toBe('deepseek/DeepSeek-V4-Flash')
    expect(q.fields[4].defaultValue).toBe('sk-xNl2VY5y4LvtcBZ6wNvut4ptt1SnOdTz21gb3Ag6JXowOxmJ')
    expect(q.fields[4].required).toBe(false)
  })

  it('未配置 → 无 action，url 必填，key 回退 AI_GATEWAY_KEY', () => {
    const q = buildDialogModelQuestions(
      { AI_GATEWAY_KEY: 'sk-fallback' } as NodeJS.ProcessEnv,
      '',
      '',
    )
    expect(q.configured).toBe(false)
    expect(q.action).toBeUndefined()
    expect(q.fields[2].required).toBe(true)
    expect(q.fields[4].defaultValue).toBe('sk-fallback')
  })

  it('未配置且无全局 key → key 必填', () => {
    const q = buildDialogModelQuestions({} as NodeJS.ProcessEnv, '', '')
    expect(q.fields[4].required).toBe(true)
    expect(q.fields[4].prompt).toContain('****')
  })
})

describe('写入与摘要', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-config-test-'))
    vi.stubEnv('DSH_HOME', tmpDir)
    vi.stubEnv('AI_GATEWAY_KEY', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writeSettingsFile / writeCredentialsFile 落盘 0600，可被 resolve 读回', () => {
    const { settingsNext, credNext } = applyDialogModelAnswers('', '', {
      'dialog.url': 'https://ai-platform.xwfintech.com',
      'dialog.model': 'deepseek/DeepSeek-V4-Flash',
      'dialog.key': 'sk-secret',
    })
    expect(writeSettingsFile(settingsNext)).toBe(true)
    expect(writeCredentialsFile(credNext)).toBe(true)
    expect(fs.existsSync(settingsPath())).toBe(true)
    expect(fs.statSync(settingsPath()).mode & 0o777).toBe(0o600)
    expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600)
    const readBack = fs.readFileSync(settingsPath(), 'utf8')
    expect(resolveDialogModelConfig(readBack)?.baseURL).toBe('https://ai-platform.xwfintech.com')
    expect(extractCredentialValue(fs.readFileSync(credentialsPath(), 'utf8'), 'COMPANY_API_KEY')).toBe('sk-secret')
  })

  it('summarizeDialogModel：已配置显示 provider/model/地址', () => {
    expect(summarizeDialogModel(SAMPLE_SETTINGS)).toContain('company / deepseek/DeepSeek-V4-Flash')
    expect(summarizeDialogModel(SAMPLE_SETTINGS)).toContain('https://ai-platform.xwfintech.com')
  })
  it('summarizeDialogModel：未配置提示引导', () => {
    expect(summarizeDialogModel('')).toContain('未配置')
  })
})
