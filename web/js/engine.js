/* 中国象棋引擎 —— 走子规则 + 位置价值评估 + Alpha-Beta/置换表/静态搜索
 * 无 DOM 依赖，浏览器与 Node 均可加载。
 */
(function (root) {
  'use strict';

  var EMPTY = '.';
  var START = 'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR';
  var MATE = 200000;
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
    nodes = 0; qnodes = 0;
    tt.clear();
    killers = [];
    for (var i = 0; i < MAX_PLY; i++) killers.push([null, null]);
    hist = new Int32Array(90 * 90);
  }

  function eqMove(a, m) { return !!a && a[0] === m[0] && a[1] === m[1]; }

  function orderMoves(b, moves, ply, ttMove) {
    var k = killers[ply] || [null, null];
    var out = [];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i], s;
      var cap = b[m[1]];
      if (eqMove(ttMove, m)) s = 100000000;
      else if (cap !== EMPTY) s = 10000000 + PVAL[cap.toUpperCase()] * 16 - PVAL[b[m[0]].toUpperCase()];
      else if (eqMove(k[0], m)) s = 9000000;
      else if (eqMove(k[1], m)) s = 8900000;
      else s = hist[m[0] * 90 + m[1]];
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

    var opp = other(side);
    var moves = orderMoves(b, genMoves(b, side), plyKey, ttMove);
    var best = -INF, bestMove = null, anyLegal = false, searchedOne = false;

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var cap = makeMove(b, m);
      if (inCheck(b, side) || kingsFacing(b)) { undoMove(b, m, cap); continue; }
      anyLegal = true;

      var sc;
      if (!searchedOne) {
        /* 首着必须用全窗口：此时 alpha 可能仍是 -INF，空窗口会算错 */
        sc = -negamax(b, opp, depth - 1, -beta, -alpha, ply + 1);
      } else {
        sc = -negamax(b, opp, depth - 1, -alpha - 1, -alpha, ply + 1);
        if (sc > alpha && sc < beta) sc = -negamax(b, opp, depth - 1, -beta, -alpha, ply + 1);
      }
      searchedOne = true;
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

  function rootSearch(board, side, maxDepth, timeMs, excluded) {
    var b = cloneBoard(board);
    var savedHash = curHash;
    curHash = computeHash(b, side);
    nodes = 0; qnodes = 0;
    deadline = Date.now() + timeMs;
    excluded = excluded || [];

    var moves = rootMoves(b, side, excluded);
    if (moves.length === 0) {
      curHash = savedHash;
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
          var sc = -negamax(b, opp, d - 1, -INF, -alpha, 1);
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
  function topMoves(board, side, n, maxDepth, timeMs) {
    var b = cloneBoard(board);
    resetSearch();
    var excluded = [], out = [];
    var budget = timeMs || 3000;
    for (var k = 0; k < n; k++) {
      var slice = Math.max(300, Math.round(budget / (n - k)));
      var res = rootSearch(b, side, maxDepth, slice, excluded);
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

  function pickMove(board, side, level) {
    var cfg = LEVELS[level] || LEVELS.normal;
    var res = rootSearch(board, side, cfg.depth, cfg.time);
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

  /* ---------- 导出 ---------- */

  var api = {
    EMPTY: EMPTY, START: START, MATE: MATE, LEVELS: LEVELS,
    isRed: isRed, sideOf: sideOf, other: other, rowOf: rowOf, colOf: colOf, nameOf: nameOf,
    parseBoard: parseBoard, boardToString: boardToString, cloneBoard: cloneBoard,
    genMoves: genMoves, genCaptures: genCaptures,
    legalMoves: legalMoves, hasLegalMove: hasLegalMove,
    inCheck: inCheck, kingsFacing: kingsFacing, findKing: findKing,
    makeMove: makeMove, undoMove: undoMove, computeHash: computeHash, syncHash: syncHash,
    evaluate: evaluate,
    searchRoot: rootSearch, topMoves: topMoves, pickMove: pickMove,
    findMoveByLabel: findMoveByLabel,
    winRate: winRate, scoreText: scoreText,
    moveLabel: moveLabel, movesToText: movesToText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XQ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
