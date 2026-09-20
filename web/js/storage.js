/* 存档 · 强弱项分析 · 针对性训练推荐
 *
 * 全部数据存在 localStorage。核心思路：
 *   每走一手棋，都用本地引擎算一遍「最好能走成什么样」和「你实际走成了什么样」，
 *   两者的分差就是这个人的失分。按阶段（开局/中局/残局）汇总失分，
 *   就能看出弱在哪 —— 而不是笼统地说「你还需要多练」。
 */
(function (root) {
  'use strict';

  var XQ = root.XQ || (typeof require !== 'undefined' ? require('./engine.js') : null);
  var XQLIB = root.XQLIB || (typeof require !== 'undefined' ? require('./library.js') : null);

  var KEY = 'xq.archive.v1';

  /* 失分分级（单位：厘兵） */
  var TH = { inaccuracy: 100, mistake: 300, blunder: 800 };

  /* 阶段划分 */
  var OPENING_PLIES = 24;      /* 前 12 回合算开局 */
  var ENDGAME_MATERIAL = 3200; /* 场上子力低于此值算残局 */

  var mem = null;

  function read() {
    if (mem) return mem;
    var raw = null;
    try { if (typeof localStorage !== 'undefined') raw = localStorage.getItem(KEY); } catch (e) {}
    if (raw) {
      try { mem = JSON.parse(raw); } catch (e) { mem = null; }
    }
    if (!mem || typeof mem !== 'object') mem = { games: [], drills: { solved: {}, attempts: {} } };
    if (!mem.games) mem.games = [];
    if (!mem.drills) mem.drills = { solved: {}, attempts: {} };
    if (!mem.drills.solved) mem.drills.solved = {};
    if (!mem.drills.attempts) mem.drills.attempts = {};
    return mem;
  }

  function write() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(read()));
    } catch (e) { /* 隐私模式等场景降级为内存存储 */ }
  }

  function uid() {
    return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }

  /* ---------- 子力统计 ---------- */

  var PIECE_WORTH = { K: 0, R: 9, N: 4, C: 4.5, A: 2, B: 2, P: 1 };

  function materialOf(board) {
    var red = 0, black = 0;
    for (var i = 0; i < 90; i++) {
      var p = board[i];
      if (p === XQ.EMPTY) continue;
      var up = p.toUpperCase();
      if (up === 'K') continue;
      var w = PIECE_WORTH[up] || 0;
      if (XQ.isRed(p)) red += w; else black += w;
    }
    return { red: red, black: black, total: red + black };
  }

  /* ---------- 逐手分析 ---------- */

  /* 评估一手棋的失分。要在落子「之前」调用。
     返回 { bestScore, bestLabel, made, loss, grade } */
  function analyzeMove(beforeBoard, move, opts) {
    opts = opts || {};
    var depth = opts.depth || 4;
    var budget = opts.budget || 500;

    var best = XQ.searchRoot(beforeBoard, 'r', depth, budget);
    var bestScore = best.score;
    var bestLabel = best.move ? XQ.moveLabel(beforeBoard, best.move) : null;

    /* 落子之后从黑方视角搜一遍，再换算回红方视角 */
    var b2 = XQ.cloneBoard(beforeBoard);
    XQ.syncHash(b2, 'r');
    XQ.makeMove(b2, move);
    var after = XQ.searchRoot(b2, 'b', depth, budget);
    var actualScore = -after.score;

    var loss = Math.max(0, bestScore - actualScore);
    if (bestScore > XQ.MATE - 1000) loss = 0;   /* 已经能杀，怎么走都不算失分 */

    var grade = 'ok';
    if (loss >= TH.blunder) grade = 'blunder';
    else if (loss >= TH.mistake) grade = 'mistake';
    else if (loss >= TH.inaccuracy) grade = 'inaccuracy';

    /* 漏杀：本来能一步成杀却没走 */
    var missedMate = (bestScore > XQ.MATE - 1000) && (actualScore <= XQ.MATE - 1000);

    return {
      bestScore: bestScore, bestLabel: bestLabel,
      actualScore: actualScore, loss: loss,
      grade: grade, missedMate: missedMate
    };
  }

  /* ---------- 对局记录 ---------- */

  function createGame(info) {
    return {
      id: uid(),
      savedAt: Date.now(),
      sceneId: info.sceneId || 'start',
      sceneName: info.sceneName || '标准开局',
      level: info.level || 'normal',
      mode: info.mode || 'engine',
      userSide: 'r',
      startFen: info.startFen || XQ.START,
      moves: [],
      evals: [],           /* 每手：{ply, redScore, loss, grade, bestLabel, phase} */
      flags: { blunders: 0, mistakes: 0, inaccuracies: 0, missedMate: 0, matedByOpponent: 0, captured: 0, lostPieces: 0 },
      phaseLoss: { opening: [], mid: [], end: [] },
      result: 'unfinished',
      finished: false,
      ply: 0
    };
  }

  function recordMove(game, board, move, analysis, phase) {
    game.ply++;
    game.moves.push([move[0], move[1]]);
    if (analysis) {
      game.evals.push({
        ply: game.ply,
        redScore: analysis.actualScore,
        loss: analysis.loss,
        grade: analysis.grade,
        bestLabel: analysis.bestLabel,
        phase: phase
      });
      if (analysis.grade === 'blunder') game.flags.blunders++;
      else if (analysis.grade === 'mistake') game.flags.mistakes++;
      else if (analysis.grade === 'inaccuracy') game.flags.inaccuracies++;
      if (analysis.missedMate) game.flags.missedMate++;
      (game.phaseLoss[phase] || game.phaseLoss.mid).push(analysis.loss);
    }
  }

  function phaseFor(board, ply) {
    if (ply <= OPENING_PLIES) return 'opening';
    if (materialOf(board).total < ENDGAME_MATERIAL) return 'end';
    return 'mid';
  }

  /* ---------- 存取 ---------- */

  function saveGame(game) {
    var s = read();
    var idx = -1;
    for (var i = 0; i < s.games.length; i++) if (s.games[i].id === game.id) { idx = i; break; }
    if (idx >= 0) s.games[idx] = game;
    else s.games.unshift(game);
    if (s.games.length > 200) s.games.length = 200;
    write();
    return game;
  }

  function listGames() { return read().games.slice(); }

  function getGame(id) {
    var g = read().games;
    for (var i = 0; i < g.length; i++) if (g[i].id === id) return g[i];
    return null;
  }

  function deleteGame(id) {
    var s = read();
    s.games = s.games.filter(function (g) { return g.id !== id; });
    write();
  }

  function clearGames() { var s = read(); s.games = []; write(); }

  /* ---------- 练习记录 ---------- */

  function markDrillSolved(id) {
    var s = read();
    if (s.drills.solved[id]) return false;   /* 已经通关过，不重复计 */
    s.drills.solved[id] = Date.now();
    s.drills.attempts[id] = (s.drills.attempts[id] || 0) + 1;
    write();
    return true;
  }

  function markDrillAttempt(id) {
    var s = read();
    s.drills.attempts[id] = (s.drills.attempts[id] || 0) + 1;
    write();
  }

  function solvedDrills() { return Object.keys(read().drills.solved); }

  /* ---------- 强弱项分析 ---------- */

  function avg(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function clampScore(v) { return Math.max(0, Math.min(100, Math.round(v))); }

  /* 把「平均失分」换算成 0~100 的能力分：0 分失 = 100 分，300 分失 ≈ 50 分 */
  function lossToScore(loss) {
    if (loss <= 0) return 100;
    return clampScore(100 * Math.exp(-loss / 420));
  }

  function computeAbilities() {
    var s = read();
    var games = s.games.filter(function (g) { return g.evals && g.evals.length > 0; });

    var openLoss = [], midLoss = [], endLoss = [];
    var totalPly = 0, matedGames = 0, missedMate = 0, blunders = 0, mistakes = 0;
    var wins = 0, losses = 0, finished = 0;

    games.forEach(function (g) {
      (g.evals || []).forEach(function (e) {
        if (e.phase === 'opening') openLoss.push(e.loss);
        else if (e.phase === 'end') endLoss.push(e.loss);
        else midLoss.push(e.loss);
      });
      totalPly += g.ply || 0;
      missedMate += (g.flags && g.flags.missedMate) || 0;
      blunders += (g.flags && g.flags.blunders) || 0;
      mistakes += (g.flags && g.flags.mistakes) || 0;
      if (g.finished) {
        finished++;
        if (g.result === 'win') wins++;
        else if (g.result === 'loss') { losses++; matedGames++; }
      }
    });

    /* 攻杀：杀法练习通关率 + 漏杀惩罚 */
    var solved = solvedDrills().length;
    var mateTotal = (XQLIB && XQLIB.MATES.length) || 11;
    var mateRatio = mateTotal ? solved / mateTotal : 0;
    var attackBase = mateRatio * 100;
    var attack = clampScore(attackBase - Math.min(35, missedMate * 7));

    /* 防守：被将死比例 + 被将军后的失分（用中局失分近似）+ 杀法通关加成 */
    var defendBase = 62 + mateRatio * 22;
    if (finished) defendBase -= (matedGames / finished) * 30;
    defendBase -= Math.min(25, blunders * 1.6);
    var defend = clampScore(defendBase);

    var opening = games.length ? lossToScore(avg(openLoss)) : 0;
    var midgame = games.length ? lossToScore(avg(midLoss)) : 0;
    var endgame = games.length ? lossToScore(avg(endLoss)) : 0;

    /* 没有对局数据时，未开局的三项显示为 0 分（未评测），避免给人「你很差」的错觉 */
    var dimensions = [
      { key: 'opening', name: '开局稳健', score: opening, samples: openLoss.length,
        note: openLoss.length ? '前 12 回合平均失分 ' + Math.round(avg(openLoss)) : '还没有对局数据' },
      { key: 'midgame', name: '中局战术', score: midgame, samples: midLoss.length,
        note: midLoss.length ? '中局平均失分 ' + Math.round(avg(midLoss)) : '还没有对局数据' },
      { key: 'endgame', name: '残局收官', score: endgame, samples: endLoss.length,
        note: endLoss.length ? '残局平均失分 ' + Math.round(avg(endLoss)) : '还没有进入过残局的记录' },
      { key: 'attack', name: '攻杀把握', score: attack, samples: solved,
        note: '杀法已通 ' + solved + '/' + mateTotal + ' 关' + (missedMate ? '，漏杀 ' + missedMate + ' 次' : '') },
      { key: 'defend', name: '防守意识', score: defend, samples: finished,
        note: finished ? ('已结束 ' + finished + ' 局，被将死 ' + matedGames + ' 局') : '还没有完整对局数据' }
    ];

    var played = games.length;
    var stat = {
      games: played,
      finished: finished,
      wins: wins,
      losses: losses,
      winRate: finished ? Math.round(wins / finished * 100) : 0,
      avgPly: played ? Math.round(totalPly / played) : 0,
      blunders: blunders,
      mistakes: mistakes,
      missedMate: missedMate,
      solvedMates: solved,
      mateTotal: mateTotal
    };

    /* 综合分：只统计有数据的维度 */
    var valid = dimensions.filter(function (d) { return played > 0 || d.key === 'attack' || d.key === 'defend'; });
    var overall = valid.length ? Math.round(avg(valid.map(function (d) { return d.score; }))) : 0;

    return { dimensions: dimensions, stat: stat, overall: overall, hasData: played > 0 || solved > 0 };
  }

  /* ---------- 针对性训练推荐 ---------- */

  var DRILL_PLAN = {
    opening: { kind: 'opening', badge: '\u5e03\u5c40', why: '开局阶段失分偏多，先把常见开局的前几手走熟' },
    midgame: { kind: 'mate',      badge: '\u6740\u6cd5', why: '中局丢子偏多，用杀法练习练「一眼看出杀棋」' },
    endgame: { kind: 'study',     badge: '\u6b8b\u5c40', why: '残局收不住，先把几个基本胜残局走通' },
    attack:  { kind: 'mate',      badge: '\u6740\u6cd5', why: '有杀棋机会没抓住，专项练成杀套路' },
    defend:  { kind: 'mate',      badge: '\u9632\u5b88', why: '容易被将死，反过来多看杀法就知道怎么防' }
  };

  function recommendDrills(limit) {
    limit = limit || 3;
    if (!XQLIB) return [];
    var ab = computeAbilities();
    var s = read();

    /* 还没有任何对局数据时，给一套「新手起步」组合，而不是把 3 个开局硬塞给人 */
    if (!ab.hasData) {
      var starter = [];
      XQLIB.MATES.filter(function (m) { return m.tier === 1; }).slice(0, 2).forEach(function (m) {
        starter.push({ id: 'mate:' + m.id, scene: 'mate:' + m.id, badge: '\u6740\u6cd5', title: m.name, desc: '\u4e00\u6b65\u6740 \u00b7 \u5148\u4ece\u8fd9\u91cc\u719f\u6089\u6740\u68cb\u7684\u611f\u89c9' });
      });
      var op = XQLIB.OPENINGS[0];
      if (op) starter.push({ id: 'opening:' + op.id, scene: 'opening:' + op.id, badge: '\u5f00\u5c40', title: op.name, desc: '\u5148\u628a\u6700\u5e38\u89c1\u5f00\u5c40\u7684\u5934\u51e0\u624b\u8d70\u719f' });
      return starter.slice(0, limit);
    }

    /* 按分数升序排，最弱的排前面 */
    var ranked = ab.dimensions.slice().sort(function (a, b) { return a.score - b.score; });
    var out = [];

    for (var i = 0; i < ranked.length && out.length < limit; i++) {
      var dim = ranked[i];
      var plan = DRILL_PLAN[dim.key];
      if (!plan) continue;

      if (plan.kind === 'opening') {
        for (var o = 0; o < XQLIB.OPENINGS.length && out.length < limit; o++) {
          var op = XQLIB.OPENINGS[o];
          out.push({
            id: 'opening:' + op.id, scene: 'opening:' + op.id,
            badge: plan.badge, title: op.name, desc: op.style + ' · ' + plan.why, reason: dim
          });
        }
      } else if (plan.kind === 'study') {
        for (var u = 0; u < XQLIB.STUDIES.length && out.length < limit; u++) {
          var st = XQLIB.STUDIES[u];
          out.push({
            id: 'study:' + st.id, scene: 'study:' + st.id,
            badge: plan.badge, title: st.name, desc: plan.why, reason: dim
          });
        }
      } else {
        /* 杀法：优先推没通关的，按难度递增 */
        var unsolved = XQLIB.MATES.filter(function (m) { return !s.drills.solved[m.id]; });
        var pool = unsolved.length ? unsolved : XQLIB.MATES;
        pool = pool.slice().sort(function (a, b) { return (a.tier || 1) - (b.tier || 1); });
        for (var k = 0; k < pool.length && out.length < limit; k++) {
          var mt = pool[k];
          out.push({
            id: 'mate:' + mt.id, scene: 'mate:' + mt.id,
            badge: plan.badge, title: mt.name,
            desc: (mt.tier === 1 ? '一步杀' : '两步杀') + ' · ' + plan.why, reason: dim
          });
        }
      }
    }

    /* 去重 + 补足 */
    var seen = {}, uniq = [];
    out.forEach(function (d) { if (!seen[d.id]) { seen[d.id] = 1; uniq.push(d); } });
    if (uniq.length < limit) {
      XQLIB.MATES.forEach(function (m) {
        var key = 'mate:' + m.id;
        if (uniq.length < limit && !seen[key]) { seen[key] = 1; uniq.push({ id: key, scene: key, badge: '\u6740\u6cd5', title: m.name, desc: '空闲时也可以练一练' }); }
      });
    }
    return uniq.slice(0, limit);
  }

  function resetAll() { mem = { games: [], drills: { solved: {}, attempts: {} } }; write(); }

  var api = {
    TH: TH,
    materialOf: materialOf,
    analyzeMove: analyzeMove,
    createGame: createGame,
    recordMove: recordMove,
    phaseFor: phaseFor,
    saveGame: saveGame, listGames: listGames, getGame: getGame,
    deleteGame: deleteGame, clearGames: clearGames,
    markDrillSolved: markDrillSolved, markDrillAttempt: markDrillAttempt,
    solvedDrills: solvedDrills,
    computeAbilities: computeAbilities,
    recommendDrills: recommendDrills,
    resetAll: resetAll
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XQSTORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
