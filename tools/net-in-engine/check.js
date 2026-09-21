/* 交叉验证：JS 侧的「棋盘解析 + 特征编码 + 前向」是否与 Python 参考实现一致。
 *
 * 三道检查，任何一道不过都说明接进去的是错的东西：
 *   1. 棋盘：JS 从 FEN 解析出的棋盘，与 Python 逐格相同（方向、镜像都能查出来）
 *   2. 激活特征数：两边的特征个数一致
 *   3. 网络输出：两边 cp 值一致（允许 1e-3 的浮点差异）
 */
'use strict';
var path = require('path');
var net = require('./net.js');
var XQ = require('./engine.js');

var HERE = __dirname;
var ref = JSON.parse(require('fs').readFileSync(path.join(HERE, 'ref_cp.json'), 'utf8'));
var weights = net.loadNet(path.join(HERE, 'net_d512.json'));

var badBoard = 0, badCount = 0, worst = 0, worstAt = -1;
var n = ref.fens.length;

for (var i = 0; i < n; i++) {
  var b = XQ.parseBoard(ref.fens[i]);
  var side = ref.sides[i];

  // 1. 棋盘一致性：JS 棋盘 join 起来应等于 Python 的字符数组
  if (b.join('') !== ref.boards[i]) {
    badBoard++;
    if (badBoard <= 3) {
      console.log('  棋盘不一致 #%d\n    JS    : %s\n    Python: %s', i, b.join(''), ref.boards[i]);
    }
    continue;
  }

  // 2. 特征个数
  var feats = net.featureIndices(b, side);
  if (feats.length !== ref.n_activated[i]) {
    badCount++;
    if (badCount <= 3) {
      console.log('  特征数不一致 #%d：JS %d / Python %d', i, feats.length, ref.n_activated[i]);
    }
    continue;
  }

  // 3. 输出
  var cp = net.sideToMoveCp(weights, b, side);
  var d = Math.abs(cp - ref.ref_cp[i]);
  if (d > worst) { worst = d; worstAt = i; }
}

console.log('交叉验证（' + n + ' 个局面）');
console.log('  棋盘不一致        : ' + badBoard);
console.log('  激活特征数不一致  : ' + badCount);
console.log('  网络输出最大偏差  : ' + worst.toExponential(3) + ' 厘兵（第 ' + worstAt + ' 个局面）');
console.log(worst < 1e-3
  ? '  => JS 实现与 Python 参考实现一致，接进引擎的是同一个网络'
  : '  => 不一致！接进去的不是训练出的那个网络，先别做后面的实验');
process.exit((badBoard || badCount || worst >= 1e-3) ? 1 : 0);
