/* 着法排序的测试（P1-2：SEE + 静态棋理）
 *
 *   node tools/test-order.js
 *
 * 为什么排序需要独立的测试：
 *   排序**不改变搜索结果**（alpha-beta 的根节点分数与着法顺序无关），
 *   所以「引擎没报错、棋路看着还行」完全不能证明排序是对的 ——
 *   排序错了只会让搜索变慢，或者更糟：让 SEE 悄悄改坏了棋盘。
 *   ⚠️ 「不改分」这条只在**没有近似剪枝**时成立，所以本文件开头强制关掉
 *      LMR 与空着裁剪（见文件开头的说明）。
 *
 * 本文件盯三件事：
 *   1. **SEE 的交换序列算得对**。所有期望值都是手算出来的，不是从实现里抄的。
 *   2. **SEE 把盘面原样还回来了**。它是「就地改棋盘再还原」，漏一格不会抛异常，
 *      只会让后面的搜索算到一盘不存在的棋 —— 这类 bug 最擅长躲在「没报错」后面。
 *   3. **亏本吃真的被压到安静着法之后了**。这是这次改动的主诉求。
 *
 * 另外，固定深度下的**节点数**才是排序质量的主要指标，那个在 tools/order-bench.js 里。
 * 本文件只保证「算的是对的」，不保证「算得快」。
 */
'use strict';

/* ⚠️ 必须在 require 引擎**之前**关掉近似剪枝。
 *
 * 第 6 节验的是「排序只许变快、不许变分」—— 这条硬约束成立的前提是
 * **搜索本身是精确的**（alpha-beta 的根节点分数与着法顺序无关）。
 * 而 LMR / 空着裁剪是按设计就会改变分数的**近似**剪枝，开着它们再断言
 * 「分数必须一模一样」，验的就不是排序了 —— 断言会在剪枝改动时无故变红，
 * 让人误以为排序被改坏。（2026-09-23 把剪枝改成默认开启后就撞到了这一点。）
 *
 * 环境变量必须在 require 前设好：engine.js 在加载时就读 process.env 定下开关。 */
process.env.XQ_NO_LMR = '1';
process.env.XQ_NO_NULL = '1';

const XQ = require('../web/js/engine.js');

let ok = true, asserts = 0;
function check(name, cond, extra) {
  asserts++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) ok = false;
  return cond;
}
const sq = (r, c) => r * 9 + c;

/** FEN 自证：10 行 × 9 字符。少写一个点，解析器照样吐 90 格，只是整盘棋错位 */
function fen(rows) {
  if (rows.length !== 10) throw new Error(`FEN 行数 ${rows.length} ≠ 10`);
  rows.forEach((r, i) => { if (r.length !== 9) throw new Error(`FEN 第 ${i} 行 '${r}' 不是 9 字符`); });
  return rows.join('/');
}

/** 棋盘原样快照（用来证明 SEE 没留下痕迹） */
function snap(b) { return b.join(''); }

/* ============================================================================
   1. SEE 的交换序列 —— 期望值全部手算
   ============================================================================ */

console.log('—— 1. SEE 交换序列（期望值手算） ——');

/* 局面 A：红兵(4,4) 吃 黑车(3,4)，没人能吃回来 → 净赚一整个车 = +900 */
const A = fen([
  '....k....',
  '.........',
  '.........',
  '....r....',
  '....P....',
  '.........',
  '.........',
  '.........',
  '.........',
  '....K....',
]);

/* 局面 B：红车(5,8) 吃 黑卒(5,0)，黑卒(4,0) 吃回来 → 100 - 900 = -800 */
const B = fen([
  '...k.....',
  '.........',
  '.........',
  '.........',
  'p........',
  'p.......R',
  '.........',
  '.........',
  '.........',
  '.....K...',
]);

/* 局面 C：红车 吃 黑车（平换），黑卒吃回来 → 900 - 900 = 0 */
const C = fen([
  '...k.....',
  '.........',
  '.........',
  '.........',
  'p........',
  'r.......R',
  '.........',
  '.........',
  '.........',
  '.....K...',
]);

/* 局面 D：红炮(5,8) 隔着黑卒(5,5) 打掉黑车(5,0)，黑卒(4,0) 吃炮 -->
   900 - 450 = +450（炮没有车值钱，所以吃回来之后仍然赚） */
const D = fen([
  '...k.....',
  '.........',
  '.........',
  '.........',
  'p........',
  'r....p..C',
  '.........',
  '.........',
  '.........',
  '.....K...',
]);

/* 局面 E：红车吃卒(100) → 黑卒吃车(900) → 红马吃卒(400)
   三步交换：100 - 900 + 400 = -400？不对，再算：
   f(3)=100（黑卒的价值，红马吃掉）
   f(2)=900 - 100 = 800（黑卒吃车赚 900，但随后被红马吃）
   f(1)=100 - 800 = -700（红车吃卒赚 100，随后车被吃）
   即红方净亏 700 —— 多步交换必须算到「对方会停下来」为止 */
const E = fen([
  '...k.....',
  '.........',
  '.........',
  '.N.......',
  'p........',
  'p.......R',
  '.........',
  '.........',
  '.........',
  '.....K...',
]);

function seeOf(f, from, to, side) {
  const b = XQ.parseBoard(f);
  return XQ.seeCapture(b, from, to, side);
}

check('A 兵吃车、无人吃回 → +900', seeOf(A, sq(4, 4), sq(3, 4), 'r') === 900,
      seeOf(A, sq(4, 4), sq(3, 4), 'r'));
check('B 车吃兵、被兵吃回 → -800', seeOf(B, sq(5, 8), sq(5, 0), 'r') === -800,
      seeOf(B, sq(5, 8), sq(5, 0), 'r'));
check('C 车吃车、被兵吃回 → 0（平换）', seeOf(C, sq(5, 8), sq(5, 0), 'r') === 0,
      seeOf(C, sq(5, 8), sq(5, 0), 'r'));
check('D 炮隔架打车、被兵吃回 → +450（炮比车便宜）', seeOf(D, sq(5, 8), sq(5, 0), 'r') === 450,
      seeOf(D, sq(5, 8), sq(5, 0), 'r'));
check('E 三步交换（车吃卒→卒吃车→马吃卒）→ -700', seeOf(E, sq(5, 8), sq(5, 0), 'r') === -700,
      seeOf(E, sq(5, 8), sq(5, 0), 'r'));

/* 反向验一次：同一盘棋换成黑方视角，符号要跟着走 */
check('同一手棋从黑方视角看符号相反（B 局面反过来摆）',
      (function () {
        /* 把 B 上下翻转：红车改在 (4,8)，黑卒改在 (4,0)/(5,0) 镜像处 */
        const F = fen([
          '.....K...',
          '.........',
          '.........',
          '.........',
          'P.......r',
          'P........',
          '.........',
          '.........',
          '.........',
          '...k.....',
        ]);
        return seeOf(F, sq(4, 8), sq(4, 0), 'b') === -800;
      })());

/* ============================================================================
   2. SEE 必须把盘面原样还回来
   ============================================================================ */

console.log();
console.log('—— 2. SEE 不得在棋盘上留下痕迹 ——');

for (const [name, f, from, to, side] of [
  ['A', A, sq(4, 4), sq(3, 4), 'r'],
  ['B', B, sq(5, 8), sq(5, 0), 'r'],
  ['C', C, sq(5, 8), sq(5, 0), 'r'],
  ['D', D, sq(5, 8), sq(5, 0), 'r'],
  ['E', E, sq(5, 8), sq(5, 0), 'r'],
]) {
  const b = XQ.parseBoard(f);
  const before = snap(b);
  const hashBefore = XQ.currentHash();
  XQ.seeCapture(b, from, to, side);
  check(`SEE(${name}) 走完之后棋盘逐格不变`, snap(b) === before);
  check(`SEE(${name}) 不碰全局增量哈希`, XQ.currentHash() === hashBefore);
}

/* 换着子力顺序多试几轮：交换序列越长，留下的临时改动越多，越容易漏还原 */
{
  const b = XQ.parseBoard(E);
  const before = snap(b);
  for (let i = 0; i < 50; i++) XQ.seeCapture(b, sq(5, 8), sq(5, 0), 'r');
  check('连续 50 次 SEE 之后棋盘仍然逐格不变', snap(b) === before);
}

/* 吃不到子（空着）→ 立刻返回 0，不许改盘面 */
{
  const b = XQ.parseBoard(A);
  const before = snap(b);
  check('对空格调用 SEE 返回 0', XQ.seeCapture(b, sq(4, 4), sq(3, 3), 'r') === 0);
  check('对空格调用 SEE 不碰棋盘', snap(b) === before);
}

/* ============================================================================
   3. leastAttacker：找的必须是**最便宜**的那一个
   ============================================================================ */

console.log();
console.log('—— 3. leastAttacker 找最便宜的攻击者 ——');

/* 同一格被黑卒(100)和黑车(900)同时攻击 → 必须返回卒 */
{
  const f = fen([
    '...k.....',
    '.........',
    '.........',
    '.........',
    'p........',
    '....r....',
    '.........',
    '.........',
    '.........',
    '.....K...',
  ]);
  const b = XQ.parseBoard(f);
  const a = XQ.leastAttacker(b, sq(5, 0), 'b');
  check('同时被卒和车攻击 → 选卒（100）', a && a.value === 100 && a.from === sq(4, 0), JSON.stringify(a));

  /* 把卒拿掉 → 只剩车 */
  const f2 = fen([
    '...k.....',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    '.........',
    '.........',
    '.........',
    '.....K...',
  ]);
  const b2 = XQ.parseBoard(f2);
  const a2 = XQ.leastAttacker(b2, sq(5, 0), 'b');
  check('卒拿掉之后 → 只剩车（900）', a2 && a2.value === 900 && a2.from === sq(5, 4), JSON.stringify(a2));
}

/* 马腿被别 → 不算攻击者 */
{
  const blocked = XQ.parseBoard(fen([
    '...k.....',
    '.........',
    '.........',
    '.N.......',
    '.p.......',   /* 黑卒正好别住马腿 */
    '.........',
    '.........',
    '.........',
    '.........',
    '.....K...',
  ]));
  const free = XQ.parseBoard(fen([
    '...k.....',
    '.........',
    '.........',
    '.N.......',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.....K...',
  ]));
  check('马腿被别 → 不算攻击 (5,0)', XQ.leastAttacker(blocked, sq(5, 0), 'r') === null);
  const a = XQ.leastAttacker(free, sq(5, 0), 'r');
  check('马腿空了 → 马算攻击者（400）', a && a.value === 400 && a.from === sq(3, 1), JSON.stringify(a));
}

/* 炮必须有炮架 */
{
  const withScreen = XQ.parseBoard(D);
  const noScreen = XQ.parseBoard(fen([
    '...k.....',
    '.........',
    '.........',
    '.........',
    'p........',
    'r.......C',   /* 炮架（黑卒 5,5）已撤走 */
    '.........',
    '.........',
    '.........',
    '.....K...',
  ]));
  const a = XQ.leastAttacker(withScreen, sq(5, 0), 'r');
  check('炮隔一个架 → 算攻击者（450）', a && a.value === 450 && a.from === sq(5, 8), JSON.stringify(a));
  check('没有炮架 → 炮不算攻击者', XQ.leastAttacker(noScreen, sq(5, 0), 'r') === null);
}

/* 兵/卒横着吃必须已过河 */
{
  const notCrossed = XQ.parseBoard(fen([
    '...k.....',
    '.........',
    '.........',
    '.........',
    '.p.......',   /* 黑卒在行 4，还没过河 */
    '.........',
    '.........',
    '.........',
    '.........',
    '.....K...',
  ]));
  const crossed = XQ.parseBoard(fen([
    '...k.....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.p.......',   /* 黑卒在行 5 = 已过河 */
    '.........',
    '.........',
    '.........',
    '.....K...',
  ]));
  const target = sq(4, 2);
  const target2 = sq(5, 2);
  check('未过河的黑卒不能横着吃', XQ.leastAttacker(notCrossed, target, 'b') === null);
  check('过河的黑卒可以横着吃', (function () {
    const a = XQ.leastAttacker(crossed, target2, 'b');
    return a && a.value === 100 && a.from === sq(5, 1);
  })());
}

/* 士/象：斜线（士一步、象两步且象眼要空、不能过河） */
{
  const b = XQ.parseBoard(fen([
    '...k.....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...B.....',   /* 红象 (7,3) */
    '....A....',   /* 红士 (8,4) */
    '.....K...',
  ]));
  const aSq = sq(7, 5);   /* 士 (8,4) → (7,5)：斜一步 */
  const a = XQ.leastAttacker(b, aSq, 'r');
  check('士可以斜一步吃（200）', a && a.value === 200 && a.from === sq(8, 4), JSON.stringify(a));
  const bSq = sq(5, 1);   /* 象 (7,3) → (5,1)：斜两步，象眼 (6,2) 空 */
  const a2 = XQ.leastAttacker(b, bSq, 'r');
  check('象可以斜两步吃（200）', a2 && a2.value === 200 && a2.from === sq(7, 3), JSON.stringify(a2));
}

/* 将/帅**不算**攻击者。
   这条以前漏了，而它是实测的关键：算上它将时，SEE 会把「在敌将旁边吃子」算成 -60000 级
   巨亏、再降到所有安静着法之后 —— SEE 反而比不改还慢。
   另外它还是「两端同一套算法」的检查点：Swift 侧 `Search.leastAttacker` 也必须不算。 */
{
  /* 黑将 (0,4) 是 (1,4) 唯一的黑方攻击者；红车放在 (1,4) 上等着被吃。
     红帅挪到 (9,3) 免得两将照面（照面的局面不是合法局面，测它没意义）。 */
  const kingOnly = XQ.parseBoard([
    '....k....',
    '....R....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...K.....',
  ].join('/'));
  check('将不算攻击者（它是唯一能吃到的子）',
        XQ.leastAttacker(kingOnly, sq(1, 4), 'b') === null,
        JSON.stringify(XQ.leastAttacker(kingOnly, sq(1, 4), 'b')));

  /* 自证：同一个局面上「换成车」必须能被找到 —— 否则上面那条也可能是因为
     位置写错（比如棋子根本没摆上）而恒为 null，属于「因为错误的原因通过」。 */
  const rookThere = XQ.parseBoard([
    '....k....',
    '....R...r',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...K.....',
  ].join('/'));
  const ctrl = XQ.leastAttacker(rookThere, sq(1, 4), 'b');
  check('（自证）同一局面换成黑车就能找到 → 上面那条不是因为没摆上棋子',
        ctrl && ctrl.value === 900 && ctrl.from === sq(1, 8), JSON.stringify(ctrl));
}

/* ============================================================================
   4. 位置价值表增量（安静着法的静态棋理）
   ============================================================================ */

console.log();
console.log('—— 4. 位置表增量：过河兵推进、子力展开 ——');

/* ⚠️ 这一节的第一版写错了，值得留个记录：
   当时拿 `XQ.START` 和一张**全空**的盘去取 (4,4)→(3,4) 的增量，结果两条断言
   给出 0 和 0 —— 空盘上根本没有棋子，`pstDelta` 只能返回 0。
   更要命的是「红兵前进与黑卒前进得分相同」那条**通过了**（0 === 0），
   属于「因为错误的原因通过」：断言在验的东西和它想验的东西不是一回事。
   所以下面必须用**真的有棋子**的局面，并且额外断言「值不为 0」。 */
const ADV = fen([
  '....k....',
  '.........',
  '.........',
  '....p....',   /* 黑卒 (3,4)，未过河 */
  '....P....',   /* 红兵 (4,4)，已过河 */
  '.........',
  '....P....',   /* 红兵 (6,4)，未过河 */
  'R........',   /* 红车 (7,0) */
  '.........',
  '....K....',
]);
{
  const b = XQ.parseBoard(ADV);
  /* 自证前提：这些格子上真的有棋子，否则后面的增量全是 0，测了个寂寞 */
  check('（前提）ADV 局面的 (6,4) 是红兵、(3,4) 是黑卒、(7,0) 是红车',
        b[sq(6, 4)] === 'P' && b[sq(3, 4)] === 'p' && b[sq(7, 0)] === 'R',
        `${b[sq(6, 4)]}/${b[sq(3, 4)]}/${b[sq(7, 0)]}`);

  const a1 = XQ.pstDelta(b, sq(6, 4), sq(5, 4));   /* 红兵前进（未过河 → 过河） */
  const a2 = XQ.pstDelta(b, sq(4, 4), sq(3, 4));   /* 红兵过河后再进 */
  check('红兵前进（行 6→5）得正分', a1 > 0, a1);
  check('红兵过河后再进（行 4→3）得分更高', a2 > a1, `${a2} vs ${a1}`);

  const redAdvance = XQ.pstDelta(b, sq(6, 4), sq(5, 4));
  const blackAdvance = XQ.pstDelta(b, sq(3, 4), sq(4, 4));
  check('红兵前进与黑卒前进得分相同（行镜像正确）',
        redAdvance > 0 && redAdvance === blackAdvance, `${redAdvance} vs ${blackAdvance}`);
  check('退子得负分（红车从河口退回底线）',
        XQ.pstDelta(b, sq(7, 0), sq(9, 0)) < 0, XQ.pstDelta(b, sq(7, 0), sq(9, 0)));
  check('没有位置表的子（帅/士/象）增量恒为 0',
        XQ.pstDelta(b, sq(9, 4), sq(8, 4)) === 0 && XQ.pstDelta(b, sq(7, 3), sq(6, 4)) === 0);
  /* 空着（起点没有子）必须返回 0 而不是崩 —— 排序里不会遇到，但接口要经得起误用 */
  check('起点没有子时增量返回 0', XQ.pstDelta(b, sq(5, 4), sq(4, 4)) === 0);
}

/* ============================================================================
   5. 排序：亏本吃必须被压到安静着法之后
   ============================================================================ */

console.log();
console.log('—— 5. 四层排序 ——');

function orderOf(f, side) {
  const b = XQ.parseBoard(f);
  XQ.resetSearch();   /* 清掉 killers/hist，否则排序不是确定的 */
  return XQ.orderMoves(b, XQ.genMoves(b, side), 0, null);
}
function indexOfMove(list, m) {
  for (let i = 0; i < list.length; i++) if (list[i][0] === m[0] && list[i][1] === m[1]) return i;
  return -1;
}

/* B 局面：唯一的吃子是「车吃兵、被兵吃回」（SEE = -800）→ 应该排到最后 */
{
  const list = orderOf(B, 'r');
  const capIdx = indexOfMove(list, [sq(5, 8), sq(5, 0)]);
  const last = list.length - 1;
  check('（前提）B 局面里那一手吃子确实在着法表里', capIdx >= 0);
  check('亏本吃被排到所有安静着法之后（最后一位）', capIdx === last, `位置 ${capIdx} / 共 ${list.length}`);
}

/* A 局面：唯一的吃子是「兵吃车、没人吃回」（SEE = +900）→ 应该排在第一位 */
{
  const list = orderOf(A, 'r');
  const capIdx = indexOfMove(list, [sq(4, 4), sq(3, 4)]);
  check('好吃子排在第一位', capIdx === 0, `位置 ${capIdx} / 共 ${list.length}`);
}

/* C 局面：平换（SEE = 0）→ 仍然算「好/等吃子」，不降级 */
{
  const list = orderOf(C, 'r');
  const capIdx = indexOfMove(list, [sq(5, 8), sq(5, 0)]);
  check('平换（SEE = 0）仍然排在最前，不降级', capIdx === 0, `位置 ${capIdx} / 共 ${list.length}`);
}

/* 门控自证：吃大子 / 平换时不该去算 SEE（省掉最贵的那一步） */
{
  XQ.resetSearch();
  const b = XQ.parseBoard(C);
  const before = XQ.seeCalls();
  XQ.orderMoves(b, XQ.genMoves(b, 'r'), 0, null);
  check('车吃车（吃子价值 ≥ 吃子方价值）不触发 SEE',
        XQ.seeCalls() === before, `多了 ${XQ.seeCalls() - before} 次`);

  XQ.resetSearch();
  const b2 = XQ.parseBoard(B);
  const before2 = XQ.seeCalls();
  XQ.orderMoves(b2, XQ.genMoves(b2, 'r'), 0, null);
  check('车吃兵（可能亏）才会去算 SEE',
        XQ.seeCalls() > before2, `多了 ${XQ.seeCalls() - before2} 次`);

  /* ply 门控：浅层算、深层不算。
     这条是实测的产物（整棵树都算 SEE 会让中局每节点贵 19%，固定时间反而更浅），
     必须有断言看着 —— 否则以后有人把那个 `ply > SEE_MAX_PLY` 去掉，
     节点数和耗时会悄悄退回去，而所有单测照样全绿。
     边界两侧各测一次：ply=SEE_MAX_PLY 要算，ply=SEE_MAX_PLY+1 不能算。 */
  XQ.resetSearch();
  const b3 = XQ.parseBoard(B);
  const at4 = XQ.seeCalls();
  XQ.orderMoves(b3, XQ.genMoves(b3, 'r'), XQ.SEE_MAX_PLY, null);
  check(`ply = SEE_MAX_PLY(${XQ.SEE_MAX_PLY}) 仍然算 SEE`,
        XQ.seeCalls() > at4, `多了 ${XQ.seeCalls() - at4} 次`);

  XQ.resetSearch();
  const b4 = XQ.parseBoard(B);
  const at5 = XQ.seeCalls();
  XQ.orderMoves(b4, XQ.genMoves(b4, 'r'), XQ.SEE_MAX_PLY + 1, null);
  check(`ply > SEE_MAX_PLY(${XQ.SEE_MAX_PLY}) 之后不再算 SEE`,
        XQ.seeCalls() === at5, `多了 ${XQ.seeCalls() - at5} 次`);
}

/* 真实搜索里 SEE 这条路确实被走到了（不看这个，上面全是可以只测不用的死代码） */
{
  XQ.resetSearch();
  const b = XQ.parseBoard(XQ.START);
  const r = XQ.searchRoot(b, 'r', 4, 30000, null, null);
  check('（自证）真实搜索中 SEE 被调用过', XQ.seeCalls() > 0, `调用 ${XQ.seeCalls()} 次`);
  check('（自证）真实搜索返回了合法着法', !!r.move && r.depth >= 1, JSON.stringify({ d: r.depth, n: r.nodes }));
}

/* ============================================================================
   6. 排序不得改变搜索结果（分数必须一模一样）
   ============================================================================ */

console.log();
console.log('—— 6. 排序只许变快，不许变分 ——');

/* alpha-beta 在根节点用全窗口搜到底，拿到的**分数**与着法顺序无关。
   所以「改排序前后同一局面同一深度的分数必须完全相同」是一条硬约束 ——
   它同时是 SEE 不许改坏棋盘的间接证明（棋盘被改坏，分数几乎必然变化）。

   下面这些值是**改排序之前**的引擎跑出来的（node tools/order-variants.js 生成
   /tmp/xq-order-variants/legacy.js 后实测），改完之后必须仍然是这三个数。
   Swift 引擎在同一局面深度 4 报 `score cp 8`，与第一行一致 —— 两端同答案。 */
const REFERENCE = [
  ['标准开局', XQ.START, 4, 8],
  ['中局',
   'r.nbakar./........./.cn...n.c/p.p.p...p/......p..'
   + '/..P....../P...P.P.P/.C..C.N../........./RNBAKABR.', 4, -186],
  ['残局',
   '..bakab.r/........./........./........./....P....'
   + '/...R...../........./....N..../........./....K....', 4, -220],
];

for (const [name, f, d, expect] of REFERENCE) {
  XQ.resetSearch();
  const b = XQ.parseBoard(f);
  const r = XQ.searchRoot(b, 'r', d, 60000, null, null);
  const label = r.move ? XQ.moveLabel(b, r.move) : '(无)';
  check(`${name} 深度 ${d} 的分数与改排序之前完全相同`, r.score === expect,
        `现在 ${r.score} / 参考 ${expect}　（最佳着法 ${label}，${r.nodes} 节点）`);
}

console.log();
console.log(ok ? `全部通过（${asserts} 项断言）` : `有断言失败（共 ${asserts} 项）`);
process.exit(ok ? 0 : 1);
