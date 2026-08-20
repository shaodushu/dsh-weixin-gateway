/**
 * cron-jobs — 定时任务持久化与到期判定。
 *
 * 任务文件：<stateDir>/weixin-dsh/cron-jobs.json（与 accounts-index.json 同目录）。
 * 直写模式（读容错返回 []，写前 mkdir），与 accounts-index 先例一致。
 *
 * 到期语义（防重复 + 错过跳过）：
 *  - 参照点 = lastSentAt（存在）或 now（新任务从当前时刻起算，绝不补发历史）
 *  - scheduled = nextRunAt(参照点)；now >= scheduled 且间隔 <= 10 分钟宽限窗口 → due（可执行）
 *  - 间隔超过宽限窗口 → missed（错过触发点，网关停机等场景）：不发送，但把
 *    lastSentAt 推进到该触发时刻，避免同一参照点反复判"错过"卡死
 *  - 执行成功后 lastSentAt 更新为发送时刻 → 每个 occurrence 至多发送一次
 *    （崩溃于"已发未持久化"窗口会补发一次，at-least-once 偏向，README 注明）
 */
import fs from 'node:fs';
import path from 'node:path';
import { nextRunAt, parseCronExpr } from './cron-expr.js';
import { resolveStateDir } from './storage/state-dir.js';
import { logger } from './util/logger.js';
import { generateId } from './util/random.js';
/** 任务文件路径。 */
export function cronJobsPath() {
    return path.join(resolveStateDir(), 'weixin-dsh', 'cron-jobs.json');
}
/** 错过宽限窗口：触发点超过此时长未执行即视为错过（容忍 daemon 短时重启）。 */
export const CRON_GRACE_MS = 10 * 60 * 1000;
/** 读取任务列表；文件缺失/损坏 → []。 */
export function loadCronJobs() {
    try {
        const raw = fs.readFileSync(cronJobsPath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((j) => typeof j === 'object' && j !== null &&
            typeof j.id === 'string' &&
            typeof j.cron === 'string' &&
            typeof j.content === 'string');
    }
    catch {
        return [];
    }
}
/** 落盘（写前建目录）。 */
export function saveCronJobs(jobs) {
    fs.mkdirSync(path.dirname(cronJobsPath()), { recursive: true });
    fs.writeFileSync(cronJobsPath(), JSON.stringify(jobs, null, 2));
}
/**
 * 新增任务。校验：cron 表达式合法（CronParseError 透传）；prompt 型不允许广播
 * （v1 不支持：prompt 任务注入收件人会话生成，'all' 无明确会话语义）。
 *
 * lastSentAt 初始化为创建时刻（= createdAt）：到期判定以它为参照点。
 * 关键正确性：若缺省 lastSentAt，判定里参照点会每次 tick 取"当前时刻"，
 * 而 nextRunAt 严格返回下一个整分 → 首次触发永远不可达（新任务永不执行）。
 * 初始化为创建时刻后：首次触发 = 创建后的下一个匹配点，不补发创建前历史。
 */
export function addCronJob(input) {
    parseCronExpr(input.cron); // 校验，非法抛 CronParseError
    if (input.type !== 'text' && input.type !== 'prompt') {
        throw new Error(`未知任务类型: ${String(input.type)}（支持 text / prompt）`);
    }
    if (input.type === 'prompt' && input.to === 'all') {
        throw new Error('prompt 型任务不支持广播（--to all），请指定具体 userId');
    }
    const now = new Date().toISOString();
    const job = {
        ...input,
        id: generateId('cron'),
        createdAt: now,
        lastSentAt: now,
    };
    const jobs = loadCronJobs();
    jobs.push(job);
    saveCronJobs(jobs);
    return job;
}
/** 删除任务；未找到返回 false。 */
export function removeCronJob(id) {
    const jobs = loadCronJobs();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length)
        return false;
    saveCronJobs(next);
    return true;
}
/** 更新任务的 lastSentAt（读-改-写；文件损坏按空处理）。 */
export function updateCronJobLastSentAt(id, at) {
    const jobs = loadCronJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) {
        logger.warn(`cron-jobs: updateCronJobLastSentAt: job ${id} not found`);
        return;
    }
    job.lastSentAt = at;
    saveCronJobs(jobs);
}
/** 任务的下一触发时刻；cron 非法（任务文件被手改）→ 记日志返回 null。 */
export function nextRunAtOf(job, from = new Date()) {
    let expr;
    try {
        expr = parseCronExpr(job.cron);
    }
    catch (err) {
        logger.warn(`cron-jobs: invalid cron "${job.cron}" for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    return nextRunAt(expr, from);
}
/**
 * 判定单个任务到期状态（纯函数）。
 * 过滤：job.accountId 与执行账号不一致 → not-due。
 */
export function evalJobDue(job, now, accountId) {
    if (job.accountId && job.accountId !== accountId)
        return { kind: 'not-due' };
    const ref = job.lastSentAt ? new Date(job.lastSentAt) : now;
    const scheduled = nextRunAtOf(job, ref);
    if (!scheduled)
        return { kind: 'not-due' };
    if (now.getTime() < scheduled.getTime())
        return { kind: 'not-due' };
    const overdue = now.getTime() - scheduled.getTime();
    if (overdue <= CRON_GRACE_MS)
        return { kind: 'due', scheduledFor: scheduled };
    return { kind: 'missed', scheduledFor: scheduled };
}
/** 当前到期的任务（宽限窗口内）。 */
export function findDueJobs(jobs, now, accountId) {
    const due = [];
    for (const job of jobs) {
        const state = evalJobDue(job, now, accountId);
        if (state.kind === 'due')
            due.push({ job, scheduledFor: state.scheduledFor });
    }
    return due;
}
/**
 * 任务列表文本（/cron list 与 CLI `cron list` 共用）。
 * 纯文本 + emoji，遵守微信不渲染 markdown 的格式契约。
 */
export function formatCronJobList(jobs, now = new Date()) {
    if (jobs.length === 0)
        return '📋 定时任务：暂无';
    const lines = jobs.map((job) => {
        const next = nextRunAtOf(job, now);
        const nextText = next
            ? `${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')} ${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
            : '永不';
        const type = job.type === 'prompt' ? 'prompt' : 'text';
        const preview = job.content.length > 20 ? `${job.content.slice(0, 20)}…` : job.content;
        return `· ${job.id} ${type} → ${job.to}\n  ${job.cron} 下次 ${nextText}\n  "${preview}"`;
    });
    return `📋 定时任务 ${jobs.length} 个：\n${lines.join('\n')}`;
}
