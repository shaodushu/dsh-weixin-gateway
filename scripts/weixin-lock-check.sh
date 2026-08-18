#!/bin/bash
# weixin-dsh-gateway 实例锁检查（daemon 守护脚本与测试共用）。
#
# 用法：source 本文件后调用 lock_held_by [lock-dir]
#   有存活网关实例持锁 → echo 持锁 PID、返回 0；否则返回 1。
#
# 与 node 侧 src/weixin/run-lock.ts 同语义：锁文件第一行为 PID，
# ps 命令行含 weixin-login/weixin-run 判定为网关实例（残留锁/非网关
# 进程持锁不视为冲突）。
lock_held_by() {
  local dir="${1:-$HOME/.openclaw/weixin-dsh}"
  local f pid
  for f in "$dir"/run-*.lock; do
    [ -f "$f" ] || continue
    pid=$(head -1 "$f" 2>/dev/null | tr -d '[:space:]')
    [ -n "$pid" ] || continue
    if ps -p "$pid" -o command= 2>/dev/null | grep -q 'weixin-\(login\|run\)'; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}
