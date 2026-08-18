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
import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { findHeldGatewayLocks, printLockConflict } from './weixin/run-lock.js';
/** 固定使用的 profile 名。 */
const PROFILE = 'headless';
/** 与 package.json version 保持一致（更新版本时同步改这里）。 */
const VERSION = '0.2.5';
/** 以继承 stdio 的方式转发给 dsh（二维码/配对码输入/Ctrl+C 都依赖继承），返回退出码。 */
function runDsh(args) {
    return new Promise((resolve) => {
        const child = spawn('dsh', args, { stdio: 'inherit' });
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', (err) => {
            console.error(`[dsh-weixin] 无法启动 dsh: ${err.message}`);
            resolve(1);
        });
    });
}
/** 短眠。 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** semver 比较：a > b。 */
function versionGt(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y)
            return x > y;
    }
    return false;
}
/**
 * 自动更新：npm view 查最新版 → npm 全局安装 → 刷新 headless profile 的
 * 插件版本。显式 npmjs registry + --prefer-online 规避 npmmirror 同步延迟
 * 和本地元数据缓存（记忆：npm 缓存装旧版、pnpm 缓存 setup 装旧版）。
 */
async function updateCli() {
    const view = spawnSync('npm', ['view', 'dsh-weixin-gateway', 'version', '--registry', 'https://registry.npmjs.org', '--prefer-online'], { encoding: 'utf8' });
    const latest = view.status === 0 ? view.stdout.trim() : '';
    if (!latest) {
        throw new Error('无法获取最新版本（npm view 失败），请检查网络后重试');
    }
    if (!versionGt(latest, VERSION)) {
        console.log(`✅ 已是最新版本 ${VERSION}`);
        return;
    }
    console.log(`📦 发现新版本 ${latest}（当前 ${VERSION}），开始更新...`);
    const install = spawnSync('npm', ['install', '-g', `dsh-weixin-gateway@${latest}`, '--registry', 'https://registry.npmjs.org', '--prefer-online'], { stdio: 'inherit' });
    if (install.status !== 0) {
        throw new Error('npm 全局安装失败');
    }
    console.log(`✅ 已更新到 ${latest}，刷新 headless profile 插件...`);
    const code = await runDsh(['plugin', '--profile', PROFILE, 'add', `dsh-weixin-gateway@${latest}`]);
    if (code !== 0) {
        console.warn('⚠️  profile 插件刷新失败（pnpm 元数据缓存可能装到旧版），可稍后重跑 dsh-weixin setup');
    }
    console.log(`🎉 更新完成：当前版本 ${latest}`);
}
/** 检测 dsh 是否可用（在 PATH 上且能返回版本）。 */
function detectDsh() {
    const res = spawnSync('dsh', ['--version'], { stdio: 'ignore' });
    return res.status === 0;
}
/**
 * 转发前预检实例互斥（只读，不写锁；真实锁由 gateway 兜底获取）。
 * 已有同账号网关实例在运行时提示并退出，避免重复启动互相顶掉会话。
 */
function precheckInstance(accountId) {
    const held = findHeldGatewayLocks();
    const conflict = accountId ? held.find((h) => h.accountId === accountId) : held[0];
    if (conflict) {
        printLockConflict(conflict.pid);
        return false;
    }
    return true;
}
/** launchd 常驻服务（本仓库 scripts/weixin-gateway.sh 安装）。 */
const DAEMON_LABEL = 'com.weixin-dsh.gateway';
/** 当前用户 uid（launchctl gui 域需要；getuid 在类型里是可选方法）。 */
function uid() {
    return process.getuid?.() ?? 0;
}
/** 执行 launchctl（服务不存在时静默忽略错误）。 */
function launchctl(...args) {
    spawnSync('launchctl', args, { stdio: 'ignore' });
}
/** 停止 launchd 守护（登录前避让：释放其网关实例持有的锁）。 */
function stopDaemon() {
    launchctl('bootout', `gui/${uid()}/${DAEMON_LABEL}`);
}
/** 重新拉起 launchd 守护（登录进程退出后交回常驻）。 */
function startDaemon() {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
    launchctl('bootstrap', `gui/${uid()}`, plist);
    launchctl('kickstart', `gui/${uid()}/${DAEMON_LABEL}`);
}
/** setup：检测/装 dsh → 建 profile+装插件 → 验证。幂等，可在已装环境重跑。 */
async function setup() {
    console.log('[dsh-weixin] 检测 dsh...');
    if (!detectDsh()) {
        console.log('[dsh-weixin] 未检测到 dsh，尝试全局安装 @deepseek-ai/dsh...');
        const install = spawnSync('npm', ['install', '-g', '@deepseek-ai/dsh'], { stdio: 'inherit' });
        if (install.status !== 0) {
            console.error('\n[dsh-weixin] dsh 安装失败，请手动安装后重试：');
            console.error('  npm install -g @deepseek-ai/dsh');
            process.exit(1);
        }
    }
    else {
        const ver = spawnSync('dsh', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '';
        console.log(`[dsh-weixin] dsh 已就绪${ver ? `（${ver}）` : ''}`);
    }
    console.log('[dsh-weixin] 创建 headless profile 并安装 dsh-weixin-gateway...');
    // 只装 dsh-weixin-gateway：dsh-headless 是 dsh 自带的 in-box bundle，显式 add
    // 反而触发 pnpm 解析它的私有依赖 @deepseek-ai/dsh-code-runtime-worker（公共
    // registry 404）→ pnpm failed in profile directory。显式 @VERSION 让 pnpm
    // 装到当前发布版（裸名会因 pnpm 不跨 minor / minimumReleaseAge 装到旧版）。
    const code = await runDsh([
        'plugin', '--profile', PROFILE, 'add',
        `dsh-weixin-gateway@${VERSION}`,
    ]);
    if (code !== 0) {
        console.error(`\n[dsh-weixin] 安装失败（退出码 ${code}）。常见原因：`);
        console.error('  - registry 不可达或需要 token（No authorization header was set）');
        console.error('  - pnpm 不在 PATH');
        console.error('  解决后重新运行: dsh-weixin setup');
        process.exit(code);
    }
    console.log('[dsh-weixin] 验证 profile 插件树...');
    const dump = spawnSync('dsh', ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8' });
    if (!dump.stdout?.includes('weixin-startup')) {
        console.error('[dsh-weixin] 验证失败：profile 里没找到 weixin-startup 插件，请检查上面的输出');
        process.exit(1);
    }
    console.log('\n✅ 环境就绪！还剩两步（一次性）：');
    console.log('  1. 配置模型 provider：在 ~/.dsh/settings.yaml 配置 llm-pi-ai（公司网关）');
    console.log('  2. 微信端启用 ClawBot 插件：微信 → 我 → 设置 → 插件');
    console.log('\n接下来：');
    console.log('  dsh-weixin login    # 扫码登录（自动避让后台守护，登录后自动交回常驻）');
    console.log('  dsh-weixin run      # 前台启动网关（已有实例会自动拦截）');
}
const program = new Command()
    .name('dsh-weixin')
    .description('微信网关一键引导（dsh 插件的环境准备与命令转发）')
    .version(VERSION);
program
    .command('setup')
    .description('一键准备环境：检测/装 dsh、创建 headless profile、安装插件并验证')
    .action(() => {
    void setup().catch((err) => {
        console.error(`[dsh-weixin] setup 失败: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
});
program
    .command('update')
    .description('更新 dsh-weixin 到最新版本（npm 全局 + 刷新 profile 插件）')
    .action(() => {
    void updateCli().catch((err) => {
        console.error(`[dsh-weixin] 更新失败: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
});
program
    .command('login')
    .description('扫码登录微信账号（自动避让后台守护；Ctrl+C 后自动交回 daemon 常驻）')
    .argument('[accountId]', '账号 id（可选）')
    .action(async (accountId) => {
    // 登录 = 换会话：若已有实例在跑（多为 launchd daemon 拉起的网关），
    // 自动停掉守护释放锁，让扫码直接进行；停不掉的前台实例才报错。
    const held = findHeldGatewayLocks();
    const conflict = accountId ? held.find((h) => h.accountId === accountId) : held[0];
    if (conflict) {
        stopDaemon();
        // bootout 是异步的（launchd 先终止进程、网关退出时才释放锁）：
        // 轮询等待锁释放，最多 5s，避免把"正在退出的 daemon"误判成前台实例
        let still = conflict;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const after = findHeldGatewayLocks();
            still = accountId ? after.find((h) => h.accountId === accountId) : after[0];
            if (!still)
                break;
            await sleep(200);
        }
        if (still) {
            printLockConflict(still.pid);
            console.error('   持锁实例是前台进程，请先按 Ctrl+C 停掉它，再重新运行 login');
            process.exit(1);
        }
        console.log('⏹  已自动停止后台守护（登录结束后会自动交回常驻）');
    }
    // Ctrl+C（SIGINT）/ 关终端（SIGHUP）时本进程不退出：dsh 优雅退出后
    // 继续拉起 daemon 接管，让登录进程退出不中断后台服务
    const onSignal = () => undefined;
    process.on('SIGINT', onSignal);
    process.on('SIGHUP', onSignal);
    const args = ['--profile', PROFILE, '--weixin-login'];
    if (accountId)
        args.push(accountId);
    const code = await runDsh(args);
    process.off('SIGINT', onSignal);
    process.off('SIGHUP', onSignal);
    // 登录进程已退出（Ctrl+C 或失败）→ 交回 launchd 守护（登录持久化了新 token）
    startDaemon();
    console.log('🚀 已交回后台守护常驻，无需再碰终端');
    process.exit(code);
});
program
    .command('run')
    .description('启动微信网关：长轮询收消息，dsh agent 回复')
    .argument('[accountId]', '账号 id（可选，默认第一个已登录账号）')
    .option('--session-mode <mode>', '会话模式：per-user（每用户独立）/ room（统一房间，默认）', 'room')
    .action(async (accountId, opts) => {
    if (!precheckInstance(accountId))
        process.exit(1);
    // accountId 必须紧跟 --weixin-run（它是该 option 的可选值），不能放在 --session-mode 后面
    const args = ['--profile', PROFILE, '--weixin-run'];
    if (accountId)
        args.push(accountId);
    args.push('--session-mode', opts.sessionMode);
    const code = await runDsh(args);
    process.exit(code);
});
program.parse();
