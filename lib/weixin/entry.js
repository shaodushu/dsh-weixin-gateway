/**
 * weixin-startup — 微信网关的命令行 provider。
 *
 * 解析 `--weixin-login [accountId]` / `--weixin-run [accountId]`，
 * 发布 WEIXIN_STARTUP_SERVICE，由 gateway 插件懒加载执行。
 *
 * 用法：
 *   dsh --profile headless --patch ./weixin.patch.yml --weixin-login
 *   dsh --profile headless --patch ./weixin.patch.yml --weixin-run
 */
import { Command } from 'commander';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
/** 稳定插件名。 */
export const name = 'weixin-startup';
/** 服务依赖：launcher 注入的命令行参数。 */
export const inject = ['cmdlineArgs'];
/** 本插件提供的服务名（gateway 插件注入它）。 */
export const WEIXIN_STARTUP_SERVICE = 'weixinStartup';
/** 会话路由测试服务名（session-test 插件注入它）。 */
export const SESSION_TEST_STARTUP_SERVICE = 'sessionTestStartup';
/** 微信网关的命令行定义。 */
function weixinCommand() {
    return new Command()
        .name('dsh --profile headless (weixin gateway)')
        .description('微信消息网关：dsh 执行层驱动')
        .helpOption('-h, --help', 'show this help')
        .option('--weixin-login [accountId]', '扫码登录微信账号（持久化凭据）')
        .option('--weixin-run [accountId]', '启动微信网关：长轮询收消息，dsh agent 回复')
        .option('--session-mode <mode>', '会话模式：per-user（每用户独立）/ room（统一房间，默认）', 'room')
        .option('--session-test [mode]', '运行会话路由自动化测试（per-user/room，默认 per-user）')
        .addHelpText('after', `
Examples:
  dsh --profile headless --patch ./weixin.patch.yml --weixin-login
  dsh --profile headless --patch ./weixin.patch.yml --weixin-run --session-mode per-user
  dsh --profile headless --patch ./weixin.patch.yml --session-test per-user
  dsh --profile headless --patch ./weixin.patch.yml --session-test room
`);
}
export function apply(ctx) {
    const program = weixinCommand();
    program.action(() => {
        const opts = program.opts();
        if (opts.weixinLogin) {
            ctx.provide(WEIXIN_STARTUP_SERVICE, {
                mode: 'login',
                accountId: typeof opts.weixinLogin === 'string' ? opts.weixinLogin : undefined,
            });
            return;
        }
        if (opts.weixinRun) {
            ctx.provide(WEIXIN_STARTUP_SERVICE, {
                mode: 'run',
                accountId: typeof opts.weixinRun === 'string' ? opts.weixinRun : undefined,
                sessionMode: opts.sessionMode === 'per-user' ? 'per-user' : 'room',
            });
            return;
        }
        if (opts.sessionTest) {
            const testMode = typeof opts.sessionTest === 'string' && opts.sessionTest === 'room' ? 'room' : 'per-user';
            ctx.provide(SESSION_TEST_STARTUP_SERVICE, { mode: testMode });
            return;
        }
        program.error('需要 --weixin-login 或 --weixin-run（--help 查看用法）');
    });
    parseCmdline(ctx, program);
}
