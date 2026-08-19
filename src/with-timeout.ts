/**
 * 超时竞速工具（LLM 推理超时保护等场景）。
 */

/**
 * 给 promise 加超时：超时前 resolve 则返回原值；超时则 reject。
 * 无论哪边先完成都会清理 timer（防止迟到 reject 造成 unhandled rejection）。
 */
export function raceWithTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 空闲超时守护：内部 promise 持续 idleMs 无 reset() 调用则 reject 超时错误，
 * 内部 promise 先 resolve/reject 则跟随其结局。活动事件（文本增量、工具调用等）
 * 通过 reset() 刷新计时——持续产出的事件流会无限续命，只有真正卡住（无任何
 * 事件）才触发。用于"LLM 推理/工具执行无事件即视为挂起"的保底：单次推理
 * 挂起会超时，而多轮工具往返的长时间正常任务不会被误杀。
 */
export function withIdleTimeout<T>(
  promise: Promise<T>,
  idleMs: number,
  onTimeout: () => Error,
): { promise: Promise<T>; reset: () => void; dispose: () => void } {
  let timer: NodeJS.Timeout | undefined
  let done = false
  let rejectInner!: (err: Error) => void

  const inner = new Promise<T>((resolve, reject) => {
    rejectInner = reject
    promise.then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })

  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (done) return
      done = true
      rejectInner(onTimeout())
    }, idleMs)
  }

  const reset = (): void => {
    if (done) return
    arm()
  }

  const dispose = (): void => {
    // 外部已不再关心结局（整轮超时/正常结束）：停表并吞掉迟到结果
    clearTimeout(timer)
    done = true
  }

  arm()
  return { promise: inner, reset, dispose }
}
