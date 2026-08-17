import { askAgent, createGatewayAgent } from './bridge.js';
/** 稳定插件名。 */
export const name = 'weixin-gateway-runner';
/** 需要 headlessStartup 提供任务后（懒配置）才启动。 */
export const inject = ['headlessStartup', 'agentDefaultModel', 'agents', 'sessions'];
export function apply(ctx, config) {
    // appExit 是 launcher 提供的可选 host 值，必须通过 ctx.get 读取（不是注入依赖）
    const exit = ctx.get('appExit');
    if (exit === undefined) {
        throw new Error('weixin-gateway-runner: 需要 launcher 在装载树前提供 ctx.appExit');
    }
    void (async () => {
        try {
            const handle = await createGatewayAgent(ctx);
            const result = await askAgent(handle, config.task);
            await handle.dispose();
            if (result.error !== undefined) {
                console.error(`[gateway] 任务失败: ${result.error}`);
                exit(1);
            }
            else {
                console.log(result.text);
                exit(0);
            }
        }
        catch (error) {
            console.error(`[gateway] ${error instanceof Error ? error.message : String(error)}`);
            exit(1);
        }
    })();
}
