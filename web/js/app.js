/* 象棋教练 —— 主控制器
 *
 * 三个页面：对弈 / 训练 / 战绩。
 * 走子流程刻意做成「状态先变、视觉随后追上」：
 * 落子后棋盘立即更新，但棋子用约 0.46 秒滑到目标位置，
 * 被吃的子同时淡出下沉，最后留 0.52 秒让使用者看清结果 —— 合计约 1 秒。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- DOM ---------- */
  var cvs = $('board');
  var elToast = $('toast');
  var elStatus = $('status'), elInfo = $('engineInfo');
  var elRedPct = $('redPct'), elBlackPct = $('blackPct'), elEvalText = $('evalText'), elEvalFill = $('evalFill');
  var elMoves = $('moves');
  var selScene = $('selScene'), selLevel = $('selLevel'), selMode = $('selMode');
  var btnHint = $('btnHint'), btnUndo = $('btnUndo'), btnRestart = $('btnRestart'), btnSave = $('btnSave');
  var btnCoach = $('btnCoach'), btnReview = $('btnReview'), btnSettings = $('btnSettings');
  var panel = $('panel'), panelTitle = $('panelTitle'), panelBody = $('panelBody'), panelFoot = $('panelFoot');
  var overlay = $('overlay');
  var demoBar = $('demoBar'), demoLabel = $('demoLabel'), demoNoteEl = $('demoNote');
  var btnDemoMain = $('btnDemoMain'), btnDemoNext = $('btnDemoNext'), btnDemoExit = $('btnDemoExit');
  var btnNotation = $('btnNotation');
  var ioOverlay = $('ioOverlay'), ioMsg = $('ioMsg');

  /* ---------- 状态 ---------- */
  var board, turn, history, legal, selected, lastMove, hintMove;
  var thinking = false, gameOver = false, redScore = 0;
  var sceneId = 'start', startFen = XQ.START, sceneName = '标准开局';
  var record = null;
  var pending = null;      /* 待分析的一手：{preBoard, move, ply, phase} */
  var aiBusy = false;
  var animating = false;

  /* ---------- 工具 ---------- */

  var toastTimer = 0;
  function toast(text, kind, ms) {
    elToast.textContent = text;
    elToast.className = 'toast on' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.className = 'toast'; }, ms || 1600);
  }

  function setStatus(html, warn) {
    elStatus.innerHTML = html;
    elStatus.className = 'card status' + (warn ? ' warn' : '');
  }

  function sideName(s) { return s === 'r' ? '红方' : '黑方'; }

  function formatEval(v) {
    if (v > XQ.MATE - 1000) return '红方已成杀';
    if (v < -XQ.MATE + 1000) return '黑方已成杀';
    if (v > 150) return '红方明显占优';
    if (v > 50) return '红方稍优';
    if (v < -150) return '黑方明显占优';
    if (v < -50) return '黑方稍优';
    return '均势';
  }

  function refreshLegal() {
    XQ.syncHash(board, turn);
    legal = XQ.legalMoves(board, turn);
  }

  function movesFrom(i) {
    var out = [];
    for (var k = 0; k < legal.length; k++) if (legal[k][0] === i) out.push(legal[k]);
    return out;
  }

  function findMove(from, to) {
    for (var k = 0; k < legal.length; k++) if (legal[k][0] === from && legal[k][1] === to) return legal[k];
    return null;
  }

  /* 把内部状态同步给渲染层 */
  function sync() {
    var checkSide = null;
    if (!gameOver) {
      if (XQ.inCheck(board, 'r')) checkSide = 'r';
      else if (XQ.inCheck(board, 'b')) checkSide = 'b';
    }
    XQBOARD.setState({
      board: board,
      turn: turn,
      selected: selected,
      targets: selected >= 0 ? movesFrom(selected) : [],
      lastMove: lastMove,
      hintMove: hintMove,
      checkSide: checkSide
    });
  }

  function render() {
    sync();
    renderMoves();
    btnUndo.disabled = history.length === 0 || thinking || animating;
    btnHint.disabled = thinking || animating || gameOver || turn !== 'r';
    btnSave.disabled = history.length === 0;
  }

  /* ---------- 场景 ---------- */

  /* ---------- 打谱演示 ---------- */

  /* 名局全谱 / 杀法解法 / 开局谱都能逐步演示。
     演示期间不接受落子，也不叫电脑走棋 —— 纯看谱。 */
  var demo = { on: false, playing: false, index: 0, moves: [], labels: [], notes: {}, note: '', timer: 0 };

  function resetDemo() {
    clearTimeout(demo.timer);
    demo.timer = 0;
    demo.on = false; demo.playing = false; demo.index = 0;
    demo.moves = []; demo.labels = []; demo.notes = {}; demo.note = '';
  }

  /* 把一段棋谱文本解析成着法序列。解析不出来的部分直接截断，不抛错。 */
  function demoPrepare(labels, highlights) {
    demo.labels = (labels || []).filter(function (t) { return t && t.length; });
    demo.notes = {};
    (highlights || []).forEach(function (h) { demo.notes[h.ply] = h.text; });

    demo.moves = [];
    var sb = XQ.parseBoard(startFen), side = 'r';
    for (var i = 0; i < demo.labels.length; i++) {
      var m = XQ.findMoveByLabel(sb, side, demo.labels[i]);
      if (!m) break;
      demo.moves.push(m);
      XQ.makeMove(sb, m);
      side = XQ.other(side);
    }
    demo.index = 0;
    demo.note = '';
  }

  function startDemo() {
    if (!demo.moves.length) return;
    loadScene(sceneId, true);
    demo.on = true;
    demo.index = 0;
    demo.note = '';
    setStatus('<span class="dot red"></span><span>打谱演示：<b>' + sceneName + '</b>　共 '
      + demo.moves.length + ' 手，点「播放」开始</span>', false);
    renderDemo();
    render();
  }

  function demoStep() {
    if (!demo.on || demo.index >= demo.moves.length) {
      demo.playing = false;
      renderDemo();
      return;
    }
    var m = demo.moves[demo.index];
    demo.index++;
    demo.note = demo.notes[demo.index] || '';
    playMove(m, { track: false });
  }

  function demoToggle() {
    if (!demo.on) { startDemo(); return; }
    if (demo.playing) {
      demo.playing = false;
      clearTimeout(demo.timer);
      renderDemo();
      return;
    }
    if (demo.index >= demo.moves.length) startDemo();
    demo.playing = true;
    demoStep();
    renderDemo();
  }

  function exitDemo() {
    clearTimeout(demo.timer);
    demo.playing = false; demo.on = false; demo.index = 0;
    loadScene(sceneId, true);
    toast('已退出演示', '', 1400);
  }

  function demoStatusHtml() {
    var tail = demo.note ? '　<b>' + demo.note + '</b>' : '';
    return '<span class="dot red"></span><span>打谱演示 '
      + demo.index + '/' + demo.moves.length + tail + '</span>';
  }

  function renderDemo() {
    if (!demoBar) return;
    var has = demo.moves.length > 0 || demo.on;
    demoBar.style.display = has ? '' : 'none';
    if (!has) return;

    demoLabel.textContent = demo.on
      ? ('演示 ' + demo.index + '/' + demo.moves.length)
      : ('看解法（共 ' + demo.moves.length + ' 手）');
    demoNoteEl.textContent = demo.on ? (demo.note || '') : '';

    btnDemoMain.textContent = demo.on ? (demo.playing ? '暂停' : '播放') : '看解法';
    btnDemoNext.style.display = demo.on ? '' : 'none';
    btnDemoExit.style.display = demo.on ? '' : 'none';
    btnDemoNext.disabled = demo.playing || demo.index >= demo.moves.length;
  }

  /* ---------- 场景 ---------- */

  function buildScenes() {
    var html = '<optgroup label="对局"><option value="start">标准开局（红先）</option></optgroup>';
    html += '<optgroup label="名局（可逐步演示）">';
    (XQLIB.CLASSICS || []).forEach(function (c) { html += '<option value="classic:' + c.id + '">' + c.name + '</option>'; });
    html += '</optgroup><optgroup label="杀法练习（红先成杀）">';
    XQLIB.MATES.forEach(function (m) { html += '<option value="mate:' + m.id + '">' + m.name + '</option>'; });
    html += '</optgroup><optgroup label="开局库（标准着法）">';
    XQLIB.OPENINGS.forEach(function (o) { html += '<option value="opening:' + o.id + '">' + o.name + '</option>'; });
    html += '</optgroup><optgroup label="实用残局（红先取胜）">';
    XQLIB.STUDIES.forEach(function (s) { html += '<option value="study:' + s.id + '">' + s.name + '</option>'; });
    html += '</optgroup>';
    selScene.innerHTML = html;
  }

  function loadScene(id, silent) {
    sceneId = id;
    history = []; selected = -1; lastMove = null; hintMove = null;
    thinking = false; gameOver = false; redScore = 0; animating = false;
    pending = null; aiBusy = false;
    XQBOARD.cancelAnim();
    turn = 'r';
    resetDemo();
    var note = '';

    if (id === 'start') {
      startFen = XQ.START; board = XQ.parseBoard(startFen); sceneName = '标准开局';
      note = '红先行。初学者可以先试「炮二平五」抢占中路。';
    } else if (id.indexOf('classic:') === 0) {
      var c = XQLIB.findById(XQLIB.CLASSICS, id.slice(8));
      startFen = XQ.START; board = XQ.parseBoard(startFen); sceneName = '名局 · ' + c.name;
      note = c.source + '\n\n' + c.desc;
      demoPrepare(c.line.split(/\s+/), c.highlights || []);
    } else if (id.indexOf('mate:') === 0) {
      var m = XQLIB.findById(XQLIB.MATES, id.slice(5));
      startFen = m.fen; board = XQ.parseBoard(startFen); sceneName = '杀法 · ' + m.name;
      note = m.idea + '\n\n轮到你走，找出成杀的那一步。想不出来就点「提示」，或用「看解法」逐步演示。';
      XQSTORE.markDrillAttempt(id);
      demoPrepare(m.line || [], []);
    } else if (id.indexOf('study:') === 0) {
      var s = XQLIB.findById(XQLIB.STUDIES, id.slice(6));
      startFen = s.fen; board = XQ.parseBoard(startFen); sceneName = '残局 · ' + s.name;
      note = s.desc;
      XQSTORE.markDrillAttempt(id);
    } else if (id.indexOf('opening:') === 0) {
      var o = XQLIB.findById(XQLIB.OPENINGS, id.slice(8));
      startFen = XQ.START; board = XQ.parseBoard(startFen); sceneName = '开局 · ' + o.name;
      var res = XQLIB.resolveLine(o.line, XQ.START);
      for (var i = 0; i < res.moves.length; i++) {
        var mv = res.moves[i];
        var label = XQ.moveLabel(board, mv);
        var cap = XQ.makeMove(board, mv);
        history.push({ m: [mv[0], mv[1]], cap: cap, label: label, side: turn });
        lastMove = mv;
        turn = XQ.other(turn);
      }
      note = o.desc + '\n\n已按谱走完 ' + res.moves.length + ' 着，可以用「看解法」逐步演示整段。';
      demoPrepare(o.line.split(/\s+/), []);
    }

    record = XQSTORE.createGame({
      sceneId: id, sceneName: sceneName, level: selLevel.value,
      mode: selMode.value, startFen: startFen
    });
    history.forEach(function (h) { record.moves.push([h.m[0], h.m[1]]); record.ply++; });

    refreshLegal();
    updateEval();
    setStatus('<span class="dot red"></span><span>轮到<b>你</b>走（红方）—— ' + sceneName + '</span>', false);
    if (!silent && note) showPanel('当前场景', note);
    render();
    renderDemo();
    renderTraining();
    renderStats();
  }

  /* ---------- 走子 ---------- */

  var ANIM_TOTAL = 0;   /* 由 board.js 的时长决定，这里只用来提示 */

  function playMove(m, opts) {
    opts = opts || {};
    XQ.syncHash(board, turn);
    var mover = turn;
    var cap = board[m[1]];
    var label = XQ.moveLabel(board, m);
    var pre = opts.track ? XQ.cloneBoard(board) : null;
    var ply = history.length + 1;

    XQ.makeMove(board, m);
    history.push({ m: [m[0], m[1]], cap: cap, label: label, side: mover });
    lastMove = m; selected = -1; hintMove = null;
    turn = XQ.other(turn);
    refreshLegal();

    if (opts.track) pending = { preBoard: pre, move: m, ply: ply };

    animating = true;
    sync();
    renderMoves();
    btnUndo.disabled = true; btnHint.disabled = true;

    /* 落子瞬间先报吃子，让使用者知道有子被拿掉了 */
    if (cap !== XQ.EMPTY) {
      toast('吃 ' + (XQ.isRed(cap) ? '红' : '黑') + XQ.nameOf(cap), 'capture', 1100);
    }

    XQBOARD.animateMove(m, cap, function () {
      animating = false;
      onMoveSettled();
    });

    /* 滑动结束（约 0.46s）时再报将军，节奏更像真人下棋 */
    setTimeout(function () {
      if (gameOver || !history.length) return;
      var last = history[history.length - 1];
      if (last.m[0] !== m[0] || last.m[1] !== m[1]) return;
      var opponent = turn;
      if (XQ.inCheck(board, opponent)) {
        if (!XQ.hasLegalMove(board, opponent)) toast(sideName(opponent) + '被将死', 'mate', 2200);
        else toast('将 军！', 'check', 1300);
      }
    }, XQBOARD.SLIDE_MS + 40);
  }

  function onMoveSettled() {
    /* 打谱演示：走完一手就把节奏交回给播放器 —— 不做逐手分析，也不叫电脑走棋 */
    if (demo.on) {
      if (demo.playing && demo.index < demo.moves.length) {
        setStatus(demoStatusHtml(), false);
        clearTimeout(demo.timer);
        demo.timer = setTimeout(function () {
          if (!demo.playing || !demo.on) return;
          demoStep();
        }, 620);
      } else if (demo.playing) {
        demo.playing = false;
        setStatus('<span class="dot red"></span><span>演示结束（共 ' + demo.moves.length + ' 手）</span>', false);
      } else {
        setStatus(demoStatusHtml(), false);
      }
      renderDemo();
      render();
      return;
    }

    var nowSide = turn;
    if (!XQ.hasLegalMove(board, nowSide)) {
      finishGame(nowSide);
      return;
    }
    updateEval();
    scheduleAnalysis();

    if (nowSide === 'b') {
      aiTurn();
    } else {
      setStatus('<span class="dot red"></span><span>轮到<b>你</b>走（红方）</span>', false);
      render();
    }
  }

  function finishGame(loserSide) {
    gameOver = true;
    var checked = XQ.inCheck(board, loserSide);
    var winner = loserSide === 'r' ? '黑方' : '红方';
    var loser = sideName(loserSide);
    redScore = loserSide === 'r' ? -XQ.MATE : XQ.MATE;
    paintEval();
    sync(); renderMoves();

    setStatus('<span class="dot gray"></span><span><b>' + loser + (checked ? '被将死' : '被困毙（无子可动同样判负）') + '</b>，' + winner + '获胜。</span>', true);
    toast(checked ? '将 死' : '困 毙', 'mate', 2600);

    var userWon = loserSide === 'b';
    if (record) {
      record.result = userWon ? 'win' : 'loss';
      record.finished = true;
      XQSTORE.saveGame(record);
      if (userWon && sceneId) XQSTORE.markDrillSolved(sceneId);
    }
    flushAnalysis();
    renderStats();
    renderTraining();
  }

  /* ---------- 逐手质量分析（异步补算，不打断手感） ---------- */

  function scheduleAnalysis() {
    if (!pending) return;
    var job = pending;
    pending = null;
    setTimeout(function () {
      if (!job.preBoard) return;
      var phase = XQSTORE.phaseFor(job.preBoard, job.ply);
      var a = null;
      try {
        a = XQSTORE.analyzeMove(job.preBoard, job.move, { depth: 4, budget: 450 });
      } catch (e) { a = null; }
      if (record) XQSTORE.recordMove(record, job.preBoard, job.move, a, phase);
      XQ.syncHash(board, turn);
      renderMoves();
      renderStats();
    }, 40);
  }

  function flushAnalysis() {
    /* 终局时把最后待分析的一手补上 */
    if (!pending) return;
    var job = pending; pending = null;
    if (!job.preBoard) return;
    try {
      var phase = XQSTORE.phaseFor(job.preBoard, job.ply);
      var a = XQSTORE.analyzeMove(job.preBoard, job.move, { depth: 4, budget: 450 });
      if (record) XQSTORE.recordMove(record, job.preBoard, job.move, a, phase);
    } catch (e) {}
  }

  /* ---------- 电脑走棋 ---------- */

  function aiTurn() {
    thinking = true;
    var hybrid = selMode.value === 'hybrid' && XQAI.isConfigured();
    setStatus('<span class="dot gray pulse"></span><span>电脑' + (hybrid ? '（大模型思考中）' : '计算中') + '…</span>', false);
    render();

    if (hybrid) { hybridTurn(); return; }

    setTimeout(function () {
      var t0 = Date.now();
      var res = XQ.pickMove(board, 'b', selLevel.value);
      elInfo.textContent = '本地引擎 ' + (res.depth || 0) + ' 层 · ' + (Date.now() - t0) + 'ms';
      thinking = false;
      if (!res.move) { onMoveSettled(); return; }
      playMove(res.move, {});
    }, 30);
  }

  function hybridTurn() {
    var cands = XQ.topMoves(board, 'b', 5, 5, 2500);
    if (!cands.length) { thinking = false; onMoveSettled(); return; }
    showPanel('大模型选着', '引擎已算出 ' + cands.length + ' 个合法候选，正在请模型选择…');

    XQAI.chat(XQAI.pickMoveMessages({ board: board, side: 'b', candidates: cands }), {
      maxTokens: 2500, temperature: 0.3,
      onReasoning: function (d, all) { panelTitle.textContent = '大模型选着（思考中 ' + all.length + ' 字）'; },
      onDelta: function (d, all) { panelBody.textContent = all; }
    }).then(function (r) {
      var obj = XQAI.extractJson(r.content);
      var mv = obj ? XQ.findMoveByLabel(board, 'b', obj.move) : null;
      var fallback = !mv;
      var used = fallback ? cands[0].label : obj.move;
      if (fallback) mv = cands[0].move;

      var body = '引擎候选：' + cands.map(function (c) { return c.label + '(' + c.score + ')'; }).join('  ') + '\n\n';
      body += '模型选择：' + used + (fallback ? '（模型给的着法无法识别，已回退到引擎首选）' : '');
      if (obj && obj.reason) body += '\n理由：' + obj.reason;
      body += '\n\n引擎推荐：' + cands[0].label + '（评估 ' + cands[0].score + '）';
      panelTitle.textContent = '大模型选着';
      panelBody.textContent = body;

      thinking = false;
      playMove(mv, {});
    }).catch(function (e) {
      panelTitle.textContent = '大模型选着（已回退）';
      panelBody.textContent = '调用失败：' + e.message + '\n\n已自动改用本地引擎走子。';
      var res = XQ.pickMove(board, 'b', selLevel.value);
      thinking = false;
      if (res.move) playMove(res.move, {});
      else onMoveSettled();
    });
  }

  /* ---------- 评估 ---------- */

  function updateEval() {
    if (gameOver) return;
    var r = XQ.searchRoot(board, turn, 3, 500);
    redScore = turn === 'r' ? r.score : -r.score;
    paintEval();
    XQ.syncHash(board, turn);
  }

  function paintEval() {
    var redPct = Math.round(XQ.winRate(redScore) * 100);
    elRedPct.textContent = redPct + '%';
    elBlackPct.textContent = (100 - redPct) + '%';
    elEvalFill.style.width = redPct + '%';
    elEvalText.textContent = formatEval(redScore);
  }

  /* ---------- 走子记录 ---------- */

  var MARKS = { mistake: '?', blunder: '??' };

  function renderMoves() {
    if (!history.length) {
      elMoves.innerHTML = '<div class="empty">对局记录会显示在这里</div>';
      return;
    }
    var marks = {};
    if (record && record.evals) {
      record.evals.forEach(function (e) {
        if (e.grade === 'mistake' || e.grade === 'blunder') marks[e.ply] = MARKS[e.grade];
      });
    }
    var parts = ['<div class="moves-title"><span>' + sceneName + '</span><span>' + Math.ceil(history.length / 2) + ' 回合</span></div>'];
    for (var i = 0; i < history.length; i += 2) {
      var a = history[i], b = history[i + 1];
      var ra = marks[i + 1] ? '<span class="tag ' + (marks[i + 1] === '??' ? 'blunder' : 'mistake') + '">' + marks[i + 1] + '</span>' : '';
      var rb = marks[i + 2] ? '<span class="tag ' + (marks[i + 2] === '??' ? 'blunder' : 'mistake') + '">' + marks[i + 2] + '</span>' : '';
      parts.push('<div class="mv"><span class="n">' + ((i / 2) + 1) + '.</span>' +
        '<span class="r">' + a.label + ra + '</span>' +
        (b ? '<span class="b">' + b.label + rb + '</span>' : '<span class="b"></span>') + '</div>');
    }
    elMoves.innerHTML = parts.join('');
    elMoves.scrollTop = elMoves.scrollHeight;
  }

  /* ---------- 棋盘交互 ---------- */

  function onTap(clientX, clientY) {
    if (gameOver || thinking || animating || demo.on || turn !== 'r') return;
    var i = XQBOARD.squareAt(clientX, clientY);
    if (i < 0) return;

    if (selected >= 0) {
      var mv = findMove(selected, i);
      if (mv) { playMove(mv, { track: true }); return; }
    }
    if (board[i] !== XQ.EMPTY && XQ.sideOf(board[i]) === 'r') {
      selected = i; hintMove = null;
    } else {
      selected = -1;
    }
    render();
  }

  cvs.addEventListener('click', function (e) { onTap(e.clientX, e.clientY); });
  cvs.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    onTap(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  /* ---------- 按钮 ---------- */

  btnHint.onclick = function () {
    if (thinking || animating || gameOver || turn !== 'r') return;
    thinking = true; btnHint.disabled = true;
    setStatus('<span class="dot gray pulse"></span><span>正在计算…</span>', false);
    setTimeout(function () {
      var t0 = Date.now();
      var cands = XQ.topMoves(board, 'r', 4, 5, 2500);
      thinking = false;
      if (!cands.length) { setStatus('<span class="dot gray"></span><span>没有可走的着法。</span>', true); render(); return; }
      hintMove = cands[0].move;
      elInfo.textContent = '本地引擎 · ' + (Date.now() - t0) + 'ms';
      XQ.syncHash(board, turn);

      var cap = XQ.makeMove(board, hintMove);
      var mate = !XQ.hasLegalMove(board, XQ.other(turn));
      XQ.undoMove(board, hintMove, cap);
      XQ.syncHash(board, turn);

      setStatus('<span class="dot"></span><span>推荐 <b>' + cands[0].label + '</b>' +
        (mate ? '（一步将死）' : '') + '　' + formatEval(cands[0].score) + '</span>', false);

      showPanel('着法建议',
        '首选：' + cands[0].label + '　评估 ' + cands[0].score + (mate ? '\n结论：这一步直接成杀。' : '') +
        '\n\n完整候选：\n' + cands.map(function (c, i) { return (i + 1) + '. ' + c.label + '　评估 ' + c.score; }).join('\n'));
      panelAction('让 AI 讲解这一步', function () {
        coach('请解释为什么推荐走 ' + cands[0].label + '，以及走了之后对方最可能怎么应对。');
      });
      render();
    }, 30);
  };

  btnUndo.onclick = function () {
    if (thinking || animating || !history.length) return;
    XQBOARD.cancelAnim();
    animating = false;
    while (history.length > 0 && turn !== 'r') {
      var h = history.pop();
      XQ.undoMove(board, h.m, h.cap);
      turn = XQ.other(turn);
    }
    if (history.length >= 2) {
      var h1 = history.pop(); XQ.undoMove(board, h1.m, h1.cap); turn = XQ.other(turn);
      var h2 = history.pop(); XQ.undoMove(board, h2.m, h2.cap); turn = XQ.other(turn);
      if (turn !== 'r') { var h3 = history.pop(); XQ.undoMove(board, h3.m, h3.cap); turn = XQ.other(turn); }
    }
    selected = -1; hintMove = null; gameOver = false; pending = null;
    lastMove = history.length ? history[history.length - 1].m : null;
    if (record) {
      record.moves = history.map(function (h) { return [h.m[0], h.m[1]]; });
      record.ply = history.length;
      record.finished = false;
      record.result = 'unfinished';
    }
    refreshLegal(); updateEval();
    setStatus('<span class="dot red"></span><span>已悔棋，轮到你走（红方）</span>', false);
    render();
  };

  btnRestart.onclick = function () { loadScene(sceneId); };

  btnSave.onclick = function () {
    if (!record || !history.length) return;
    record.savedAt = Date.now();
    XQSTORE.saveGame(record);
    toast('已存入战绩', '', 1500);
    renderStats();
  };

  selScene.onchange = function () { loadScene(selScene.value); };
  selLevel.onchange = function () {
    setStatus('<span class="dot gray"></span><span>难度已切换为「' + selLevel.options[selLevel.selectedIndex].text.replace('难度：', '') + '」</span>', false);
  };
  selMode.onchange = function () {
    var t = selMode.value === 'hybrid'
      ? '已切换为「引擎 + 大模型协作」：引擎算出合法候选，模型从中选择并说明理由。'
      : '已切换回纯本地引擎对弈。';
    if (selMode.value === 'hybrid' && !XQAI.isConfigured()) t += '（尚未配置 API Key，将自动使用本地引擎。）';
    setStatus('<span class="dot gray"></span><span>' + t + '</span>', false);
  };

  /* ---------- 面板 ---------- */

  function showPanel(title, text) {
    panelTitle.textContent = title;
    panelBody.textContent = text || '';
    panelBody.className = 'panel-body';
    panelFoot.innerHTML = '';
    panel.className = 'card panel on';
  }
  function panelAction(label, fn) {
    var b = document.createElement('button');
    b.className = 'tiny ghost'; b.style.width = 'auto';
    b.textContent = label; b.onclick = fn;
    panelFoot.appendChild(b);
  }
  $('panelClose').onclick = function () { panel.className = 'card panel'; };

  /* ---------- 大模型 ---------- */

  function collectContext() {
    return {
      board: board, side: turn,
      moveText: XQ.movesToText(startFen, history.map(function (h) { return h.m; })),
      engineScore: redScore,
      candidates: XQ.topMoves(board, 'r', 4, 4, 2000),
      inCheck: XQ.inCheck(board, turn)
    };
  }

  function requireConfig() {
    if (XQAI.isConfigured()) return true;
    showPanel('尚未配置模型', '点右上角齿轮填写接口地址、API Key 和模型名。\n\n默认已填好 DeepSeek 的地址，通常只需确认 Key。');
    panelAction('打开设置', openSettings);
    return false;
  }

  function afterAi(r, t0) {
    var text = (r.content || '').trim();
    if (!text) {
      panelBody.textContent = '模型这次没有返回正文，输出全花在思维链上了。\n\n' +
        '到「设置」把 max_tokens 调大（建议 5000 以上），或换用 deepseek-v4-pro。';
      panelBody.className = 'panel-body err';
      panelTitle.textContent = '没有正文';
      return;
    }
    panelTitle.textContent = panelTitle.textContent.replace(/（[^）]*）$/, '') + '（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）';
    panelBody.textContent = text + (r.truncated ? '\n\n—— 输出已达 max_tokens 上限，最后一段可能被截断。' : '');
    if (r.usage) elInfo.textContent = '模型输出 ' + r.usage.completion_tokens + ' token';
  }

  function coach(question) {
    if (aiBusy || !requireConfig()) return;
    aiBusy = true;
    showPanel('教练点评', '正在整理局面并请求模型…');
    var ctx = collectContext();
    var t0 = Date.now();
    XQAI.chat(XQAI.coachMessages(ctx, question), {
      maxTokens: 4000,
      onRetry: function (n, tokens) { panelBody.textContent = '上一次输出被思维链占满，正在用更大的预算重试（' + tokens + ' token）…'; },
      onReasoning: function (d, all) { panelTitle.textContent = '教练点评（思考中 ' + all.length + ' 字）'; },
      onDelta: function (d, all) { panelBody.textContent = all; }
    }).then(function (r) {
      afterAi(r, t0);
      if ((r.content || '').trim()) {
        panelFoot.innerHTML = '';
        panelAction('继续追问', openAsk);
        if (ctx.candidates.length) panelAction('在棋盘上标出推荐着法', function () { hintMove = ctx.candidates[0].move; render(); });
      }
    }).catch(function (e) {
      panelBody.textContent = '调用失败：' + e.message;
      panelBody.className = 'panel-body err';
    }).finally(function () { aiBusy = false; });
  }

  function openAsk() {
    panelFoot.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px;width:100%';
    var input = document.createElement('input');
    input.placeholder = '继续问教练…';
    var btn = document.createElement('button');
    btn.className = 'tiny primary'; btn.textContent = '提问'; btn.style.width = '72px';
    btn.onclick = function () { var q = input.value.trim(); if (q) coach(q); };
    input.onkeydown = function (e) { if (e.key === 'Enter') btn.onclick(); };
    wrap.appendChild(input); wrap.appendChild(btn);
    panelFoot.appendChild(wrap);
    input.focus();
  }

  btnCoach.onclick = function () { coach(null); };

  btnReview.onclick = function () {
    if (aiBusy || !requireConfig()) return;
    if (history.length < 6) { showPanel('复盘', '至少走满 3 个回合再复盘比较有意义，先多下几步。'); return; }
    aiBusy = true;
    showPanel('复盘报告', '正在整理棋谱…');
    var moveText = XQ.movesToText(startFen, history.map(function (h) { return h.m; }));
    var trace = (record && record.evals ? record.evals : []).map(function (e) { return '第' + e.ply + '手 ' + e.redScore; });
    var t0 = Date.now();
    XQAI.chat(XQAI.reviewMessages({
      moveText: moveText,
      result: gameOver ? (record && record.result === 'win' ? '红方（你）获胜' : '黑方获胜') : '对局进行中',
      endBoard: board, evalTrace: trace
    }), {
      maxTokens: 8000,
      onRetry: function (n, tokens) { panelBody.textContent = '上一次输出被思维链占满，正在用更大的预算重试（' + tokens + ' token）…'; },
      onReasoning: function (d, all) { panelTitle.textContent = '复盘报告（思考中 ' + all.length + ' 字）'; },
      onDelta: function (d, all) { panelBody.textContent = all; }
    }).then(function (r) {
      afterAi(r, t0);
      if ((r.content || '').trim()) {
        panelFoot.innerHTML = '';
        panelAction('复制棋谱', function () {
          if (navigator.clipboard) navigator.clipboard.writeText(moveText);
          else window.prompt('复制棋谱', moveText);
        });
      }
    }).catch(function (e) {
      panelBody.textContent = '调用失败：' + e.message;
      panelBody.className = 'panel-body err';
    }).finally(function () { aiBusy = false; });
  };

  /* ---------- 训练页 ---------- */

  function drillCard(d) {
    return '<div class="drill" data-scene="' + d.scene + '">' +
      '<span class="badge">' + (d.badge || '练') + '</span>' +
      '<span class="meta"><span class="t">' + d.title + '</span>' +
      '<span class="d">' + (d.desc || '') + '</span></span>' +
      '<span class="go">›</span></div>';
  }

  function renderTraining() {
    var drills = XQSTORE.recommendDrills(3);
    var ab = XQSTORE.computeAbilities();
    var weakest = ab.dimensions.slice().sort(function (a, b) { return a.score - b.score; })[0];
    $('drillHint').textContent = ab.hasData && weakest ? ('弱项：' + weakest.name) : '先下一局，系统才知道你的弱项';
    $('drillList').innerHTML = drills.map(drillCard).join('') ||
      '<div class="empty-state">开始一局对弈后，这里会给出针对性建议</div>';

    var solved = XQSTORE.solvedDrills();
    var solvedSet = {};
    solved.forEach(function (s) { solvedSet[s] = 1; });
    var mateSolved = XQLIB.MATES.filter(function (m) { return solvedSet['mate:' + m.id]; }).length;
    $('mateProgress').textContent = mateSolved + ' / ' + XQLIB.MATES.length + ' 已通';
    $('mateList').innerHTML = XQLIB.MATES.map(function (m) {
      var done = solvedSet['mate:' + m.id];
      return '<div class="drill" data-scene="mate:' + m.id + '">' +
        '<span class="badge" style="' + (done ? 'background:#e6f4ef;color:#0f6e56' : 'background:#f4f1ea;color:#938b7e') + '">' +
        (done ? '✓' : (m.tier === 1 ? '一' : '二')) + '</span>' +
        '<span class="meta"><span class="t">' + m.name + '</span>' +
        '<span class="d">' + (m.tier === 1 ? '一步杀' : '两步杀') + '</span></span>' +
        '<span class="go">›</span></div>';
    }).join('');

    $('openingList').innerHTML = XQLIB.OPENINGS.map(function (o) {
      return '<div class="drill" data-scene="opening:' + o.id + '">' +
        '<span class="badge">局</span>' +
        '<span class="meta"><span class="t">' + o.name + '</span>' +
        '<span class="d">' + o.style + '</span></span>' +
        '<span class="go">›</span></div>';
    }).join('');

    $('studyList').innerHTML = XQLIB.STUDIES.map(function (s) {
      return '<div class="drill" data-scene="study:' + s.id + '">' +
        '<span class="badge">残</span>' +
        '<span class="meta"><span class="t">' + s.name + '</span>' +
        '<span class="d">红先取胜</span></span>' +
        '<span class="go">›</span></div>';
    }).join('');
  }

  /* ---------- 战绩页 ---------- */

  function renderStats() {
    var ab = XQSTORE.computeAbilities();
    var s = ab.stat;

    $('statGrid').innerHTML = [
      { v: s.games, k: '总对局', cls: '' },
      { v: s.finished ? s.winRate + '%' : '—', k: '胜率', cls: s.winRate >= 50 ? 'good' : 'bad' },
      { v: s.avgPly, k: '平均回合', cls: '' },
      { v: s.solvedMates + '/' + s.mateTotal, k: '杀法通关', cls: 'good' },
      { v: s.blunders, k: '严重失误', cls: s.blunders ? 'bad' : 'good' },
      { v: s.mistakes, k: '失误', cls: s.mistakes ? 'warn' : 'good' },
      { v: s.missedMate, k: '漏杀', cls: s.missedMate ? 'bad' : 'good' }
    ].map(function (x) {
      return '<div class="stat ' + x.cls + '"><div class="v">' + x.v + '</div><div class="k">' + x.k + '</div></div>';
    }).join('');

    $('overallScore').textContent = ab.hasData ? ('综合 ' + ab.overall + ' 分') : '暂无数据';

    $('abilityBox').innerHTML = ab.dimensions.map(function (d) {
      var cls = d.score >= 70 ? 'good' : (d.score >= 45 ? 'mid' : 'bad');
      return '<div class="abil-row">' +
        '<div class="abil-top"><span class="name">' + d.name + '</span>' +
        '<span class="score ' + cls + '">' + d.score + '</span></div>' +
        '<div class="abil-bar"><i class="' + cls + '" style="width:' + d.score + '%"></i></div>' +
        '<span class="abil-note">' + d.note + '</span></div>';
    }).join('');

    var games = XQSTORE.listGames();
    if (!games.length) {
      $('gameList').innerHTML = '<div class="card empty-state"><span class="big">♟</span>还没有存档。<br>下完一局会自动存起来，也可以随时点「存档」。</div>';
      return;
    }
    $('gameList').innerHTML = games.slice(0, 30).map(function (g) {
      var cls = g.result === 'win' ? 'win' : (g.result === 'loss' ? 'loss' : (g.finished ? 'draw' : 'open'));
      var txt = g.result === 'win' ? '胜' : (g.result === 'loss' ? '负' : (g.finished ? '和' : '未完'));
      var d = new Date(g.savedAt);
      var when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      return '<div class="rec" style="margin-bottom:8px">' +
        '<span class="out ' + cls + '">' + txt + '</span>' +
        '<span class="meta"><span class="t">' + g.sceneName + '</span>' +
        '<span class="d">' + when + ' · ' + Math.ceil(g.ply / 2) + ' 回合' +
        (g.flags && g.flags.blunders ? ' · 严重失误 ' + g.flags.blunders : '') + '</span></span>' +
        '<span class="acts">' +
        '<button class="tiny" data-load="' + g.id + '">载入</button>' +
        '<button class="tiny ghost" data-del="' + g.id + '">删</button>' +
        '</span></div>';
    }).join('');
  }

  $('btnClearGames').onclick = function () {
    if (!confirm('确定清空所有对局存档和练习记录？此操作不可撤销。')) return;
    XQSTORE.resetAll();
    renderStats(); renderTraining();
    toast('已清空存档', '', 1500);
  };

  /* 列表点击（事件委托） */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var sceneEl = t.closest ? t.closest('[data-scene]') : null;
    if (sceneEl) {
      var sid = sceneEl.getAttribute('data-scene');
      goTab('play');
      selScene.value = sid;
      loadScene(sid);
      return;
    }
    var loadEl = t.closest ? t.closest('[data-load]') : null;
    if (loadEl) { loadGame(loadEl.getAttribute('data-load')); return; }
    var delEl = t.closest ? t.closest('[data-del]') : null;
    if (delEl) {
      XQSTORE.deleteGame(delEl.getAttribute('data-del'));
      renderStats();
      toast('已删除', '', 1200);
      return;
    }
  });

  function loadGame(id) {
    var g = XQSTORE.getGame(id);
    if (!g) return;
    goTab('play');
    sceneId = g.sceneId || 'start';
    sceneName = g.sceneName || '存档对局';
    startFen = g.startFen || XQ.START;
    board = XQ.parseBoard(startFen);
    history = []; lastMove = null; selected = -1; hintMove = null;
    gameOver = false; thinking = false; animating = false; pending = null;
    XQBOARD.cancelAnim();
    turn = 'r';
    for (var i = 0; i < g.moves.length; i++) {
      var m = g.moves[i];
      var label = XQ.moveLabel(board, m);
      var cap = XQ.makeMove(board, m);
      history.push({ m: [m[0], m[1]], cap: cap, label: label, side: turn });
      lastMove = m;
      turn = XQ.other(turn);
    }
    record = g;
    record.id = g.id;
    selScene.value = sceneId;
    if (selScene.value !== sceneId) selScene.selectedIndex = 0;
    refreshLegal();
    updateEval();
    setStatus('<span class="dot red"></span><span>已载入存档「' + sceneName + '」，轮到你走（红方）</span>', false);
    showPanel('载入存档', '共 ' + Math.ceil(g.moves.length / 2) + ' 回合。\n可以继续下，也可以点「悔棋」回看。');
    render();
  }

  /* ---------- 页面切换 ---------- */

  function goTab(name) {
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) pages[i].className = 'page' + (pages[i].id === 'page-' + name ? ' on' : '');
    var btns = document.querySelectorAll('#tabs button');
    for (var j = 0; j < btns.length; j++) {
      btns[j].className = btns[j].getAttribute('data-page') === name ? 'on' : '';
    }
    if (name === 'stats') renderStats();
    if (name === 'train') renderTraining();
    if (name === 'play') { XQBOARD.resize(); XQBOARD.invalidate(); }
    window.scrollTo(0, 0);
  }

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-page]') : null;
    if (b) goTab(b.getAttribute('data-page'));
  });

  /* ---------- 设置 ---------- */

  var cfgBase = $('cfgBase'), cfgKey = $('cfgKey'), cfgModel = $('cfgModel');
  var cfgTemp = $('cfgTemp'), cfgMax = $('cfgMax'), cfgTimeout = $('cfgTimeout');
  var cfgMsg = $('cfgMsg'), modelList = $('modelList');

  function cfgShow(text, kind) {
    cfgMsg.style.display = text ? 'block' : 'none';
    cfgMsg.textContent = text || '';
    cfgMsg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function fillSettings() {
    var c = XQAI.getConfig();
    cfgBase.value = c.baseUrl || '';
    cfgKey.value = c.apiKey || '';
    cfgModel.value = c.model || '';
    cfgTemp.value = c.temperature;
    cfgMax.value = c.maxTokens;
    cfgTimeout.value = Math.round((c.timeoutMs || 180000) / 1000);
    modelList.innerHTML = (c.knownModels || []).map(function (m) { return '<option value="' + m + '"></option>'; }).join('');
    cfgShow('');
  }

  function openSettings() { fillSettings(); overlay.className = 'overlay on'; }
  function closeSettings() { overlay.className = 'overlay'; }
  btnSettings.onclick = openSettings;

  /* ---------- 打谱演示按钮 ---------- */

  btnDemoMain.onclick = function () { demoToggle(); };
  btnDemoNext.onclick = function () { if (!demo.playing) demoStep(); };
  btnDemoExit.onclick = function () { exitDemo(); };

  /* ---------- 棋谱导入导出 ---------- */

  function copyText(text, cb) {
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { cb(true); }, function () { cb(fallback()); });
    } else cb(fallback());
  }

  function ioShow(text, kind) {
    ioMsg.textContent = text || '';
    ioMsg.style.display = text ? '' : 'none';
    ioMsg.className = 'io-note ' + (kind || '');
  }

  function ioShareText() {
    var out = ['象棋教练 · ' + sceneName, '', '【初始局面】', startFen];
    var mt = $('ioMoves').value;
    if (mt) out.push('', '【棋谱】', mt, '', '【着法坐标】', $('ioCoords').value);
    out.push('', '【当前局面】', XQ.boardToString(board));
    return out.join('\n');
  }

  function ioRefresh() {
    $('ioFen').value = XQ.boardToString(board);
    $('ioMoves').value = XQ.movesToText(startFen, history.map(function (h) { return h.m; }));
    $('ioCoords').value = history.map(function (h) { return h.m[0] + ',' + h.m[1]; }).join(',');
  }

  function openIO() {
    ioRefresh();
    ioShow('', '');
    ioOverlay.className = 'overlay on';
  }
  function closeIO() { ioOverlay.className = 'overlay'; }

  btnNotation.onclick = openIO;
  $('ioClose').onclick = closeIO;
  ioOverlay.addEventListener('click', function (e) { if (e.target === ioOverlay) closeIO(); });
  $('ioClear').onclick = function () { $('ioInput').value = ''; ioShow('', ''); };

  $('ioCopy').onclick = function () {
    copyText(ioShareText(), function (ok) {
      ioShow(ok ? '已复制到剪贴板。' : '复制失败，请长按文本框手动选择。', ok ? 'ok' : 'err');
    });
  };

  $('ioShare').onclick = function () {
    var text = ioShareText();
    if (navigator.share) {
      navigator.share({ title: '象棋教练 · ' + sceneName, text: text })['catch'](function () {});
    } else {
      copyText(text, function (ok) {
        ioShow(ok ? '当前浏览器不支持系统分享，已复制到剪贴板。' : '分享不可用。', ok ? 'ok' : 'err');
      });
    }
  };

  $('ioImport').onclick = function () {
    var err = importText($('ioInput').value);
    if (err) ioShow(err, 'err');
    else { ioShow('导入成功，已切换到这个局面。', 'ok'); ioRefresh(); }
  };

  /* 校验并规范化一个局面串。返回 null 表示这不是一个可用局面。 */
  function validateFEN(s) {
    var str = String(s || '').trim();
    var rows = str.split('/');
    if (rows.length !== 10) return null;
    for (var i = 0; i < 10; i++) {
      if (rows[i].length !== 9) return null;
      if (!/^[KABNRCPkabnrcp.]+$/.test(rows[i])) return null;
    }
    var b = XQ.parseBoard(str);
    var kr = -1, kb = -1, rk = 0, bk = 0;
    for (var j = 0; j < 90; j++) {
      if (b[j] === 'K') { kr = j; rk++; }
      else if (b[j] === 'k') { kb = j; bk++; }
    }
    /* 必须恰好一个帅一个将，而且都在九宫里 —— 否则引擎会算出离谱的结果 */
    if (rk !== 1 || bk !== 1) return null;
    var rr = (kr / 9) | 0, rc = kr % 9;
    if (rr < 7 || rc < 3 || rc > 5) return null;
    var br = (kb / 9) | 0, bc = kb % 9;
    if (br > 2 || bc < 3 || bc > 5) return null;
    if (XQ.kingsFacing(b)) return null;
    return XQ.boardToString(b);
  }

  /* 导入统一走这里，返回 null 表示成功，否则返回给用户看的说明 */
  function importText(raw) {
    var text = String(raw || '').trim();
    if (!text) return '没有内容可导入。';

    /* ① 局面串 */
    var tokens = text.split(/[\s,，、;；]+/);
    for (var i = 0; i < tokens.length; i++) {
      var fen = validateFEN(tokens[i].replace(/[：:。()（）]/g, ''));
      if (fen) { applyImportedFen(fen); return null; }
    }

    /* ② 中文棋谱 */
    var labels = text.split(/\s+/).filter(function (t) { return /[平进退]/.test(t); });
    if (labels.length) return applyImportedMoves(labels);

    /* ③ 着法坐标 */
    var nums = (text.match(/\d+/g) || []).map(Number);
    if (nums.length >= 2 && nums.length % 2 === 0
        && nums.every(function (n) { return n >= 0 && n < 90; })) {
      return applyImportedCoords(nums);
    }
    return '没认出可导入的内容。\n\n可以粘贴：\n· FEN 局面串\n· 中文棋谱，如「炮二平五 马8进7」\n· 着法坐标，如「67,40,19,46」';
  }

  function resetForImport() {
    history = []; selected = -1; lastMove = null; hintMove = null;
    thinking = false; gameOver = false; redScore = 0; animating = false;
    pending = null; aiBusy = false;
    turn = 'r';
    resetDemo();
    XQBOARD.cancelAnim();
  }

  function applyImportedFen(fen) {
    sceneId = 'custom';
    sceneName = '导入的局面';
    startFen = fen;
    board = XQ.parseBoard(fen);
    resetForImport();
    record = XQSTORE.createGame({
      sceneId: sceneId, sceneName: sceneName, level: selLevel.value,
      mode: selMode.value, startFen: startFen
    });
    refreshLegal(); updateEval(); render(); renderDemo(); renderTraining(); renderStats();
    setStatus('<span class="dot red"></span><span>已导入局面，轮到<b>你</b>走（红方）</span>', false);
  }

  function installImported(moves, note) {
    sceneId = 'custom';
    sceneName = '导入的棋谱';
    startFen = XQ.START;
    board = XQ.parseBoard(startFen);
    resetForImport();
    for (var i = 0; i < moves.length; i++) {
      var mv = moves[i];
      var label = XQ.moveLabel(board, mv);
      var cap = XQ.makeMove(board, mv);
      history.push({ m: [mv[0], mv[1]], cap: cap, label: label, side: turn });
      lastMove = mv;
      turn = XQ.other(turn);
    }
    record = XQSTORE.createGame({
      sceneId: sceneId, sceneName: sceneName, level: selLevel.value,
      mode: selMode.value, startFen: startFen
    });
    history.forEach(function (h) { record.moves.push([h.m[0], h.m[1]]); record.ply++; });
    refreshLegal(); updateEval(); render(); renderDemo(); renderTraining(); renderStats();
    setStatus('<span class="dot red"></span><span>' + note + '</span>', false);
  }

  function applyImportedMoves(labels) {
    var b = XQ.parseBoard(XQ.START), side = 'r', applied = [], rejected = null;
    for (var i = 0; i < labels.length; i++) {
      var m = XQ.findMoveByLabel(b, side, labels[i]);
      if (!m) { rejected = labels[i]; break; }
      applied.push(m);
      XQ.makeMove(b, m);
      side = XQ.other(side);
    }
    if (!applied.length) return '第一手「' + (rejected || labels[0]) + '」从标准开局走不通。';
    installImported(applied, rejected
      ? '已按棋谱走 ' + applied.length + ' 手；「' + rejected + '」之后的着法没认出来，停在合法处。'
      : '已按棋谱走完 ' + applied.length + ' 手。');
    return null;
  }

  function applyImportedCoords(nums) {
    var b = XQ.parseBoard(XQ.START), side = 'r', applied = [];
    for (var i = 0; i + 1 < nums.length; i += 2) {
      var legal = XQ.legalMoves(b, side), hit = null;
      for (var j = 0; j < legal.length; j++) {
        if (legal[j][0] === nums[i] && legal[j][1] === nums[i + 1]) { hit = legal[j]; break; }
      }
      if (!hit) {
        if (!applied.length) return '第一手「' + nums[i] + '→' + nums[i + 1] + '」在当前局面不合法。';
        break;
      }
      applied.push(hit);
      XQ.makeMove(b, hit);
      side = XQ.other(side);
    }
    if (!applied.length) return '没能识别出任何合法着法。';
    installImported(applied, '按坐标导入，共 ' + applied.length + ' 手。');
    return null;
  }
  $('cfgCancel').onclick = closeSettings;
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSettings(); });

  function settingsPatch() {
    return {
      baseUrl: cfgBase.value.trim(),
      apiKey: cfgKey.value.trim(),
      model: cfgModel.value.trim(),
      temperature: parseFloat(cfgTemp.value),
      maxTokens: parseInt(cfgMax.value, 10),
      timeoutMs: Math.max(10, parseInt(cfgTimeout.value, 10) || 180) * 1000
    };
  }

  $('cfgSave').onclick = function () {
    var p = settingsPatch();
    if (isNaN(p.temperature)) p.temperature = 0.6;
    if (isNaN(p.maxTokens) || p.maxTokens < 256) p.maxTokens = 6000;
    XQAI.saveConfig(p);
    cfgShow('已保存。', 'ok');
    setTimeout(closeSettings, 600);
  };

  $('cfgRestore').onclick = function () { XQAI.resetConfig(); fillSettings(); cfgShow('已恢复默认配置。', 'ok'); };

  $('cfgResetData').onclick = function () {
    XQSTORE.resetAll();
    renderStats(); renderTraining();
    cfgShow('本机所有对局存档与练习记录已清空。', 'ok');
  };

  $('cfgFetch').onclick = function () {
    cfgShow('正在拉取…');
    XQAI.saveConfig(settingsPatch());
    XQAI.listModels().then(function (list) {
      modelList.innerHTML = list.map(function (m) { return '<option value="' + m + '"></option>'; }).join('');
      cfgShow('接口返回 ' + list.length + ' 个模型：' + list.join('、'), 'ok');
      if (list.length && list.indexOf(cfgModel.value) < 0) cfgModel.value = list[0];
    }).catch(function (e) { cfgShow('拉取失败：' + e.message, 'err'); });
  };

  $('cfgTest').onclick = function () {
    cfgShow('正在测试…（推理模型可能要十几秒）');
    XQAI.saveConfig(settingsPatch());
    XQAI.testConnection().then(function (r) {
      cfgShow('连接正常，' + (r.ms / 1000).toFixed(1) + ' 秒返回。\n正文：' + (r.reply || '(空)') +
        '\n本次思维链消耗 ' + r.reasoningTokens + ' token', 'ok');
    }).catch(function (e) { cfgShow('连接失败：' + e.message, 'err'); });
  };

  /* ---------- 启动 ---------- */

  window.addEventListener('resize', function () { XQBOARD.resize(); });

  buildScenes();
  XQBOARD.mount(cvs);
  loadScene('start', true);
  panel.className = 'card panel';
  goTab('play');

  /* 自动化测试钩子 */
  window.__xq = {
    play: function (label) {
      var mv = XQ.findMoveByLabel(board, 'r', label);
      if (!mv) return false;
      playMove(mv, { track: true });
      return true;
    },
    state: function () {
      return {
        turn: turn, ply: history.length, gameOver: gameOver,
        redScore: redScore, animating: animating, scene: sceneId,
        evalText: elEvalText.textContent,
        status: elStatus.innerText.replace(/\s+/g, ' '),
        toast: elToast.textContent,
        toastOn: elToast.className.indexOf('on') >= 0,
        report: XQSTORE.computeAbilities(),
        drills: XQSTORE.recommendDrills(3).map(function (d) { return d.title; })
      };
    },
    scene: loadScene,
    tab: goTab,
    save: function () { btnSave.onclick(); },
    demo: {
      start: startDemo, step: demoStep, toggle: demoToggle, exit: exitDemo,
      state: function () {
        return {
          on: demo.on, playing: demo.playing, index: demo.index,
          total: demo.moves.length, note: demo.note, labels: demo.labels.slice()
        };
      }
    },
    io: {
      open: openIO, close: closeIO, refresh: ioRefresh,
      import: importText, exportText: ioShareText, validateFEN: validateFEN,
      fields: function () {
        ioRefresh();   // 先刷新，保证拿到的是当前局面而不是上次打开面板时的快照
        return { fen: $('ioFen').value, moves: $('ioMoves').value, coords: $('ioCoords').value };
      }
    }
  };
})();
