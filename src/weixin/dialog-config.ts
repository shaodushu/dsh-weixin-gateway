/**
 * dialog-config — 对话模型 provider 配置（~/.dsh/settings.yaml + .credentials.yaml）。
 *
 * 与 ai-config.ts 同模式：setup 交互式引导的纯逻辑（检测 / 问题构建 / 文本
 * upsert / 写文件），cli.ts 只做 readline 交互。文件结构（实测 dsh 0.1.0-rc.6，
 * 2026-08-19 复查：dsh 保存时会把 providers 序列化成 flow 多行格式）：
 *
 * ~/.dsh/settings.yaml:
 *   llm-pi-ai:
 *     providers:
 *       {
 *         company:
 *           {
 *             displayName: company,
 *             apiKeyEnv: COMPANY_API_KEY,      # 指向 ~/.dsh/.credentials.yaml 的键
 *             api: anthropic-messages,
 *             baseURL: https://ai-platform.xwfintech.com,
 *             models: [ { id: deepseek/DeepSeek-V4-Flash, name: deepseek-v4-flash } ]
 *           }
 *       }
 *   agent-default-model:
 *     provider: company
 *     model: deepseek/DeepSeek-V4-Flash
 *
 * ~/.dsh/.credentials.yaml:
 *   { COMPANY_API_KEY: sk-xxx }
 *
 * 两种 llm-pi-ai 风格都识别：flow 多行（dsh 保存时的输出，10 空格字段）与
 * 简化块（早期手动/工具写入，6 空格字段）——不能只认一种，否则真实配置
 * 会被误判为未配置。写回统一生成 flow 格式（与 dsh 再保存时零 diff）。
 *
 * 注意：对话模型 baseURL 不带 /v1（anthropic-messages API），与 AI 能力
 * （OpenAI 兼容，/v1）不同源——引导里地址与 key 单独问，不复用。
 * apiKeyEnv 固定 COMPANY_API_KEY（与 dsh 惯例一致），key 值写入 .credentials.yaml。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { maskKey } from './ai-config.js'

/** 对话模型凭据键名（settings.yaml 的 apiKeyEnv 与 .credentials.yaml 的键）。 */
export const DIALOG_API_KEY_ENV = 'COMPANY_API_KEY'

/** 对话模型 provider 配置（从 settings.yaml 提取的当前值）。 */
export interface DialogModelConfig {
  provider: string
  apiKeyEnv: string
  baseURL: string
  model: string
}

/** 单字段问题（cli 交互用）。 */
export interface DialogModelQuestionField {
  id: string
  prompt: string
  defaultValue?: string
  required?: boolean
}

/** 对话模型引导问题束（仿 AiCapabilityQuestions）。 */
export interface DialogModelQuestions {
  configured: boolean
  current: DialogModelConfig | null
  /** .credentials.yaml 里的当前 key（打码显示用）。 */
  keyCurrent: string | undefined
  action?: { id: string; prompt: string }
  fields: DialogModelQuestionField[]
}

/** dsh 家目录（测试用 DSH_HOME 隔离）。 */
export function dshHome(): string {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}

/** settings.yaml 路径。 */
export function settingsPath(): string {
  return path.join(dshHome(), 'settings.yaml')
}

/** .credentials.yaml 路径。 */
export function credentialsPath(): string {
  return path.join(dshHome(), '.credentials.yaml')
}

/** 顶层键 → 块文本（缩进 0 的 `key:` 行到下一个顶层键行之前）。 */
function topLevelBlocks(text: string): Map<string, string> {
  const lines = text.split('\n')
  const keys: Array<{ key: string; start: number }> = []
  lines.forEach((l, i) => {
    const m = l.match(/^([A-Za-z0-9_.-]+):/)
    if (m) keys.push({ key: m[1], start: i })
  })
  const blocks = new Map<string, string>()
  for (let i = 0; i < keys.length; i++) {
    const end = i + 1 < keys.length ? keys[i + 1].start : lines.length
    blocks.set(keys[i].key, lines.slice(keys[i].start, end).join('\n'))
  }
  return blocks
}

/** 顶层键行号区间（替换/删除用）。返回 null 表示键不存在。 */
function topLevelRange(text: string, key: string): { start: number; end: number } | null {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.match(new RegExp(`^${key}:`)))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_.-]+:/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/**
 * 解析 settings.yaml 文本 → 对话模型配置（缺 llm-pi-ai 或 agent-default-model 返回 null）。
 * 兼容两种 llm-pi-ai 风格：flow 多行（dsh 保存输出：providers 块含 `{`，字段
 * 10 空格、值带尾逗号）与简化块（4/6 空格、无逗号）。detect 后走对应锚定组，
 * 避免无锚定正则把 provider 名误配到 displayName 等带值键行（实测坑）。
 */
export function resolveDialogModelConfig(settingsText: string): DialogModelConfig | null {
  const blocks = topLevelBlocks(settingsText)
  const llm = blocks.get('llm-pi-ai')
  const adm = blocks.get('agent-default-model')
  if (!llm || !adm) return null
  // flow 判定：providers 子层是 4 空格独立的 `{` 行（简化块里 `{` 只出现在 models 行内，缩进更深）
  const isFlow = /^ {4}\{/m.test(llm)
  // flow（dsh 保存格式）：providers 下 { company: { 字段 10 空格 } }；agent-default-model 保持简化 2 空格
  const baseURL = llm.match(isFlow ? /^ {10}baseURL:\s*(\S+?),?\s*$/m : /^ {6}baseURL:\s*(\S+)$/m)?.[1]
  const apiKeyEnv = llm.match(isFlow ? /^ {10}apiKeyEnv:\s*(\S+?),?\s*$/m : /^ {6}apiKeyEnv:\s*(\S+)$/m)?.[1]
  const provider = llm.match(isFlow ? /^ {6}([A-Za-z0-9_.-]+):\s*$/m : /^ {4}([A-Za-z0-9_.-]+):\s*$/m)?.[1]
  const model = adm.match(/^ {2}model:\s*(\S+)$/m)?.[1]
  if (!baseURL || !apiKeyEnv || !provider || !model) return null
  return { provider, apiKeyEnv, baseURL, model }
}

/** 从 .credentials.yaml 文本提取某键的值（flow map 或多行 map 均支持）。 */
export function extractCredentialValue(credText: string, key: string): string | undefined {
  const m = credText.match(new RegExp(`(?:^|[^\\w])${key}:\\s*(\\S+)`))
  return m?.[1]
}

/** 构建引导问题束（已配置：摘要 + 回车保持 / r 重配 / x 清除；字段按交互输入）。 */
export function buildDialogModelQuestions(
  env: NodeJS.ProcessEnv,
  settingsText: string,
  credText: string,
): DialogModelQuestions {
  const current = resolveDialogModelConfig(settingsText)
  const keyCurrent = extractCredentialValue(credText, DIALOG_API_KEY_ENV)
  // key 默认值：现有凭据优先，其次 AI 能力全局 key（同网关常见）；无默认时必填
  const keyDefault = keyCurrent ?? env.AI_GATEWAY_KEY?.trim() ?? ''
  const providerDefault = current?.provider ?? 'company'
  const apiDefault = 'anthropic-messages'
  const modelDefault = current?.model ?? 'deepseek/DeepSeek-V4-Flash'

  const fields: DialogModelQuestionField[] = [
    { id: 'dialog.provider', prompt: `  provider 名 [${providerDefault}]: `, defaultValue: providerDefault },
    {
      id: 'dialog.api',
      prompt: `  API 风格 [${apiDefault}]（anthropic-messages / openai-responses / openai-completions）: `,
      defaultValue: apiDefault,
    },
    { id: 'dialog.url', prompt: '  网关地址（必填，如 https://ai-platform.xwfintech.com，不带 /v1）: ', required: true },
    { id: 'dialog.model', prompt: `  模型 id [${modelDefault}]: `, defaultValue: modelDefault },
    {
      id: 'dialog.key',
      prompt: `  API 密钥 [${maskKey(keyDefault)}${keyDefault ? '，回车保持现有' : ''}]: `,
      defaultValue: keyDefault,
      required: keyDefault === '',
    },
  ]

  if (current) {
    return {
      configured: true,
      current,
      keyCurrent,
      action: {
        id: 'dialog.action',
        prompt: `对话模型 已配置（${current.baseURL}，${current.provider} / ${current.model}，key ${maskKey(keyDefault)}），回车保持 / r 重新配置 / x 清除: `,
      },
      fields,
    }
  }
  return { configured: false, current: null, keyCurrent: undefined, fields }
}

/** 模型 id → 展示名（deepseek/DeepSeek-V4-Flash → deepseek-v4-flash）。 */
export function modelDisplayName(modelId: string): string {
  const tail = modelId.split('/').pop() ?? modelId
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * 生成 settings.yaml 的两个块。llm-pi-ai 用 flow 多行格式（与 dsh 保存时的
 * 序列化输出逐字符一致：providers 花括号 4/8 空格、字段 10 空格带尾逗号、
 * models 最后一项无逗号）——这样 dsh 下次写配置时零 diff。agent-default-model
 * 是固定两键对象，dsh 以简化块输出（2 空格），保持一致。
 */
function buildSettingsBlocks(parts: {
  provider: string
  api: string
  url: string
  model: string
}): { llm: string; adm: string } {
  return {
    llm: [
      'llm-pi-ai:',
      '  providers:',
      '    {',
      `      ${parts.provider}:`,
      '        {',
      `          displayName: ${parts.provider},`,
      `          apiKeyEnv: ${DIALOG_API_KEY_ENV},`,
      `          api: ${parts.api},`,
      `          baseURL: ${parts.url},`,
      `          models: [ { id: ${parts.model}, name: ${modelDisplayName(parts.model)} } ]`,
      '        }',
      '    }',
    ].join('\n'),
    adm: ['agent-default-model:', `  provider: ${parts.provider}`, `  model: ${parts.model}`].join('\n'),
  }
}

/** 替换顶层块（不存在则追加到文件末尾，保留其他顶层键；内容相同则原样返回）。 */
function upsertTopLevelBlock(text: string, key: string, block: string): string {
  const range = topLevelRange(text, key)
  if (!range) {
    return text.replace(/\s*$/, '') + (text ? '\n' : '') + block + '\n'
  }
  const existing = text.split('\n').slice(range.start, range.end).join('\n')
  // 幂等：内容无变化不重写（容忍块尾换行差异，SAMPLE 文件以 \n 结尾）
  if (existing.replace(/\n$/, '') === block.replace(/\n$/, '')) return text
  const lines = text.split('\n')
  lines.splice(range.start, range.end - range.start, block)
  return lines.join('\n')
}

/** 删除顶层块（连同紧邻空行清理）。 */
function deleteTopLevelBlock(text: string, key: string): string {
  const range = topLevelRange(text, key)
  if (!range) return text
  const lines = text.split('\n')
  lines.splice(range.start, range.end - range.start)
  // 清理块留下的连续空行
  const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
  return joined
}

/** upsert .credentials.yaml 的某个键值（单行 flow map / 多行 map / 新建均支持）。 */
export function upsertCredentialKey(text: string, key: string, value: string): string {
  if (text.trim() === '') return `{ ${key}: ${value} }\n`
  const re = new RegExp(`(${key}:\\s*)\\S+`)
  if (re.test(text)) return text.replace(re, `$1${value}`)
  const flow = text.match(/^\{\s*([^}]*)\s*\}\s*$/)
  if (flow) {
    const inner = flow[1].trim()
    return inner === '' ? `{ ${key}: ${value} }\n` : `{ ${inner}, ${key}: ${value} }\n`
  }
  return text.replace(/\s*$/, '') + `\n${key}: ${value}\n`
}

/**
 * 纯函数：现有 settings.yaml + .credentials.yaml 文本 + 问答结果 → 两个新文本。
 * answers 键：dialog.action（'x' 删除）/ dialog.provider / dialog.api /
 * dialog.url / dialog.model / dialog.key（非空才写入；缺 url/key 时回退现有值）。
 */
export function applyDialogModelAnswers(
  settingsText: string,
  credText: string,
  answers: Record<string, string>,
): { settingsNext: string; credNext: string } {
  if (answers['dialog.action'] === 'x') {
    return {
      settingsNext: deleteTopLevelBlock(deleteTopLevelBlock(settingsText, 'llm-pi-ai'), 'agent-default-model'),
      credNext: credText,
    }
  }
  const cur = resolveDialogModelConfig(settingsText)
  const provider = answers['dialog.provider'] ?? cur?.provider ?? 'company'
  const api = answers['dialog.api'] ?? 'anthropic-messages'
  const url = answers['dialog.url'] ?? cur?.baseURL ?? ''
  const model = answers['dialog.model'] ?? cur?.model ?? 'deepseek/DeepSeek-V4-Flash'
  const key = answers['dialog.key'] ?? extractCredentialValue(credText, DIALOG_API_KEY_ENV) ?? ''
  if (!url || !key) return { settingsNext: settingsText, credNext: credText } // 防御：交互层已保证必填

  const { llm, adm } = buildSettingsBlocks({ provider, api, url, model })
  return {
    settingsNext: upsertTopLevelBlock(upsertTopLevelBlock(settingsText, 'llm-pi-ai', llm), 'agent-default-model', adm),
    credNext: upsertCredentialKey(credText, DIALOG_API_KEY_ENV, key),
  }
}

/** 写 settings.yaml（0600）。失败返回 false 由调用方打印手动指引。 */
export function writeSettingsFile(text: string): boolean {
  return writeTextFile(settingsPath(), text)
}

/** 写 .credentials.yaml（0600）。 */
export function writeCredentialsFile(text: string): boolean {
  return writeTextFile(credentialsPath(), text)
}

function writeTextFile(p: string, text: string): boolean {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** 打印用摘要：✅ provider / model（地址）或 ⚪ 未配置。 */
export function summarizeDialogModel(settingsText: string): string {
  const cfg = resolveDialogModelConfig(settingsText)
  if (!cfg) return '  ⚪ 对话模型: 未配置（可 dsh-weixin setup 引导，或手动编辑 ~/.dsh/settings.yaml）'
  return `  ✅ 对话模型: ${cfg.provider} / ${cfg.model}（${cfg.baseURL}）`
}
