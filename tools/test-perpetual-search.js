/* 验证「搜索层认得长将」——修复前后行为对照。
 *
 * 局面取自 tools/test-draw.js 的 PERPETUAL：黑将 e0、红帅 f9、红车 d2。
 * 红车在 d2/e2 之间来回照将、黑将 e0/d0 之间躲，走满 4 手回到起点。
 *
 * 做法：把这 4 手当作「历史」喂进去（于是当前局面在路径上已经出现过一次），
 * 再**强制**红方走第 5 手 d2→e2 —— 这一手之后轮到黑方时，搜索就会撞上重复局面。
 *
 *   修复前：重复 = 和棋 → 这一手「不亏」，评分 ≈ 0
 *   修复后：认出这是长将 → 判红方负 → 评分 ≈ -MATE
 *
 * 用 searchRoot 的 excluded 参数把其它合法着法全排掉，剩下的分数就是这一手的分数
 * （否则「被新逻辑压低」和「本来就烂」分不开）。
 */
'use strict';

const path = require('path');
const XQ = require(path.resolve(__dirname, '../web/js/engine.js'));

const sq = (r, c) => r * 9 + c;

/* 黑将 e0、红车 d2、红帅 f9 */
const PERPETUAL = '...k...../........./....R..../........./........./........./.........'
  + '/........./........./.....K...';

/* 一轮完整循环：红车 d2→e2（将）、黑将 e0→d0、红车 e2→d2（将）、黑将 d0→e0 */
const CYCLE = [
  [sq(2, 4), sq(2, 3)],
  [sq(0, 3), sq(0, 4)],
  [sq(2, 3), sq(2, 4)],
  [sq(0, 4), sq(0, 3)],
];

const TARGET = CYCLE[0];   /* 强制红方走的这一手 */

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    console.log('  ❌ ' + name + (extra !== undefined ? '\n       实际: ' + extra : ''));
  }
}

console.log('='.repeat(66));
console.log('搜索层长将判定 —— 强制走「造成重复」的那一手，看给多少分');
console.log('='.repeat(66));
console.log('  MATE =', XQ.MATE);

const b = XQ.parseBoard(PERPETUAL);
const legal = XQ.legalMoves(b, 'r');
const others = legal.filter(m => !(m[0] === TARGET[0] && m[1] === TARGET[1]));
console.log('  红方合法着法 %d 个，排掉目标这一手后剩 %d 个（都要被 excluded）',
  legal.length, others.length);
check('目标着法 d2→e2 确实在合法着法里', legal.length - others.length === 1);

/* 历史：走完一轮循环，当前局面回到起点（于是它在路径上出现过一次） */
const hist = { fen: PERPETUAL, moves: CYCLE, side: 'r' };

const r = XQ.searchRoot(b, 'r', 3, 8000, others, hist);
console.log('  强制 d2→e2 后，红方视角评分 = %s（深度 %s，节点 %s）',
  r.score, r.depth, r.nodes);

check('红方视角评分是「大负」（认出长将会被判负）',
  r.score < -XQ.MATE / 2, r.score);
check('分数就是绝杀量级，不是 0（没被当成和棋）',
  Math.abs(Math.abs(r.score) - XQ.MATE) < 2000, Math.abs(r.score));

/* 对照：同一局面、同一历史，但不排除任何着法 —— 红方大优（车 vs 无子），
   它应该挑一个能赢的着法，分数是大正分。这一条用来证明「上面的负分
   是强制走长将造成的」，而不是这个局面本身对红方不利。 */
const rFree = XQ.searchRoot(b, 'r', 3, 8000, null, hist);
console.log('  自由搜索（不排除任何着法）评分 = %s，选中着法 %s',
  rFree.score, JSON.stringify(rFree.move));
check('自由搜索时红方是大优（说明局面本身没问题）',
  rFree.score > XQ.MATE / 2, rFree.score);
check('自由搜索没有选那一步长将', !rFree.move
  || rFree.move[0] !== TARGET[0] || rFree.move[1] !== TARGET[1],
  JSON.stringify(rFree.move));

console.log('');
console.log('='.repeat(66));
console.log('共 %d 项，通过 %d，失败 %d', pass + fail, pass, fail);
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);
