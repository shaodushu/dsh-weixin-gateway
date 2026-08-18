/**
 * 版本号比较工具（dsh-weixin update 用）。
 */
/** semver 比较：a > b（按数字段逐段比较，0.2.10 > 0.2.9）。 */
export function versionGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}
