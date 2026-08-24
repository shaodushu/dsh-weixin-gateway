/**
 * session-router — 微信用户 ↔ dsh agent 会话路由。
 *
 * 两种模式：
 *  - per-user：每个微信用户一个独立 agent 会话（互不干扰，多用户隔离）
 *  - room：所有用户共享同一个 agent 会话（统一房间，上下文互通）
 *
 * 注意：会话持久化已生效——headless profile 装配了 dsh-session-persistence-jsonl
 * （~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd），getSession 按
 * 稳定 id（room key / userId）resume、按 id 跨根定位，网关重启后上下文延续
 * （实测 2026-08-20：daemon 重启后日志 "resumed persisted session for room"）。
 * resume 失败（后端不可用/会话不存在）时回退新建。
 *
 * 写前同步（2026-08-24，0.5.1）：web 端（dsh web profile）与网关共享会话文件时，
 * web 会向文件追加自己的事件流（attach 会话写 end-seed、聊天写事件）。网关作为
 * 唯一"合法"写者，每次取会话时检查文件 revision：被外部修改过则扫描验证，
 * 有效就 dispose+resume 重建会话（融入 web 新事件），损坏则截断到有效前缀
 * （见 session-sync.ts）再重建——修复双写 seq 错位导致的 corrupt session log。
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createGatewayAgent, resumeGatewayAgent } from '../bridge.js';
import { logger } from './util/logger.js';
import { loadEnvFile } from './ai-config.js';
import { decompressAllFrames, scanAndRepairSessionLog } from './session-sync.js';
/** 房间模式的统一会话 key。 */
const ROOM_KEY = '__room__';
/** 文件身份 revision（与 persistence 的 fileRevision 同构：stat 全量字段）。 */
function fileRevision(st) {
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':');
}
/** bigint stat（mtimeNs/ctimeNs 只在 BigIntStats 上）。 */
function statBigint(file) {
    return stat(file, { bigint: true });
}
export class SessionRouter {
    ctx;
    cwd;
    resume;
    handles = new Map();
    mode;
    roomKey;
    /** 各会话文件最近一次成功同步的 revision（写前同步用）。 */
    syncedRevisions = new Map();
    /** 定时自愈定时器（每 30s 检查会话文件，损坏时截断修复——网关进程内串行，安全）。 */
    healTimer;
    constructor(ctx, mode, 
    /** 会话 cwd（缺省 process.cwd()）。测试注入独立 cwd 以隔离持久化根目录。 */
    cwd, 
    /** 是否尝试恢复持久化会话。测试禁用：persistence 按 id 跨根扫描，恢复/创建都可能撞上真实网关的同名会话。 */
    resume = true, 
    /** 房间模式会话 key（缺省 __room__）。测试用专属 key：persistence 按 id 跨根定位，与线上共用 __room__ 必撞。 */
    roomKey = ROOM_KEY) {
        this.ctx = ctx;
        this.cwd = cwd;
        this.resume = resume;
        this.mode = mode;
        this.roomKey = roomKey;
        logger.info(`session-router: mode=${mode}`);
        // 定时自愈：web attach 写入与网关写入的竞态会周期性损坏会话文件
        // （seq 错位差 1），每 30s 检查一次，损坏即截断修复；网关进程内串行
        // 执行，不与自身写入竞争（web 侧 repair 会并发覆盖丢数据，已弃用）。
        this.healTimer = setInterval(() => void this.healRoomFile(), 30_000);
    }
    /** 定时自愈：扫描 __room__ 文件，损坏时截断到有效前缀；修复后强制下次 resync。 */
    async healRoomFile() {
        if (this.mode !== 'room')
            return;
        let file;
        try {
            const located = this.ctx
                .get('sessionPersistence')
                ?.locate({ cwd: this.cwd ?? process.cwd(), id: this.roomKey });
            file = located?.path;
        }
        catch {
            return;
        }
        if (file === undefined)
            return;
        try {
            const scan = await scanAndRepairSessionLog(file);
            if (scan.outcome === 'repaired') {
                logger.warn(`session-router: periodic heal repaired ${this.roomKey} (kept ${scan.validEvents} events)`);
                // 文件被截断修复 → 强制下次 getSession 重新同步（重建会话）
                this.syncedRevisions.delete(this.roomKey);
            }
        }
        catch (err) {
            logger.warn(`session-router: periodic heal failed for ${this.roomKey}: ${String(err)}`);
        }
    }
    /** 取某用户的 agent 会话：优先恢复持久化会话，否则新建。 */
    async getSession(userId) {
        const key = this.mode === 'room' ? this.roomKey : userId;
        let handle = this.handles.get(key);
        if (!handle) {
            const label = this.mode === 'room' ? 'room' : `user ${userId}`;
            if (this.resume) {
                // 有持久化后端时尝试恢复（stable sessionId = key）
                try {
                    handle = await resumeGatewayAgent(this.ctx, key);
                    logger.info(`session-router: resumed persisted session for ${label}`);
                }
                catch {
                    handle = undefined;
                }
            }
            if (!handle) {
                handle = await createGatewayAgent(this.ctx, this.cwd, key);
                logger.info(`session-router: created fresh agent session for ${label}`);
            }
            this.handles.set(key, handle);
            const initial = await this.readRevision(key);
            if (initial !== undefined)
                this.syncedRevisions.set(key, initial);
            await this.applyNicknameTitle(key, handle);
            await this.touchSyncSignal(handle.agent.session.seq);
            return handle;
        }
        // 写前同步：文件被外部（web 端）修改时重建会话融入新事件
        await this.resync(key, handle);
        await this.applyNicknameTitle(key, handle);
        await this.touchSyncSignal(handle.agent.session.seq);
        return handle;
    }
    /**
     * 写入同步信号文件（~/.dsh/room-sync-signal）：内容为 room+当前会话 seq，
     * web 端插件 watch 它并比对 seq（有增量才刷新/推送）。每次消息处理触发一次。
     */
    async touchSyncSignal(seq) {
        try {
            const path = join(homedir(), '.dsh', 'room-sync-signal');
            await writeFile(path, `room=${this.roomKey},seq=${seq ?? ''}\n`);
        }
        catch {
            // 信号写入失败不阻断消息处理
        }
    }
    /**
     * 应用微信用户昵称标题（setup 引导配置的 WEIXIN_USER_NICKNAME）：
     * 读会话日志最后一个 session/title 事件，与配置不一致才 rename（避免每次写入）。
     * 失败仅告警，不阻断消息处理。
     */
    async applyNicknameTitle(key, handle) {
        // 网关进程不预载 .env（AI 配置是"用时加载"），先加载一次（幂等，不覆盖已存在变量）
        loadEnvFile();
        const nickname = process.env.WEIXIN_USER_NICKNAME?.trim();
        if (!nickname)
            return;
        let file;
        try {
            const located = this.ctx
                .get('sessionPersistence')
                ?.locate({ cwd: this.cwd ?? process.cwd(), id: key });
            file = located?.path;
        }
        catch {
            return;
        }
        if (file === undefined)
            return;
        try {
            const raw = await readFile(file);
            const text = decompressAllFrames(raw).toString('utf8');
            let last;
            for (const line of text.split('\n')) {
                if (!line.includes('session/title'))
                    continue;
                try {
                    const ev = JSON.parse(line);
                    if (ev.type === 'session/title' && typeof ev.data?.title === 'string')
                        last = ev.data.title;
                }
                catch {
                    // 跳过无法解析的行
                }
            }
            if (last === nickname)
                return;
            // 直接 append session/title 事件（不依赖 sessionTitle 服务的 rename——
            // 网关进程里该服务不可用/时机不稳；事件格式照抄现有 title 事件）。
            // 签名断言：dsh-session 的 SessionEventMap 类型定义落后于运行时（title 事件合法）。
            // 必须 bind 保持 this（解构后 this 丢失 → this.log undefined 报错，实测 0.5.8）。
            const appendTitle = handle.agent.session.append.bind(handle.agent.session);
            appendTitle('session/title', {
                title: nickname,
                messageSeqs: [],
                source: { kind: 'user' },
            });
            logger.info(`session-router: applied nickname title for ${key}: ${nickname}`);
        }
        catch (err) {
            logger.warn(`session-router: apply nickname failed for ${key}: ${String(err)}`);
        }
    }
    /**
     * 写前同步：比较会话文件 revision，被外部修改则扫描验证并重建会话。
     * 损坏时由 session-sync 截断到有效前缀（自愈）。失败一律不阻断：
     * 保持内存会话继续服务，仅告警。
     */
    async resync(key, handle) {
        let file;
        try {
            const located = this.ctx
                .get('sessionPersistence')
                ?.locate({ cwd: this.cwd ?? process.cwd(), id: key });
            file = located?.path;
        }
        catch {
            // locate 失败（后端不可用）：跳过同步
        }
        if (file === undefined)
            return;
        const revision = await this.readRevision(file);
        if (revision === undefined)
            return;
        if (revision === this.syncedRevisions.get(key))
            return;
        const label = this.mode === 'room' ? 'room' : `user ${key}`;
        const scan = await scanAndRepairSessionLog(file);
        if (scan.outcome === 'unrepairable') {
            // 帧级损坏，无法恢复任何前缀：记录 revision 避免每次消息重复扫描，
            // 保持内存会话继续服务（微信功能不受影响，仅文件不可读）
            this.syncedRevisions.set(key, revision);
            logger.warn(`session-router: session file for ${label} unrepairable, keeping in-memory session`);
            return;
        }
        if (scan.outcome === 'repaired') {
            logger.warn(`session-router: repaired corrupt session log for ${label} (kept ${scan.validEvents} events)`);
        }
        const afterRepair = await this.readRevision(file);
        this.syncedRevisions.set(key, afterRepair ?? revision);
        await this.rebuild(key, handle, label);
    }
    /**
     * 重建会话：先 resume 新 handle（成功才替换），成功后 dispose 旧 handle。
     * 顺序保证：resume 失败时旧 handle 完好，不会丢服务。
     */
    async rebuild(key, old, label) {
        let fresh;
        try {
            fresh = await resumeGatewayAgent(this.ctx, key);
        }
        catch (err) {
            logger.warn(`session-router: resync resume failed for ${label}: ${err instanceof Error ? err.message : String(err)}`);
            fresh = undefined;
        }
        if (!fresh) {
            logger.warn(`session-router: resync resume failed for ${label}, keeping existing session`);
            return;
        }
        await old.dispose().catch((err) => {
            logger.warn(`session-router: resync dispose old ${label} failed: ${String(err)}`);
        });
        this.handles.set(key, fresh);
        logger.info(`session-router: resynced session for ${label} (external file change)`);
    }
    /** 读会话文件的 stat revision；文件不存在返回 undefined。 */
    async readRevision(file) {
        try {
            return fileRevision(await statBigint(file));
        }
        catch {
            return undefined;
        }
    }
    /** 当前会话数。 */
    get size() {
        return this.handles.size;
    }
    /**
     * 关闭并移除某用户的会话句柄（per-user 模式 key=userId；room 模式 key=roomKey）。
     * dispose 失败仅告警不抛；下次 getSession 自动重建（`/reset` 命令用）。
     * 安全性：轮询串行处理消息，reset 发生时不存在该会话正在流式生成消息的并发窗口。
     */
    async reset(userId) {
        const key = this.mode === 'room' ? this.roomKey : userId;
        const handle = this.handles.get(key);
        if (!handle)
            return;
        await handle.dispose().catch((err) => {
            logger.warn(`session-router: reset ${key} failed: ${String(err)}`);
        });
        this.handles.delete(key);
        logger.info(`session-router: reset session for ${this.mode === 'room' ? 'room' : `user ${userId}`}`);
    }
    /** 关闭全部会话。 */
    async disposeAll() {
        if (this.healTimer !== undefined) {
            clearInterval(this.healTimer);
            this.healTimer = undefined;
        }
        for (const [key, handle] of this.handles) {
            await handle.dispose().catch((err) => {
                logger.warn(`session-router: dispose ${key} failed: ${String(err)}`);
            });
        }
        this.handles.clear();
    }
}
