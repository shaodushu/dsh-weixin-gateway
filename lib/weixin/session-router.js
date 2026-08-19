import { createGatewayAgent, resumeGatewayAgent } from '../bridge.js';
import { logger } from './util/logger.js';
/** 房间模式的统一会话 key。 */
const ROOM_KEY = '__room__';
export class SessionRouter {
    ctx;
    cwd;
    resume;
    handles = new Map();
    mode;
    roomKey;
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
        }
        return handle;
    }
    /** 当前会话数。 */
    get size() {
        return this.handles.size;
    }
    /** 关闭全部会话。 */
    async disposeAll() {
        for (const [key, handle] of this.handles) {
            await handle.dispose().catch((err) => {
                logger.warn(`session-router: dispose ${key} failed: ${String(err)}`);
            });
        }
        this.handles.clear();
    }
}
