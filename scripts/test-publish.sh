#!/bin/bash
# weixin-dsh-gateway 发布前测试。
#
# 发布任何版本前必须跑这个脚本全部通过：
#   0) 单元测试（vitest：实例互斥锁等纯逻辑，不依赖微信）
#   1) 构建（tsc 编译 src → lib）
#   2) 打包（npm pack，files 白名单生效）
#   3) 隔离前缀安装 tarball（复现全局安装路径，验证 peerDependenciesMeta 不触发 ERESOLVE）
#   4) bin 验证（dsh-weixin --version / --help 可执行）
#   5) 会话路由测试（per-user / room，不依赖微信）
#   6) setup 链路测试（全新临时 profile 上 add 当前版本 → weixin-startup 可加载）。
#      曾踩坑：add @deepseek-ai/dsh-headless 会触发 pnpm 解析私有依赖
#      dsh-code-runtime-worker（公共 registry 404）失败——本步确保只 add
#      dsh-weixin-gateway 时不会复现。
#
# 用法：./scripts/test-publish.sh
set -euo pipefail

cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== [0/6] 单元测试（pnpm test） ==="
pnpm test

echo "=== [1/6] 构建（pnpm build） ==="
pnpm build

echo "=== [2/6] 打包（npm pack） ==="
TARBALL="$(npm pack --pack-destination "$TMP" 2>/dev/null | tail -1)"
echo "tarball: $TMP/$TARBALL"

echo "=== [3/6] 隔离前缀安装 tarball（复现全局安装，验证 peer 不冲突） ==="
npm install --prefix "$TMP/install" "$TMP/$TARBALL" --registry https://registry.npmjs.org >/dev/null

echo "=== [4/6] bin 验证 ==="
BIN="$TMP/install/node_modules/.bin/dsh-weixin"
"$BIN" --version
"$BIN" --help >/dev/null && echo "dsh-weixin --help OK"

echo "=== [5/6] 会话路由测试（不依赖微信） ==="
if command -v dsh >/dev/null 2>&1; then
  # 用临时 patch 指向当前构建产物（仓库内 lib/），而非 profile 里装的旧版包，
  # 确保验证的是本次要发布的代码。前提：headless profile 已通过 bundles 加载
  # dsh-weixin-gateway（weixin-startup 提供 --session-test 解析）。
  cat > "$TMP/session-test.patch.yml" <<EOF
- id: weixin-gateway
  disabled: true
- insert:
    - id: weixin-session-test
      name: '$PWD/lib/weixin/session-test.js'
      inject: [sessionTestStartup, agentDefaultModel, agents, sessions]
      config:
        mode: !!js ctx.sessionTestStartup.mode ?? 'per-user'
EOF
  dsh --profile headless --patch "$TMP/session-test.patch.yml" --session-test per-user
  dsh --profile headless --patch "$TMP/session-test.patch.yml" --session-test room

  echo "=== [6/6] setup 链路测试（全新临时 profile，模拟 setup 核心） ==="
  # 用本地 tarball（[2/6] 的产物）而非 registry：发布前新版本还没上 registry，
  # 且要测的核心是"add dsh-weixin-gateway（不 add dsh-headless）不撞私有依赖
  # dsh-code-runtime-worker"。registry 版由发布后验证覆盖。
  FRESH="publish-test-$$"
  if ! dsh plugin --profile "$FRESH" add "$TMP/$TARBALL" >/dev/null 2>&1; then
    echo "❌ 全新 profile add 本地 tarball 失败（可能又撞私有依赖）"
    rm -rf "$HOME/.dsh/profiles/$FRESH"
    exit 1
  fi
  echo "✅ 全新 profile add tarball 成功"
  if ! dsh --profile "$FRESH" --dump-config 2>/dev/null | grep -q weixin-startup; then
    echo "❌ 全新 profile 未加载 weixin-startup"
    rm -rf "$HOME/.dsh/profiles/$FRESH"
    exit 1
  fi
  echo "✅ 全新 profile 加载 weixin-startup"
  dsh --profile "$FRESH" --help 2>&1 | grep -q weixin-run && echo "✅ --weixin-run 可用"
  rm -rf "$HOME/.dsh/profiles/$FRESH"
else
  echo "（跳过：本机无 dsh 环境）"
fi

echo "✅ 发布前测试全部通过"
