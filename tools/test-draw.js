/* 对局层终局判定（判和 / 长将判负）的测试。
 *
 *   node tools/test-draw.js
 *
 * 为什么单独一个文件：这是**规则**（中国象棋特有），不是搜索。
 * 判错的后果是「用户明明和棋却判他输」，比棋力弱严重得多，所以逐条钉死。
 */
'use strict';

const XQ = require('../web/js/engine.js');

let ok = true;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) ok = false;
  return cond;
}
const sq = (r, c) => r * 9 + c;
const show = (v) => (v === null ? 'null' : JSON.stringify(v));

/* ============ 1. 长将判负：红车在将门来回照将 ============ */

/* 黑将 e0、红帅 f9、红车 d2 —— 红车在 d2/f2 之间来回，每一步都照将，
   黑将只能在 e0/d0 之间躲。四次来回后 d2+e0 这个局面第三次出现。 */
const PERPETUAL = '...k...../........./....R..../........./........./........./........./........./........./.....K...';
const cyc = (a, b) => [[sq(2, a), sq(2, b)], [sq(0, 3), sq(0, 4)], [sq(2, b), sq(2, a)], [sq(0, 4), sq(0, 3)]];

const p3 = cyc(4, 3);
check('长将局面：红车在 d2/e2 来回，黑将 e0/d0 躲 —— 无合法性问题',
  XQ.legalMoves(XQ.parseBoard(PERPETUAL), 'r').some(m => m[0] === sq(2, 4) && m[1] === sq(2, 3)),
  JSON.stringify(cyc(4, 3)[0]));

check('走 4 手（局面只重复两次）还不该判终局',
  XQ.adjudicate(PERPETUAL, p3.slice(0, 4)) === null,
  show(XQ.adjudicate(PERPETUAL, p3.slice(0, 4))));

const p3x2 = p3.concat(p3);
const v3 = XQ.adjudicate(PERPETUAL, p3x2);
check('走 8 手（三次重复）→ 红方长将判负',
  !!v3 && v3.winner === 'b' && /长将/.test(v3.reason) && /红方/.test(v3.reason),
  show(v3));

/* 每一手将军这个事实必须真的成立（别让判定函数自己骗自己） */
{
  const b = XQ.parseBoard(PERPETUAL);
  let side = 'r';
  const checks = [];
  for (const m of p3x2) {
    XQ.makeMove(b, m);
    side = XQ.other(side);
    checks.push(XQ.inCheck(b, side));
  }
  check('红方每一手都是将军、黑方每一手都不是（长将的前提）',
    checks[0] && !checks[1] && checks[2] && !checks[3] && checks[4] && !checks[5] && checks[6] && !checks[7],
    checks.join(','));
}

/* ============ 2. 纯三次重复（无人长将）→ 判和 ============ */

/* 双方各一个车，在同一侧来回挪：既不吃子也不将军，纯循环 */
const QUIET_REP = '.....k.../........./........./........./r......../R......../........./........./........./...K.....';
const q = [[sq(5, 0), sq(5, 1)], [sq(4, 0), sq(4, 1)], [sq(5, 1), sq(5, 0)], [sq(4, 1), sq(4, 0)]];

check('无人将军的局面：走 4 手还不判终局',
  XQ.adjudicate(QUIET_REP, q) === null, show(XQ.adjudicate(QUIET_REP, q)));

const vq = XQ.adjudicate(QUIET_REP, q.concat(q));
check('无人将军的三次重复 → 判和（且不误判成长将）',
  !!vq && vq.winner === null && /三次重复/.test(vq.reason),
  show(vq));

/* ============ 3. 「谁长将」这个判定本身（含实战难摆的「双方都长将」） ============ */

const pc = XQ.perpetualChecker;
const R = { side: 'r', check: true }, r = { side: 'r', check: false };
const B = { side: 'b', check: true }, b = { side: 'b', check: false };

check('perpetualChecker: 红全将、黑全不将 → 红方长将',
  pc([R, b, R, b]) === 'r', show(pc([R, b, R, b])));
check('perpetualChecker: 黑全将、红全不将 → 黑方长将',
  pc([r, B, r, B]) === 'b', show(pc([r, B, r, B])));
check('perpetualChecker: 双方都长将 → null（规则判和，不能判某一方输）',
  pc([R, B, R, B]) === null, show(pc([R, B, R, B])));
check('perpetualChecker: 双方都不将 → null',
  pc([r, b, r, b]) === null, show(pc([r, b, r, b])));
check('perpetualChecker: 红方只有一手漏了将军就不算长将',
  pc([R, b, r, b]) === null, show(pc([R, b, r, b])));
check('perpetualChecker: 空循环 → null（空集不能算「全都将军」）',
  pc([]) === null, show(pc([])));

/* ============ 4. 60 回合无吃子判和（含 119/120 的边界） ============ */

/* 让两个车 + 两个将领着走一条「不回头」的路线：
   每手都不吃子、且保证任何局面出现次数 < 2 —— 于是 120 手内不会先撞上三次重复，
   能干净地测到「60 回合无吃子」这一条。
   captureAtPly 用来在中途插一手吃子，验证计数会被清零。 */
function quietWalk(fen, plies, captureAtPly) {
  const b = XQ.parseBoard(fen);
  let side = 'r';
  const seen = Object.create(null);
  seen[XQ.boardToString(b) + '|' + side] = 1;
  const moves = [];
  const captures = [];
  for (let j = 0; j < plies; j++) {
    const wantCapture = j === captureAtPly;
    let picked = null, bestOpts = -1;
    for (const m of XQ.legalMoves(b, side)) {
      const cap = XQ.makeMove(b, m);
      const ns = XQ.other(side);
      const key = XQ.boardToString(b) + '|' + ns;
      const fits = wantCapture ? (cap !== XQ.EMPTY) : (cap === XQ.EMPTY && (seen[key] || 0) < 2);
      if (fits) {
        /* 一层前瞻：数一下落子后还剩几条「新鲜」走法，挑最多的，
           否则贪心会把自己走进死角（实测剩 117 手就走不动了）。 */
        let opts = 0;
        for (const m2 of XQ.legalMoves(b, ns)) {
          const c2 = XQ.makeMove(b, m2);
          const k2 = XQ.boardToString(b) + '|' + XQ.other(ns);
          if (c2 === XQ.EMPTY && (seen[k2] || 0) < 2) opts++;
          XQ.undoMove(b, m2, c2);
        }
        if (opts > bestOpts) { bestOpts = opts; picked = { m, cap, key, ns }; }
      }
      XQ.undoMove(b, m, cap);
    }
    if (!picked) return { moves, captures, reached: moves.length };
    if (picked.cap !== XQ.EMPTY) captures.push(j);
    XQ.makeMove(b, picked.m);
    moves.push([picked.m[0], picked.m[1]]);
    seen[picked.key] = (seen[picked.key] || 0) + 1;
    side = picked.ns;
  }
  return { moves, captures, reached: moves.length };
}

check('规则常量：60 回合 = 120 手', XQ.NO_CAPTURE_PLIES === 120, XQ.NO_CAPTURE_PLIES);

const walk = quietWalk(QUIET_REP, 121);
check('能走出 121 手不吃子且不与三次重复冲突的路（否则下面两条测不到东西）',
  walk.reached === 121 && walk.captures.length === 0,
  walk.reached + ' 手，吃子 ' + walk.captures.length + ' 次');

const at119 = XQ.adjudicate(QUIET_REP, walk.moves.slice(0, 119));
const at120 = XQ.adjudicate(QUIET_REP, walk.moves.slice(0, 120));
check('119 手时还没到 60 回合 → 不判终局', at119 === null, show(at119));
check('120 手时 → 判「60 回合无吃子」和棋',
  !!at120 && at120.winner === null && /60 回合无吃子/.test(at120.reason), show(at120));

/* 中途吃子会把计数清零。对照要尽量干净：让它和上面那组**长度相同**，
   只差第一手吃了个子 —— 上面 120 手判和、这里同样 120 手就不该判和。 */
const walkCap = quietWalk(QUIET_REP, 121, 0);
check('能构造出「第一手就吃子」的对照序列（至少要够 120 手，否则测了个空）',
  walkCap.reached >= 120 && walkCap.captures.length === 1 && walkCap.captures[0] === 0,
  walkCap.reached + ' 手，吃子在 ' + JSON.stringify(walkCap.captures));

const capped = XQ.adjudicate(QUIET_REP, walkCap.moves.slice(0, 120));
check('第一手吃过子 → 同样 120 手也不判和（计数确实被清零了）',
  capped === null, show(capped));

/* ============ 5. 判定函数不许有副作用：全局增量哈希不能被它推走 ============ */

/* adjudicate 要重放整局棋。如果它用公开的 makeMove（会改全局 curHash），
   走完 curHash 就停在被重放局面的哈希上，引擎置换表会串味。
   这条容易在以后「顺手改成 makeMove」时悄悄退化，所以钉住。 */
{
  const scratch = XQ.parseBoard(XQ.START);
  let s = 'r';
  const seq = [];
  for (let i = 0; i < 20; i++) {
    const lm = XQ.legalMoves(scratch, s);
    seq.push([lm[0][0], lm[0][1]]);
    XQ.makeMove(scratch, lm[0]);
    s = XQ.other(s);
  }

  XQ.syncHash(XQ.parseBoard(XQ.START), 'r');
  const h0 = XQ.currentHash();
  XQ.adjudicate(XQ.START, seq);
  check('adjudicate 重放 20 手后，全局哈希原地不动（置换表不会串味）',
    XQ.currentHash() === h0, XQ.currentHash() + ' vs ' + h0);

  /* 对照组：证明上面那条不是空转 —— 直接用 makeMove 确实会把哈希推走 */
  const b2 = XQ.parseBoard(XQ.START);
  XQ.makeMove(b2, XQ.legalMoves(b2, 'r')[0]);
  check('（对照）直接用 makeMove 会把全局哈希推走 —— 所以上面那条有意义',
    XQ.currentHash() !== h0, XQ.currentHash() + ' vs ' + h0);
}

/* ============ 6. 没到终局就不该乱判 ============ */

check('空历史 → null', XQ.adjudicate(XQ.START, []) === null);
check('开局正常走几步 → null',
  XQ.adjudicate(XQ.START, [XQ.legalMoves(XQ.parseBoard(XQ.START), 'r')[0]]) === null);

console.log('\n=== ' + (ok ? '全部通过' : '存在失败项') + ' ===');
process.exit(ok ? 0 : 1);
