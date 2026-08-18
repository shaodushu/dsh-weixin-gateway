/**
 * run-lock — 微信网关实例互斥锁（账号级 pidfile）。
 *
 * 背景：同一账号可经两条互不知情的路径启动网关——launchd 后台 daemon
 * 和手动前台 `dsh-weixin run`。此前无任何互斥，两个实例同时轮询同一账号
 * 会互相顶掉对方会话（-14 session timeout，重新扫码也无效）。本模块用
 * pidfile 保证同一账号同时只有一个网关实例：run/login 启动时 acquire，
 * 进程退出时 release。
 *
 * 残留恢复：实例崩溃（kill -9 / OOM）会留下锁文件，下次启动时校验锁内
 * PID——已死、被无关进程复用、或内容损坏都视为残留，自动覆盖。校验依赖
 * `ps` 命令行匹配（weixin-login/weixin-run），daemon 脚本与测试用同语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveStateDir } from './storage/state-dir.js';
/** 锁文件路径：<state-dir>/weixin-dsh/run-<accountId>.lock。 */
export function lockPath(accountId) {
    return path.join(resolveStateDir(), 'weixin-dsh', `run-${accountId}.lock`);
}
/** 读锁文件内记录的第一行（PID）；文件缺失/内容为空返回 undefined。 */
function readLockPid(lockFile) {
    try {
        const first = fs.readFileSync(lockFile, 'utf8').split('\n')[0]?.trim();
        return first || undefined;
    }
    catch {
        return undefined;
    }
}
/** 判断 PID 是否存活且是网关实例（命令行含 --weixin-login/--weixin-run）。 */
function isGatewayProcess(pid) {
    const res = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
    if (res.status !== 0)
        return false;
    return /weixin-(login|run)/.test(res.stdout);
}
/** 原子创建锁文件（O_EXCL），写入自身 PID + 时间戳。 */
function writeLock(accountId) {
    fs.writeFileSync(lockPath(accountId), `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
}
/**
 * 获取账号实例锁。
 * - 成功：{ ok: true }（锁内记录本进程 PID）
 * - 冲突（已有存活网关实例持锁）：{ ok: false, pid }，pid 为持锁实例
 * - 残留锁（持锁进程已死 / 被无关进程复用 / 内容损坏）：自动覆盖后成功
 */
export function acquireRunLock(accountId) {
    fs.mkdirSync(path.dirname(lockPath(accountId)), { recursive: true });
    // 循环重试：覆盖残留锁时若另一个进程恰好抢建，重新走校验，避免误判
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            writeLock(accountId);
            return { ok: true };
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            const pid = readLockPid(lockPath(accountId));
            if (pid && isGatewayProcess(pid))
                return { ok: false, pid };
            // 残留锁 → 删掉重试
            fs.rmSync(lockPath(accountId), { force: true });
        }
    }
    throw new Error(`无法获取网关实例锁（${lockPath(accountId)} 持续冲突）`);
}
/** 释放账号实例锁（仅持有者调用；进程崩溃后的残留由下次 acquire 覆盖）。 */
export function releaseRunLock(accountId) {
    fs.rmSync(lockPath(accountId), { force: true });
}
/** 扫描所有被存活网关实例持有的锁（cli 转发前预检用，只读不写）。 */
export function findHeldGatewayLocks() {
    const dir = path.join(resolveStateDir(), 'weixin-dsh');
    let files;
    try {
        files = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const held = [];
    for (const f of files) {
        if (!f.startsWith('run-') || !f.endsWith('.lock'))
            continue;
        const pid = readLockPid(path.join(dir, f));
        if (pid && isGatewayProcess(pid)) {
            held.push({ accountId: f.slice('run-'.length, -'.lock'.length), pid });
        }
    }
    return held;
}
/**
 * 找与目标账号冲突的持锁实例（login 自动避让 / run 预检用）。
 * 未指定 accountId 时取任一持锁实例（无参 run 会占用最新账号，一律拦截）。
 */
export function findConflict(held, accountId) {
    return accountId ? held.find((h) => h.accountId === accountId) : held[0];
}
/** 锁冲突提示（gateway 与 cli 共用同一文案）。 */
export function printLockConflict(pid) {
    console.error(`⚠️⚠️  检测到已有微信网关实例在运行（PID ${pid}）⚠️⚠️`);
    console.error('   同一账号同时只能有一个网关实例，本次启动已取消。');
    console.error('   停掉旧实例后重试：前台实例按 Ctrl+C；launchd 守护执行 ./scripts/weixin-gateway.sh stop');
}
