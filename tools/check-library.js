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
 * 规则本体现在在 tools/lib/position-check.js（import-puzzles.js 也要用同一份），
 * 这里只负责遍历自己的库、打印报告。
 */
const fs = require('fs');
const path = require('path');
const XQ = require(path.resolve(__dirname, '../web/js/engine.js'));
const { check, checkMid } = require('./lib/position-check.js');

const LIB = path.resolve(__dirname, '../shared/library.json');

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
