/**
 * cron-expr — 5 字段 cron 表达式解析与下一触发时刻计算（零依赖自实现）。
 *
 * 支持的表达式（空白分隔，恰好 5 段）：
 *   minute hour dayOfMonth month dayOfWeek
 * 每段支持：`*`（任意）| `N`（具体值）| `* /step`（从最小允许值起按步长展开）。
 * 范围：minute 0-59 / hour 0-23 / dayOfMonth 1-31 / month 1-12 / dayOfWeek 0-7
 * （0 与 7 均为周日，解析时归一化为 0）。
 *
 * 日匹配采用标准 cron OR 语义：dayOfMonth 与 dayOfWeek 均受限时，任一匹配
 * 即通过（例如 `0 0 1 * 1` = 每月 1 号或每周一）。
 *
 * 时间基准为进程本地时间，逐分扫描，不做 DST/时区特判（README 注明）。
 */

export type CronField = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek'

/** 单个字段的匹配规格。 */
export interface CronFieldSpec {
  /** 已展开的匹配值集合（dayOfWeek 已归一化：7 → 0）。 */
  values: Set<number>
  /** true = '*'（任意值，忽略 values）。 */
  any: boolean
}

/** 解析后的 cron 表达式。 */
export interface CronExpr {
  minute: CronFieldSpec
  hour: CronFieldSpec
  dayOfMonth: CronFieldSpec
  month: CronFieldSpec
  dayOfWeek: CronFieldSpec
  raw: string
}

/** 解析失败：携带出错字段名与中文消息（CLI / 任务文件校验共用）。 */
export class CronParseError extends Error {
  constructor(
    message: string,
    /** 出错字段（'minute' | 'hour' | ...）。 */
    public readonly field: CronField,
  ) {
    super(message)
    this.name = 'CronParseError'
  }
}

const FIELD_RANGES: Record<CronField, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
}

/** 单字段解析：`*` | `N` | `* /step`。 */
function parseField(raw: string, field: CronField): CronFieldSpec {
  const { min, max } = FIELD_RANGES[field]
  if (raw === '*') return { values: new Set<number>(), any: true }

  let step = 1
  let token = raw
  if (raw.startsWith('*/')) {
    const stepText = raw.slice(2)
    if (!/^\d+$/.test(stepText)) {
      throw new CronParseError(`cron 字段 ${field} 的步长 "${stepText}" 不是数字`, field)
    }
    step = Number(stepText)
    if (step < 1) {
      throw new CronParseError(`cron 字段 ${field} 的步长必须 >= 1（"${raw}"）`, field)
    }
    token = '*'
  } else if (!/^\d+$/.test(raw)) {
    throw new CronParseError(`cron 字段 ${field} 的值 "${raw}" 非法（仅支持 * / 数字 / */步长）`, field)
  }

  if (token === '*') {
    // */step：从 min 起按步长展开（step 超过范围时只剩 min 一个值，属合法）
    const values = new Set<number>()
    for (let v = min; v <= max; v += step) values.add(v)
    return { values, any: false }
  }

  let value = Number(raw)
  if (field === 'dayOfWeek' && value === 7) value = 0 // 0 与 7 都是周日
  if (value < min || value > max) {
    throw new CronParseError(
      `cron 字段 ${field} 值 ${value} 超出范围 ${min}-${max}`,
      field,
    )
  }
  return { values: new Set([value]), any: false }
}

/**
 * 解析 5 字段 cron 表达式。
 * @throws CronParseError 段数不为 5、非法 token、越界、步长 < 1。
 */
export function parseCronExpr(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron 表达式必须恰好 5 段（分 时 日 月 周），实际 ${parts.length} 段: "${expr}"`,
      'minute',
    )
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  return {
    minute: parseField(minute, 'minute'),
    hour: parseField(hour, 'hour'),
    dayOfMonth: parseField(dayOfMonth, 'dayOfMonth'),
    month: parseField(month, 'month'),
    dayOfWeek: parseField(dayOfWeek, 'dayOfWeek'),
    raw: expr.trim(),
  }
}

function matchField(spec: CronFieldSpec, v: number): boolean {
  return spec.any || spec.values.has(v)
}

/** 本地时间是否命中表达式（日字段用标准 OR 语义）。 */
export function matchesCronExpr(expr: CronExpr, d: Date): boolean {
  if (!matchField(expr.minute, d.getMinutes())) return false
  if (!matchField(expr.hour, d.getHours())) return false
  if (!matchField(expr.month, d.getMonth() + 1)) return false

  const dom = expr.dayOfMonth
  const dow = expr.dayOfWeek
  if (dom.any && dow.any) return true
  if (!dom.any && !dow.any) {
    return matchField(dom, d.getDate()) || matchField(dow, d.getDay())
  }
  return dom.any ? matchField(dow, d.getDay()) : matchField(dom, d.getDate())
}

/** 扫描上限：5 年（约 260 万次纯整数/日期运算，毫秒级，无需优化）。 */
const MAX_SCAN_MS = 5 * 365 * 24 * 60 * 60 * 1000

/**
 * 从 from 之后找第一个匹配的整分时刻（严格大于 from、分钟精度向上取整）。
 * 5 年内无匹配（如 `0 0 30 2 *` 2 月 30 日）返回 null。
 */
export function nextRunAt(expr: CronExpr, from: Date = new Date()): Date | null {
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  const deadline = candidate.getTime() + MAX_SCAN_MS
  while (candidate.getTime() <= deadline) {
    if (matchesCronExpr(expr, candidate)) return candidate
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return null
}
