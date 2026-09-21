/**
 * 用手写评估函数给同一批候选着法排序，和训练出来的网络做对照。
 *
 * 要回答的问题很直接：**训出来的 NNUE 到底有没有比原来手写的强？**
 * 两者都是静态评估（不看后续变化），所以这个比较是公平的。
 *
 * 数据来自 eval_net_strength.py 导出的 JSON —— 同一批局面、同一组候选着法、
 * 同一个"标准答案"（引擎多层搜索的排序），只换评估函数。
 *
 * 用法：
 *   python tests/eval_net_strength.py --engine ... --positions 150 \
 *          --depth 10 --dump /tmp/positions.json
 *   node tests/eval_handcrafted.js /tmp/positions.json
 *
 * 手写评估取自 web/js/engine.js —— 也就是现在网页端和 iOS 端实际在用的
 * 那一套（子力价值 + 位置价值表），不是另写一个来凑数。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const ENGINE_JS = path.join(ROOT, '..', 'web', 'js', 'engine.js');

if (!fs.existsSync(ENGINE_JS)) {
  console.error('找不到 ' + ENGINE_JS);
  process.exit(1);
}
const XQ = require(ENGINE_JS);

/* ---------- 小工具（注意别用 C 风格的 % 格式化，JS 不支持）---------- */

function pad(s, width) {
  s = String(s);
  while (s.length < width) s = ' ' + s;
  return s;
}

function padRight(s, width) {
  s = String(s);
  while (s.length < width) s = s + ' ';
  return s;
}

function pct(part, total) {
  return (part / total * 100).toFixed(1) + '%';
}

/** 'h2e2' -> [from, to] 的 0..89 棋盘索引 */
function uciToIdx(sq) {
  const c = sq.charCodeAt(0) - 97;          // a..i -> 0..8
  const r = 9 - parseInt(sq[1], 10);        // 行号（0 是黑方底线）
  return r * 9 + c;
}

function moveFromUci(uci) {
  return [uciToIdx(uci.slice(0, 2)), uciToIdx(uci.slice(2, 4))];
}

function argmax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i;
  }
  return best;
}

function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function countWhere(arr, pred) {
  let c = 0;
  for (const v of arr) if (pred(v)) c++;
  return c;
}

/* ---------- 主流程 ---------- */

function main() {
  const dump = process.argv[2];
  if (!dump) {
    console.error('用法: node tests/eval_handcrafted.js <positions.json>');
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(dump, 'utf8'));
  const hcRanks = [];       // 手写评估的名次
  const netRanks = [];      // 网络的名次
  const baseRanks = [];     // 引擎 depth 1 的名次（顺带一起看）
  let skipped = 0;

  for (const item of items) {
    let board;
    try {
      board = XQ.parseBoard(item.board);
    } catch (e) {
      skipped++;
      continue;
    }
    if (!board || board.length !== 90) {
      skipped++;
      continue;
    }

    const scores = [];
    for (const uci of item.cands) {
      const probe = XQ.cloneBoard(board);
      XQ.makeMove(probe, moveFromUci(uci));
      // evaluate 是红方视角；换回「走子方视角」才能和引擎分值同向
      const red = XQ.evaluate(probe);
      scores.push(item.side === 'r' ? red : -red);
    }

    hcRanks.push(argmax(scores));
    netRanks.push(item.net_rank);
    baseRanks.push(item.base_rank);
  }

  if (!hcRanks.length) {
    console.error('没有可用的局面');
    process.exit(1);
  }

  const n = hcRanks.length;
  const nCand = items[0].cands.length;
  const rows = [
    ['手写评估（子力 + 位置价值表）', hcRanks],
    ['神经网络 NNUE（1.3 MB）', netRanks],
    ['引擎只搜 depth 1（参考上限）', baseRanks]
  ];

  console.log('='.repeat(68));
  console.log('同一批局面上，几种评估方式的对比');
  console.log('='.repeat(68));
  console.log('  局面数 ' + n + '（跳过 ' + skipped + '）　每局候选数 ' + nCand);
  console.log('  标准答案：Pikafish 多层搜索给出的排序');
  console.log();
  console.log('  ' + padRight('评估方式', 32) + pad('平均名次', 10)
    + pad('选中首选', 10) + pad('前三名内', 10));
  console.log('  ' + '-'.repeat(62));

  for (const row of rows) {
    const name = row[0];
    const arr = row[1];
    console.log('  ' + padRight(name, 32)
      + pad(mean(arr).toFixed(2), 10)
      + pad(pct(countWhere(arr, (r) => r === 0), n), 10)
      + pad(pct(countWhere(arr, (r) => r <= 2), n), 10));
  }
  console.log('  ' + padRight('（随机瞎猜作参考）', 32)
    + pad(((nCand + 1) / 2).toFixed(2), 10));
  console.log();

  console.log('  名次分布：');
  for (const row of rows) {
    const arr = row[1];
    const parts = [];
    for (let r = 0; r < nCand; r++) {
      const c = countWhere(arr, (x) => x === r);
      if (c) parts.push('第' + (r + 1) + '名 ' + c + '个');
    }
    console.log('    ' + padRight(row[0], 32) + parts.join('  '));
  }
  console.log();

  const hc = mean(hcRanks);
  const nn = mean(netRanks);
  console.log('='.repeat(68));
  if (nn < hc) {
    console.log(' 网络优于手写评估：平均名次 ' + hc.toFixed(2) + ' -> '
      + nn.toFixed(2) + '（改善 ' + ((hc - nn) / hc * 100).toFixed(0) + '%）');
    console.log(' 结论：训练有效，网络学到了手写评估没有的东西。');
  } else if (nn > hc) {
    console.log(' 网络还不如手写评估：平均名次 ' + hc.toFixed(2) + ' -> '
      + nn.toFixed(2));
    console.log(' 结论：暂时不能用它替代手写评估，需要更多数据或更大的网络。');
  } else {
    console.log(' 两者基本持平：' + hc.toFixed(2) + ' vs ' + nn.toFixed(2));
  }
  console.log('='.repeat(68));

  const agree = countWhere(hcRanks.map((v, i) => v === netRanks[i]), (x) => x);
  console.log('  两者选中同一步的比例：' + pct(agree, n)
    + '（' + agree + '/' + n + '）');

  // 给了第二个参数就把名次写出去 —— 光看平均值的差别不足以下结论，
  // 要做配对检验才知道"网络更差"是真差距还是采样噪声
  const outPath = process.argv[3];
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({
      handcrafted: hcRanks,
      net: netRanks,
      base: baseRanks
    }));
    console.log('  名次已写入 ' + outPath);
  }
}

main();
