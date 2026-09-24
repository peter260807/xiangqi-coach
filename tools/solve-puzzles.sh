#!/usr/bin/env bash
# 分片并行求解：把 1310 道杀法题交给 N 个进程，各写各的分片文件。
# 不用 fork 管理，是因为「N 个后台进程 + 各写各的文件」更简单、也更容易看到进度。
#
# 用法：bash tools/solve-puzzles.sh [深度] [每局面时间上限ms] [分片数]
set -u
cd "$(dirname "$0")/.."
DEPTH=${1:-13}
BUDGET=${2:-30000}
SHARDS=${3:-6}
OUT=${OUT:-/tmp/xq-solve}

mkdir -p "$OUT"
# 注意：这里不能用 `rm -f "$OUT"/*.jsonl` —— zsh 在**没有匹配**时会让整条命令失败
# （`no matches found`），把后面的 && 链一起带走。用 find 明确定位。
find "$OUT" -maxdepth 1 -name '*.jsonl' -delete 2>/dev/null || true
find "$OUT" -maxdepth 1 -name '*.log' -delete 2>/dev/null || true

echo "深度 $DEPTH  预算 ${BUDGET}ms  分片 $SHARDS  → $OUT"
date '+%H:%M:%S 开始'

pids=""
for i in $(seq 0 $((SHARDS - 1))); do
  node tools/import-puzzles.js solve \
    --out "$OUT/shard$i.jsonl" --shard "$i/$SHARDS" \
    --depth "$DEPTH" --budget "$BUDGET" \
    > "$OUT/shard$i.log" 2>&1 &
  pids="$pids $!"
done
# 只等自己派出去的这些，不要 wait 整个进程组
for p in $pids; do wait "$p" || echo "  (pid $p 退出码非 0)"; done

date '+%H:%M:%S 全部完成'
total=0
for i in $(seq 0 $((SHARDS - 1))); do
  n=$(wc -l < "$OUT/shard$i.jsonl" 2>/dev/null | tr -d ' ')
  total=$((total + ${n:-0}))
  printf "  shard%-2d %6s 行   最后一行: %s\n" "$i" "${n:-0}" "$(tail -1 "$OUT/shard$i.log" 2>/dev/null | cut -c1-96)"
done
echo "  合计 $total 行"
