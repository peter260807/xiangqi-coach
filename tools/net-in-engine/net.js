/* 把训练出的 .xqnn 网络接进真引擎时用的推理实现。
 *
 * 照 trainer/src/export.py 的 NumpyNet 重写了一遍 —— 用同一份权重、
 * 同一个特征编码，输出「走子方视角」的厘兵分（1 兵 = 100）。
 * 纯 JS、不做增量更新，为的是量出「朴素实现」的价格。
 */
'use strict';
var fs = require('fs');

var EMPTY = '.';
var NUM_TYPES = 14;                    // 己方 7 种 + 对方 7 种
var TYPE_OF = {
  K: 0, A: 1, B: 2, N: 3, R: 4, C: 5, P: 6,
  k: 0, a: 1, b: 2, n: 3, r: 4, c: 5, p: 6
};
var VALUE_CLIP = 30;                   // 与训练标签的值域一致（±30 兵）

function loadNet(path) {
  var j = JSON.parse(fs.readFileSync(path, 'utf8'));
  var net = {
    meta: j,
    l1: j.l1, l2: j.l2,
    featW: j.feat_w, sideB: j.side_b,
    w2: j.fc2_w, b2: j.fc2_b,
    w3: j.fc3_w[0], b3: j.fc3_b[0],
    outputScale: j.output_scale,
    legacy: j.legacy_winrate,
    forwards: 0                          // 统计被调用次数，便于算单次成本
  };
  return net;
}

/* 与 xq.py 的 feature_indices 逐字对应：索引 = 格子 * 14 + 类型，
   己方棋子映射到 0-6、对方映射到 7-13（视角归一化）。 */
function featureIndices(board, side) {
  var redSide = (side === 'r');
  var out = [];
  for (var i = 0; i < 90; i++) {
    var p = board[i];
    if (p === EMPTY) continue;
    var isRed = (p >= 'A' && p <= 'Z');
    var base = TYPE_OF[p];
    out.push(i * NUM_TYPES + ((isRed === redSide) ? base : base + 7));
  }
  return out;
}

function forward(net, feats, sideIdx) {
  var l1 = net.l1, l2 = net.l2, k, j;
  var sb = net.sideB[sideIdx];
  var acc = new Float64Array(l1);
  for (k = 0; k < l1; k++) acc[k] = sb[k];
  for (var f = 0; f < feats.length; f++) {
    var row = net.featW[feats[f]];
    for (k = 0; k < l1; k++) acc[k] += row[k];
  }
  for (k = 0; k < l1; k++) { var a = acc[k]; acc[k] = a < 0 ? 0 : (a > 1 ? 1 : a); }

  var h2 = new Float64Array(l2);
  for (j = 0; j < l2; j++) {
    var r2 = net.w2[j], s = net.b2[j];
    for (k = 0; k < l1; k++) s += r2[k] * acc[k];
    h2[j] = s < 0 ? 0 : (s > 1 ? 1 : s);
  }
  var out = net.b3;
  for (j = 0; j < l2; j++) out += net.w3[j] * h2[j];
  return out;
}

/* 走子方视角的分差（厘兵） */
function sideToMoveCp(net, board, side) {
  net.forwards++;
  var v = forward(net, featureIndices(board, side), side === 'r' ? 0 : 1);
  if (net.legacy) {
    var p = Math.min(1 - 1e-6, Math.max(1e-6, 1 / (1 + Math.exp(-v))));
    return 400 * Math.log(p / (1 - p));
  }
  if (v > VALUE_CLIP) v = VALUE_CLIP;
  if (v < -VALUE_CLIP) v = -VALUE_CLIP;
  return v * net.outputScale;
}

/* 引擎要的是「红方视角」的分；网络给的是走子方视角，这里翻转一下。 */
function redPerspective(net, board, side) {
  var v = sideToMoveCp(net, board, side);
  return side === 'r' ? v : -v;
}

module.exports = {
  loadNet: loadNet,
  featureIndices: featureIndices,
  sideToMoveCp: sideToMoveCp,
  redPerspective: redPerspective,
  NUM_TYPES: NUM_TYPES
};
