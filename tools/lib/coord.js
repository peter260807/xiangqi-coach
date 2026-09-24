'use strict';
/* 坐标与 FEN 方言的转换 —— 单一实现。
 *
 * 原来这两套转换各有一份拷贝（`tools/match.js` 的 `idxToUci/uciToIdx`、
 * `tools/precompute.js` 的 `sqName/fromUci/toStdFen`），到第三个消费方
 * （`tools/solve-mates-pika.js`）出现时抽出来。**方向写反不会报错** ——
 * 只会让引擎去算另一盘棋，所以这种转换必须只有一份。
 *
 * 两套坐标：
 *   · 内部索引 i = row*9 + col，row 0 = **黑方底线**、col 0 = 左（黑方视角的 a 路）
 *   · UCI 走格 a0..i9，数字是**红方的行号**：a0 = 红方底线左角
 * 所以 i 的 row 0 ↔ UCI 的 rank 9，两者行序相反。
 */

/* 内部索引 → UCI 合法格名（如 70 → 'h2'、76 → 'e1'） */
function idxToUci(i) {
  return String.fromCharCode(97 + (i % 9)) + (9 - Math.floor(i / 9));
}
/* UCI 格名 → 内部索引 */
function uciToIdx(s) {
  return (9 - parseInt(s.slice(1), 10)) * 9 + (s.charCodeAt(0) - 97);
}
/* UCI 着法串（'h2e2'）→ 内部着法 [from, to] */
function uciToMove(s) {
  return [uciToIdx(s.slice(0, 2)), uciToIdx(s.slice(2, 4))];
}
/* 内部着法 → UCI 着法串 */
function moveToUci(m) {
  return idxToUci(m[0]) + idxToUci(m[1]);
}

/* 本项目的内部 FEN 用 `.` 表示空格，**Pikafish 不认** —— 它会报
 * `CRITICAL ERROR: Invalid FEN. Invalid piece: .` 然后**直接退出进程**，
 * 而调用方只会以为搜索还没结束，一直等下去（实测把整个任务拖到被系统杀掉）。
 * 标准 FEN 用数字表示连续空格，走子方是 w/b。行序两边一致（第 0 行都是黑方底线）。
 * 末尾的着法计数一律不带：Pikafish 用不上，带上反而多一处能写错的地方。 */
function toStdFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const rows = parts[0].split('/').map((row) => row.replace(/\.+/g, (m) => String(m.length)));
  return rows.join('/') + ' ' + (parts[1] === 'b' ? 'b' : 'w');
}

module.exports = { idxToUci, uciToIdx, uciToMove, moveToUci, toStdFen };
