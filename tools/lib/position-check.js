'use strict';
/* 局面合法性校验 —— 单一实现，给 check-library.js（查自己的库）和
 * import-puzzles.js（查外部导入的题）共用。
 *
 * 为什么要单独抽出来：check-library.js 原来把主流程写在模块顶层，
 * 一 require 就会跑完并 process.exitCode = 1 —— 别的工具想复用那个 check()
 * 是拿不到的。这类「工具只写成了脚本、没写成模块」的债，在第二个消费方
 * 出现时就得还，否则只能复制一份规则，两份迟早不一致。
 *
 * 校验项（每一条都对应一次真踩过的坑，见 check-library.js 的注释）：
 *   · 每方恰好 1 将/帅
 *   · 士 ≤2、象 ≤2、车 ≤2、马 ≤2、炮 ≤2、兵/卒 ≤5
 *   · 士必须在九宫内；象必须在象位（七个子，不是均匀分布）
 *   · 将帅必须在九宫内
 *   · 兵/卒只能朝前走：黑卒在第 3~9 行，红兵在第 0~6 行
 *   · 双将不能对面（飞将）
 *   · **不该走的一方不能被将军**
 *   · 走子方必须有合法着法
 */
const path = require('path');
const XQ = require(path.resolve(__dirname, '../../web/js/engine.js'));

/* 象位：本方不能过河，且只能在 7 个点上。
 * ⚠️ 七个子不是均匀分布：底行和河沿行是 {2,6}，中间那一行是 {0,4,8}。
 * 因为象走「田」字：(9,2)→(7,0)/(7,4)、(9,6)→(7,4)/(7,8)，
 * 所以第 7 行能落 {0,4,8}，第 5 行只能落 {2,6}。写错的话
 * 「相三进五」这种最普通的开局都会被误报成非法。 */
function elephantOk(row, col, red) {
  const mid = red ? 7 : 2;
  if (row === mid) return [0, 4, 8].indexOf(col) >= 0;
  const edge = red ? [9, 5] : [0, 4];
  if (edge.indexOf(row) >= 0) return [2, 6].indexOf(col) >= 0;
  return false;
}

function inPalace(row, col, red) {
  if (col < 3 || col > 5) return false;
  return red ? (row >= 7 && row <= 9) : (row >= 0 && row <= 2);
}

/* 标准 FEN（空格用数字压缩，如 `3a5`）→ 本项目的内部格式（空格用 `.`）。
 * 外部题库（xiangqi-pwa-offline、Pikafish 的 `position fen`）都用标准 FEN，
 * 我们的 parseBoard 只会按 `rows[r][c]` 逐格取字符 —— 直接喂 `3a5` 会取到
 * 字符 '3'，被当成一个棋子，**而且不报错**。所以这一步必须显式做。 */
function stdFenToInternal(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const rows = parts[0].split('/');
  if (rows.length !== 10) throw new Error('行数不是 10：' + rows.length);
  const out = rows.map((row) => {
    let s = '';
    for (const ch of row) {
      if (ch >= '1' && ch <= '9') s += '.'.repeat(parseInt(ch, 10));
      else s += ch;
    }
    return s;
  });
  for (let i = 0; i < 10; i++) {
    if (out[i].length !== 9) throw new Error('第 ' + i + ' 行展开后不是 9 格：' + out[i]);
  }
  /* 走子方：中国象棋 FEN 用 w/b，w = 红先 */
  const side = parts[1] === 'b' ? 'b' : 'r';
  return { fen: out.join('/') + ' ' + side, board: out.join('/'), side };
}

function check(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const rows = parts[0].split('/');
  const problems = [];
  if (rows.length !== 10) return ['棋盘不是 10 行'];
  const cnt = { red: {}, black: {} };
  const kings = { red: [], black: [] };
  for (let r = 0; r < 10; r++) {
    if (rows[r].length !== 9) { problems.push('第 ' + r + ' 行不是 9 格'); continue; }
    for (let c = 0; c < 9; c++) {
      const ch = rows[r][c];
      if (ch === '.') continue;
      const red = ch === ch.toUpperCase();
      const side = red ? 'red' : 'black';
      const t = ch.toLowerCase();
      cnt[side][t] = (cnt[side][t] || 0) + 1;
      if (t === 'k') kings[side].push([r, c]);
      if (t === 'a' && !inPalace(r, c, red)) {
        problems.push(side + '的士不在九宫：(' + r + ',' + c + ')');
      }
      if (t === 'b' && !elephantOk(r, c, red)) {
        problems.push(side + '的象不在象位：(' + r + ',' + c + ')');
      }
      if (t === 'k' && !inPalace(r, c, red)) {
        problems.push(side + '的将不在九宫：(' + r + ',' + c + ')');
      }
      /* 兵/卒永远不后退：黑卒从第 3 行起步只会往下（行号增大）→ 只能在 3~9 行；
         红兵从第 6 行起步只会往上 → 只能在 0~6 行。
         踩过：一开始漏了这条，于是「黑卒站在自己底线」这种局面被放过去了，
         直到 Pikafish 报 `BLACK pawn(s) on invalid positions` 才发现。 */
      if (t === 'p') {
        if (!red && r < 3) problems.push('黑卒不可能在第 ' + r + ' 行（应在 3~9 行）');
        if (red && r > 6) problems.push('红兵不可能在第 ' + r + ' 行（应在 0~6 行）');
      }
    }
  }
  for (const side of ['red', 'black']) {
    const c = cnt[side];
    const cn = side === 'red' ? '红' : '黑';
    if (kings[side].length !== 1) problems.push(cn + '方有 ' + kings[side].length + ' 个将/帅（应为 1）');
    if ((c.a || 0) > 2) problems.push(cn + '方有 ' + c.a + ' 个士（应 ≤2）');
    if ((c.b || 0) > 2) problems.push(cn + '方有 ' + c.b + ' 个象（应 ≤2）');
    if ((c.r || 0) > 2) problems.push(cn + '方有 ' + c.r + ' 个车（应 ≤2）');
    if ((c.n || 0) > 2) problems.push(cn + '方有 ' + c.n + ' 个马（应 ≤2）');
    if ((c.c || 0) > 2) problems.push(cn + '方有 ' + c.c + ' 个炮（应 ≤2）');
    if ((c.p || 0) > 5) problems.push(cn + '方有 ' + c.p + ' 个兵/卒（应 ≤5）');
  }
  const side = parts[1] === 'b' ? 'b' : 'r';
  const board = XQ.parseBoard(fen);
  if (kings.red.length === 1 && kings.black.length === 1 && XQ.kingsFacing(board)) {
    problems.push('双将对面（飞将），非法局面');
  }
  if (kings.red.length === 1 && kings.black.length === 1) {
    const notToMove = XQ.other(side);
    if (XQ.inCheck(board, notToMove)) {
      problems.push('不该走的 ' + (notToMove === 'r' ? '红' : '黑') + '方正被将军，非法局面');
    }
  }
  if (!XQ.hasLegalMove(board, side)) problems.push('走子方无合法着法（已是终局，不该作为待分析局面）');
  return problems;
}

/* 线路最后一步走出将死是**正常的**，别报成非法 —— 只检查中间局面够不够走 */
function checkMid(fen) {
  return check(fen).filter((x) => !x.startsWith('走子方无合法着法'));
}

/* 按 id 去重用的局面键：完整棋盘串 + 走子方。
 * 项目里已有这个约定（和棋判定、预计算都用它），别改成哈希 —— 哈希会漏掉
 * 「不同局面撞同一个键」的重复，那种重复一旦写进库就是两条一样的题。 */
function positionKey(boardStr, side) { return boardStr + ' ' + side; }

module.exports = { check, checkMid, stdFenToInternal, elephantOk, inPalace, positionKey };
