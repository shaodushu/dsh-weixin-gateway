import { defineTool } from '@deepseek-ai/dsh-tools';
import { listWeixinAccounts, resolveAccount, runWeixinGateway, weixinLoginWithQr, } from './driver.js';
import { acquireRunLock, printLockConflict, releaseRunLock } from './run-lock.js';
export const name = 'weixin-gateway';
/** 需要 weixinStartup 提供命令后（懒配置）才启动。 */
export const inject = ['weixinStartup', 'agentDefaultModel', 'agents', 'sessions', 'tools'];
export function apply(ctx, config) {
    // 注册"文生图"工具：agent 可自主调用生成图片，配合 [image:] 标记发微信
    if (ctx.tools) {
        ctx.tools.register(defineTool({
            name: 'generate_image',
            description: '根据文字描述生成一张图片，返回图片的本地路径。生成的图片可以直接用 [image:路径] 标记发送给用户。',
            parameters: {
                prompt: { type: 'string', required: true, description: '图片内容描述（中文）' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: `图片已生成: ${value}` }],
            },
            async execute(args) {
                const { generateImage } = await import('./ai-service.js');
                return generateImage(args.prompt);
            },
        }));
        console.log('[weixin-gateway] 已注册 generate_image 工具（文生图）');
    }
    else {
        console.warn('[weixin-gateway] tools 服务不可用，generate_image 工具未注册');
    }
    void (async () => {
        try {
            if (config.mode === 'login') {
                // 登录成功后必须同一进程立即开始轮询：getupdates 长轮询既是拉消息
                // 也是会话保活心跳，登录进程退出会导致服务端回收 session（-14）。
                const account = await weixinLoginWithQr(config.accountId);
                console.log(`✅ 微信登录成功，账号: ${account.accountId}`);
                // 登录后同一进程进入保活轮询，同样持锁（避免顶掉已有网关实例的会话）
                const loginLock = acquireRunLock(account.accountId);
                if (!loginLock.ok) {
                    printLockConflict(loginLock.pid);
                    const exit = ctx.get('appExit');
                    exit?.(1);
                    return;
                }
                console.log(`🚀 会话已建立，同一进程启动网关轮询（保活），Ctrl+C 停止...`);
                try {
                    const abort = new AbortController();
                    const onSignal = () => abort.abort();
                    process.once('SIGINT', onSignal);
                    process.once('SIGTERM', onSignal);
                    await runWeixinGateway(ctx, account, { abortSignal: abort.signal, sessionMode: config.sessionMode ?? 'room' });
                    process.off('SIGINT', onSignal);
                    process.off('SIGTERM', onSignal);
                }
                finally {
                    releaseRunLock(account.accountId);
                }
                const exit = ctx.get('appExit');
                exit?.(0);
                return;
            }
            // run 模式：解析账号并常驻
            let accountId = config.accountId;
            if (!accountId) {
                const accounts = listWeixinAccounts();
                if (accounts.length === 0) {
                    throw new Error('没有已登录的微信账号，请先运行: --weixin-login');
                }
                accountId = accounts[0];
                console.log(`使用已登录账号: ${accountId}`);
            }
            // 实例互斥：同一账号同时只能有一个网关实例（防互顶会话 -14）
            const lock = acquireRunLock(accountId);
            if (!lock.ok) {
                printLockConflict(lock.pid);
                const exit = ctx.get('appExit');
                exit?.(1);
                return;
            }
            const account = resolveAccount(accountId);
            try {
                const abort = new AbortController();
                const onSignal = () => abort.abort();
                process.once('SIGINT', onSignal);
                process.once('SIGTERM', onSignal);
                console.log(`🚀 微信网关启动（账号 ${account.accountId}），Ctrl+C 停止...`);
                await runWeixinGateway(ctx, account, { abortSignal: abort.signal, sessionMode: config.sessionMode ?? 'room' });
                process.off('SIGINT', onSignal);
                process.off('SIGTERM', onSignal);
            }
            finally {
                releaseRunLock(accountId);
            }
            const exit = ctx.get('appExit');
            exit?.(0);
        }
        catch (error) {
            console.error(`[weixin-gateway] ${error instanceof Error ? error.message : String(error)}`);
            const exit = ctx.get('appExit');
            exit?.(1);
        }
    })();
}
