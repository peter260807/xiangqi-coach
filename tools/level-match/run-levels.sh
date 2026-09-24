#!/bin/bash
# 档位循环赛：相邻档互下，量出「每档之间差多少 Elo」。
#
# 为什么要相邻档而不是全循环：相邻档差 2~4 层，差距足够大，胜负不会大量和棋；
# 而且相邻差累加起来就等于任意两档的差，全循环是重复劳动。
#
# 用法：
#   ./tools/level-match/run-levels.sh          # 每对 16 局（默认）
#   ./tools/level-match/run-levels.sh 32       # 每对 32 局（分辨力约翻倍）
#
# 产出（tools/level-match/results/）：
#   probe-levels.txt            档位引擎自证表（各档实际到第几层）
#   lvl-A-vs-B.txt              对局结果汇总
#   lvl-A-vs-B.jsonl            逐局记录（支持中断续跑）
#
# ⚠️ 局数 ≠ 独立样本数：对局台按开局取手局面，--games 16 --openings 8 只有 8 组独立
#    起手局面（成对设计，每组重放 2 遍）。脚本会把「独立起手局面」打出来核对。
set -u
cd "$(dirname "$0")/../.." || exit 1

GAMES="${1:-16}"
OUT=tools/level-match/results
mkdir -p "$OUT"

# ── 关卡：档位引擎自证不过就拒绝开赛 ───────────────────────────────
# 测量工具坏掉的样子跟否定结论一样（本项目踩过：excluded 写死成 []，
# 于是「新功能完全没作用」）。所以这里先把自证跑一遍，不过就停。
node tools/level-match/gen-level-engines.js >/dev/null || exit 2
node tools/level-match/probe-level-engines.js > "$OUT/probe-levels.txt" 2>&1
if [ $? -ne 0 ]; then
  echo "档位引擎自证没过，拒绝开赛（详见 $OUT/probe-levels.txt）"
  cat "$OUT/probe-levels.txt"
  exit 3
fi
echo "档位引擎自证通过 → $OUT/probe-levels.txt"

for pair in easy:normal normal:hard hard:expert; do
  A="${pair%%:*}"
  B="${pair##*:}"
  LOG="$OUT/lvl-${A}-vs-${B}.jsonl"
  TXT="$OUT/lvl-${A}-vs-${B}.txt"
  echo "──────────────────────────────────────────────────"
  echo "  ${A}  vs  ${B}   （每对 ${GAMES} 局）"
  echo "──────────────────────────────────────────────────"
  node tools/match.js --a "js:tools/level-match/build/lv-${A}.js" \
                      --b "js:tools/level-match/build/lv-${B}.js" \
                      --games "$GAMES" --openings 8 --random-plies 4 --jobs 8 \
                      --gamelog "$LOG" > "$TXT" 2>&1
  RC=$?
  if [ "$RC" -ne 0 ]; then
    echo "  对局台退出码 ${RC} —— 见 ${TXT}"
    tail -5 "$TXT"
    continue
  fi
  grep -E "A [0-9]+ 胜|得分率|平均层数|独立起手|Elo 差|置信区间|区间不含|结束原因" "$TXT"
done

echo
echo "══════════════════════════════════════════════════"
echo "  全部完成，结果在 ${OUT}/"
echo "══════════════════════════════════════════════════"
