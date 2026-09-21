/* 把训练出的网络接进真引擎当评估函数，和现在的手写评估逐档位对比。
 *
 * 三个阶段：
 *   A. 同一深度、给足预算：决策会不会变？变了以后谁更好？（隔离「质量」）
 *   B. 按 App 各档位的真实时间预算：同样时间里谁搜得更深？（隔离「速度」）
 * 参考评分统一用「手写评估 + 深度 6」，避免让被评估者给自己打分。
 *
 * 用法：node exp2.js [局面数] [是否含深度5]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var netMod = require('./net.js');
var XQ = require('./engine.js');

var HERE = __dirname;
var ROOT = '/Users/GoodHarvest/WorkBuddy/2026-09-21-00-07-27/xiangqi-coach/trainer';

var N_POS = parseInt(process.argv[2] || '144', 10);
var WITH_D5 = process.argv[3] !== 'skip5';
var N_LEVEL = Math.min(N_POS, parseInt(process.argv[4] || '60', 10));

var weights = netMod.loadNet(path.join(HERE, 'net_d512.json'));
var pos = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'pos-xq-d512.json'), 'utf8')).slice(0, N_POS);

/* 固定随机种子：低档位在 slack 内随机挑，不可复现就没法比较 */
var seed = 12345;
Math.random = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function useHand() { XQ.setEval(null); }
function useNet() { XQ.setEval(function (b, side) { return netMod.redPerspective(weights, b, side); }); }

function mk(m) { return m ? (m[0] + '-' + m[1]) : 'null'; }
function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
function med(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[(s.length / 2) | 0] : 0; }
function f1(v) { return v.toFixed(1); }
function f2(v) { return v.toFixed(2); }
function f0(v) { return Math.round(v).toString(); }
function pc(v) { return (v * 100).toFixed(0) + '%'; }

function scoreMove(board, side, m, depth, ms) {
  var b = board.slice();
  XQ.makeMove(b, m);
  return -XQ.searchRoot(b, XQ.other(side), depth, ms).score;
}

console.log('===== 网络当评估函数 vs 现在的手写评估 =====');
console.log('局面数 ' + pos.length + '（取自评估用的那批局面，与之前的静态评估同源）');
console.log('网络：xq-d512.xqnn  ' + weights.meta.feat_dim + ' -> ' + weights.l1 + ' -> ' + weights.l2 + ' -> 1，output_scale=' + weights.outputScale);
console.log('');

var depths = WITH_D5 ? [1, 3, 5] : [1, 3];
var rows = [];

console.log('===== A. 同一深度、给足预算（隔离质量，不掺速度）=====');
depths.forEach(function (D) {
  var same = 0, diff = 0, better = 0, worse = 0, deltas = [];
  var dH = [], dN = [], mH = [], mN = [], nH = [], nN = [], shortN = 0;

  pos.forEach(function (it) {
    var b = XQ.parseBoard(it.board), side = it.side;

    useHand();
    var t0 = Date.now();
    var rh = XQ.searchRoot(b, side, D, 6000);
    mH.push(Date.now() - t0);

    useNet();
    t0 = Date.now();
    var rn = XQ.searchRoot(b, side, D, 6000);
    mN.push(Date.now() - t0);

    dH.push(rh.depth); dN.push(rn.depth);
    nH.push(rh.nodes || 0); nN.push(rn.nodes || 0);
    if (rn.depth < D) shortN++;

    if (mk(rh.move) === mk(rn.move)) { same++; return; }
    diff++;
    var sH = scoreMove(b, side, rh.move, 6, 4000);
    var sN = scoreMove(b, side, rn.move, 6, 4000);
    deltas.push(sH - sN);
    if (sN > sH) better++; else if (sN < sH) worse++;
  });

  console.log('  深度 ' + D);
  console.log('    决策：相同 ' + same + ' / 不同 ' + diff + '（不同占 ' + pc(diff / pos.length) + '）');
  if (deltas.length) {
    console.log('    差异局面的参考分差（手写选择 - 网络选择，正数=网络更好）：均值 ' +
      f2(avg(deltas)) + '  中位 ' + f2(med(deltas)) +
      '  网络更好 ' + better + ' 局 / 更差 ' + worse + ' 局');
  }
  console.log('    到达深度：手写 ' + f2(avg(dH)) + ' / 网络 ' + f2(avg(dN)) +
    '（网络有 ' + shortN + ' 局没到 ' + D + '）');
  console.log('    耗时：手写 ' + f0(avg(mH)) + ' ms / 网络 ' + f0(avg(mN)) + ' ms  慢 ' +
    f1(avg(mH) > 1 ? avg(mN) / avg(mH) : 0) + ' 倍');
  console.log('    节点：手写 ' + f0(avg(nH)) + ' / 网络 ' + f0(avg(nN)));
  console.log('');
  rows.push('深度 ' + D + '：决策差异 ' + pc(diff / pos.length) + '，慢 ' +
    f1(avg(mH) > 1 ? avg(mN) / avg(mH) : 0) + ' 倍');
});

console.log('===== B. 按 App 各档位的真实时间预算（隔离速度：时间固定，比深度）=====');
var LEVELS = [['入门 easy', 1, 600], ['初级 normal', 3, 1200], ['中级 hard', 5, 2200]];
var sub = pos.slice(0, N_LEVEL);
LEVELS.forEach(function (lv) {
  var name = lv[0], d = lv[1], budget = lv[2];
  var dH = [], dN = [], mH = [], mN = [], diff = 0, deltas = [];
  sub.forEach(function (it) {
    var b = XQ.parseBoard(it.board), side = it.side;
    useHand();
    var t0 = Date.now(); var rh = XQ.searchRoot(b, side, d, budget); mH.push(Date.now() - t0);
    useNet();
    t0 = Date.now(); var rn = XQ.searchRoot(b, side, d, budget); mN.push(Date.now() - t0);
    dH.push(rh.depth); dN.push(rn.depth);
    if (mk(rh.move) !== mk(rn.move)) {
      diff++;
      deltas.push(scoreMove(b, side, rh.move, 6, 3000) - scoreMove(b, side, rn.move, 6, 3000));
    }
  });
  console.log('  ' + name + '（深度上限 ' + d + '，预算 ' + budget + ' ms，' + sub.length + ' 个局面）');
  console.log('    到达深度：手写 ' + f2(avg(dH)) + ' / 网络 ' + f2(avg(dN)) +
    '  ->  网络平均少搜 ' + f2(avg(dH) - avg(dN)) + ' 层');
  console.log('    实际耗时：手写 ' + f0(avg(mH)) + ' ms / 网络 ' + f0(avg(mN)) + ' ms');
  console.log('    决策不同：' + diff + ' / ' + sub.length + '（' + pc(diff / sub.length) + '）' +
    (deltas.length ? '  参考分差均值 ' + f2(avg(deltas)) + ' 厘兵' : ''));
});

console.log('');
console.log('===== 小结 =====');
rows.forEach(function (r) { console.log('  ' + r); });
console.log('  网络前向累计调用：' + weights.forwards + ' 次');
