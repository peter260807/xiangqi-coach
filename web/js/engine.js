/* 中国象棋引擎 —— 走子规则 + 位置价值评估 + Alpha-Beta/置换表/静态搜索
 * 无 DOM 依赖，浏览器与 Node 均可加载。
 */
(function (root) {
  'use strict';

  var EMPTY = '.';
  var START = 'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR';
  var MATE = 200000;

  /* ---- LMR（后期着法缩减）：排在后面的安静着法先用浅一点的深度搜，
     分数够高再全深度重搜。一个节点里真正有希望的往往只有排序后的前几个着法，
     后面的安静着法绝大多数会被 alpha-beta 直接剪掉；用浅深度快速否掉它们，
     省下的时间换成深度。与空着裁剪并列的两大剪枝之一。

     三条保守约束：深度不够不启用；排序后的前 LMR_FULL_MOVES 个着法不缩减；
     被将军 / 吃子 / 将军着法都不缩减（它们往往是唯一的解，缩减会漏杀）。 */
  var LMR_MIN_DEPTH = 3;
  var LMR_FULL_MOVES = 3;

  /* 缩减量表：行 = 深度，列 = 着法序号（从 1 起）。
     r = 0.75 + ln(d)·ln(m) / 2.25（与主流引擎同一量级），取整后夹在 0…4。
     预计算成表是为了不在热点循环里调 Math.log —— 每个节点、每个着法都要查一次。 */
  var LMR_TABLE = (function () {
    var t = [];
    for (var d = 0; d < 64; d++) {
      var row = [];
      for (var m = 0; m < 64; m++) {
        if (d === 0 || m === 0) { row.push(0); continue; }
        var v = 0.75 + Math.log(d) * Math.log(m) / 2.25;
        row.push(Math.max(0, Math.min(4, Math.floor(v))));
      }
      t.push(row);
    }
    return t;
  })();

  /* ---- 空着裁剪（null move pruning）：先「放弃一手」试探，如果对手多走一步
     仍然够不到 beta，说明这个局面已经好到不必细算，直接按 beta 剪枝。
     放在着法生成**之前** —— 剪枝成功连着法都不用生成。 ---- */

  /* 低于这个深度不做：剪掉 2 层后几乎没得搜，反而失真 */
  var NULL_MOVE_MIN_DEPTH = 3;
  /* 空着之后缩减几层。用固定值而不是 `2 + depth/6` 那类自适应，是为了**便于归因**：
     出问题时只需怀疑一个参数，而不是两处联动 */
  var NULL_MOVE_R = 2;

  /* 归因开关（用环境变量控制，便于同一个文件跑所有变体）。
     剪枝都是**近似**，A/B 变差时必须能「只关一个」来定位是哪一项干的 ——
     否则每改一次都要重跑全套，时间全耗在换编译上。 */
  var HAS_ENV = (typeof process !== 'undefined' && !!process.env);
  /* 剪枝开关：**默认开启**（`XQ_NO_LMR` / `XQ_NO_NULL` 可关）。

     依据是一次只有环境变量之差的对局（同一个二进制，A 开剪枝 / B 关剪枝，
     两边都含长将修复）：40 局 **71.3% 得分率、Elo +158、区间 [+64,+251] 不含 0**，
     平均层数 +2.72（9.32 vs 6.60）。

     `XQ_LMR=1` / `XQ_NULL=1` 是显式「打开」，纯为兼容脚本 —— 脚本里写正向开关
     比依赖「默认是什么」更难出错（踩过：一键脚本的 full 分支漏设变量，
     于是与 safe 跑出完全一样的结果，而脚本照样报「完成」）。

     ⚠️ 2026-09-23 这里犯过一次大的：LMR 的「缩减后重搜」用的是零窗口
     （`(-alpha-1, -alpha)`）而不是全窗口，返回的只是下界却被当成精确分 ——
     同一批 40 局 A/B 从 **71.3% 掉到 47.5%**（Elo −17、区间跨 0），
     差一点把 LMR 判成「没用」。

     （浏览器里没有 process：剪枝开启、长将判负开启，与 iOS 侧默认一致。） */
  var LMR_ENABLED = !(HAS_ENV && process.env.XQ_NO_LMR);
  var NULL_MOVE_ENABLED = !(HAS_ENV && process.env.XQ_NO_NULL);
  var PERPETUAL_ENABLED = !(HAS_ENV && process.env.XQ_NO_PERPETUAL);
  /* 搜索窗口哨兵必须是有穷值：用 Infinity 会让空窗口退化成 (∞, ∞) 并污染置换表 */
  var INF = 1000000000;

  var DIR4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var HORSE = [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
               [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]];

  var PVAL = { K: 60000, R: 900, N: 400, C: 450, A: 200, B: 200, P: 100 };

  var NAMES = {
    K: '\u5e05', A: '\u4ed5', B: '\u76f8', N: '\u9a6c', R: '\u8f66', C: '\u70ae', P: '\u5175',
    k: '\u5c06', a: '\u58eb', b: '\u8c61', n: '\u9a6c', r: '\u8f66', c: '\u70ae', p: '\u5352'
  };

  /* ---------- 位置价值表（红方视角，第 0 行 = 对方底线；黑方按行镜像取用） ---------- */

  var PST = {
    P: [
      [  0,  0,  0,  0,  0,  0,  0,  0,  0],
      [  0,  0,  0,  0,  0,  0,  0,  0,  0],
      [ 35, 45, 55, 70, 80, 70, 55, 45, 35],
      [ 25, 35, 45, 60, 70, 60, 45, 35, 25],
      [ 15, 20, 28, 40, 48, 40, 28, 20, 15],
      [  6,  8, 10, 14, 18, 14, 10,  8,  6],
      [  0,  0,  0,  0,  0,  0,  0,  0,  0],
      [  0,  0,  0,  0,  0,  0,  0,  0,  0],
      [  0,  0,  0,  0,  0,  0,  0,  0,  0],
      [  0,  0,  0,  0,  0,  0,  0,  0,  0]
    ],
    N: [
      [  0, -4,  0,  0,  0,  0,  0, -4,  0],
      [  0,  2,  4,  6,  6,  6,  4,  2,  0],
      [  2,  6, 10, 12, 14, 12, 10,  6,  2],
      [  4,  8, 14, 18, 20, 18, 14,  8,  4],
      [  4, 10, 16, 22, 24, 22, 16, 10,  4],
      [  2,  8, 14, 20, 22, 20, 14,  8,  2],
      [  0,  6, 12, 16, 18, 16, 12,  6,  0],
      [  0,  4,  8, 10, 10, 10,  8,  4,  0],
      [  0,  0,  2,  4,  4,  4,  2,  0,  0],
      [ -6, -4,  0,  2,  2,  2,  0, -4, -6]
    ],
    C: [
      [  6,  4,  0, -6, -8, -6,  0,  4,  6],
      [  6,  6,  2,  2,  2,  2,  2,  6,  6],
      [  4,  6,  8, 10, 12, 10,  8,  6,  4],
      [  2,  4,  6,  8, 10,  8,  6,  4,  2],
      [  2,  4,  6,  8,  8,  8,  6,  4,  2],
      [  2,  4,  6,  8,  8,  8,  6,  4,  2],
      [  2,  4,  6,  8, 10,  8,  6,  4,  2],
      [  0,  2,  4,  6,  8,  6,  4,  2,  0],
      [  0,  0,  2,  4,  4,  4,  2,  0,  0],
      [  0,  0,  0,  0,  0,  0,  0,  0,  0]
    ],
    R: [
      [  8, 10, 10, 12, 12, 12, 10, 10,  8],
      [ 10, 12, 12, 14, 14, 14, 12, 12, 10],
      [  6,  8, 10, 12, 14, 12, 10,  8,  6],
      [  6,  8, 10, 12, 14, 12, 10,  8,  6],
      [  4,  6, 10, 12, 14, 12, 10,  6,  4],
      [  4,  6, 10, 12, 14, 12, 10,  6,  4],
      [  2,  6,  8, 10, 12, 10,  8,  6,  2],
      [  2,  4,  6,  8, 10,  8,  6,  4,  2],
      [  0,  2,  4,  6,  8,  6,  4,  2,  0],
      [  0,  0,  2,  4,  4,  4,  2,  0,  0]
    ]
  };

  /* ---------- 基础工具 ---------- */

  function isRed(p) { return p !== EMPTY && p >= 'A' && p <= 'Z'; }
  function sideOf(p) { return isRed(p) ? 'r' : 'b'; }
  function other(s) { return s === 'r' ? 'b' : 'r'; }
  function inB(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }
  function rowOf(i) { return (i / 9) | 0; }
  function colOf(i) { return i % 9; }
  function nameOf(p) { return NAMES[p] || '?'; }

  function parseBoard(str) {
    var rows = str.split('/');
    var b = new Array(90);
    for (var r = 0; r < 10; r++) {
      for (var c = 0; c < 9; c++) b[r * 9 + c] = rows[r][c];
    }
    return b;
  }

  function boardToString(b) {
    var out = [];
    for (var r = 0; r < 10; r++) out.push(b.slice(r * 9, r * 9 + 9).join(''));
    return out.join('/');
  }

  function cloneBoard(b) { return b.slice(); }

  /* ---------- 着法生成 ---------- */

  function genMoves(b, side) {
    var out = [];
    for (var i = 0; i < 90; i++) {
      var p = b[i];
      if (p === EMPTY) continue;
      if (sideOf(p) !== side) continue;

      var r = rowOf(i), c = colOf(i), up = p.toUpperCase();
      var red = side === 'r';

      if (up === 'K' || up === 'A') {
        var rMin = red ? 7 : 0, rMax = red ? 9 : 2;
        var dirs = up === 'K' ? DIR4 : DIAG;
        for (var d = 0; d < dirs.length; d++) {
          var nr = r + dirs[d][0], nc = c + dirs[d][1];
          if (nr < rMin || nr > rMax || nc < 3 || nc > 5) continue;
          var t = b[nr * 9 + nc];
          if (t !== EMPTY && sideOf(t) === side) continue;
          out.push([i, nr * 9 + nc]);
        }
      } else if (up === 'B') {
        var eMin = red ? 5 : 0, eMax = red ? 9 : 4;
        for (var d2 = 0; d2 < DIAG.length; d2++) {
          var nr2 = r + 2 * DIAG[d2][0], nc2 = c + 2 * DIAG[d2][1];
          if (nr2 < eMin || nr2 > eMax || nc2 < 0 || nc2 > 8) continue;
          if (b[(r + DIAG[d2][0]) * 9 + (c + DIAG[d2][1])] !== EMPTY) continue;
          var t2 = b[nr2 * 9 + nc2];
          if (t2 !== EMPTY && sideOf(t2) === side) continue;
          out.push([i, nr2 * 9 + nc2]);
        }
      } else if (up === 'N') {
        for (var h = 0; h < HORSE.length; h++) {
          var dr = HORSE[h][0], dc = HORSE[h][1];
          var nr3 = r + dr, nc3 = c + dc;
          if (!inB(nr3, nc3)) continue;
          if (b[(r + HORSE[h][2]) * 9 + (c + HORSE[h][3])] !== EMPTY) continue;
          var t3 = b[nr3 * 9 + nc3];
          if (t3 !== EMPTY && sideOf(t3) === side) continue;
          out.push([i, nr3 * 9 + nc3]);
        }
      } else if (up === 'R') {
        for (var d3 = 0; d3 < 4; d3++) {
          var ar = DIR4[d3][0], ac = DIR4[d3][1];
          var sr = r + ar, sc = c + ac;
          while (inB(sr, sc)) {
            var t4 = b[sr * 9 + sc];
            if (t4 === EMPTY) out.push([i, sr * 9 + sc]);
            else { if (sideOf(t4) !== side) out.push([i, sr * 9 + sc]); break; }
            sr += ar; sc += ac;
          }
        }
      } else if (up === 'C') {
        for (var d4 = 0; d4 < 4; d4++) {
          var br = DIR4[d4][0], bc = DIR4[d4][1];
          var tr = r + br, tc = c + bc, jumped = false;
          while (inB(tr, tc)) {
            var t5 = b[tr * 9 + tc];
            if (!jumped) {
              if (t5 === EMPTY) out.push([i, tr * 9 + tc]);
              else jumped = true;
            } else if (t5 !== EMPTY) {
              if (sideOf(t5) !== side) out.push([i, tr * 9 + tc]);
              break;
            }
            tr += br; tc += bc;
          }
        }
      } else if (up === 'P') {
        var fwd = red ? -1 : 1;
        var pr = r + fwd;
        if (inB(pr, c)) {
          var t6 = b[pr * 9 + c];
          if (t6 === EMPTY || sideOf(t6) !== side) out.push([i, pr * 9 + c]);
        }
        var crossed = red ? r <= 4 : r >= 5;
        if (crossed) {
          for (var k = -1; k <= 1; k += 2) {
            var pc = c + k;
            if (!inB(r, pc)) continue;
            var t7 = b[r * 9 + pc];
            if (t7 === EMPTY || sideOf(t7) !== side) out.push([i, r * 9 + pc]);
          }
        }
      }
    }
    return out;
  }

  function genCaptures(b, side, moves) {
    var src = moves || genMoves(b, side);
    var out = [];
    for (var i = 0; i < src.length; i++) if (b[src[i][1]] !== EMPTY) out.push(src[i]);
    return out;
  }

  /* ---------- 局面判定 ---------- */

  function findKing(b, side) { return b.indexOf(side === 'r' ? 'K' : 'k'); }

  function kingsFacing(b) {
    var kr = b.indexOf('K'), kb = b.indexOf('k');
    if (kr < 0 || kb < 0) return false;
    var cr = colOf(kr), cb = colOf(kb);
    if (cr !== cb) return false;
    var r1 = Math.min(rowOf(kr), rowOf(kb)), r2 = Math.max(rowOf(kr), rowOf(kb));
    for (var r = r1 + 1; r < r2; r++) if (b[r * 9 + cr] !== EMPTY) return false;
    return true;
  }

  function inCheck(b, side) {
    var ki = findKing(b, side);
    if (ki < 0) return true;
    var ms = genMoves(b, other(side));
    for (var i = 0; i < ms.length; i++) if (ms[i][1] === ki) return true;
    return false;
  }

  /* ---------- Zobrist 哈希 ---------- */

  var PIECES = 'KABNRCPkabnrcp';
  var PI = {};
  for (var pi = 0; pi < PIECES.length; pi++) PI[PIECES[pi]] = pi;

  var zob = [], zseed = 0x9e3779b9;
  function zrnd() {
    zseed ^= zseed << 13; zseed >>>= 0;
    zseed ^= zseed >>> 17;
    zseed ^= zseed << 5;  zseed >>>= 0;
    return zseed;
  }
  for (var zi = 0; zi < PIECES.length; zi++) {
    var zrow = [];
    for (var zj = 0; zj < 90; zj++) zrow.push(zrnd());
    zob.push(zrow);
  }
  var ZSIDE = zrnd();

  var curHash = 0;

  function computeHash(b, side) {
    var h = 0;
    for (var i = 0; i < 90; i++) {
      var p = b[i];
      if (p !== EMPTY) h ^= zob[PI[p]][i];
    }
    if (side === 'b') h ^= ZSIDE;
    return h;
  }

  /* 把全局哈希重新对齐到指定局面。
     外部调用者（界面、棋谱分析）在跨模块搜索之后调一次，可确保
     makeMove 的增量哈希始终与真实局面一致，避免置换表串味。 */
  function syncHash(b, side) {
    curHash = computeHash(b, side);
    return curHash;
  }

  function makeMove(b, m) {
    var p = b[m[0]], cap = b[m[1]];
    if (cap !== EMPTY) curHash ^= zob[PI[cap]][m[1]];
    curHash ^= zob[PI[p]][m[0]] ^ zob[PI[p]][m[1]];
    curHash ^= ZSIDE;
    b[m[1]] = p;
    b[m[0]] = EMPTY;
    return cap;
  }

  function undoMove(b, m, cap) {
    var p = b[m[1]];
    b[m[0]] = p;
    b[m[1]] = cap;
    curHash ^= ZSIDE;
    curHash ^= zob[PI[p]][m[0]] ^ zob[PI[p]][m[1]];
    if (cap !== EMPTY) curHash ^= zob[PI[cap]][m[1]];
  }

  function legalMoves(b, side) {
    var pseudo = genMoves(b, side);
    var h0 = curHash;
    var res = [];
    for (var i = 0; i < pseudo.length; i++) {
      var m = pseudo[i];
      var cap = makeMove(b, m);
      if (!inCheck(b, side) && !kingsFacing(b)) res.push(m);
      undoMove(b, m, cap);
    }
    curHash = h0;
    return res;
  }

  function hasLegalMove(b, side) {
    var pseudo = genMoves(b, side);
    var h0 = curHash;
    for (var i = 0; i < pseudo.length; i++) {
      var cap = makeMove(b, pseudo[i]);
      var ok = !inCheck(b, side) && !kingsFacing(b);
      undoMove(b, pseudo[i], cap);
      if (ok) { curHash = h0; return true; }
    }
    curHash = h0;
    return false;
  }

  /* ---------- 局面评估（红方视角，单位：厘兵） ---------- */

  function evaluate(b) {
    var s = 0;
    for (var i = 0; i < 90; i++) {
      var p = b[i];
      if (p === EMPTY) continue;
      var red = isRed(p), up = p.toUpperCase();
      var v = PVAL[up];
      if (up === 'P' || up === 'N' || up === 'C' || up === 'R') {
        v += PST[up][red ? rowOf(i) : 9 - rowOf(i)][colOf(i)];
      }
      s += red ? v : -v;
    }
    return s;
  }

  /* ---------- 搜索 ---------- */

  var TIMEOUT = { timeout: true };
  var nodes = 0, deadline = 0, qnodes = 0;
  var tt = new Map();
  var TT_MAX = 400000;
  var MAX_PLY = 64;
  var killers = [], hist = new Int32Array(90 * 90);
  for (var kp = 0; kp < MAX_PLY; kp++) killers.push([null, null]);

  var TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

  function resetSearch() {
    nodes = 0; qnodes = 0; seeCalls = 0;
    tt.clear();
    killers = [];
    for (var i = 0; i < MAX_PLY; i++) killers.push([null, null]);
    hist = new Int32Array(90 * 90);
  }

  function eqMove(a, m) { return !!a && a[0] === m[0] && a[1] === m[1]; }

  /* ---------- 静态交换评估（SEE）：吃子到底赚不赚 ----------
   *
   * 原来的吃子排序分只有 `PVAL[cap] * 16 - PVAL[attacker]`，它只知道「吃到的东西值多少」，
   * 完全不知道**目标格有没有人守**。于是「车吃兵、立刻被兵吃回来」排在所有安静着法前面 ——
   * 这种着法每个节点都要展开一整棵子树才算得出「亏了 800」，白烧一大半节点。
   *
   * SEE 就是把这个交换序列**静态地**算一遍：双方轮流用最便宜的子去吃，得到一个净收益。
   * 正数 = 赚，0 = 平换，负数 = 亏本吃（降到安静着法之后）。
   *
   * 算法（自己推的，因为查到的几个版本索引记不牢、容易写错）：
   *   设 U = [u1, u2, …, un] 为每一步「进攻方用的那颗子」的价值（u1 = 走子方的子）。
   *   第 k 步**吃到**的东西价值 G[k]：G[1] = 被吃子的价值，G[k] = u(k-1)。
   *   记 f(k) = 第 k 步进攻方的净收益，则
   *       f(n) = G[n]（再没人能吃回去了）
   *       f(k) = G[k] - max(0, f(k+1))     ← 对方可以选择不吃（停了对他更亏就不吃）
   *   答案就是 f(1)。
   *
   * 例（可当单元测试）：车(900)吃兵(100)、被兵吃回来
   *   U = [900, 100]，G = [100, 900]；f(2)=900，f(1)=100-900 = **-800** ✓
   * 例：兵(100)吃车(900)、没人吃回来 → U=[100]，G=[900]，f(1)=900 ✓
   * 例：车(900)吃车(900)、被兵吃回来 → U=[900,100]，G=[900,900]，f(1)=900-900 = **0** ✓
   */

  /**
   * `side` 方攻击 sq 上那颗子的**最便宜**的子。
   *
   * 必须是「找最小」而不是「列全部」—— SEE 交换序列的每一步都要调一次，
   * 列全部再排序会把调用成本放大好几倍。
   * 按价值从低到高依次试：兵 100 → 士/象 200 → 马 400 → 炮 450 → 车 900。
   *
   * ⚠️ **不算将/帅**（60000 那一档）。理由见函数末尾的说明 ——
   * 这不是省事，是实测出来的：算上它 SEE 会把正常吃子算成巨亏，让搜索反而变慢。
   */
  function leastAttacker(b, sq, side) {
    var r = rowOf(sq), c = colOf(sq);
    var red = side === 'r';
    var i;

    /* 兵/卒（100） */
    var pc = red ? 'P' : 'p';
    var fwd = red ? r + 1 : r - 1;
    if (fwd >= 0 && fwd < 10 && b[fwd * 9 + c] === pc) return { from: fwd * 9 + c, value: 100 };
    /* 横着吃的兵必须已过河：红兵过河 = 行 ≤ 4，黑卒过河 = 行 ≥ 5 */
    if (red ? r <= 4 : r >= 5) {
      if (c > 0 && b[r * 9 + c - 1] === pc) return { from: r * 9 + c - 1, value: 100 };
      if (c < 8 && b[r * 9 + c + 1] === pc) return { from: r * 9 + c + 1, value: 100 };
    }

    /* 士（200）：斜一步，且必须在本方九宫内 */
    var ac = red ? 'A' : 'a';
    for (i = 0; i < 4; i++) {
      var ar = r + DIAG[i][0], acl = c + DIAG[i][1];
      if (ar < 0 || ar > 9 || acl < 3 || acl > 5) continue;
      if (red ? (ar < 7 || ar > 9) : (ar > 2)) continue;
      if (b[ar * 9 + acl] === ac) return { from: ar * 9 + acl, value: 200 };
    }

    /* 象（200）：斜两步，象眼要空，且不过河 */
    var bc = red ? 'B' : 'b';
    for (i = 0; i < 4; i++) {
      var br = r + 2 * DIAG[i][0], bcl = c + 2 * DIAG[i][1];
      if (br < 0 || br > 9 || bcl < 0 || bcl > 8) continue;
      if (red ? br < 5 : br > 4) continue;
      if (b[br * 9 + bcl] !== bc) continue;
      if (b[(r + DIAG[i][0]) * 9 + (c + DIAG[i][1])] !== EMPTY) continue;
      return { from: br * 9 + bcl, value: 200 };
    }

    /* 马（400）：HORSE 表是「从马出发」的偏移，攻击 sq 的马在 (r-dr, c-dc)，腿相对马算 */
    var nc = red ? 'N' : 'n';
    for (i = 0; i < HORSE.length; i++) {
      var hr = r - HORSE[i][0], hc = c - HORSE[i][1];
      if (hr < 0 || hr > 9 || hc < 0 || hc > 8) continue;
      if (b[hr * 9 + hc] !== nc) continue;
      var lr = hr + HORSE[i][2], lc = hc + HORSE[i][3];
      if (lr < 0 || lr > 9 || lc < 0 || lc > 8) continue;
      if (b[lr * 9 + lc] !== EMPTY) continue;
      return { from: hr * 9 + hc, value: 400 };
    }

    /* 炮（450）：必须正好隔一个炮架（第一个碰到的子当架，再碰到的才是炮） */
    var cc = red ? 'C' : 'c';
    for (i = 0; i < 4; i++) {
      var dr = DIR4[i][0], dc = DIR4[i][1];
      var tr = r + dr, tc = c + dc, screen = false;
      while (tr >= 0 && tr < 10 && tc >= 0 && tc < 9) {
        var t = b[tr * 9 + tc];
        if (!screen) { if (t !== EMPTY) screen = true; }
        else if (t !== EMPTY) {
          if (t === cc) return { from: tr * 9 + tc, value: 450 };
          break;
        }
        tr += dr; tc += dc;
      }
    }

    /* 车（900）：四个方向碰到的第一个子 */
    var rc = red ? 'R' : 'r';
    for (i = 0; i < 4; i++) {
      var dr2 = DIR4[i][0], dc2 = DIR4[i][1];
      var ur = r + dr2, uc = c + dc2;
      while (ur >= 0 && ur < 10 && uc >= 0 && uc < 9) {
        var u = b[ur * 9 + uc];
        if (u !== EMPTY) {
          if (u === rc) return { from: ur * 9 + uc, value: 900 };
          break;
        }
        ur += dr2; uc += dc2;
      }
    }

    /* ⚠️ 这里**故意**不把将/帅算作攻击者（原来有一段返回 60000 的代码）。
       将的「吃回」在象棋里经常是**非法**的：那个格子被自己人挡着时将在原地就违规，
       或者格子另外被别的子守住。SEE 不知道这些，于是把很多正常吃子算成 -60000 级的
       巨亏、再降到所有安静着法之后 —— 实测算上将/帅时 SEE 反而比不改还慢。

       注：本函数返回的是**最便宜**的攻击者，所以将只有在「它是唯一攻击者」时才会被返回；
       但那种局面（在敌将旁边吃子）恰恰很常见，这一条有实际影响。

       Swift 侧 `Search.leastAttacker` 也是这么做的 —— 两端必须同一套算法。 */
    return null;
  }

  /**
   * 走 `from → to` 这一手吃子的 SEE 净收益（见上面推导）。
   *
   * ⚠️ 它会**就地改棋盘**再原样改回来。传进来的 `b` 是搜索正在用的那块盘面
   * （不是副本），所以还原必须逐格精确 —— 漏一格，搜索就会算到一盘不存在的棋，
   * 而且**不会报错**，只会让结果变得莫名其妙。用「记录被改动的格子 + 原值」
   * 的办法还原，改动通常不到 20 格。
   */
  function seeCapture(b, from, to, side) {
    var victim = b[to];
    if (victim === EMPTY) return 0;

    var savedIdx = [], savedPc = [];
    function put(idx, p) { savedIdx.push(idx); savedPc.push(b[idx]); b[idx] = p; }

    var u = [PVAL[b[from].toUpperCase()]];
    put(to, b[from]);
    put(from, EMPTY);

    var cur = other(side), guard = 0;
    while (guard++ < 24) {
      var att = leastAttacker(b, to, cur);
      if (!att) break;
      u.push(att.value);
      put(to, b[att.from]);
      put(att.from, EMPTY);
      cur = other(cur);
    }

    /* G = [被吃子的价值, u1, …, u(n-1)]，从尾部往前取 max(0, ·) */
    var val = 0;
    for (var k = u.length - 2; k >= 0; k--) val = u[k] - Math.max(0, val);
    val = PVAL[victim.toUpperCase()] - Math.max(0, val);

    for (var s = savedIdx.length - 1; s >= 0; s--) b[savedIdx[s]] = savedPc[s];
    return val;
  }

  /* ---------- 安静着法用的静态棋理 ----------
   *
   * 原来安静着法的兜底分只有历史表，而历史表在**开局**攒不出区分度
   * （局面高度对称、评估分数大量并列）→ 排序退化成近似随机 → alpha-beta 剪枝率崩掉。
   * 实测这就是「同样 32 个棋子，开局 8 层要 2833 万节点、中局只要 343 万」的根因。
   *
   * 这里只用**位置价值表增量**：走完之后这颗子在位置表上值多少、原来值多少，取差值。
   * 别小看它 —— 位置表本身已经把「过河兵推进」「马往前跳」「车占好线」都编码进去了，
   * 所以这一个差值就同时覆盖了这几条，成本只有两次查表（几十纳秒）。
   *
   * 注意方向：位置表是红方视角（行 0 = 对方底线），黑方的行要镜像。
   * 但**不需要**按颜色翻符号 —— 因为镜像之后，「红兵前进」和「黑卒前进」都会让
   * 同一个索引变小、分值变大，所以「增量 > 0」对两边都等于「这颗子变好了」。
   */
  var PST_W = 8;

  function pstDelta(b, from, to) {
    var p = b[from];
    var up = p.toUpperCase();
    var pst = PST[up];
    if (!pst) return 0;
    var red = isRed(p);
    return (pst[red ? rowOf(to) : 9 - rowOf(to)][colOf(to)]
          - pst[red ? rowOf(from) : 9 - rowOf(from)][colOf(from)]) * PST_W;
  }

  /* ---------- 着法排序：四层 ----------
   *
   *   TT 着法                                 100,000,000
   *   好/等吃子（SEE ≥ 0）                     20,000,000 + MVV-LVA
   *   杀手着法 1 / 2                          15,000,000 / 14,000,000
   *   安静着法                                10,000,000 + 位置表增量 + 历史
   *   亏本吃（SEE < 0）                        1,000,000 + SEE
   *
   * 两条纪律：
   *   1. **亏本吃必须降到安静着法之后。** 它的价值是负的，排在前面只会让每个节点
   *      都白展开一整棵子树去证明「果然亏了」。
   *   2. **SEE 只在「可能亏」的时候算。** 被吃子比吃子方的子更值钱时（吃大子 / 平换），
   *      即使被吃回来也不亏，MVV-LVA 就够了 —— 这一条把 SEE 的调用次数砍掉大半，
   *      因为 SEE 里每一步都要做一次射线扫描，它比排序里其它任何一项都贵。
   */
  var SCORE_TT = 100000000;
  var SCORE_GOOD_CAP = 20000000;
  var SCORE_KILLER1 = 15000000;
  var SCORE_KILLER2 = 14000000;
  var SCORE_QUIET = 10000000;
  var SCORE_BAD_CAP = 1000000;
  /* 历史分数的上限。历史表靠「同一着法反复造成截断」累积，深度平方增长；
     不封顶的话它会盖掉位置表增量，等于把这次补的静态棋理全废掉。 */
  var HIST_CAP = 4096;

  /* SEE 只在 **ply ≤ 这个值** 的时候算（浅层），理由与 Swift 侧 `Engine.seeMaxPly` 完全一致：
     整棵树都算 SEE 时，开局节点省 16%，但中局（吃子多、射线扫描贵）每千节点/秒掉 19%，
     而中局节点只省 5% —— 固定时间下反而更浅（实测 150 个随机局面，改动前多搜到一层 14:3）。
     限制到浅 4 层能保住 SEE 大部分好处（开局节点 78.2% vs 整棵树 77.0%），砍掉深层的代价。 */
  var SEE_MAX_PLY = 4;

  var seeCalls = 0;   /* 自证用：SEE 到底被调了多少次（为 0 就说明门控把步子迈没了） */
  /* 上一次搜索是不是「空着」。**连续两次空着没有意义**（等于双方各放弃一手、
     局面回到原样），而且会一直递归下去 —— 所以空着之后必须禁用一次。 */
  var nullMoveOk = true;

  function orderMoves(b, moves, ply, ttMove) {
    var k = killers[ply] || [null, null];
    var out = [];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i], s;
      var cap = b[m[1]];
      if (eqMove(ttMove, m)) {
        s = SCORE_TT;
      } else if (cap !== EMPTY) {
        var capVal = PVAL[cap.toUpperCase()];
        var attVal = PVAL[b[m[0]].toUpperCase()];
        var mvv = capVal * 16 - attVal;
        if (capVal >= attVal || ply > SEE_MAX_PLY) {
          /* 吃大子 / 平换：再差也不会亏，不必花 SEE。
             深于 SEE_MAX_PLY 的节点也走这一支（理由见 SEE_MAX_PLY 的注释） */
          s = SCORE_GOOD_CAP + mvv;
        } else {
          seeCalls++;
          var see = seeCapture(b, m[0], m[1], sideOf(b[m[0]]));
          s = see >= 0 ? SCORE_GOOD_CAP + mvv : SCORE_BAD_CAP + see;
        }
      } else if (eqMove(k[0], m)) {
        s = SCORE_KILLER1;
      } else if (eqMove(k[1], m)) {
        s = SCORE_KILLER2;
      } else {
        var hv = hist[m[0] * 90 + m[1]];
        s = SCORE_QUIET + pstDelta(b, m[0], m[1]) + (hv > HIST_CAP ? HIST_CAP : hv);
      }
      out.push([s, m]);
    }
    out.sort(function (x, y) { return y[0] - x[0]; });
    var res = [];
    for (var j = 0; j < out.length; j++) res.push(out[j][1]);
    return res;
  }

  function checkTime() {
    if ((++nodes & 255) === 0 && Date.now() > deadline) throw TIMEOUT;
  }

  /* ---------- 重复局面：搜索里的「和棋意识」 ----------

     没有它的时候，引擎不知道自己在绕圈。P2-1 之前实测：20 局自对弈有 9 局（45%）
     以三次重复告终 —— 对局层现在会兜住（判和 / 判长将负），但那是**用户看不到**的
     兜底；引擎自己仍然会把「循环」当成普通局面继续走，**一盘赢棋被自己走成和棋**。

     加上它之后：回到路径上出现过的局面 = 0 分（和棋）。于是优势方会主动躲开循环，
     劣势方会主动去找循环 —— 后者正是我们希望的（和棋好过输棋）。

     路径栈要分「段」：吃子、走兵之后，之前的局面**不可能**再出现（兵只进不退），
     所以判定只在「当前段」内做，遇到不可逆着法就把计数表清空。

     计数表用 Map 而不是线性回溯：每个节点只做一次 O(1) 的查表，
     否则安静残局里一段能有上百手，每层往回扫一遍会把搜索拖慢。 */

  /* 当前段上的局面 { h, fresh, mover, check }，栈顶 = 当前局面。
     mover/check 记的是「走到这个局面的那一手」的走子方与是否将军 —— 带它们是为了
     在重复发生时能构造出循环体交给 perpetualChecker，把**长将判负**也搬进搜索。
     否则搜索只认「重复 = 和棋」，会主动走进长将循环捞半分，到对局层却被判负。
     栈底那项（段的起点）的 mover/check 没有意义，不会被读。 */
  var repStack = [];
  var repCount = new Map();   /* 段内每个局面哈希出现过几次 */
  var repSaved = [];     /* 遇到新的不可逆段时，把上一段的计数表暂存到这里 */

  /** 这一手之后，之前的局面还有可能重现吗？吃子 / 兵走子 → 不可能 */
  function repIsIrreversible(piece, cap) {
    return cap !== EMPTY || piece === 'P' || piece === 'p';
  }

  /**
   * 这个局面「子力够不够做空着裁剪」。
   *
   * 残局必须禁用：象棋残局里「放弃一手」常常反而变好（zugzwang，
   * 车兵 / 马兵残局尤其明显），拿它去剪枝会把赢棋判成输棋。
   *
   * 判据刻意收得保守：只有本方**还有车 / 炮 / 马**才算子力足够。士象不参与进攻，
   * 「士象全 对 无子」通常也是和棋 —— 把它们算进来会让本该禁用的局面误开空着裁剪。
   *
   * 只在 depth >= NULL_MOVE_MIN_DEPTH 时调用；找到第一个子就返回。
   */
  function hasNonPawnMaterial(b, side) {
    var wantRed = (side === 'r');
    for (var i = 0; i < 90; i++) {
      var p = b[i];
      if (p === EMPTY) continue;
      if (isRed(p) !== wantRed) continue;
      if (p === 'R' || p === 'N' || p === 'C'
          || p === 'r' || p === 'n' || p === 'c') return true;
    }
    return false;
  }

  /**
   * 把「从开局到当前局面」的着法重放一遍，得到搜索根之前的历史路径。
   * 只用局部棋盘 + computeHash，**绝不碰全局 curHash** —— 理由同 applyRaw：
   * 搜索外的旁观者一旦挪动 curHash，引擎置换表就串味了。
   */
  function repContext(startFen, moves, startSide) {
    var b = parseBoard(startFen || START);
    var side = startSide || 'r';
    var keys = [computeHash(b, side)], segs = [0], segStart = 0;
    /* 与 keys 同下标：走到 keys[i] 的那一手的（走子方, 是否将军）。
       下标 0 是起始局面，没有「走到它的那一手」，填占位值（不会被读）。 */
    var infos = [['r', false]];
    for (var i = 0; i < (moves || []).length; i++) {
      var m = moves[i];
      var mover = side;
      var irrev = repIsIrreversible(b[m[0]], b[m[1]]);
      applyRaw(b, m);
      side = other(side);
      if (irrev) segStart = keys.length;
      keys.push(computeHash(b, side));
      /* 走完这一手后 side 已经是对方，「对方被将」就等于「这一手是将军」 */
      infos.push([mover, inCheck(b, side)]);
      segs.push(segStart);
    }
    return { keys: keys, segs: segs, infos: infos };
  }

  /** 走子之后把新局面压进路径栈 —— 必须在 makeMove **之后**调用（要读新局面的哈希）。
      `mover` 是刚落子的那一方（此时走子权已经交给它的对手）。 */
  function repPush(b, m, cap, mover) {
    var fresh = repIsIrreversible(b[m[1]], cap);
    if (fresh) { repSaved.push(repCount); repCount = new Map(); }
    /* 走完后轮到对手 —— 对手被将，就等于这一手是将军。
       顺手返回它给 LMR 用，省得再算一次 inCheck（每个节点都要跑）。 */
    var givesCheck = inCheck(b, other(mover));
    repStack.push({ h: curHash, fresh: fresh, mover: mover, check: givesCheck });
    repCount.set(curHash, (repCount.get(curHash) || 0) + 1);
    return givesCheck;
  }

  function repPop() {
    var e = repStack.pop();
    var c = repCount.get(e.h) - 1;
    if (c <= 0) repCount.delete(e.h); else repCount.set(e.h, c);
    if (e.fresh) repCount = repSaved.pop();
  }

  /**
   * 当前局面在本段路径上出现过 → 按和棋算（0 分）。
   *
   * 注意这里是**两次重复**就判和，比正式的「三次重复」保守一层。这是引擎的通用做法：
   * 搜索里要防的是「双方都愿意重复」导致的无限循环，宁可早判；判早了只会让优势方
   * 更主动地躲开循环，不会把赢棋判成和棋。对局层仍然是三次重复才判（P2-1），
   * **两处不一致是刻意的**。
   */
  function repIsDraw() {
    return repStack.length > 1 && repCount.get(curHash) > 1;
  }

  /**
   * 当前局面重复了 —— 那这是「长将循环」吗？
   *
   * 返回长将的一方（**该方判负**）；null 表示普通重复，按和棋算。
   *
   * 判据与对局层的 adjudicate 用的是**同一个** perpetualChecker：只取出
   * 「上次出现当前局面 → 现在」这一段的着法（走子方 + 是否将军）交给它，
   * 由它去认谁在长将。这样搜索和裁判对长将的看法终于一致 —— 从前搜索只认
   * 「重复 = 0 分」，优势方就会主动走进长将循环捞半分，到对局层却被判负
   * （两批 A/B 各有 2 局栽在这上面，是结构性的）。
   *
   * 搜索仍然是**两次重复**就介入（对局层是三次），这个不一致刻意保留：
   * 防的是「双方都愿意重复」导致的无限循环，宁可早判。
   */
  function repPerpetualLoser() {
    if (repStack.length <= 1) return null;
    /* 栈顶（下标 length-1）就是当前局面，从它下面一个位置往前找「上一次出现」 */
    var prev = -1;
    for (var i = repStack.length - 2; i >= 0; i--) {
      if (repStack[i].h === curHash) { prev = i; break; }
    }
    if (prev < 0 || prev + 1 >= repStack.length) return null;
    var cycle = [];
    for (var k = prev + 1; k < repStack.length; k++) {
      cycle.push({ side: repStack[k].mover, check: repStack[k].check });
    }
    if (!cycle.length) return null;
    return perpetualChecker(cycle);
  }

  /**
   * 把「根节点 + 它之前的棋局历史」装进路径栈。
   *
   * history 可以写成两种：
   *   - 一串着法（`[[from,to], …]`）—— 从标准开局摆起来的情况，App 与对局台走这条；
   *   - `{fen, moves, side}` —— 棋局不是从标准开局开始的（界面里载入的局面、
   *     测试里的合成局面），必须给出起始局面，否则历史会被按标准开局重放，全是错的。
   */
  function repInit(history) {
    var fen = START, moves = null, startSide = 'r';
    if (Array.isArray(history)) moves = history;
    else if (history) {
      fen = history.fen || START;
      moves = history.moves || [];
      startSide = history.side || 'r';
    }
    if (!moves || !moves.length) {
      repStack = [{ h: curHash, fresh: false, mover: 'r', check: false }];
      repCount = new Map();
      repCount.set(curHash, 1);
      repSaved = [];
      return;
    }
    var ctx = repContext(fen, moves, startSide);
    /* 以真实棋盘为准：万一调用方给的着法历史和棋盘不是同一路棋，也不至于引入假重复 */
    ctx.keys[ctx.keys.length - 1] = curHash;
    /* 只把「最后一个不可逆段」里的局面装进计数表 —— 更早的局面不可能重现了 */
    var from = ctx.segs[ctx.segs.length - 1] || 0;
    repStack = [];
    repCount = new Map();
    repSaved = [];
    for (var i = from; i < ctx.keys.length; i++) {
      var info = ctx.infos[i] || ['r', false];
      repStack.push({ h: ctx.keys[i], fresh: i === from,
                      mover: info[0], check: info[1] });
      repCount.set(ctx.keys[i], (repCount.get(ctx.keys[i]) || 0) + 1);
    }
    /* 根节点不是被 repPush 压进去的，它不需要在下一次 pop 时还原计数表 */
    if (repStack.length) repStack[0].fresh = false;
  }

  /* 静态搜索：只搜吃子，消除水平线效应 */
  function quiesce(b, side, alpha, beta, ply, qd) {
    checkTime();
    qnodes++;
    var sign = side === 'r' ? 1 : -1;
    var stand = sign * evaluate(b);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qd <= 0) return alpha;

    var caps = orderMoves(b, genCaptures(b, side), Math.min(ply, MAX_PLY - 1), null);
    var best = stand;
    for (var i = 0; i < caps.length; i++) {
      var m = caps[i];
      var cap = makeMove(b, m);
      if (inCheck(b, side) || kingsFacing(b)) { undoMove(b, m, cap); continue; }
      var sc = -quiesce(b, other(side), -beta, -alpha, ply + 1, qd - 1);
      undoMove(b, m, cap);
      if (sc > best) best = sc;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(b, side, depth, alpha, beta, ply) {
    checkTime();

    /* 重复局面必须在置换表**之前**判。0 分是「相对路径」的结论 —— 同一个局面
       从别的路径搜过来并不等于和棋，把它当普通评分存进置换表会污染后续搜索。
       也因为要提前返回，这里天然不会把评分写进表里。 */
    if (ply > 0 && repIsDraw()) {
      /* 先问一句「这是不是长将循环」：是的话长将方判负（给绝杀分，按 ply 递减，
         与「无合法着法」用的是同一套表示），而不是判和。 */
      if (PERPETUAL_ENABLED) {
        var repLoser = repPerpetualLoser();
        if (repLoser) return repLoser === side ? -MATE + ply : MATE - ply;
      }
      return 0;
    }

    var alphaOrig = alpha;
    var plyKey = Math.min(ply, MAX_PLY - 1);
    var ttMove = null;
    var h = curHash;

    var hit = tt.get(h);
    if (hit) {
      ttMove = hit.move;
      if (hit.depth >= depth && ply > 0) {
        var hs = hit.score;
        if (hs > MATE - 1000) hs -= ply;
        else if (hs < -MATE + 1000) hs += ply;
        if (hit.flag === TT_EXACT) return hs;
        if (hit.flag === TT_LOWER && hs >= beta) return hs;
        if (hit.flag === TT_UPPER && hs <= alpha) return hs;
      }
    }

    if (depth <= 0) return quiesce(b, side, alpha, beta, ply, 8);

    /* 空着裁剪和 LMR 都要知道「当前节点是否被将军」，合起来只算一次。
       只在深度够时才付这笔钱 —— inCheck 要扫全盘找将。 */
    var needInCheck = depth >= Math.min(NULL_MOVE_MIN_DEPTH, LMR_MIN_DEPTH);
    var inCheckNow = needInCheck ? inCheck(b, side) : false;

    /* 空着裁剪：先「放弃一手」试探。如果对手**多走一步**仍然够不到 beta，
       说明这个局面已经好到不必细算 —— 直接按 beta 剪枝。
       放在着法生成**之前**：剪枝成功连着法都不用生成。

       三个前提缺一不可：① 不被将军（被将时每一步都可能是唯一的解）
       ② 上一次不是空着（连续空着等于双方都放弃一手，会无限递归）
       ③ 子力足够（残局的 zugzwang 会让「放弃一手」反而变好） */
    if (NULL_MOVE_ENABLED && depth >= NULL_MOVE_MIN_DEPTH && nullMoveOk
        && !inCheckNow && hasNonPawnMaterial(b, side)) {
      /* 缩减后**至少留 1 层**，剩下的交给静态搜索兜底。
         ⚠️ 原来这里写的是 `depth - 1 - NULL_MOVE_R > 0`，那个条件在「搜索深度 4」
         这类常见场景下永远不会成立 —— negamax 拿到的 depth 最大只有 maxDepth-1 = 3，
         而 3-1-2 = 0 不 > 0，于是空着裁剪**静默失效**（节点数一个没少才发现）。
         「深度够不够」的判据只留一处（上面的 MIN_DEPTH），别再叠加更严的守卫。 */
      var nmDepth = depth - 1 - NULL_MOVE_R;
      if (nmDepth < 1) nmDepth = 1;
      /* 空着：棋盘不动，只把走子权交给对方 —— 哈希里的走子方项要跟着翻 */
      curHash ^= ZSIDE;
      nullMoveOk = false;
      var nmScore = -negamax(b, other(side), nmDepth, -beta, -beta + 1, ply + 1);
      nullMoveOk = true;
      curHash ^= ZSIDE;
      if (nmScore >= beta) {
        /* 不写置换表：这是「少算了一层」的结论，当普通评分存进去会污染搜索 */
        return beta;
      }
    }

    var opp = other(side);
    var moves = orderMoves(b, genMoves(b, side), plyKey, ttMove);
    var best = -INF, bestMove = null, anyLegal = false, searchedOne = false;
    /* 已搜索过的合法着法数（不是循环下标 —— 非法着法被 continue 跳过，
       用下标会让缩减判断偏早） */
    var moveIdx = 0;

    /* LMR 的两个前提：深度够、着法够多（浅节点上不值得这么做） */
    var lmrPossible = LMR_ENABLED
      && depth >= LMR_MIN_DEPTH && moves.length > LMR_FULL_MOVES;
    /* inCheckNow 已在上面（空着裁剪那一段）算过，这里直接复用，不重复付钱 */

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var cap = makeMove(b, m);
      if (inCheck(b, side) || kingsFacing(b)) { undoMove(b, m, cap); continue; }
      anyLegal = true;
      var givesCheck = repPush(b, m, cap, side);

      /* LMR：只缩减「排序靠后的安静着法」。吃子、将军、被将军三类都不缩减 ——
         它们往往是唯一的解，缩减会把正确着法漏掉（宁可少省一点时间）。 */
      var reduced = 0;
      if (lmrPossible && moveIdx >= LMR_FULL_MOVES && cap === EMPTY
          && !inCheckNow && !givesCheck) {
        reduced = LMR_TABLE[Math.min(depth, 63)][Math.min(moveIdx + 1, 63)];
        /* 缩减后至少要留 1 层可搜，否则等于不搜 */
        var maxR = Math.max(0, depth - 2);
        if (reduced > maxR) reduced = maxR;
      }

      var sc;
      if (!searchedOne) {
        /* 首着必须用全窗口：此时 alpha 可能仍是 -INF，空窗口会算错 */
        sc = -negamax(b, opp, depth - 1, -beta, -alpha, ply + 1);
      } else if (reduced > 0) {
        /* 先用缩减深度 + 零窗口试探，够好再按全深度重搜。
           ⚠️ 重搜是**两步**，和下面 PVS 分支一致：先零窗口确认它确实超过 alpha，
           再开全窗口取精确值。只做第一步会漏掉落在 (alpha, beta) 区间里的精确值 ——
           那个值要写进置换表、也会成为 PV，不精确会顺着树往上放大。 */
        sc = -negamax(b, opp, depth - 1 - reduced, -alpha - 1, -alpha, ply + 1);
        if (sc > alpha) {
          sc = -negamax(b, opp, depth - 1, -alpha - 1, -alpha, ply + 1);
          if (sc > alpha && sc < beta) {
            sc = -negamax(b, opp, depth - 1, -beta, -alpha, ply + 1);
          }
        }
      } else {
        sc = -negamax(b, opp, depth - 1, -alpha - 1, -alpha, ply + 1);
        if (sc > alpha && sc < beta) sc = -negamax(b, opp, depth - 1, -beta, -alpha, ply + 1);
      }
      searchedOne = true;
      moveIdx++;
      repPop();
      undoMove(b, m, cap);

      if (sc > best) { best = sc; bestMove = m; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (cap === EMPTY) {
          var kk = killers[plyKey];
          if (!eqMove(kk[0], m)) { kk[1] = kk[0]; kk[0] = m; }
          hist[m[0] * 90 + m[1]] += depth * depth;
        }
        break;
      }
    }

    if (!anyLegal) return -MATE + ply;

    var store = best;
    if (store > MATE - 1000) store += ply;
    else if (store < -MATE + 1000) store -= ply;
    var flag = best <= alphaOrig ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
    if (best > -INF && tt.size < TT_MAX) tt.set(h, { depth: depth, score: store, flag: flag, move: bestMove });

    return best;
  }

  function rootMoves(b, side, excluded) {
    var ms = orderMoves(b, genMoves(b, side), 0, null);
    var h0 = curHash;
    var res = [];
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i], skip = false;
      for (var e = 0; e < excluded.length; e++) if (eqMove(excluded[e], m)) { skip = true; break; }
      if (skip) continue;
      var cap = makeMove(b, m);
      var ok = !inCheck(b, side) && !kingsFacing(b);
      undoMove(b, m, cap);
      if (ok) res.push(m);
    }
    curHash = h0;
    return res;
  }

  /**
   * @param {Array} [excluded] 排除的着法（多路分析用）
   * @param {Array} [history]  走到 board 为止的着法历史（内部索引形式，含开局起的全部着法）。
   *   给了它，引擎才知道哪些局面「已经出现过」→ 走回去按和棋算。
   *   不给也能跑，但那样搜索是**没有局面记忆**的，会往循环里走。
   */
  function rootSearch(board, side, maxDepth, timeMs, excluded, history) {
    var b = cloneBoard(board);
    var savedHash = curHash;
    curHash = computeHash(b, side);
    nodes = 0; qnodes = 0;
    deadline = Date.now() + timeMs;
    excluded = excluded || [];
    repInit(history);

    var moves = rootMoves(b, side, excluded);
    if (moves.length === 0) {
      curHash = savedHash;
      repInit(null);
      return { move: null, score: -MATE, nodes: 0, qnodes: 0, depth: 0 };
    }

    var opp = other(side);
    var sign = side === 'r' ? 1 : -1;
    var bestMove = moves[0], bestScore = sign * evaluate(b), reached = 0;

    for (var d = 1; d <= maxDepth; d++) {
      var alpha = -INF, localBest = null, localScore = -INF;
      try {
        for (var i = 0; i < moves.length; i++) {
          var m = moves[i];
          var cap = makeMove(b, m);
          repPush(b, m, cap, side);
          var sc = -negamax(b, opp, d - 1, -INF, -alpha, 1);
          repPop();
          undoMove(b, m, cap);
          if (sc > localScore) { localScore = sc; localBest = m; }
          if (sc > alpha) alpha = sc;
        }
        bestMove = localBest;
        bestScore = localScore;
        reached = d;
        var idx = moves.indexOf(localBest);
        if (idx > 0) { moves.splice(idx, 1); moves.unshift(localBest); }
        if (Math.abs(bestScore) > MATE - 1000) break;
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        break;
      }
    }

    curHash = savedHash;
    return { move: bestMove, score: bestScore, nodes: nodes, qnodes: qnodes, depth: reached };
  }

  /* 多路分析：给出前 n 个候选着法，供教练点评与大模型选择使用 */
  function topMoves(board, side, n, maxDepth, timeMs, history) {
    var b = cloneBoard(board);
    resetSearch();
    var excluded = [], out = [];
    var budget = timeMs || 3000;
    for (var k = 0; k < n; k++) {
      var slice = Math.max(300, Math.round(budget / (n - k)));
      var res = rootSearch(b, side, maxDepth, slice, excluded, history);
      if (!res.move) break;
      out.push({
        move: res.move,
        score: res.score,
        depth: res.depth,
        label: moveLabel(board, res.move)
      });
      excluded.push(res.move);
      if (Math.abs(res.score) > MATE - 1000) break;
    }
    return out;
  }

  /* ---------- 难度分级 ---------- */

  var LEVELS = {
    easy:   { depth: 1,  time: 600,  slack: 320, label: '\u5165\u95e8' },
    normal: { depth: 3,  time: 1200, slack: 110, label: '\u521d\u7ea7' },
    hard:   { depth: 5,  time: 2200, slack: 35,  label: '\u4e2d\u7ea7' },
    expert: { depth: 8,  time: 3500, slack: 0,   label: '\u9ad8\u7ea7' },
    master: { depth: 12, time: 6000, slack: 0,   label: '\u5927\u5e08' }
  };

  function pickMove(board, side, level, history) {
    var cfg = LEVELS[level] || LEVELS.normal;
    var res = rootSearch(board, side, cfg.depth, cfg.time, null, history);
    if (res.move && cfg.slack > 0) {
      var b = cloneBoard(board);
      var legal = legalMoves(b, side);
      var cands = [];
      for (var i = 0; i < legal.length; i++) {
        var m = legal[i];
        var cap = makeMove(b, m);
        var s = -rootSearch(b, other(side), 1, 120).score;
        undoMove(b, m, cap);
        if (res.score - s <= cfg.slack) cands.push(m);
      }
      if (cands.length > 0) {
        return { move: cands[(Math.random() * cands.length) | 0], score: res.score, nodes: res.nodes, depth: res.depth };
      }
    }
    return res;
  }

  /* 按棋谱文本反查着法，用于校验大模型给出的着法是否合法 */
  function findMoveByLabel(board, side, text) {
    if (!text) return null;
    var legal = legalMoves(board, side);
    var clean = String(text).replace(/\s+/g, '');
    for (var i = 0; i < legal.length; i++) {
      if (moveLabel(board, legal[i]) === clean) return legal[i];
    }
    return null;
  }

  /* ---------- 评分 → 胜率 ---------- */

  function winRate(redScore) {
    if (redScore > MATE - 1000) return 1;
    if (redScore < -MATE + 1000) return 0;
    var k = 1 / (1 + Math.pow(10, -redScore / 400));
    return Math.max(0.02, Math.min(0.98, k));
  }

  function scoreText(v) {
    if (v > MATE - 1000) return '\u7ea2\u65b9\u5df2\u6210\u6740';
    if (v < -MATE + 1000) return '\u9ed1\u65b9\u5df2\u6210\u6740';
    if (v > 0) return '\u7ea2\u4f18 +' + v;
    if (v < 0) return '\u9ed1\u4f18 ' + v;
    return '\u5747\u52bf';
  }

  /* ---------- 标准中文棋谱记法 ---------- */

  var CN_NUM = ['\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d', '\u4e03', '\u516b', '\u4e5d'];

  function fileNum(c, red) { return red ? (9 - c) : (c + 1); }
  function numLabel(n, red) { return red ? CN_NUM[n - 1] : String(n); }

  function ordinalLabel(idx, n) {
    if (n === 2) return idx === 0 ? '\u524d' : '\u540e';
    if (n === 3) return ['\u524d', '\u4e2d', '\u540e'][idx];
    return ['\u524d', '\u4e8c', '\u4e09', '\u56db', '\u4e94'][idx] || '';
  }

  function moveLabel(board, m) {
    var p = board[m[0]];
    var red = isRed(p);
    var name = NAMES[p] || '?';
    var r1 = rowOf(m[0]), c1 = colOf(m[0]);
    var r2 = rowOf(m[1]), c2 = colOf(m[1]);

    var lead;
    var sameCol = [];
    for (var i = 0; i < 90; i++) if (board[i] === p && colOf(i) === c1) sameCol.push(i);
    if (sameCol.length > 1) {
      sameCol.sort(function (a, b) { return red ? rowOf(a) - rowOf(b) : rowOf(b) - rowOf(a); });
      lead = ordinalLabel(sameCol.indexOf(m[0]), sameCol.length) + name;
    } else {
      lead = name + numLabel(fileNum(c1, red), red);
    }

    if (r2 === r1) return lead + '\u5e73' + numLabel(fileNum(c2, red), red);

    var forward = red ? (r2 < r1) : (r2 > r1);
    var diag = p.toUpperCase() === 'N' || p.toUpperCase() === 'B' || p.toUpperCase() === 'A';
    var step = diag ? numLabel(fileNum(c2, red), red) : numLabel(Math.abs(r2 - r1), red);
    return lead + (forward ? '\u8fdb' : '\u9000') + step;
  }

  /* 把一串着法转成棋谱文本；棋盘可传数组，也可传 FEN 字符串 */
  function movesToText(boardOrFen, moves) {
    var b = (typeof boardOrFen === 'string') ? parseBoard(boardOrFen) : cloneBoard(boardOrFen);
    var parts = [], turn = 'r', i = 0;
    while (i < moves.length) {
      var lab = moveLabel(b, moves[i]);
      if (turn === 'r') parts.push(((i / 2) | 0) + 1 + '. ' + lab);
      else parts.push(lab);
      makeMove(b, moves[i]);
      turn = other(turn);
      i++;
    }
    return parts.join('  ');
  }

  /* ---------- 对局层终局判定：判和 / 长将判负 ----------
   *
   * 这是「对局层」的规则，**不进搜索**（搜索内判重复局面是另一件事，见 strength-plan 的 P2-2）。
   * 之前两端都只有「将死 / 困毙」，长将循环、60 回合无吃子都不会结束对局 ——
   * 对局台 20 局自对弈里 45% 是被循环吃掉的。
   *
   * 判据必须与 iOS 的 Rules.adjudicate 和 tools/match.js 的裁判保持一致（同一套规则三处实现）。
   */

  /* 60 回合无吃子判和 —— 一回合 = 双方各一手，所以按半回合数是 120 */
  var NO_CAPTURE_PLIES = 120;

  /**
   * 在一次重复循环里判断「谁在长将」。
   *
   * 抽成纯函数是为了能直接测「双方都长将」这种实战里极难摆出来的局面 ——
   * 用合成数据测判定逻辑，比硬凑一个棋例可靠得多。
   *
   * @param {Array<{side:string, check:boolean}>} cycle 一个重复循环内的着法
   * @returns {('r'|'b'|null)} 长将的一方；null = 双方都长将 或 双方都不是
   */
  function perpetualChecker(cycle) {
    var redChecks = true, blackChecks = true, redMoves = 0, blackMoves = 0;
    for (var k = 0; k < cycle.length; k++) {
      if (cycle[k].side === 'r') { redMoves++; if (!cycle[k].check) redChecks = false; }
      else { blackMoves++; if (!cycle[k].check) blackChecks = false; }
    }
    /* 循环里没出过手的一方不算长将（别让空集的真值混进来） */
    if (redMoves === 0) redChecks = false;
    if (blackMoves === 0) blackChecks = false;
    /* 都长将 / 都不长将 → 不认定某一方长将（按规则判和） */
    if (redChecks === blackChecks) return null;
    return redChecks ? 'r' : 'b';
  }

  /**
   * 只动盘面、不碰全局增量哈希的走子。
   *
   * adjudicate 是「旁观者」：它要重放整局棋，如果直接用 makeMove，
   * 走完 curHash 就停在被重放局面的哈希上，与真实盘面对不上 ——
   * 引擎的置换表会因此串味（syncHash 的注释里写的就是这个坑）。
   */
  function applyRaw(b, m) {
    var cap = b[m[1]];
    b[m[1]] = b[m[0]];
    b[m[0]] = EMPTY;
    return cap;
  }

  /**
   * 判定当前局面是否已经终局。
   *
   * @param {string} startFen 起始局面
   * @param {Array}  moves    从起始局面开始的着法，元素为 [from, to]
   * @param {string} [startSide] 起始走子方，默认 'r'
   * @returns {null | {winner: ('r'|'b'|null), reason: string}}
   *          null = 还没终局；winner 为 null = 判和
   */
  function adjudicate(startFen, moves, startSide) {
    if (!moves || !moves.length) return null;

    var b = parseBoard(startFen);
    var side = startSide || 'r';
    /* 每手走完后的局面键（含走子方），下标 0 = 起始局面 —— 用完整盘面而不是哈希，
       避免 32 位哈希碰撞把「像重复」当成「真重复」而误判长将。 */
    var keys = [boardToString(b) + '|' + side];
    var movers = [];          /* movers[j] = 走第 j 手的一方 */
    var gaveCheck = [];       /* gaveCheck[j] = 第 j 手走完是否将军 */
    var lastCapturePly = 0;   /* 最近一次吃子在第几手（从 1 起数），0 = 至今没吃过 */

    for (var j = 0; j < moves.length; j++) {
      movers.push(side);
      var cap = applyRaw(b, moves[j]);
      side = other(side);
      if (cap !== EMPTY) lastCapturePly = j + 1;
      keys.push(boardToString(b) + '|' + side);
      gaveCheck.push(inCheck(b, side));
    }
    var n = moves.length;

    /* 1) 60 回合无吃子 → 和 */
    if (n - lastCapturePly >= NO_CAPTURE_PLIES) {
      return { winner: null, reason: '60 回合无吃子' };
    }

    /* 2) 三次重复局面：拿「倒数第三次出现 → 现在」这一段当循环体 */
    var cur = keys[n], occ = [];
    for (var i = 0; i <= n; i++) if (keys[i] === cur) occ.push(i);
    if (occ.length < 3) return null;

    var from = occ[occ.length - 3];
    var cycle = [];
    for (var k = from; k < n; k++) cycle.push({ side: movers[k], check: gaveCheck[k] });

    /* 一方长将、另一方不将 → 长将方判负；双方都长将 → 和（中国象棋规则） */
    var checker = perpetualChecker(cycle);
    if (checker === 'r') return { winner: 'b', reason: '长将（红方长将判负）' };
    if (checker === 'b') return { winner: 'r', reason: '长将（黑方长将判负）' };
    return { winner: null, reason: '三次重复局面（双方均非长将）' };
  }

  /* ---------- 导出 ---------- */

  var api = {
    EMPTY: EMPTY, START: START, MATE: MATE, LEVELS: LEVELS,
    isRed: isRed, sideOf: sideOf, other: other, rowOf: rowOf, colOf: colOf, nameOf: nameOf,
    parseBoard: parseBoard, boardToString: boardToString, cloneBoard: cloneBoard,
    genMoves: genMoves, genCaptures: genCaptures,
    legalMoves: legalMoves, hasLegalMove: hasLegalMove,
    inCheck: inCheck, kingsFacing: kingsFacing, findKing: findKing,
    makeMove: makeMove, undoMove: undoMove, computeHash: computeHash, syncHash: syncHash,
    currentHash: function () { return curHash; },
    evaluate: evaluate,
    searchRoot: rootSearch, topMoves: topMoves, pickMove: pickMove,
    findMoveByLabel: findMoveByLabel,
    winRate: winRate, scoreText: scoreText,
    moveLabel: moveLabel, movesToText: movesToText,
    adjudicate: adjudicate, perpetualChecker: perpetualChecker,
    NO_CAPTURE_PLIES: NO_CAPTURE_PLIES,
    /* 搜索内「和棋意识」的两块料，给测试与自检用 */
    repContext: repContext, repIsIrreversible: repIsIrreversible,
    /* 排序：SEE 与静态棋理（P1-2）。给测试单独立着法用 ——
       SEE 是「就地改盘面再还原」，还原漏一格不会报错，只会让搜索算到一盘不存在的棋，
       所以它必须有独立断言看着。 */
    seeCapture: seeCapture, leastAttacker: leastAttacker, pstDelta: pstDelta,
    seeCalls: function () { return seeCalls; },
    /* SEE 的 ply 门控阈值。导出是为了让测试能**贴着边界两侧**各断言一次
       （ply = 阈值要算、ply = 阈值+1 不能算）—— 硬编码一个 4 的话，
       改了阈值测试就变成在测别的东西。 */
    SEE_MAX_PLY: SEE_MAX_PLY,
    /* 排序函数本身也导出来：它是纯的（只依赖 killers/hist 当前状态），
       所以在 resetSearch() 之后对给定局面调用是**确定性**的，可以直接断言顺序。 */
    orderMoves: orderMoves,
    /* 置换表条目数。JS 侧的表是 Map 且有条数上限（TT_MAX），写满之后**不再新增**
       —— 深搜时它会让搜索退化成近似「没有置换表」，量节点数会失准。
       把它暴露出来是为了能当场看出「这次测量到底有没有撞到上限」。 */
    ttSize: function () { return tt.size; },
    TT_MAX: TT_MAX,
    /* 置换表跨调用是留着的（对局里这叫「越下越快」）。测试要可复现的数字，
       就得自己先把表清干净 —— 否则同一个查询的第二次会走缓存，节点数差几十倍。 */
    resetSearch: resetSearch
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XQ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
