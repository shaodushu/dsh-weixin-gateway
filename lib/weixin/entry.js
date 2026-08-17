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
/** 微信网关的命令行定义。 */
function weixinCommand() {
    return new Command()
        .name('dsh --profile headless (weixin gateway)')
        .description('微信消息网关：dsh 执行层驱动')
        .helpOption('-h, --help', 'show this help')
        .option('--weixin-login [accountId]', '扫码登录微信账号（持久化凭据）')
        .option('--weixin-run [accountId]', '启动微信网关：长轮询收消息，dsh agent 回复')
        .addHelpText('after', `
Examples:
  dsh --profile headless --patch ./weixin.patch.yml --weixin-login
  dsh --profile headless --patch ./weixin.patch.yml --weixin-run
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
            });
            return;
        }
        program.error('需要 --weixin-login 或 --weixin-run（--help 查看用法）');
    });
    parseCmdline(ctx, program);
}
