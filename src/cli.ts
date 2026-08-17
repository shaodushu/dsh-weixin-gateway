#!/usr/bin/env node
/**
 * dsh-weixin — 微信网关一键引导 CLI。
 *
 * 让"别人"用当前插件只需三条命令：
 *   dsh-weixin setup    # 一键准备环境：检测/装 dsh → 建 profile+装插件 → 验证
 *   dsh-weixin login    # 扫码登录（转发 dsh --profile headless --weixin-login）
 *   dsh-weixin run      # 启动网关（转发 dsh --profile headless --weixin-run）
 *
 * 本质是 dsh 的引导器/转发器：插件本身由 dsh launcher 作为宿主加载，
 * 这里只负责把繁琐的环境准备和命令转发藏起来。
 *
 * 关键机制（实测确认）：
 *   - `dsh plugin --profile X add <pkg>` 会自动初始化 profile，并把声明了
 *     dsh.bundle 的包自动 reconcile 进 profile 层 → 装完无需 --patch。
 *   - dsh-headless / dsh-base 是 dsh 自带的 in-box bundle，**不需要**显式 add
 *     （add dsh-headless 会触发 pnpm 解析它依赖的私有包
 *     @deepseek-ai/dsh-code-runtime-worker，公共 registry 404 → 安装失败）。
 *     只 add dsh-weixin-gateway 即可，--weixin-login/--weixin-run 直接可用。
 *   - add 时显式 @<version>：裸名会被 pnpm 的 minor 范围 / minimumReleaseAge
 *     限制装到旧版，显式版本号会进 minimumReleaseAgeExclude 而装到最新。
 */
import { Command } from 'commander'
import { spawn, spawnSync } from 'node:child_process'

/** 固定使用的 profile 名。 */
const PROFILE = 'headless'
/** 与 package.json version 保持一致（更新版本时同步改这里）。 */
const VERSION = '0.2.2'

/** 以继承 stdio 的方式转发给 dsh（二维码/配对码输入/Ctrl+C 都依赖继承），返回退出码。 */
function runDsh(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('dsh', args, { stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', (err) => {
      console.error(`[dsh-weixin] 无法启动 dsh: ${err.message}`)
      resolve(1)
    })
  })
}

/** 检测 dsh 是否可用（在 PATH 上且能返回版本）。 */
function detectDsh(): boolean {
  const res = spawnSync('dsh', ['--version'], { stdio: 'ignore' })
  return res.status === 0
}

/** setup：检测/装 dsh → 建 profile+装插件 → 验证。幂等，可在已装环境重跑。 */
async function setup(): Promise<void> {
  console.log('[dsh-weixin] 检测 dsh...')
  if (!detectDsh()) {
    console.log('[dsh-weixin] 未检测到 dsh，尝试全局安装 @deepseek-ai/dsh...')
    const install = spawnSync('npm', ['install', '-g', '@deepseek-ai/dsh'], { stdio: 'inherit' })
    if (install.status !== 0) {
      console.error('\n[dsh-weixin] dsh 安装失败，请手动安装后重试：')
      console.error('  npm install -g @deepseek-ai/dsh')
      process.exit(1)
    }
  } else {
    const ver = spawnSync('dsh', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? ''
    console.log(`[dsh-weixin] dsh 已就绪${ver ? `（${ver}）` : ''}`)
  }

  console.log('[dsh-weixin] 创建 headless profile 并安装 dsh-weixin-gateway...')
  // 只装 dsh-weixin-gateway：dsh-headless 是 dsh 自带的 in-box bundle，显式 add
  // 反而触发 pnpm 解析它的私有依赖 @deepseek-ai/dsh-code-runtime-worker（公共
  // registry 404）→ pnpm failed in profile directory。显式 @VERSION 让 pnpm
  // 装到当前发布版（裸名会因 pnpm 不跨 minor / minimumReleaseAge 装到旧版）。
  const code = await runDsh([
    'plugin', '--profile', PROFILE, 'add',
    `dsh-weixin-gateway@${VERSION}`,
  ])
  if (code !== 0) {
    console.error(`\n[dsh-weixin] 安装失败（退出码 ${code}）。常见原因：`)
    console.error('  - registry 不可达或需要 token（No authorization header was set）')
    console.error('  - pnpm 不在 PATH')
    console.error('  解决后重新运行: dsh-weixin setup')
    process.exit(code)
  }

  console.log('[dsh-weixin] 验证 profile 插件树...')
  const dump = spawnSync('dsh', ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8' })
  if (!dump.stdout?.includes('weixin-startup')) {
    console.error('[dsh-weixin] 验证失败：profile 里没找到 weixin-startup 插件，请检查上面的输出')
    process.exit(1)
  }

  console.log('\n✅ 环境就绪！还剩两步（一次性）：')
  console.log('  1. 配置模型 provider：在 ~/.dsh/settings.yaml 配置 llm-pi-ai（公司网关）')
  console.log('  2. 微信端启用 ClawBot 插件：微信 → 我 → 设置 → 插件')
  console.log('\n接下来：')
  console.log('  dsh-weixin login    # 扫码登录（成功后同一进程自动进入保活轮询，Ctrl+C 停止）')
  console.log('  dsh-weixin run      # 启动网关（常驻收消息 → dsh 回复）')
}

const program = new Command()
  .name('dsh-weixin')
  .description('微信网关一键引导（dsh 插件的环境准备与命令转发）')
  .version(VERSION)

program
  .command('setup')
  .description('一键准备环境：检测/装 dsh、创建 headless profile、安装插件并验证')
  .action(() => {
    void setup().catch((err) => {
      console.error(`[dsh-weixin] setup 失败: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
  })

program
  .command('login')
  .description('扫码登录微信账号（成功后同一进程自动进入保活轮询，Ctrl+C 停止）')
  .argument('[accountId]', '账号 id（可选）')
  .action(async (accountId?: string) => {
    const args = ['--profile', PROFILE, '--weixin-login']
    if (accountId) args.push(accountId)
    const code = await runDsh(args)
    process.exit(code)
  })

program
  .command('run')
  .description('启动微信网关：长轮询收消息，dsh agent 回复')
  .argument('[accountId]', '账号 id（可选，默认第一个已登录账号）')
  .option('--session-mode <mode>', '会话模式：per-user（每用户独立）/ room（统一房间，默认）', 'room')
  .action(async (accountId: string | undefined, opts: { sessionMode: string }) => {
    // accountId 必须紧跟 --weixin-run（它是该 option 的可选值），不能放在 --session-mode 后面
    const args = ['--profile', PROFILE, '--weixin-run']
    if (accountId) args.push(accountId)
    args.push('--session-mode', opts.sessionMode)
    const code = await runDsh(args)
    process.exit(code)
  })

program.parse()
