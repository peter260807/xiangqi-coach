/* 棋谱库访问层 —— 杀法练习、开局库、实用残局
 *
 * 数据不写在这里：唯一数据源是 shared/library.json，
 * 网页端读的是由 tools/sync-library.js 生成的 web/js/library-data.js。
 * 所有局面都由 validateLibrary() 用引擎自动校验，避免出现非法或退化局面。
 */
(function (root) {
  'use strict';

  var XQ = root.XQ || (typeof require !== 'undefined' ? require('./engine.js') : null);
  var DATA = root.XQ_LIBRARY ||
    (typeof require !== 'undefined' ? require('./library-data.js') : null) ||
    { mates: [], openings: [], studies: [] };

  var MATES = DATA.mates || [];
  var OPENINGS = DATA.openings || [];
  var STUDIES = DATA.studies || [];
  var CLASSICS = DATA.classics || [];

  /* 把一条棋谱文本（如「炮二平五 马8进7」）逐步落到棋盘上，顺带校验合法性 */
  function resolveLine(line, startFen) {
    var board = XQ.parseBoard(startFen || XQ.START);
    var side = 'r';
    var tokens = String(line).trim().split(/\s+/);
    var moves = [], bad = null;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      var m = XQ.findMoveByLabel(board, side, t);
      if (!m) { bad = '\u7b2c ' + (i + 1) + ' \u7740\u65e0\u6cd5\u8bc6\u522b\u6216\u4e0d\u5408\u6cd5\uff1a' + t; break; }
      moves.push(m);
      XQ.makeMove(board, m);
      side = XQ.other(side);
    }
    return { moves: moves, error: bad, finalFen: XQ.boardToString(board) };
  }

  /* 找出当前局面下所有「一步成杀」的着法 */
  function matingMoves(fen) {
    var b = XQ.parseBoard(fen);
    var out = [];
    var legal = XQ.legalMoves(b, 'r');
    for (var i = 0; i < legal.length; i++) {
      var m = legal[i];
      var cap = XQ.makeMove(b, m);
      var inChk = XQ.inCheck(b, 'b');
      var stuck = !XQ.hasLegalMove(b, 'b');
      XQ.undoMove(b, m, cap);
      if (stuck) out.push({ move: m, label: XQ.moveLabel(b, m), check: inChk });
    }
    return out;
  }

  /* 校验全部棋谱条目；测试与界面共用，返回结构化报告 */
  function validateLibrary() {
    var report = { mates: [], openings: [], studies: [], classics: [], ok: true };

    MATES.forEach(function (p) {
      var b = XQ.parseBoard(p.fen);
      var r = { id: p.id, name: p.name };
      r.redMoves = XQ.legalMoves(b, 'r').length;
      r.blackHasMove = XQ.hasLegalMove(b, 'b');
      r.blackNotChecked = !XQ.inCheck(b, 'b');

      if (p.line && p.line.length) {
        /* **有解法路线时，直接走一遍验证它** —— 又快又更强。
         * 判据：① 每一步都能识别且合法；② 最后是红方走完、黑方无子可动（真成杀）；
         *       ③ 步数与 mateIn 对得上。
         *
         * 以前这里用「depth 6 搜索能不能看到杀棋分」当判据。对一步杀/两步杀成立，
         * 但从公开题库导入的题最深到六手（11 步），depth 6 根本看不到 ——
         * 456 条全部被误报成失败，而且代价是每条一次搜索（整套跑 46 秒）。
         * 更根本的问题是：搜索判据验证的是「引擎能不能看到杀」，
         * 而我们真正要保证的是「**库里存的那条路线是对的**」（它就是给学生看的那个）。 */
        var bb = XQ.parseBoard(p.fen);
        var side = 'r';
        var bad = null;
        for (var i = 0; i < p.line.length; i++) {
          var mv = XQ.findMoveByLabel(bb, side, p.line[i]);
          if (!mv) { bad = p.line[i]; break; }
          XQ.makeMove(bb, mv);
          side = XQ.other(side);
        }
        r.lineError = bad;
        r.linePlies = p.line.length;
        r.mated = !bad && !XQ.hasLegalMove(bb, side);
        /* 红先且步数为奇数时，走完最后一手轮到黑方 —— 这才是「红方成杀」 */
        r.redMated = r.mated && side === 'b';
        r.mateInOk = p.mateIn ? (p.line.length === 2 * p.mateIn - 1) : true;
        r.mate = r.redMated && r.mateInOk;
        r.best = p.line[0];
        /* 不编「杀着数」—— 走一遍只证明**这一条**路线对，
           证明不了「还有没有别的杀法」。调用方据 linePlies 判断用的是哪种判据。 */
        r.solutions = null;
      } else {
        /* 没有路线（老库）就退回搜索判据 */
        var res = r.redMoves > 0 ? XQ.searchRoot(b, 'r', 6, 8000) : { score: 0, move: null, depth: 0 };
        r.mate = res.score > XQ.MATE - 1000;
        r.best = res.move ? XQ.moveLabel(b, res.move) : null;
        r.depth = res.depth;
        r.solutions = r.redMoves ? matingMoves(p.fen).length : 0;
      }

      r.pass = r.redMoves > 0 && r.blackHasMove && r.blackNotChecked && r.mate;
      if (!r.pass) report.ok = false;
      report.mates.push(r);
    });

    OPENINGS.forEach(function (o) {
      var res = resolveLine(o.line);
      var r = { id: o.id, name: o.name, moves: res.moves.length, error: res.error };
      r.pass = !res.error && res.moves.length > 0;
      if (!r.pass) report.ok = false;
      report.openings.push(r);
    });

    STUDIES.forEach(function (s) {
      var b = XQ.parseBoard(s.fen);
      var r = { id: s.id, name: s.name };
      r.redMoves = XQ.legalMoves(b, 'r').length;
      r.blackHasMove = XQ.hasLegalMove(b, 'b');
      var res = XQ.searchRoot(b, 'r', 5, 6000);
      r.score = res.score;
      r.best = res.move ? XQ.moveLabel(b, res.move) : null;
      r.pass = r.redMoves > 0 && r.blackHasMove && res.score > 300;
      if (!r.pass) report.ok = false;
      report.studies.push(r);
    });

    /* 名局：逐手校验，并且要求最后一手确实构成将死 */
    CLASSICS.forEach(function (c) {
      var res = resolveLine(c.line);
      var r = { id: c.id, name: c.name, moves: res.moves.length, error: res.error };
      if (!res.error && res.moves.length > 0) {
        var b = XQ.parseBoard(XQ.START);
        var side = 'r';
        for (var i = 0; i < res.moves.length; i++) {
          XQ.makeMove(b, res.moves[i]);
          side = XQ.other(side);
        }
        r.mated = !XQ.hasLegalMove(b, side);
        r.checked = XQ.inCheck(b, side);
      }
      r.pass = !res.error && res.moves.length > 0 && r.mated === true && r.checked === true;
      if (!r.pass) report.ok = false;
      report.classics.push(r);
    });

    return report;
  }

  /* 按 id 取条目 */
  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  var api = {
    MATES: MATES, OPENINGS: OPENINGS, STUDIES: STUDIES, CLASSICS: CLASSICS,
    findById: findById,
    resolveLine: resolveLine, matingMoves: matingMoves, validateLibrary: validateLibrary
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XQLIB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
