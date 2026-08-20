/**
 * push — 一次性主动推送（独立 CLI 进程 `dsh-weixin push`）。
 *
 * 数据获取链（与网关默认账号语义一致）：
 *  1. 账号：<stateDir>/weixin-dsh/accounts-index.json 索引 → pickDefaultAccount（末位=最新登录）
 *  2. baseUrl/token：<stateDir>/openclaw-weixin/accounts/{accountId}.json（loadWeixinAccount）
 *  3. contextToken：<stateDir>/openclaw-weixin/accounts/{accountId}.context-tokens.json 盘直读
 *     （readPersistedContextTokens；用户需先给机器人发过消息，token 才会落盘）
 *  4. 发送：sendMessageWeixin（contextToken 缺失仅 warn 照发，可能被服务端拒绝）
 *
 * CLI push 仅支持 text；prompt 型内容走 daemon 调度（CLI 无 cordis 环境无法建 agent）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BASE_URL, loadWeixinAccount } from './accounts.js';
import { pickDefaultAccount } from './account-select.js';
import { readPersistedContextTokens } from './inbound.js';
import { sendMessageWeixin } from './send.js';
import { resolveStateDir } from './storage/state-dir.js';
import { logger } from './util/logger.js';
/** 本地账号索引（与 driver.ts 的 listWeixinAccounts 同一文件、同一语义）。 */
function listLocalAccounts() {
    try {
        const raw = fs.readFileSync(path.join(resolveStateDir(), 'weixin-dsh', 'accounts-index.json'), 'utf8');
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
    }
    catch {
        return [];
    }
}
/**
 * 解析推送账号：显式 accountId 优先，缺省取最新登录账号。
 * @throws 无已登录账号 / 账号缺少 token（未登录）。
 */
export function resolvePushAccount(accountId) {
    const id = accountId ?? pickDefaultAccount(listLocalAccounts());
    if (!id) {
        throw new Error('没有已登录的微信账号，请先运行 dsh-weixin login');
    }
    const stored = loadWeixinAccount(id);
    if (!stored?.token) {
        throw new Error(`账号 ${id} 未登录（缺少 token），请先运行 dsh-weixin login`);
    }
    return {
        accountId: id,
        baseUrl: stored.baseUrl?.trim() || DEFAULT_BASE_URL,
        token: stored.token.trim(),
    };
}
/**
 * 展开推送目标：'all' → 账号下所有活跃会话用户（盘上有 context token 的用户）；
 * 具体 userId → 单条（无 token 也返回，发送时 warn 照发）。
 */
export function resolvePushTargets(accountId, to) {
    if (to === 'all') {
        return Object.entries(readPersistedContextTokens(accountId)).map(([userId, token]) => ({
            userId,
            contextToken: token,
        }));
    }
    return [{ userId: to, contextToken: readPersistedContextTokens(accountId)[to] }];
}
/**
 * 逐目标发送，单个失败不阻断其余；返回 sent/failed 统计。
 * @throws 无任何可推送目标（'all' 但账号下无活跃会话用户）。
 */
export async function pushMessage(params) {
    const acct = resolvePushAccount(params.accountId);
    const targets = resolvePushTargets(acct.accountId, params.to);
    if (targets.length === 0) {
        throw new Error(`没有可推送的目标：账号 ${acct.accountId} 下没有活跃会话用户（用户需先给机器人发过消息）`);
    }
    const sendFn = params.sendFn ??
        (async (to, text, contextToken) => {
            await sendMessageWeixin({
                to,
                text,
                opts: { baseUrl: acct.baseUrl, token: acct.token, contextToken },
            });
        });
    let sent = 0;
    let failed = 0;
    for (const target of targets) {
        try {
            await sendFn(target.userId, params.text, target.contextToken);
            sent++;
            logger.info(`push: sent to ${target.userId}`);
        }
        catch (err) {
            failed++;
            logger.error(`push: to ${target.userId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { sent, failed };
}
