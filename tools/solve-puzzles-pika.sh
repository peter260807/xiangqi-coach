#!/usr/bin/env bash
# 用 Pikafish 批量求解「自研引擎看不到的深杀」，分片并行、各写各的文件。
#
# 用法：bash tools/solve-puzzles-pika.sh [每局面ms] [分片数] [depth上限]
#   默认 3000ms / 6 片 / depth 64
# 产出：$OUT/shardN.jsonl  →  再跑
#   node tools/import-puzzles.js emit --in <各分片> --dry   （先看）
#   node tools/solve-mates-pika.js report --in <各分片>      （体检报告）
set -u
cd "$(dirname "$0")/.."
MS=${1:-3000}
SHARDS=${2:-6}
DEPTH=${3:-64}
OUT=${OUT:-/tmp/xq-pika}

mkdir -p "$OUT"
# 注意：不能用 `rm -f "$OUT"/*.jsonl` —— zsh 在**没有匹配**时会让整条命令失败
# （`no matches found`），把后面的 && 链一起带走。用 find 明确定位。
find "$OUT" -maxdepth 1 -name '*.jsonl' -delete 2>/dev/null || true
find "$OUT" -maxdepth 1 -name '*.log' -delete 2>/dev/null || true

echo "每局面 ${MS}ms  depth ${DEPTH}  分片 ${SHARDS}  → $OUT"
date '+%H:%M:%S 开始'

pids=""
for i in $(seq 0 $((SHARDS - 1))); do
  node tools/solve-mates-pika.js \
    --out "$OUT/shard$i.jsonl" --shard "$i/$SHARDS" \
    --depth "$DEPTH" --movetime "$MS" \
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
