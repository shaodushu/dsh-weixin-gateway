/**
 * dsh-room-projection-sync — 真实时同步 __room__ 会话到 web 前端。
 *
 * 实时链路（0.0.2，seq 信号版，参考同行三层架构：存储/通知/交付）：
 * - 存储层：共享会话文件（网关写入，seq 追加）
 * - 通知层：网关每次消息后写信号文件 ~/.dsh/room-sync-signal，
 *   内容 room=<id>,seq=<N>；本插件 fs.watch 信号文件并比对 seq
 *   （有增量才处理，避免无脑刷新）
 * - 交付层：detachEntered（下次打开重新 attach 读文件，history 最新）
 *   + coldSnapshot（投影缓存刷新，列表层实时）
 *   + readFrom 增量 → ctx.emit('session/event')（前端 WebSocket 实时渲染）
 *
 * 30s 轮询兜底（fs.watch 偶发漏事件）；信号文件是普通文件（~/.dsh 下），
 * inotify 稳定（会话文件在 bind mount 上 watch 不可靠，实测）。
 */
import { watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = "dsh-room-projection-sync";

export const inject = ["sessionProjectionCache", "sessions", "sessionPersistence"];

const ROOM_ID = "__room__";
const SIGNAL_PATH = join(homedir(), ".dsh", "room-sync-signal");
const REFRESH_INTERVAL_MS = 30_000;
/** 信号防抖：网关批量处理消息时合并为一次刷新。 */
const SIGNAL_DEBOUNCE_MS = 300;

export async function apply(ctx) {
  const cache = ctx.get("sessionProjectionCache");
  const sessions = ctx.get("sessions");
  const persistence = ctx.get("sessionPersistence");
  let roomSession;
  /** 已处理的最大 seq（信号比对 + 增量游标）。 */
  let cursorSeq = -1;
  let signalTimer;

  // 从会话事件流捕获 __room__ 的会话对象（emit/detach 需要它）
  ctx.on("session/event", (session) => {
    if (session.id !== ROOM_ID) return;
    roomSession = session;
    if (typeof session.seq === "number" && session.seq > cursorSeq) cursorSeq = session.seq;
  });

  /** 处理一次同步：detach + 推送增量 + 刷新投影。 */
  const sync = async () => {
    // 1. 分离会话对象：下次打开重新 attach（读文件）→ history 最新
    if (roomSession !== undefined && sessions !== undefined) {
      try {
        const entry = sessions.liveEntryFor(roomSession);
        if (entry !== undefined) {
          sessions.detachEntered(entry);
          console.log("[dsh-room-projection-sync] detached room session (re-attach on next open)");
        }
      } catch (err) {
        console.log(`[dsh-room-projection-sync] detach failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      roomSession = undefined;
    }
    // 2. 读文件增量并推入事件流（前端 WebSocket 实时渲染）
    if (persistence !== undefined) {
      try {
        const from = cursorSeq + 1;
        const { events } = await persistence.readFrom(ROOM_ID, from);
        for (const event of events) {
          // 事件流消费者按 session.id 路由；detach 后传轻量标识对象即可
          ctx.emit("session/event", roomSession ?? { id: ROOM_ID }, event);
          if (typeof event.seq === "number" && event.seq > cursorSeq) cursorSeq = event.seq;
        }
        if (events.length > 0) {
          console.log(`[dsh-room-projection-sync] pushed ${events.length} events (seq ${from}..${cursorSeq})`);
        }
      } catch (err) {
        console.log(`[dsh-room-projection-sync] push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 3. 投影缓存（列表层）
    try {
      if (cache !== undefined && typeof cache.coldSnapshot === "function") {
        const snap = await cache.coldSnapshot(ROOM_ID);
        console.log(`[dsh-room-projection-sync] refreshed asOfSeq=${snap?.asOfSeq}`);
      }
    } catch (err) {
      console.log(`[dsh-room-projection-sync] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 信号触发：解析 seq，有增量才同步。 */
  const onSignal = async () => {
    try {
      const text = (await readFile(SIGNAL_PATH, "utf8")).trim();
      const m = text.match(/^room=([^,]+),seq=(\d+)$/);
      if (m === null) return;
      const seq = Number(m[2]);
      if (!Number.isFinite(seq)) return;
      if (seq <= cursorSeq) return; // 无增量，跳过
      console.log(`[dsh-room-projection-sync] signal seq=${seq} (cursor=${cursorSeq})`);
    } catch {
      return;
    }
    await sync();
  };
  const debouncedSignal = () => {
    if (signalTimer !== undefined) clearTimeout(signalTimer);
    signalTimer = setTimeout(() => void onSignal(), SIGNAL_DEBOUNCE_MS);
  };

  // 真实时：监听网关的信号文件（普通文件，inotify 可靠）
  let watcher;
  try {
    await writeFile(SIGNAL_PATH, `room=${ROOM_ID},seq=0\n`); // fs.watch 需要文件存在
    watcher = watch(SIGNAL_PATH, { persistent: false }, debouncedSignal);
    console.log(`[dsh-room-projection-sync] watching signal ${SIGNAL_PATH}`);
  } catch (err) {
    console.log(`[dsh-room-projection-sync] signal watch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const timer = setInterval(() => void sync(), REFRESH_INTERVAL_MS);
  ctx.on("dispose", () => {
    clearInterval(timer);
    if (signalTimer !== undefined) clearTimeout(signalTimer);
    try {
      watcher?.close();
    } catch {
      // 忽略关闭错误
    }
  });
  void sync();
  console.log(`[dsh-room-projection-sync] started (seq signal + ${REFRESH_INTERVAL_MS}ms fallback)`);
}
