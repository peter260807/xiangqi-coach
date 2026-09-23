/* 搜索层「和棋意识」的测试 —— 引擎知不知道自己在绕圈。
 *
 *   node tools/test-rep-search.js
 *
 * 为什么和 test-draw.js 分开：那两个是两件事，别混。
 *   - test-draw.js 验的是**对局层**（判定棋局终局，用户看得到的规则）；
 *   - 本文件验的是**搜索层**：引擎在搜索里就认得「走回旧局面 = 和棋」。
 *
 * 分开之前实测过的区别很实在：20 局自对弈有 9 局（45%）以三次重复告终。
 * 对局层只能把结局判对（判和 / 判长将负），**引擎自己还是会把循环当成正分去追**，
 * 一盘赢棋就这么被自己走成和棋。这一层修的是那个。
 *
 * 手法：要证明「引擎认得重复」，不能只看它没报错 —— 得让同一手棋在有 / 无历史
 * 两种情况下被强制走一遍，比较引擎给的分。分从「正常评估」掉到恰好 0，
 * 才说明那次判和真的发生了。 */
'use strict';

const XQ = require('../web/js/engine.js');

let ok = true, asserts = 0;
function check(name, cond, extra) {
  asserts++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) ok = false;
  return cond;
}
const sq = (r, c) => r * 9 + c;

/** 强制走某一手（把其它合法着法全排除），看引擎给这一手打多少分 */
function forcedScore(board, side, m, depth, history) {
  XQ.resetSearch();
  const all = XQ.legalMoves(XQ.parseBoard(board), side);
  const excluded = all.filter(x => !(x[0] === m[0] && x[1] === m[1]));
  const r = XQ.searchRoot(XQ.parseBoard(board), side, depth, 20000, excluded, history);
  return { score: r.score, excluded: excluded.length, total: all.length };
}

/** 自由搜索（不排除任何着法） */
function freeSearch(board, side, depth, history) {
  XQ.resetSearch();
  return XQ.searchRoot(XQ.parseBoard(board), side, depth, 20000, null, history);
}

/* ============ 1. 不可逆着法的判定 ============ */

check('不吃子的车走 → 局面还可能重现', XQ.repIsIrreversible('R', '.') === false);
check('不吃子的马走 → 局面还可能重现', XQ.repIsIrreversible('N', '.') === false);
check('吃子 → 之前的局面不可能重现了', XQ.repIsIrreversible('R', 'p') === true);
check('走兵（红）→ 兵只进不退，局面不可能重现', XQ.repIsIrreversible('P', '.') === true);
check('走兵（黑）同理', XQ.repIsIrreversible('p', '.') === true);

/* ============ 2. repContext：历史路径与「段」的边界 ============ */

/* 一个刚好能让红车吃黑卒的局面；吃完之后就是一段干净的挪子 */
const EAT_FEN = '...k...../........./........./........./....p..../....R..../........./........./........./....K....';
const EAT_MOVES = [
  [sq(5, 4), sq(4, 4)],   /* 红车吃卒 —— 第 1 手就是不可逆的 */
  [sq(0, 3), sq(1, 3)],   /* 黑将 d0->d1 */
  [sq(4, 4), sq(4, 5)],   /* 红车 e4->f4 */
  [sq(1, 3), sq(0, 3)]    /* 黑将 d1->d0 */
];
{
  const b = XQ.parseBoard(EAT_FEN);
  let s = 'r', legal = true;
  for (const m of EAT_MOVES) {
    if (!XQ.legalMoves(b, s).some(x => x[0] === m[0] && x[1] === m[1])) { legal = false; break; }
    XQ.makeMove(b, m); s = XQ.other(s);
  }
  check('（前提）吃子用例的 4 手在裁判这里全部合法', legal === true);
}

{
  const ctx = XQ.repContext(EAT_FEN, EAT_MOVES, 'r');
  check('repContext 给出「着法数 + 1」个局面', ctx.keys.length === EAT_MOVES.length + 1,
    ctx.keys.length + ' 个');
  check('第 1 手就吃子 → 从第 2 个局面起单独成段（segs 全为 1）',
    JSON.stringify(ctx.segs) === JSON.stringify([0, 1, 1, 1, 1]), JSON.stringify(ctx.segs));
}

{
  /* 全程不吃子、不动兵 → 整条历史是同一段，段起点始终是 0 */
  const QUIET = [[sq(9, 0), sq(8, 0)], [sq(0, 0), sq(1, 0)], [sq(8, 0), sq(9, 0)], [sq(1, 0), sq(0, 0)]];
  const ctx = XQ.repContext(XQ.START, QUIET, 'r');
  check('连续挪子（不吃子、不动兵）→ 整条历史是同一段',
    JSON.stringify(ctx.segs) === JSON.stringify([0, 0, 0, 0, 0]), JSON.stringify(ctx.segs));
}

{
  /* repContext 是「旁观者」，不许挪动全局增量哈希 */
  XQ.syncHash(XQ.parseBoard(XQ.START), 'r');
  const h0 = XQ.currentHash();
  XQ.repContext(EAT_FEN, EAT_MOVES, 'r');
  check('repContext 重放历史后，全局哈希原地不动（置换表不会串味）',
    XQ.currentHash() === h0, XQ.currentHash() + ' vs ' + h0);

  /* 对照组：证明上面那条不是空转 —— 直接用 makeMove 确实会把哈希推走 */
  const b2 = XQ.parseBoard(XQ.START);
  XQ.makeMove(b2, XQ.legalMoves(b2, 'r')[0]);
  check('（对照）直接用 makeMove 会把全局哈希推走 —— 所以上面那条有意义',
    XQ.currentHash() !== h0, XQ.currentHash() + ' vs ' + h0);
}

/* ============ 3. 反复出现在第 1 层：重复着法应当掉到 0 分 ============ */

/* 标准开局，红黑各一个车上下挪一趟，正好回到开局 ——
   于是「再挪一次」= 回到历史里的第 1 个局面 = 重复。 */
const SHUF = [[sq(9, 0), sq(8, 0)], [sq(0, 0), sq(1, 0)], [sq(8, 0), sq(9, 0)], [sq(1, 0), sq(0, 0)]];
const SHUF_X = SHUF[0];

{
  const b = XQ.parseBoard(XQ.START);
  let s = 'r', legal = true;
  for (const m of SHUF) {
    if (!XQ.legalMoves(b, s).some(x => x[0] === m[0] && x[1] === m[1])) { legal = false; break; }
    XQ.makeMove(b, m); s = XQ.other(s);
  }
  check('（前提）挪车往返 4 手全部合法，且回到标准开局',
    legal && XQ.boardToString(b) === XQ.START && s === 'r', XQ.boardToString(b) === XQ.START);

  const ctx = XQ.repContext(XQ.START, SHUF, 'r');
  const afterX = (() => {
    const c = XQ.parseBoard(XQ.START);
    XQ.makeMove(c, SHUF_X);
    return XQ.computeHash(c, 'b');
  })();
  check('（前提）重复着法走出来的局面，就是历史里的第 1 个局面',
    ctx.keys[1] === afterX, '历史 keys[1] vs 走出来的局面');
  check('（前提）这段历史自己回到了起点（keys[4] == keys[0]）',
    ctx.keys[4] === ctx.keys[0]);
}

{
  const withH = forcedScore(XQ.START, 'r', SHUF_X, 4, SHUF);
  const noH = forcedScore(XQ.START, 'r', SHUF_X, 4, null);
  check('（前提）这手棋是唯一被允许的着法（排除表生效）',
    withH.excluded === withH.total - 1 && withH.total === 44,
    withH.excluded + '/' + withH.total);
  check('带历史时，走回旧局面 → 恰好判 0 分', withH.score === 0, withH.score);
  check('同样的着法、同样的深度，不给历史就得不到 0 分（说明 0 分是判出来的）',
    noH.score !== 0, noH.score);
  check('价值翻转方向对：劣势方会因此开始考虑求和',
    withH.score > noH.score, `带历史 ${withH.score} > 无历史 ${noH.score}`);
}

/* ============ 4. 反复发生在第 2 层：接线真的到了子树里 ============ */

/* 黑将只能在 d0/d1 之间来回（红车 e5 封住整条 e 线、红车 a2 封住整条 2 线），
   所以黑方的应手是**被迫**的，红方躲不掉。历史走的是同一段循环的前两拍：
   红车 e5->e6、黑将 d0->d1。根局面 = 循环的第 3 拍，红走。
   红车 e6->e5 之后黑将被迫 d1->d0 → 回到历史起点 → 这在**第 2 层**才被发现。 */
const BOXED = '...k...../........./R......../........./........./....R..../........./........./........./....K....';
const BOXED_H = { fen: BOXED, moves: [[sq(5, 4), sq(6, 4)], [sq(0, 3), sq(1, 3)]] };
const BOXED_ROOT = '........./...k...../R......../........./........./........./....R..../........./........./....K....';
const BOXED_X = [sq(6, 4), sq(5, 4)];   /* 红车 e6->e5 */

{
  const b = XQ.parseBoard(BOXED);
  const fromD0 = XQ.legalMoves(b, 'b').map(m => m[0] + '>' + m[1]);
  XQ.makeMove(b, [sq(0, 3), sq(1, 3)]);
  const fromD1 = XQ.legalMoves(b, 'b').map(m => m[0] + '>' + m[1]);
  check('（前提）黑将在 d0 只有一条合法着法（去 d1）',
    fromD0.length === 1 && fromD0[0] === sq(0, 3) + '>' + sq(1, 3), fromD0.join(','));
  check('（前提）黑将在 d1 只有一条合法着法（回 d0）→ 重复是被迫的',
    fromD1.length === 1 && fromD1[0] === sq(1, 3) + '>' + sq(0, 3), fromD1.join(','));
}

{
  /* 根局面：把历史重放一遍，确认拼出来的就是 BOXED_ROOT */
  const b = XQ.parseBoard(BOXED);
  for (const m of BOXED_H.moves) XQ.makeMove(b, m);
  check('（前提）历史重放后的根局面与预期一致', XQ.boardToString(b) === BOXED_ROOT,
    XQ.boardToString(b));

  /* 深度 2：叶子本来只会做静态评估（红多两个车 ≈ +1800）。
     带历史时它应当在第 2 层认出重复 → 0；不带就该停在静态分上。
     这一条就是「push/pop 接线真的到了子树」的证据。 */
  const withH = forcedScore(BOXED_ROOT, 'r', BOXED_X, 2, BOXED_H);
  const noH = forcedScore(BOXED_ROOT, 'r', BOXED_X, 2, null);
  check('第 2 层的重复也要认：带历史 → 0 分（而不是静态分的 +1800）',
    withH.score === 0, withH.score);
  check('同一手棋、同一深度，不给历史就只是静态分（> 1000）',
    noH.score > 1000, noH.score);
}

/* ============ 5. 行为：优势方不会把「重复」当成好棋 ============ */

{
  const free = freeSearch(BOXED_ROOT, 'r', 2, BOXED_H);
  const forced = forcedScore(BOXED_ROOT, 'r', BOXED_X, 2, BOXED_H);
  check('优势方选了致胜着法，而不是那手 0 分的重复着法',
    !!free.move && (free.move[0] !== BOXED_X[0] || free.move[1] !== BOXED_X[1]),
    JSON.stringify(free.move) + ' vs 重复着法 ' + JSON.stringify(BOXED_X));
  check('（对照）那手重复着法确实只有 0 分', forced.score === 0, forced.score);
  check('自由搜索拿到的是胜势分（远高于 0）', free.score > 10000, free.score);
}

/* ============ 6. 行为：劣势方会主动去找和棋 ============ */

/* 红方只剩一个帅，还被黑双车逼得只能在 d9/d8 两格来回（和构造 2 上下镜像：
   那里被迫来回的是黑将，这里是被迫来回的红帅 —— 而且红方是**输定的**那一方）。
   历史里已经走过一轮循环，于是红帅再挪一次就等于回到旧局面。 */
const LOST = '....k..../........./........./........./....r..../........./........./r......../........./...K.....';
const LOST_CYCLE = [
  [sq(9, 3), sq(8, 3)],   /* 红帅 d9->d8 */
  [sq(7, 0), sq(7, 1)],   /* 黑车 a7->b7 */
  [sq(8, 3), sq(9, 3)],   /* 红帅 d8->d9 */
  [sq(7, 1), sq(7, 0)]    /* 黑车 b7->a7 —— 一轮走完正好回到起点 */
];
const LOST_X = LOST_CYCLE[0];

{
  const b = XQ.parseBoard(LOST);
  let s = 'r', legal = true;
  const redMoveCounts = [XQ.legalMoves(b, 'r').length];
  for (const m of LOST_CYCLE) {
    if (!XQ.legalMoves(b, s).some(x => x[0] === m[0] && x[1] === m[1])) { legal = false; break; }
    XQ.makeMove(b, m); s = XQ.other(s);
    if (s === 'r') redMoveCounts.push(XQ.legalMoves(b, 'r').length);
  }
  check('（前提）循环着法全部合法，且一轮走完回到起点',
    legal && XQ.boardToString(b) === LOST && s === 'r', XQ.boardToString(b) === LOST);
  check('（前提）红帅每一步都只有一条合法着法（来回是被迫的）',
    redMoveCounts.every(c => c === 1), redMoveCounts.join(','));
}

{
  const withH = forcedScore(LOST, 'r', LOST_X, 4, { fen: LOST, moves: LOST_CYCLE }).score;
  const noH = forcedScore(LOST, 'r', LOST_X, 4, null).score;
  check('输定的一方：不给历史时引擎看到的是「要被将死了」', noH < -10000, noH);
  check('同一个局面、同一手棋，给了历史就变成 0 分（和棋）——劣势方会主动求和',
    withH === 0 && withH > noH, `带历史 ${withH} vs 无历史 ${noH}`);
}

/* ============ 7. 性能护栏：长历史不许拖慢搜索 ============ */

/* 最坏情况是「一段很长」：全程不吃子、不动兵，段起点停在 0。
   用 Map 计数是这个护栏存在的原因 —— 换成每层线性回溯，这里会明显变慢。 */
function quietWalk(targetPlies) {
  const b = XQ.parseBoard(XQ.START);
  let side = 'r', prev = null;
  const out = [], seen = new Set([XQ.boardToString(b) + side]);
  for (let i = 0; i < targetPlies; i++) {
    let pick = null;
    for (const m of XQ.legalMoves(b, side)) {
      if (b[m[1]] !== '.' || b[m[0]] === 'P' || b[m[0]] === 'p') continue;   /* 不吃子、不动兵 */
      if (prev && m[0] === prev[1] && m[1] === prev[0]) continue;            /* 不立刻回头 */
      const cap = XQ.makeMove(b, m);
      const key = XQ.boardToString(b) + XQ.other(side);
      XQ.undoMove(b, m, cap);
      if (seen.has(key)) continue;
      pick = m; break;
    }
    if (!pick) break;
    XQ.makeMove(b, pick);
    prev = pick; side = XQ.other(side);
    out.push([pick[0], pick[1]]);
    seen.add(XQ.boardToString(b) + side);
  }
  return out;
}

{
  const walk = quietWalk(120);
  check('（前提）造出了 120 手不吃子、不动兵的历史', walk.length === 120, walk.length + ' 手');
  const ctx = XQ.repContext(XQ.START, walk, 'r');
  check('（前提）这段历史确实是一整段（段起点为 0，没有被打断）',
    ctx.segs[ctx.segs.length - 1] === 0, '段起点 ' + ctx.segs[ctx.segs.length - 1]);

  const time = (hist) => {
    XQ.resetSearch();
    const t = Date.now();
    const r = XQ.searchRoot(XQ.parseBoard(XQ.START), 'r', 4, 60000, null, hist);
    return { ms: Date.now() - t, score: r.score, nodes: r.nodes };
  };
  const a = time(null), b = time(walk);
  check('两边的搜索结果一致（历史不该改变这里的最佳分）', a.score === b.score, a.score + ' vs ' + b.score);
  check('120 手历史不拖慢搜索（最坏情况 < 3 倍）',
    b.ms < Math.max(50, a.ms * 3), `${a.ms}ms → ${b.ms}ms`);
}

/* ============ 8. 自证：这些断言真的跑到了 ============ */

check('断言条数 > 0（别让零匹配被读成通过）', asserts > 20, asserts + ' 条');

console.log('\n=== ' + (ok ? '全部通过' : '存在失败项') + `（共 ${asserts} 条断言）` + ' ===');
process.exit(ok ? 0 : 1);
