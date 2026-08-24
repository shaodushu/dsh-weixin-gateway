/**
 * nickname-config — setup 引导"微信用户昵称"的纯逻辑。
 *
 * 昵称写入固定位置 ~/.openclaw/weixin-dsh/.env（WEIXIN_USER_NICKNAME），
 * 网关用它给 __room__ 会话设置标题（web 端会话列表可识别）。
 * 与 ai-config.ts 同模式：问题/文本 upsert 为纯函数，便于单测。
 */
import { envPath, writeEnvFile } from './ai-config.js'

/** 昵称环境变量键。 */
export const NICKNAME_ENV_KEY = 'WEIXIN_USER_NICKNAME'

/** 当前已配置的昵称（env 已由 loadEnvFile 注入）；未配置返回 undefined。 */
export function currentNickname(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[NICKNAME_ENV_KEY]?.trim()
  return v === '' ? undefined : v
}

/**
 * .env 文本 upsert WEIXIN_USER_NICKNAME（保留无关行，重复行去重）。
 * 空昵称视为不修改，原样返回。
 */
export function applyNicknameText(existing: string, nickname: string): string {
  const value = nickname.trim()
  if (value === '') return existing
  const lines = existing.split('\n')
  const keyOf = new Map<number, string>()
  const firstIndex = new Map<string, number>()
  lines.forEach((line, i) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!m) return
    keyOf.set(i, m[1])
    if (!firstIndex.has(m[1])) firstIndex.set(m[1], i)
  })
  const next: string[] = []
  lines.forEach((line, i) => {
    const key = keyOf.get(i)
    if (key !== NICKNAME_ENV_KEY) {
      next.push(line)
      return
    }
    if (firstIndex.get(key) !== i) return // 重复行删除
    next.push(`${key}=${value}`)
  })
  while (next.length > 0 && next[next.length - 1] === '') next.pop()
  if (!firstIndex.has(NICKNAME_ENV_KEY)) next.push(`${NICKNAME_ENV_KEY}=${value}`)
  let text = next.join('\n')
  if (text !== '') text += '\n'
  return text
}

/** 写入固定位置 .env；失败返回 false（调用方打印手动指引）。 */
export function writeNicknameEnv(text: string): boolean {
  return writeEnvFile(text)
}

/** .env 文件路径（复用 ai-config 的固定位置）。 */
export function nicknameEnvPath(): string {
  return envPath()
}
