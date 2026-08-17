import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./storage/state-dir.js";
import { logger } from "./util/logger.js";
/**
 * 本地实现：OpenClaw SDK 的 withFileLock（简单文件锁）。
 * 用独占创建锁文件 + 轮询重试，保证配对文件读改写不并发交错。
 */
async function withFileLock(filePath, options, fn) {
    const lockPath = `${filePath}.lock`;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const retryMs = options.retryMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const fd = fs.openSync(lockPath, "wx");
            try {
                return await fn();
            }
            finally {
                fs.closeSync(fd);
                fs.rmSync(lockPath, { force: true });
            }
        }
        catch (err) {
            const e = err;
            if (e.code !== "EEXIST" || Date.now() > deadline)
                throw err;
            await new Promise((resolve) => setTimeout(resolve, retryMs));
        }
    }
}
/**
 * Resolve the framework credentials directory (mirrors core resolveOAuthDir).
 * Path: $OPENCLAW_OAUTH_DIR || $OPENCLAW_STATE_DIR/credentials || ~/.openclaw/credentials
 */
function resolveCredentialsDir() {
    const override = process.env.OPENCLAW_OAUTH_DIR?.trim();
    if (override)
        return override;
    return path.join(resolveStateDir(), "credentials");
}
/**
 * Sanitize a channel/account key for safe use in filenames (mirrors core safeChannelKey).
 */
function safeKey(raw) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed)
        throw new Error("invalid key for allowFrom path");
    const safe = trimmed.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
    if (!safe || safe === "_")
        throw new Error("invalid key for allowFrom path");
    return safe;
}
/**
 * Resolve the framework allowFrom file path for a given account.
 * Mirrors: `resolveAllowFromPath(channel, env, accountId)` from core.
 * Path: `<credDir>/openclaw-weixin-<accountId>-allowFrom.json`
 */
export function resolveFrameworkAllowFromPath(accountId) {
    const base = safeKey("openclaw-weixin");
    const safeAccount = safeKey(accountId);
    return path.join(resolveCredentialsDir(), `${base}-${safeAccount}-allowFrom.json`);
}
/**
 * Read the framework allowFrom list for an account (user IDs authorized via pairing).
 * Returns an empty array when the file is missing or unreadable.
 */
export function readFrameworkAllowFromList(accountId) {
    const filePath = resolveFrameworkAllowFromPath(accountId);
    try {
        if (!fs.existsSync(filePath))
            return [];
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.allowFrom)) {
            return parsed.allowFrom.filter((id) => typeof id === "string" && id.trim() !== "");
        }
    }
    catch {
        // best-effort
    }
    return [];
}
/** File lock options for the local withFileLock implementation. */
const LOCK_OPTIONS = {
    timeoutMs: 2_000,
    retryMs: 100,
};
/**
 * Register a user ID in the framework's channel allowFrom store.
 * This writes directly to the same JSON file that `readChannelAllowFromStore` reads,
 * making the user visible to the framework authorization pipeline.
 *
 * Uses file locking to avoid races with concurrent readers/writers.
 */
export async function registerUserInFrameworkStore(params) {
    const { accountId, userId } = params;
    const trimmedUserId = userId.trim();
    if (!trimmedUserId)
        return { changed: false };
    const filePath = resolveFrameworkAllowFromPath(accountId);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Ensure the file exists before locking
    if (!fs.existsSync(filePath)) {
        const initial = { version: 1, allowFrom: [] };
        fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return await withFileLock(filePath, LOCK_OPTIONS, async () => {
        let content = { version: 1, allowFrom: [] };
        try {
            const raw = fs.readFileSync(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.allowFrom)) {
                content = parsed;
            }
        }
        catch {
            // If read/parse fails, start fresh
        }
        if (content.allowFrom.includes(trimmedUserId)) {
            return { changed: false };
        }
        content.allowFrom.push(trimmedUserId);
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
        logger.info(`registerUserInFrameworkStore: added userId=${trimmedUserId} accountId=${accountId} path=${filePath}`);
        return { changed: true };
    });
}
