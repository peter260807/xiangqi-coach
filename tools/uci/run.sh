#!/bin/bash
#
# 编译 UCI 前端（对局台用）—— 和 search-bench 一样：xcrun swiftc 把引擎源文件
# 和 main.swift 链成命令行程序，不经过 Xcode、不碰 App 工程。
#
#   ./tools/uci/run.sh                # 编译到 tools/uci/build/xq-uci（-O）
#   ./tools/uci/run.sh --debug        # -Onone，用来对比优化档的影响
#   ./tools/uci/run.sh --out /tmp/x   # 指定输出路径
#
# 编出来的可执行文件直接交给对局台：
#   node tools/match.js --a uci:tools/uci/build/xq-uci --b js --ms 300
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENGINE="$ROOT/ios/XiangqiCoach/Engine"

OPTS="-O -whole-module-optimization"
OUT="$HERE/build/xq-uci"
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) OPTS="-Onone"; shift ;;
    --out)   OUT="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

for f in Rules.swift Notation.swift Search.swift; do
  if [ ! -f "$ENGINE/$f" ]; then
    echo "缺少引擎源文件: $ENGINE/$f"
    exit 1
  fi
done

mkdir -p "$(dirname "$OUT")"

# shellcheck disable=SC2086
if ! xcrun swiftc $OPTS -o "$OUT" \
    "$ENGINE/Rules.swift" "$ENGINE/Notation.swift" "$ENGINE/Search.swift" "$HERE/main.swift"; then
  echo "编译失败"
  exit 1
fi

echo "已生成: $OUT"
