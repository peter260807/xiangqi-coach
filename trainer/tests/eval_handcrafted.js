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

/**
 * 选中第 rank 名（0 = 引擎首选）时，相比首选丢了多少分。
 *
 * 这个指标比「平均名次」灵敏得多：名次是 0~7 的整数，144 个局面下均值的
 * 标准误就有 0.24，0.1 量级的差别根本读不出来（实测三组网络都落在噪声里）。
 * 丢分是连续量，同样的样本量下能把差别放大出来，而且它才是真正在乎的东西 ——
 * 换这个评估函数要付出多少棋力。
 */
function lossAt(cps, rank) {
  const s = cps.slice().sort((a, b) => b - a);
  const r = Math.min(rank, s.length - 1);
  return s[0] - s[r];
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

/* ---------- 配对检验 ----------
 *
 * 光比平均值不足以下结论。150 个局面的名次差，均值差 0.3 完全可能是采样噪声；
 * 也可能是真差距。之前就是这么误判过一次 —— 看平均名次 "网络 2.81 vs 手写
 * 2.44" 像是明显更差，做了配对检验才发现在 5% 水平上根本不显著（p=0.146）。
 *
 * 这里给两个检验，一个参数法一个非参数法，结论一致才敢下判断：
 *   配对 t 检验：看名次差的均值是否显著偏离 0（用正态近似算 p，n≈150 足够）
 *   符号检验：只数"网络更好"和"手写更好"的局数，不依赖分布假设
 */

/** Lanczos 近似的 log Γ(x)，用于算二项系数 */
function logGamma(x) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) {
    // 反射公式
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBinom(n, k) {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** 标准正态分布 CDF（Abramowitz-Stegun 7.1.26 的 erf 近似） */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
    + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** 配对 t 检验，返回 { mean, sd, t, p } */
function pairedTTest(a, b) {
  const n = a.length;
  const d = a.map((v, i) => v - b[i]);
  const md = mean(d);
  let ss = 0;
  for (const v of d) ss += (v - md) * (v - md);
  const sd = Math.sqrt(ss / (n - 1));
  if (sd === 0) return { mean: md, sd: 0, t: 0, p: md === 0 ? 1 : 0 };
  const t = md / (sd / Math.sqrt(n));
  return { mean: md, sd: sd, t: t, p: 2 * (1 - normCdf(Math.abs(t))) };
}

/** 符号检验（精确二项检验，p=0.5），返回 { better, worse, p } */
function signTest(a, b) {
  let better = 0, worse = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) better++;        // 名次更小 = 更好
    else if (a[i] > b[i]) worse++;
  }
  const n = better + worse;
  if (n === 0) return { better: better, worse: worse, p: 1 };
  // 两端 p：把所有概率不高于观测值的取值加起来
  const lp = (i) => logBinom(n, i) + n * Math.log(0.5);
  const observed = lp(better);
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const l = lp(i);
    if (l <= observed + 1e-9) sum += Math.exp(l);
  }
  return { better: better, worse: worse, p: Math.min(1, sum) };
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
  // 平均丢分：选中的着法比引擎首选差多少分。比名次灵敏得多，见文件末尾说明
  const hcLoss = [];
  const netLoss = [];
  const baseLoss = [];
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
    hcLoss.push(lossAt(item.cps, argmax(scores)));
    netLoss.push(lossAt(item.cps, item.net_rank));
    baseLoss.push(lossAt(item.cps, item.base_rank));
  }

  if (!hcRanks.length) {
    console.error('没有可用的局面');
    process.exit(1);
  }

  const n = hcRanks.length;
  const nCand = items[0].cands.length;
  const rows = [
    ['手写评估（子力 + 位置价值表）', hcRanks],
    ['神经网络 NNUE（训练产物）', netRanks],
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

  // ---- 平均丢分：比名次灵敏得多的指标 ----
  //
  // 名次是整数，分辨率不够：144 个局面下均值的标准误约 0.24，
  // 实测三组网络的名次差只有 0.05~0.16，全部落在噪声里读不出来。
  // 丢分是连续量，同样样本量下能把差别放大出来，而且它才是真正在乎的东西。
  const lossRows = [
    ['手写评估（子力 + 位置价值表）', hcLoss],
    ['神经网络 NNUE（训练产物）', netLoss],
    ['引擎只搜 depth 1（参考上限）', baseLoss]
  ];
  console.log('  平均丢分（选中的着法比引擎首选差多少分，越低越好）：');
  console.log('  ' + padRight('评估方式', 32) + pad('平均', 10)
    + pad('丢分>100 的局数', 16));
  console.log('  ' + '-'.repeat(58));
  for (const row of lossRows) {
    const arr = row[1];
    console.log('  ' + padRight(row[0], 32)
      + pad((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1), 10)
      + pad(pct(countWhere(arr, (v) => v >= 100), arr.length), 16));
  }
  console.log();
  const lt = pairedTTest(netLoss, hcLoss);
  console.log('  丢分的配对检验（差值 = 网络 - 手写，正数表示网络丢分更多）');
  console.log('    平均差 ' + lt.mean.toFixed(1) + ' 分   配对 t 检验 p = '
    + lt.p.toFixed(4));
  console.log();

  const hc = mean(hcRanks);
  const nn = mean(netRanks);
  const agree = countWhere(hcRanks.map((v, i) => v === netRanks[i]), (x) => x);
  console.log('  两者选中同一步的比例：' + pct(agree, n)
    + '（' + agree + '/' + n + '）');

  // ---- 配对检验：均值差到底是真差距还是采样噪声 ----
  const tt = pairedTTest(netRanks, hcRanks);     // 正数 = 网络名次更差
  const st = signTest(netRanks, hcRanks);

  console.log();
  console.log('  配对检验（名次差 = 网络 - 手写，正数表示网络更差）');
  console.log('    平均名次差   : ' + tt.mean.toFixed(3)
    + '（标准差 ' + tt.sd.toFixed(3) + '）');
  console.log('    配对 t 检验  : t = ' + tt.t.toFixed(3)
    + '，双侧 p = ' + tt.p.toFixed(4));
  console.log('    符号检验     : 网络更好 ' + st.better + ' 局 / 手写更好 '
    + st.worse + ' 局，双侧 p = ' + st.p.toFixed(4));

  console.log();
  console.log('='.repeat(68));
  const significant = (tt.p < 0.05) && (st.p < 0.05);
  if (!significant) {
    console.log(' 两者差异不显著（两个检验的 p 都未低于 0.05，实测 p = '
      + tt.p.toFixed(3) + ' / ' + st.p.toFixed(3) + '）。');
    console.log(' 均名次差 ' + tt.mean.toFixed(2) + ' 在 ' + n
      + ' 个样本上完全落在噪声范围内 —— 不能说谁强谁弱。');
    console.log(' 要下结论得扩大样本量，或者换个分辨率更高的评测方式。');
  } else if (nn < hc) {
    console.log(' 网络显著优于手写评估：平均名次 ' + hc.toFixed(2) + ' -> '
      + nn.toFixed(2) + '（改善 ' + ((hc - nn) / hc * 100).toFixed(0) + '%）');
    console.log(' 结论：训练有效，网络学到了手写评估没有的东西。');
  } else {
    console.log(' 网络显著差于手写评估：平均名次 ' + hc.toFixed(2) + ' -> '
      + nn.toFixed(2));
    console.log(' 结论：暂时不能用它替代手写评估，需要更多数据或更大的网络。');
  }
  console.log('='.repeat(68));

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
