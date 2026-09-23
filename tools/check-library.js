'use strict';
/* 检查 shared/library.json 里的局面是不是**合法的中国象棋局面**。
 *
 *   node tools/check-library.js
 *
 * 起因：Pikafish 在 study s2 上直接退出，报的是
 *   `Unsupported position. BLACK has more than 2 advisors.`
 * —— 那个局面有 3 个黑士。我们的引擎不校验合法性（它只是搜索），所以一路照算，
 * 而 app 是把这个局面当**题目**展示给学生的。
 *
 * 校验项：
 *   · 每方恰好 1 将/帅
 *   · 士 ≤2、象 ≤2、车 ≤2、马 ≤2、炮 ≤2、兵/卒 ≤5
 *   · 士/象不能过河（象还必须落在本方 7 个象位之一）
 *   · 将帅必须在九宫内
 *   · 双将不能对面（飞将）
 *   · **不该走的一方不能被将军**（否则是吃了将的非法局面）
 */
const fs = require('fs');
const path = require('path');
const XQ = require(path.resolve(__dirname, '../web/js/engine.js'));

const LIB = path.resolve(__dirname, '../shared/library.json');

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

function check(fen) {
  const parts = fen.trim().split(/\s+/);
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
      if ((t === 'a' || t === 'b') && !inPalace(r, c, red) && t === 'a') {
        problems.push(side + '的士不在九宫：(' + r + ',' + c + ')');
      }
      if (t === 'b' && !elephantOk(r, c, red)) {
        problems.push(side + '的象不在象位：(' + r + ',' + c + ')');
      }
      if (t === 'k' && !inPalace(r, c, red)) {
        problems.push(side + '的将不在九宫：(' + r + ',' + c + ')');
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
  /* 走子方可省略，默认红 */
  const side = parts[1] === 'b' ? 'b' : 'r';
  const board = XQ.parseBoard(fen);
  if (kings.red.length === 1 && kings.black.length === 1 && XQ.kingsFacing(board)) {
    problems.push('双将对面（飞将），非法局面');
  }
  if (kings.red.length === 1 && kings.black.length === 1) {
    const notToMove = XQ.other(side);
    if (XQ.inCheck(board, notToMove)) problems.push('不该走的 ' + (notToMove === 'r' ? '红' : '黑') + '方正被将军，非法局面');
  }
  if (!XQ.hasLegalMove(board, side)) problems.push('走子方无合法着法（已是终局，不该作为待分析局面）');
  return problems;
}

/* 线路最后一步走出将死是**正常的**，别报成非法 —— 只检查中间局面够不够走 */
function checkMid(fen) {
  return check(fen).filter((x) => !x.startsWith('走子方无合法着法'));
}

const lib = JSON.parse(fs.readFileSync(LIB, 'utf8'));
let bad = 0, total = 0;
for (const sec of ['classics', 'studies', 'mates']) {
  for (const it of lib[sec]) {
    if (!it.fen) continue;
    total++;
    const p = check(it.fen + ' r');
    if (p.length) {
      bad++;
      console.log('❌ ' + sec + ' ' + it.id + '  ' + (it.name || ''));
      console.log('   ' + it.fen);
      for (const x of p) console.log('   · ' + x);
    }
  }
}
/* 开局/名局是走出来的，顺手走一遍看有没有中途非法 */
for (const sec of ['classics', 'openings']) {
  for (const it of lib[sec]) {
    let b = XQ.parseBoard(XQ.START);
    let side = 'r';
    total++;
    for (const label of String(it.line).trim().split(/\s+/)) {
      const mv = XQ.findMoveByLabel(b, side, label);
      if (!mv) break;
      XQ.makeMove(b, mv);
      side = XQ.other(side);
      const p = checkMid(XQ.boardToString(b) + ' ' + side);
      if (p.length) {
        bad++;
        console.log('❌ ' + sec + ' ' + it.id + ' 走完「' + label + '」之后非法');
        console.log('   ' + XQ.boardToString(b) + ' ' + side);
        for (const x of p) console.log('   · ' + x);
        break;
      }
    }
  }
}
console.log('');
console.log('检查 ' + total + ' 个局面/线路，非法 ' + bad + ' 处');
process.exitCode = bad ? 1 : 0;
