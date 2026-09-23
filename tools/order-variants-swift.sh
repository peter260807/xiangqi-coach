#!/bin/bash
#
# 生成并编译「排序改动的对照组」Swift 引擎 —— 和 tools/order-variants.js 是同一件事，
# 只不过对象是真正在 App 里跑的 Swift 引擎。
#
#   ./tools/order-variants-swift.sh                 # 输出到 /tmp/xq-order-swift/
#   ./tools/order-variants-swift.sh --out DIR
#
# 为什么要拆：
#   P1-2 加了两样东西（SEE + 位置表增量），结果**固定深度节点数下来了 30%，
#   但固定时间下的有效深度在开局/中局却没变**。这说明新增的「每节点开销」
#   把省下来的节点吃掉了 —— 必须知道是 SEE 贵还是位置表增量贵，才能决定砍哪个。
#   光看总分是分不出来的。
#
# 做法：正本一行不动，读源码 → 做**有限次字符串替换** → 写到 /tmp 编译。
#   每处替换都断言「恰好命中 1 次」—— 一次都没替换到的时候替换函数不报错，
#   四个变体会是同一份代码、四个一模一样的数字，看起来像「这些改动都无效」。
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENGINE="$ROOT/ios/XiangqiCoach/Engine"
SRC="$ENGINE/Search.swift"

OUT="/tmp/xq-order-swift"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

mkdir -p "$OUT"

# 断言「恰好替换 1 次」。用 node 做：替换次数必须自证，
# 一次都没替换到的静默失败会把「改动无效」和「没改到」混成一种现象。
patch_file() {
  local from="$1" to="$2" in="$3" out="$4" label="$5"
  node -e '
    const fs = require("fs");
    const [from, to, inp, outp, label] = process.argv.slice(1);
    const text = fs.readFileSync(inp, "utf8");
    const n = text.split(from).length - 1;
    if (n !== 1) { console.error(`替换失败：${label} —— 命中 ${n} 处（应为 1 处）`); process.exit(1); }
    fs.writeFileSync(outp, text.replace(from, to));
  ' "$from" "$to" "$in" "$out" "$label"
}

PST_ON='private static let pstWeight: Int32 = 8'
PST_OFF='private static let pstWeight: Int32 = 0'
SEE_GATE='if capVal >= attVal {'
SEE_OFF='if true {'

# build <名字> <pst: on|off> <see: on|off> <说明>
build() {
  local name="$1" pst="$2" see="$3" note="$4"
  local tmp="$OUT/.$name.tmp.swift"
  local work="$OUT/$name.swift"
  rm -f "$tmp"
  if [ "$pst" = "off" ]; then
    patch_file "$PST_ON" "$PST_OFF" "$SRC" "$tmp" "关掉位置表增量" || return 1
  else
    cp "$SRC" "$tmp"
  fi
  if [ "$see" = "off" ]; then
    patch_file "$SEE_GATE" "$SEE_OFF" "$tmp" "$work" "关掉 SEE" || return 1
    rm -f "$tmp"
  elif [ "$see" = "on" ]; then
    mv "$tmp" "$work"
  else
    # see = plyN：只在 ply <= N 的浅层算 SEE。
    # 动机（实测）：整棵树都算 SEE 时，开局节点数省 16% 但中局反而慢 14%，
    # 且固定时间下任何局面都没多搜到一层 —— 说明 SEE 的「每节点开销」在中局把收益吃回去了。
    # 砍掉深层的 SEE 调用，看能不能只留下浅层那点好处。
    local n="${see#ply}"
    patch_file "$SEE_GATE" "if capVal >= attVal || ply > $n {" "$tmp" "$work" \
      "SEE 限制在 ply <= $n" || return 1
    rm -f "$tmp"
  fi
  if ! xcrun swiftc -O -whole-module-optimization -o "$OUT/$name" \
      "$ENGINE/Rules.swift" "$ENGINE/Notation.swift" "$work" "$HERE/uci/main.swift" \
      >"$OUT/$name.build.log" 2>&1; then
    echo "  编译失败：$name（日志 $OUT/$name.build.log）"
    return 1
  fi
  echo "  $(printf '%-8s' "$name") $(wc -c < "$work" | tr -d ' ') 字节  $note"
}

echo "正本：$SRC"
echo "输出：$OUT"
echo
build legacy off off "两项都关 —— 应等价于改之前的排序"
build pst    on  off "只开位置表增量"
build see    off on  "只开 SEE"
build both   on  on  "两项都开 —— 已发布的版本"
build see4   on  ply4 "位置表增量 + SEE 只在 ply<=4"
build see1   on  ply1 "位置表增量 + SEE 只在 ply<=1"
echo
echo "用法：node tools/order-ab-swift.js --before $OUT/legacy --after $OUT/both"
