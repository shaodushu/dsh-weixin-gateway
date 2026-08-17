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
ACCOUNT=34943af36ee6@im.bot
MODE=room
LOG=~/.openclaw/weixin-dsh/gateway-daemon.log

# launchd 最小环境不继承 shell 配置；显式补 PATH（dsh shebang 需要 env node）
export PATH="/Users/baymax/.local/share/mise/installs/node/22/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/baymax/.local/bin"

echo "[$(date '+%F %T')] daemon started (mode=$MODE account=$ACCOUNT)" >> "$LOG"

while true; do
  echo "[$(date '+%F %T')] starting gateway..." >> "$LOG"
  "$DSH" --profile headless --patch "$PATCH" --weixin-run "$ACCOUNT" --session-mode "$MODE"
  code=$?
  echo "[$(date '+%F %T')] gateway exited (code=$code), restarting in 5s" >> "$LOG"
  sleep 5
done
