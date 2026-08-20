import { createGatewayAgent, askAgentStreaming } from '../bridge.js';
export const name = 'tool-probe';
export const inject = ['agentDefaultModel', 'agents', 'sessions'];
export function apply(ctx, config) {
    void (async () => {
        try {
            const handle = await createGatewayAgent(ctx);
            const r = await askAgentStreaming(handle, config.task, {});
            console.log(`[tool-probe] text=${r.text.slice(0, 300).replace(/\n/g, '\\n')}`);
            console.log(`[tool-probe] error=${r.error ?? 'none'}`);
            await handle.dispose().catch(() => undefined);
            const exit = ctx.get('appExit');
            exit?.(r.error ? 1 : 0);
        }
        catch (err) {
            console.error(`[tool-probe] FAILED: ${err instanceof Error ? err.message : String(err)}`);
            const exit = ctx.get('appExit');
            exit?.(1);
        }
    })();
}
