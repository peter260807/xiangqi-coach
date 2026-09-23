#!/bin/bash
#
# 编译并运行 Swift 搜索引擎的体外测量台。
#
#   ./tools/search-bench/run.sh            # 两种优化档都测（推荐）
#   ./tools/search-bench/run.sh --release  # 只测 -O（真机 Release 档）
#   ./tools/search-bench/run.sh --debug    # 只测 -Onone（模拟器 Debug 档）
#
# 其余参数原样转给测量程序，例如只跑难度档那一段（几秒钟）：
#   ./tools/search-bench/run.sh --release --levels-only
#
# 为什么要分两档：Swift 的 -Onone 构建在数组/泛型密集的代码上会慢好几倍。
# 模拟器上跑的是 Debug 档，真机上跑的是 Release 档 —— 两者体感差很多，
# 拿 Debug 的数字去规划会严重低估「真机上到底能搜多深」。
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENGINE="$ROOT/ios/XiangqiCoach/Engine"

MODE="both"
case "${1:-}" in
  --release) MODE="release"; shift ;;
  --debug)   MODE="debug"; shift ;;
  "")        ;;
  *) echo "未知参数: ${1}"; exit 2 ;;
esac

# macOS 自带 bash 是 3.2，空数组配 set -u 时 "${arr[@]}" 会报 unbound variable，
# 所以这里必须用 ${#arr[@]} 先判断个数，不能直接展开。
BENCH_ARGS=("$@")

for f in Rules.swift Notation.swift Search.swift; do
  if [ ! -f "$ENGINE/$f" ]; then
    echo "缺少引擎源文件: $ENGINE/$f"
    exit 1
  fi
done

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

build_and_run() {
  local tag="$1" opts="$2"
  echo "##################################################################"
  echo "# 构建档: ${tag}"
  echo "##################################################################"
  # shellcheck disable=SC2086
  if ! xcrun swiftc $opts -o "$OUT/bench-$tag" \
      "$ENGINE/Rules.swift" "$ENGINE/Notation.swift" "$ENGINE/Search.swift" "$HERE/main.swift" 2>"$OUT/err-$tag"; then
    echo "编译失败:"
    head -30 "$OUT/err-$tag"
    return 1
  fi
  echo
  if [ "${#BENCH_ARGS[@]}" -gt 0 ]; then
    "$OUT/bench-$tag" "${BENCH_ARGS[@]}"
  else
    "$OUT/bench-$tag"
  fi
  echo
}

RC=0
if [ "$MODE" = "both" ] || [ "$MODE" = "release" ]; then
  build_and_run "release" "-O -whole-module-optimization" || RC=1
fi
if [ "$MODE" = "both" ] || [ "$MODE" = "debug" ]; then
  build_and_run "debug" "-Onone" || RC=1
fi
exit $RC
