/**
 * 超时竞速工具（LLM 推理超时保护等场景）。
 */
/**
 * 给 promise 加超时：超时前 resolve 则返回原值；超时则 reject。
 * 无论哪边先完成都会清理 timer（防止迟到 reject 造成 unhandled rejection）。
 */
export function raceWithTimeout(promise, ms, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
