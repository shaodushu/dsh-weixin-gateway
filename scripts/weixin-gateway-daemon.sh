#!/bin/bash
# weixin-dsh-gateway 守护脚本。
#
# 背景：Darwin 25.5 的 launchd 实测不触发 RunAtLoad（bootstrap 加载时）
# 且 KeepAlive 对被杀进程不重启（系统级行为，最小 plist 同样不触发）。
# 方案：launchd 启动本脚本（常驻），脚本内 while 循环保证 dsh 网关
# 进程退出/崩溃后 5 秒自动拉起（兜底 KeepAlive）。
#
# 用法（launchd 已配置在 plist 中）：
#   手动启停：launchctl kickstart gui/$(id -u)/com.weixin-dsh.gateway
#              launchctl bootout  gui/$(id -u)/com.weixin-dsh.gateway

set -u

DSH=/Users/baymax/.local/share/mise/installs/node/22/bin/dsh
PATCH=/Users/baymax/Code/weixin-dsh-gateway/weixin.patch.yml
MODE=room
LOG=~/.openclaw/weixin-dsh/gateway-daemon.log
# 实例互斥锁目录（与 src/weixin/run-lock.ts 同路径语义）：同一账号同时只能
# 有一个网关实例。手动前台 run 持锁时，daemon 退避等待其退出后接管。
# 注意：扫码登录会创建新账号（xxx@im.bot），因此不固定 ACCOUNT——
# --weixin-run 不带账号参数，gateway 自动取第一个已登录账号（最新登录）。

# launchd 最小环境不继承 shell 配置；显式补 PATH（dsh shebang 需要 env node）
export PATH="/Users/baymax/.local/share/mise/installs/node/22/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/baymax/.local/bin"

# 锁检查：任一账号有存活网关实例（前台手动 run 等）时返回其 PID，无则空。
lock_held_by() {
  local f pid
  for f in "$HOME"/.openclaw/weixin-dsh/run-*.lock; do
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

echo "[$(date '+%F %T')] daemon started (mode=$MODE, 账号取最新已登录)" >> "$LOG"

while true; do
  if held=$(lock_held_by); then
    echo "[$(date '+%F %T')] 已有网关实例（PID $held）在运行，60s 后重试接管..." >> "$LOG"
    sleep 60
    continue
  fi
  # 残留锁（持锁进程已死）提前清除，与 node 侧 acquire 的"残留覆盖"一致
  rm -f "$HOME"/.openclaw/weixin-dsh/run-*.lock
  echo "[$(date '+%F %T')] starting gateway..." >> "$LOG"
  "$DSH" --profile headless --patch "$PATCH" --weixin-run --session-mode "$MODE"
  code=$?
  echo "[$(date '+%F %T')] gateway exited (code=$code), restarting in 5s" >> "$LOG"
  sleep 5
done
