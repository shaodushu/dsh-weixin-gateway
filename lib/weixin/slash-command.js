/**
 * slash-command — 微信内斜杠命令（/help /reset /status /cron list）。
 *
 * 纯函数部分（解析/命令表/授权/路由）全部可单测；执行器 handleSlashMessage
 * 由 driver 层在 agent 调用前调用，返回 true = 消息已被命令消费（不再走 agent）。
 *
 * 关键设计：未命中命令表的消息（如 "/tmp 目录在哪"）返回 unknown → 放行给
 * agent 正常处理，不误伤正常对话。
 *
 * 授权：WECHAT_ADMIN_IDS（逗号分隔的微信 userId，写入 <stateDir>/weixin-dsh/.env）。
 * 默认无管理员；/help 恒可用；/reset 在 per-user 模式重置自己会话无需授权，
 * room 模式（共享会话）需管理员；/status /cron 需管理员。
 */
import { loadEnvFile } from './ai-config.js';
import { formatCronJobList, loadCronJobs } from './cron-jobs.js';
export const SLASH_COMMANDS = [
    { name: 'help', requireAdmin: false, usage: '/help', description: '显示可用命令' },
    { name: 'reset', requireAdmin: false, usage: '/reset', description: '重置会话（room 模式需管理员）' },
    { name: 'status', requireAdmin: true, usage: '/status', description: '网关运行状态' },
    { name: 'cron', requireAdmin: true, usage: '/cron list', description: '定时任务列表' },
];
/** 解析 '/help' → { name: 'help', args: [] }；'/cron list' → { name: 'cron', args: ['list'] }。 */
export function parseSlashCommand(text) {
    if (!text.startsWith('/') || text === '/')
        return null;
    const rest = text.slice(1).trim();
    if (!rest)
        return null;
    const [name, ...args] = rest.split(/\s+/);
    return { name, args };
}
/**
 * 授权判定（纯函数）：管理员恒有权限；help 恒允许；reset 在 per-user 模式允许；
 * status/cron 需要管理员。
 */
export function isSlashCommandAuthorized(cmd, input) {
    if (input.adminUserIds.has(input.userId))
        return true;
    const spec = SLASH_COMMANDS.find((s) => s.name === cmd.name);
    if (!spec)
        return false;
    // reset 特殊：per-user 模式重置自己会话免授权；room 模式（共享会话）需管理员
    if (cmd.name === 'reset')
        return input.sessionMode === 'per-user';
    return !spec.requireAdmin;
}
/** 路由（纯函数，不含 I/O）。 */
export function routeSlashCommand(input) {
    const parsed = parseSlashCommand(input.text);
    if (!parsed)
        return { kind: 'not-command' };
    const spec = SLASH_COMMANDS.find((s) => s.name === parsed.name);
    if (!spec)
        return { kind: 'unknown' };
    if (!isSlashCommandAuthorized(parsed, input))
        return { kind: 'not-authorized' };
    return { kind: 'handled', command: spec.name, args: parsed.args };
}
/** 管理员列表解析：WECHAT_ADMIN_IDS 逗号分隔、trim、去空（纯函数，env 注入）。 */
export function parseAdminUserIds(env) {
    const raw = env.WECHAT_ADMIN_IDS ?? '';
    return new Set(raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean));
}
/**
 * 生产入口：先 loadEnvFile()（保证 launchd daemon 无 shell env 也能读到
 * <stateDir>/weixin-dsh/.env 的 WECHAT_ADMIN_IDS），再解析。
 */
export function resolveAdminUserIds() {
    loadEnvFile();
    return parseAdminUserIds(process.env);
}
/**
 * 处理一条可能是斜杠命令的消息。
 * @returns true = 已被命令消费（driver 不再走 agent）；false = 放行给 agent。
 */
export async function handleSlashMessage(deps, msg) {
    const route = routeSlashCommand({
        text: msg.text,
        userId: msg.userId,
        adminUserIds: resolveAdminUserIds(),
        sessionMode: deps.sessionMode,
    });
    if (route.kind === 'not-command' || route.kind === 'unknown')
        return false;
    try {
        if (route.kind === 'not-authorized') {
            await deps.send('⚠️ 该命令需要管理员权限（未在 WECHAT_ADMIN_IDS 白名单中）');
            return true;
        }
        switch (route.command) {
            case 'help':
                await deps.send(buildHelpText());
                break;
            case 'reset':
                await deps.router.reset(msg.userId);
                await deps.send('✅ 会话已重置，下次对话从零开始');
                break;
            case 'status':
                await deps.send(buildStatusText(deps));
                break;
            case 'cron':
                await deps.send(formatCronJobList(deps.loadJobs?.() ?? loadCronJobs()));
                break;
        }
        return true;
    }
    catch (err) {
        // 执行失败也要消费该消息（不让命令文本进 agent），回复错误信息
        await deps.send(`❌ 命令执行失败：${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
        return true;
    }
}
/** /help 帮助文本（纯文本 + emoji，遵守微信不渲染 markdown 契约）。 */
export function buildHelpText() {
    const lines = SLASH_COMMANDS.map((s) => `${s.usage} — ${s.description}`);
    return `📋 可用命令：\n${lines.join('\n')}\n\n提示：以 / 开头但未命中命令的消息会正常交给 AI 处理`;
}
function buildStatusText(deps) {
    return [
        '⚙️ 网关状态',
        `账号: ${deps.accountId}`,
        `会话模式: ${deps.sessionMode === 'room' ? 'room（共享会话）' : 'per-user（每人独立）'}`,
        `活跃会话数: ${deps.router.size}`,
    ].join('\n');
}
