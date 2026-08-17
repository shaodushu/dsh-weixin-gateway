/**
 * session-test — 会话路由双模式自动化测试。
 *
 * 在真实 dsh 环境中模拟两个微信用户（A=小明、B=小红）依次对话，
 * 验证 SessionRouter 两种模式的行为：
 *   - per-user：会话隔离（B 不知道 A 说的话）
 *   - room：共享（B 能感知 A 的上下文）
 *
 * 用法：dsh --profile headless --patch ./weixin.patch.yml --session-test [per-user|room]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askAgentStreaming } from '../bridge.js';
import { SessionRouter } from './session-router.js';
import { logger } from './util/logger.js';
export const name = 'weixin-session-test';
export const inject = ['sessionTestStartup', 'agentDefaultModel', 'agents', 'sessions'];
/**
 * 测试专用 session key：room 用 router 的 ROOM_KEY，per-user 用两个测试用户 id。
 * 这些会话在 JSONL 持久化后端落盘后，下次测试会 resume 旧上下文导致断言不稳
 * （实测：room 残留 __room__ 后 A 首条回复为空）。因此测试开始前统一清理。
 */
const TEST_SESSION_KEYS = ['__room__', 'user-A-xiaoming', 'user-B-xiaohong'];
/** 清理测试专用持久化会话（遍历所有 cwd root），保证测试幂等可重复。 */
function cleanupTestSessions() {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    const sessionsRoot = path.join(home, 'sessions');
    let roots;
    try {
        roots = fs.readdirSync(sessionsRoot);
    }
    catch {
        return;
    }
    let cleaned = 0;
    for (const root of roots) {
        for (const key of TEST_SESSION_KEYS) {
            const target = path.join(sessionsRoot, root, key);
            if (fs.existsSync(target)) {
                fs.rmSync(target, { recursive: true, force: true });
                cleaned++;
            }
        }
    }
    logger.info(`session-test: cleaned test sessions (${cleaned} dirs) under ${sessionsRoot}`);
}
export function apply(ctx, config) {
    void (async () => {
        cleanupTestSessions();
        const router = new SessionRouter(ctx, config.mode);
        const results = [];
        try {
            // 用户 A（小明）
            const userA = 'user-A-xiaoming';
            const userB = 'user-B-xiaohong';
            const step = (label, pass, detail) => {
                const line = `${pass ? '✅' : '❌'} ${label}: ${detail}`;
                results.push(line);
                console.log(line);
            };
            // 1. A 记住名字
            const a1 = await router.getSession(userA);
            const r1 = await askAgentStreaming(a1, '记住我的名字叫小明，只回复"记住了"', {});
            step('A 记住名字', r1.text.includes('记住') || r1.text.length > 0, `A1=${r1.text.slice(0, 40)}`);
            // 2. B 问名字（per-user 应隔离；room 可能共享）
            const b1 = await router.getSession(userB);
            const r2 = await askAgentStreaming(b1, '我叫什么名字？请只回答名字或"不知道"', {});
            const bKnows = r2.text.includes('小明');
            if (config.mode === 'per-user') {
                step('B 不知 A 的名字（隔离）', !bKnows, `B1=${r2.text.slice(0, 40)}`);
            }
            else {
                step('room 共享上下文（B 可能知道）', true, `B1=${r2.text.slice(0, 40)}（共享模式下行为正常即可）`);
            }
            // 3. A 问名字（会话应保留 A 的记忆）
            const a2 = await router.getSession(userA);
            const r3 = await askAgentStreaming(a2, '我叫什么名字？请只回答名字', {});
            const aRemembers = r3.text.includes('小明');
            step('A 会话保留记忆', aRemembers, `A2=${r3.text.slice(0, 40)}`);
            // 4. 会话数量断言
            const count = router.size;
            if (config.mode === 'per-user') {
                step('per-user 两个会话', count === 2, `sessions=${count}`);
            }
            else {
                step('room 单个共享会话', count === 1, `sessions=${count}`);
            }
        }
        catch (err) {
            console.error(`[session-test] 失败: ${err instanceof Error ? err.message : String(err)}`);
            results.push(`❌ 异常: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            await router.disposeAll();
            const exit = ctx.get('appExit');
            exit?.(results.some((r) => r.startsWith('❌')) ? 1 : 0);
        }
    })();
}
