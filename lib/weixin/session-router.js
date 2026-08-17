import { createGatewayAgent } from '../bridge.js';
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
    /** 取某用户的 agent 会话（不存在则创建）。 */
    async getSession(userId) {
        const key = this.mode === 'room' ? ROOM_KEY : userId;
        let handle = this.handles.get(key);
        if (!handle) {
            logger.info(`session-router: creating agent session for ${this.mode === 'room' ? 'room' : `user ${userId}`}`);
            handle = await createGatewayAgent(this.ctx);
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
