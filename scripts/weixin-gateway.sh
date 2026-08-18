#!/bin/bash
# weixin-dsh-gateway 管理脚本。
#
# 用法：
#   ./scripts/weixin-gateway.sh start          # 启动 launchd 服务
#   ./scripts/weixin-gateway.sh stop           # 停止 launchd 服务
#   ./scripts/weixin-gateway.sh restart        # 重启
#   ./scripts/weixin-gateway.sh status         # 状态
#   ./scripts/weixin-gateway.sh logs [N]       # 最近日志（默认 30 行）
#   ./scripts/weixin-gateway.sh login          # 重新扫码登录（微信账号）
#   ./scripts/weixin-gateway.sh relogin         # 一步重登：停 daemon → 扫码 → Ctrl+C 后自动交回 daemon
#   ./scripts/weixin-gateway.sh test [mode]    # 会话路由测试（per-user/room）
#   ./scripts/weixin-gateway.sh demo "<任务>"  # 命令行注入闭环演示

set -euo pipefail

LABEL=com.weixin-dsh.gateway
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.openclaw/weixin-dsh"

cmd="${1:-status}"

case "$cmd" in
  start)
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl kickstart "gui/$(id -u)/$LABEL"
    echo "✅ 已启动（launchctl kickstart ${LABEL}）"
    ;;
  stop)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    echo "⏹  已停止"
    ;;
  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;
  status)
    if pgrep -f "weixin-gateway-daemon" >/dev/null; then
      echo "✅ 运行中"
      echo "   网关 pid: $(pgrep -f 'weixin.patch' | head -1)"
      echo "   守护 pid: $(pgrep -f weixin-gateway-daemon | head -1)"
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit" | head -2
    else
      echo "❌ 未运行"
    fi
    ;;
  logs)
    n="${2:-30}"
    tail -n "$n" "$LOG_DIR/gateway-daemon.log" 2>/dev/null || echo "（无守护日志）"
    echo "--- launchd.out ---"
    tail -n "$n" "$LOG_DIR/launchd.out.log" 2>/dev/null || true
    echo "--- launchd.err ---"
    tail -n "$n" "$LOG_DIR/launchd.err.log" 2>/dev/null || true
    ;;
  login)
    dsh --profile headless --patch "$REPO/weixin.patch.yml" --weixin-login
    ;;
  relogin)
    # 一步重登：停 daemon（释放实例锁）→ 扫码登录 → 登录成功后进入保活轮询，
    # Ctrl+C 停止登录进程后自动交回 daemon 常驻。trap INT 保证脚本在 Ctrl+C
    # 后继续执行（实测：bash 收到 SIGINT 仍会执行后续命令）。
    "$0" stop
    echo "👉 请扫码登录；登录成功后进入保活轮询，Ctrl+C 停止后自动交回 daemon 常驻"
    trap 'echo "⏹  登录进程已停止，重新拉起 daemon..."' INT
    dsh --profile headless --patch "$REPO/weixin.patch.yml" --weixin-login
    trap - INT
    "$0" start
    ;;
  test)
    mode="${2:-per-user}"
    dsh --profile headless --patch "$REPO/test.patch.yml" --session-test "$mode"
    ;;
  demo)
    dsh --profile headless --patch "$REPO/gateway.patch.yml" "${2:?需要任务文本}"
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs [N]|login|relogin|test [mode]|demo \"任务\"}"
    exit 1
    ;;
esac
