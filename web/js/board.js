/* 棋盘渲染与动画
 *
 * 关键点：落子不是「棋盘状态直接跳变」，而是先让视觉追上来 ——
 * 棋子从起点滑到终点（约 0.45 秒），被吃的子同时淡出下沉，
 * 这样使用者能看清到底是谁走到了哪里、吃了什么。
 */
(function (root) {
  'use strict';

  var XQ = root.XQ;
  var EMPTY = '.';

  var CELL = 44;
  var MARGIN = 36;
  var BW = 8 * CELL + 2 * MARGIN;
  var BH = 9 * CELL + 2 * MARGIN;

  var SLIDE_MS = 460;
  var CAPTURE_MS = 420;
  var SETTLE_MS = 520;

  var cvs = null, ctx = null, scale = 1, dpr = 1;
  var raf = 0, dirty = true;
  var lastFrame = 0;

  var st = {
    board: null,
    turn: 'r',
    selected: -1,
    targets: [],
    lastMove: null,
    hintMove: null,
    checkSide: null,
    showCoords: true
  };

  var anim = null;   /* {from,to,piece,cap,capIdx,t0,phase:'slide'|'settle',onDone} */
  var pulseT0 = 0;

  var PIECE_CHAR = {
    K: '\u5e05', A: '\u4ed5', B: '\u76f8', N: '\u9a6c', R: '\u8f66', C: '\u70ae', P: '\u5175',
    k: '\u5c06', a: '\u58eb', b: '\u8c61', n: '\u9a6c', r: '\u8f66', c: '\u70ae', p: '\u5352'
  };

  function px(c) { return MARGIN + c * CELL; }
  function py(r) { return MARGIN + r * CELL; }
  function idxAt(r, c) { return r * 9 + c; }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ---------- 初始化 ---------- */

  function mount(canvas) {
    cvs = canvas;
    ctx = cvs.getContext('2d');
    resize();
    kick();
  }

  function resize() {
    if (!cvs) return;
    var maxW = Math.min(cvs.parentNode ? cvs.parentNode.clientWidth : 440, 440);
    if (maxW < 120) maxW = 440;
    scale = maxW / BW;
    dpr = window.devicePixelRatio || 1;
    cvs.style.width = (BW * scale) + 'px';
    cvs.style.height = (BH * scale) + 'px';
    cvs.width = Math.round(BW * scale * dpr);
    cvs.height = Math.round(BH * scale * dpr);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    dirty = true;
    kick();
  }

  function setState(patch) {
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) st[k] = patch[k];
    if (patch && 'checkSide' in patch) {
      pulseT0 = performance.now();
      /* 将军圈只呼吸 1.5 秒，之后停住不再空转重绘 */
      pulseUntil = patch.checkSide ? pulseT0 + 1500 : 0;
    }
    dirty = true;
    kick();
  }

  /* ---------- 动画 ---------- */

  /* 动画完成一律由定时器保证，rAF 只用来插值画面。
     原因：rAF 在标签页切到后台、或被系统降频时会停摆，
     如果把「轮到谁走」这种流程控制挂在 rAF 上，整局棋会直接卡死。 */
  function animateMove(move, captured, onDone) {
    stopAnim();
    anim = {
      from: move[0], to: move[1],
      piece: st.board[move[1]],
      cap: captured && captured !== EMPTY ? captured : null,
      t0: performance.now(),
      onDone: onDone || null,
      timer: 0
    };
    anim.timer = setTimeout(function () {
      var cb = anim && anim.onDone;
      anim = null;
      dirty = true;
      kick();
      if (cb) cb();
    }, SLIDE_MS + SETTLE_MS);
    dirty = true;
    kick();
  }

  function isAnimating() { return !!anim; }

  function stopAnim() {
    if (anim && anim.timer) { clearTimeout(anim.timer); anim.timer = 0; }
    anim = null;
    dirty = true;
  }

  function cancelAnim() { stopAnim(); }

  var pulseUntil = 0;

  function kick() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    var need = false;

    if (anim) {
      dirty = true;
      need = true;
    }
    if (now < pulseUntil) {
      dirty = true;
      need = true;
    }

    if (dirty) {
      dirty = false;
      lastFrame = now;
      draw(now);
    }
    if (need) raf = requestAnimationFrame(frame);
  }

  /* ---------- 绘制 ---------- */

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function line(x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  function drawWood() {
    var g = ctx.createLinearGradient(0, 0, BW * 0.35, BH);
    g.addColorStop(0, '#f3e3c3');
    g.addColorStop(0.5, '#eddcb8');
    g.addColorStop(1, '#e3cfa6');
    ctx.fillStyle = g;
    roundRect(0, 0, BW, BH, 14);
    ctx.fill();

    /* 四角轻微压暗，模拟木料边缘 */
    var v = ctx.createRadialGradient(BW / 2, BH / 2, BH * 0.25, BW / 2, BH / 2, BH * 0.78);
    v.addColorStop(0, 'rgba(255,255,255,0)');
    v.addColorStop(1, 'rgba(150,118,72,0.16)');
    ctx.fillStyle = v;
    roundRect(0, 0, BW, BH, 14);
    ctx.fill();
  }

  /* 传统的「十」字定位点 */
  function drawMark(r, c, quadrants) {
    var x = px(c), y = py(r);
    var d = 5, len = 9;
    ctx.strokeStyle = 'rgba(140,106,58,.65)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    for (var i = 0; i < quadrants.length; i++) {
      var sx = quadrants[i][0], sy = quadrants[i][1];
      ctx.beginPath();
      ctx.moveTo(x + sx * d, y + sy * (d + len));
      ctx.lineTo(x + sx * d, y + sy * d);
      ctx.lineTo(x + sx * (d + len), y + sy * d);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  function drawGrid() {
    ctx.strokeStyle = 'rgba(148,112,64,.62)';
    ctx.lineWidth = 1;

    for (var r = 0; r < 10; r++) line(px(0), py(r), px(8), py(r));
    for (var c = 0; c < 9; c++) {
      if (c === 0 || c === 8) line(px(c), py(0), px(c), py(9));
      else {
        line(px(c), py(0), px(c), py(4));
        line(px(c), py(5), px(c), py(9));
      }
    }

    /* 九宫斜线 */
    line(px(3), py(0), px(5), py(2));
    line(px(5), py(0), px(3), py(2));
    line(px(3), py(7), px(5), py(9));
    line(px(5), py(7), px(3), py(9));

    /* 外框加重 */
    ctx.strokeStyle = 'rgba(128,95,52,.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(MARGIN, MARGIN, 8 * CELL, 9 * CELL);

    /* 定位点：炮位与兵位 */
    var T = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    var L = [[1, -1], [1, 1]];
    var R = [[-1, -1], [-1, 1]];
    var TL = [[1, 1]], TR = [[-1, 1]], BL = [[1, -1]], BR = [[-1, -1]];

    drawMark(2, 1, T); drawMark(2, 7, T);
    drawMark(7, 1, T); drawMark(7, 7, T);
    drawMark(3, 0, L); drawMark(3, 2, T); drawMark(3, 4, T); drawMark(3, 6, T); drawMark(3, 8, R);
    drawMark(6, 0, L); drawMark(6, 2, T); drawMark(6, 4, T); drawMark(6, 6, T); drawMark(6, 8, R);
  }

  function drawRiver() {
    ctx.save();
    ctx.fillStyle = 'rgba(138,104,60,.42)';
    ctx.font = '600 17px "Songti SC", "STSong", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '0px';
    ctx.fillText('\u695a  \u6cb3', px(1.65), py(4.42));
    ctx.save();
    ctx.translate(px(6.35), py(4.42));
    ctx.rotate(Math.PI);
    ctx.fillText('\u6c49  \u754c', 0, 0);
    ctx.restore();
    ctx.restore();
  }

  /* 木纹棋子：径向渐变做出微微的立体感 */
  function pieceColors(p) {
    var red = XQ.isRed(p);
    return red
      ? { ring: '#a8281c', ink: '#b4271d', face: ['#fffdf6', '#f8ecd7', '#e8d6b3'] }
      : { ring: '#242220', ink: '#2c2a27', face: ['#fffdf6', '#f5efdf', '#e2d8c4'] };
  }

  function drawPieceAt(p, x, y, opts) {
    opts = opts || {};
    var rad = CELL * 0.43 * (opts.scale || 1);
    var alpha = opts.alpha === undefined ? 1 : opts.alpha;
    var col = pieceColors(p);

    ctx.save();
    ctx.globalAlpha = alpha;

    /* 投影 */
    ctx.beginPath();
    ctx.ellipse(x, y + rad * 0.42, rad * 0.95, rad * 0.34, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(96,70,36,' + (0.22 * alpha) + ')';
    ctx.fill();

    /* 棋面 */
    var g = ctx.createRadialGradient(x - rad * 0.34, y - rad * 0.42, rad * 0.12, x, y, rad * 1.08);
    g.addColorStop(0, col.face[0]);
    g.addColorStop(0.58, col.face[1]);
    g.addColorStop(1, col.face[2]);
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    /* 外圈 */
    ctx.strokeStyle = col.ring;
    ctx.lineWidth = Math.max(1.5, rad * 0.09);
    ctx.stroke();

    /* 内圈细线 */
    ctx.beginPath();
    ctx.arc(x, y, rad * 0.82, 0, Math.PI * 2);
    ctx.strokeStyle = col.ring;
    ctx.globalAlpha = alpha * 0.34;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = alpha;

    /* 字 */
    ctx.fillStyle = col.ink;
    ctx.font = '600 ' + Math.round(rad * 1.32) + 'px "Songti SC", "STSong", "PingFang SC", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PIECE_CHAR[p] || '?', x, y + rad * 0.04);

    ctx.restore();
  }

  function drawHighlights(now) {
    /* 上一步落点 */
    if (st.lastMove) {
      ctx.fillStyle = 'rgba(31,111,235,.10)';
      var a = st.lastMove[0], b = st.lastMove[1];
      [a, b].forEach(function (i) {
        var x = px(XQ.colOf(i)) - CELL * 0.42, y = py(XQ.rowOf(i)) - CELL * 0.42;
        roundRect(x, y, CELL * 0.84, CELL * 0.84, 8);
        ctx.fill();
      });
      ctx.strokeStyle = 'rgba(31,111,235,.28)';
      ctx.lineWidth = 1;
      [a, b].forEach(function (i) {
        var x = px(XQ.colOf(i)) - CELL * 0.42, y = py(XQ.rowOf(i)) - CELL * 0.42;
        roundRect(x, y, CELL * 0.84, CELL * 0.84, 8);
        ctx.stroke();
      });
    }

    /* 选中与可落点 */
    if (st.selected >= 0) {
      ring(st.selected, 'rgba(31,111,235,.95)', 3);
      st.targets.forEach(function (m) {
        var to = m[1];
        var x = px(XQ.colOf(to)), y = py(XQ.rowOf(to));
        if (st.board[to] !== EMPTY || (anim && anim.to === to)) {
          ring(to, 'rgba(31,111,235,.55)', 3);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(31,111,235,.45)';
          ctx.fill();
        }
      });
    }

    /* 建议着法：虚线箭头 */
    if (st.hintMove) {
      var x1 = px(XQ.colOf(st.hintMove[0])), y1 = py(XQ.rowOf(st.hintMove[0]));
      var x2 = px(XQ.colOf(st.hintMove[1])), y2 = py(XQ.rowOf(st.hintMove[1]));
      var ang = Math.atan2(y2 - y1, x2 - x1);
      var off = CELL * 0.36;
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -(now / 42) % 11;
      ctx.strokeStyle = 'rgba(31,111,235,.95)';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(x1 + Math.cos(ang) * off, y1 + Math.sin(ang) * off);
      ctx.lineTo(x2 - Math.cos(ang) * off, y2 - Math.sin(ang) * off);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x1, y1, CELL * 0.47, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x2, y2, CELL * 0.47, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /* 将军 */
    if (st.checkSide) {
      var ki = XQ.findKing(st.board, st.checkSide);
      if (ki >= 0) {
        var t = (Math.sin(((now - pulseT0) / 1200) * Math.PI * 2) + 1) / 2;
        ctx.save();
        ctx.strokeStyle = 'rgba(180,39,29,' + (0.45 + t * 0.5) + ')';
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.arc(px(XQ.colOf(ki)), py(XQ.rowOf(ki)), CELL * 0.5 + t * 2.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function ring(i, color, w) {
    var h = CELL * 0.44, x = px(XQ.colOf(i)), y = py(XQ.rowOf(i)), s = h * 0.52;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    var corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (var k = 0; k < 4; k++) {
      var sx = x + corners[k][0] * h, sy = y + corners[k][1] * h;
      ctx.beginPath();
      ctx.moveTo(sx, sy - corners[k][1] * s);
      ctx.lineTo(sx, sy);
      ctx.lineTo(sx - corners[k][0] * s, sy);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  function drawCoords() {
    if (!st.showCoords) return;
    ctx.fillStyle = 'rgba(140,106,58,.5)';
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var letters = 'abcdefghi';
    for (var c = 0; c < 9; c++) {
      ctx.fillText(letters[c], px(c), MARGIN * 0.5);
      ctx.fillText(letters[c], px(c), BH - MARGIN * 0.5);
    }
    for (var r = 0; r < 10; r++) {
      ctx.fillText(String(9 - r), MARGIN * 0.48, py(r));
      ctx.fillText(String(9 - r), BW - MARGIN * 0.48, py(r));
    }
  }

  function draw(now) {
    if (!st.board) {
      /* mount() 会同步跑第一帧，此时状态还没注入，先只铺个底色 */
      ctx.clearRect(0, 0, BW, BH);
      drawWood();
      return;
    }
    ctx.clearRect(0, 0, BW, BH);
    drawWood();
    drawGrid();
    drawRiver();
    drawHighlights(now);

    /* 动画中的棋子单独画，避免重复 */
    var skip = -1;
    var animPos = null;
    if (anim) {
      skip = anim.to;
      var t = Math.min(1, (now - anim.t0) / SLIDE_MS);
      var e = easeOutCubic(t);
      var fx = px(XQ.colOf(anim.from)), fy = py(XQ.rowOf(anim.from));
      var tx = px(XQ.colOf(anim.to)), ty = py(XQ.rowOf(anim.to));
      animPos = { x: lerp(fx, tx, e), y: lerp(fy, ty, e) };
    }

    for (var i = 0; i < 90; i++) {
      var p = st.board[i];
      if (p === EMPTY) continue;
      if (i === skip) continue;
      drawPieceAt(p, px(XQ.colOf(i)), py(XQ.rowOf(i)));
    }

    /* 被吃的子：淡出并微微下沉 */
    if (anim && anim.cap) {
      var ct = Math.min(1, (now - anim.t0) / CAPTURE_MS);
      drawPieceAt(anim.cap,
        px(XQ.colOf(anim.to)),
        py(XQ.rowOf(anim.to)) + ct * 6,
        { alpha: 1 - ct, scale: 1 - ct * 0.22 });
    }

    if (animPos) drawPieceAt(anim.piece, animPos.x, animPos.y, { scale: 1.06 });

    drawCoords();
  }

  /* ---------- 命中测试 ---------- */

  function squareAt(clientX, clientY) {
    var rect = cvs.getBoundingClientRect();
    var x = (clientX - rect.left) / rect.width * BW;
    var y = (clientY - rect.top) / rect.height * BH;
    var c = Math.round((x - MARGIN) / CELL);
    var r = Math.round((y - MARGIN) / CELL);
    if (r < 0 || r > 9 || c < 0 || c > 8) return -1;
    var dx = x - px(c), dy = y - py(r);
    if (Math.sqrt(dx * dx + dy * dy) > CELL * 0.56) return -1;
    return idxAt(r, c);
  }

  var api = {
    CELL: CELL, MARGIN: MARGIN, BW: BW, BH: BH,
    SLIDE_MS: SLIDE_MS, CAPTURE_MS: CAPTURE_MS, SETTLE_MS: SETTLE_MS,
    mount: mount, resize: resize, setState: setState,
    animateMove: animateMove, isAnimating: isAnimating,
    cancelAnim: cancelAnim, stopAnim: stopAnim,
    invalidate: function () { dirty = true; kick(); },
    squareAt: squareAt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XQBOARD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
