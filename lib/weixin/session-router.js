import { createGatewayAgent, resumeGatewayAgent } from '../bridge.js';
import { logger } from './util/logger.js';
/** 房间模式的统一会话 key。 */
const ROOM_KEY = '__room__';
export class SessionRouter {
    ctx;
    handles = new Map();
    mode;
    constructor(ctx, mode) {
        this.ctx = ctx;
        this.mode = mode;
        logger.info(`session-router: mode=${mode}`);
    }
    /** 取某用户的 agent 会话：优先恢复持久化会话，否则新建。 */
    async getSession(userId) {
        const key = this.mode === 'room' ? ROOM_KEY : userId;
        let handle = this.handles.get(key);
        if (!handle) {
            const label = this.mode === 'room' ? 'room' : `user ${userId}`;
            // 有持久化后端时尝试恢复（stable sessionId = key）
            try {
                handle = await resumeGatewayAgent(this.ctx, key);
                logger.info(`session-router: resumed persisted session for ${label}`);
            }
            catch {
                handle = await createGatewayAgent(this.ctx, undefined, key);
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
