/* 排序改动拆解实验：SEE 和「静态棋理」各自到底值多少？
 *
 *   node tools/order-variants.js     # 先生成四份对照引擎（必须，有自证）
 *   node tools/order-ab.js           # 再跑本脚本对比
 *   node tools/order-ab.js --depths 5,6,7
 *
 * 为什么要在**同一个进程里**依次跑四份：
 *   分开跑四次进程，机器负载、TT 预热、GC 都会飘；而这里要看的差异只有几个百分点，
 *   必须把噪声压到比信号小。同进程内四个模块各有一份独立的哈希表/置换表/历史表
 *   （都在各自的 IIFE 闭包里），互不干扰 —— 这是可以放心同进程的前提。
 *
 * 判据：**固定深度下的节点数**。
 *   alpha-beta 的剪枝率完全取决于着法排序，而根节点的**分数与着法顺序无关**，
 *   所以「同一深度分数完全相同 + 节点数下降」是排序变好的干净证据。
 *   分数一旦不同，说明改动越界了（排序不该改变搜索结果），脚本会直接报错。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VAR_DIR = '/tmp/xq-order-variants';
const VARIANTS_ALL = ['legacy', 'pst', 'see', 'shipped', 'seeAll', 'withKing',
                      'see_rk', 'both_rk', 'w4', 'w16', 'w32', 'cap0', 'capbig'];
let VARIANTS = VARIANTS_ALL;

const POSITIONS = [
  { name: '标准开局', fen: null },
  { name: '中局', fen: 'r.nbakar./........./.cn...n.c/p.p.p...p/......p../..P....../P...P.P.P/.C..C.N../........./RNBAKABR.' },
  { name: '残局', fen: '..bakab.r/........./........./........./....P..../...R...../........./....N..../........./....K....' },
];

const argv = process.argv.slice(2);
let DEPTHS = [5, 6, 7];
let ONLY_POS = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--depths') DEPTHS = argv[++i].split(',').map(Number);
  else if (argv[i] === '--positions') ONLY_POS = argv[++i].split(',');
  else if (argv[i] === '--variants') {
    VARIANTS = argv[++i].split(',');
    for (const v of VARIANTS) {
      if (!VARIANTS_ALL.includes(v)) { console.error(`未知变体 ${v}（可选：${VARIANTS_ALL.join(',')}）`); process.exit(2); }
    }
  }
}

/* ---------- 装载四份对照引擎 ---------- */

const engines = {};
for (const v of VARIANTS) {
  const f = path.join(VAR_DIR, `${v}.js`);
  if (!fs.existsSync(f)) {
    console.error(`缺少对照引擎 ${f}\n请先运行：node tools/order-variants.js`);
    process.exit(1);
  }
  engines[v] = require(f);
}
const base = engines.legacy;
POSITIONS[0].fen = base.START;

/* 自证：四份引擎确实是四份不同的代码（都来自同一个正本，靠两处替换区分）
   判断方式是「同一局面同深度下的 SEE 调用次数」——
   legacy 必须一次都不调，see/both 必须调用。 */
{
  const b = base.parseBoard(base.START);
  base.resetSearch(); base.searchRoot(b, 'r', 4, 60000, null, null);
  const legacySee = base.seeCalls();
  if (legacySee !== 0) { console.error(`自证失败：legacy 不该调用 SEE，实际 ${legacySee} 次`); process.exit(1); }
}

/* ---------- SEE 的单项成本（决定它值不值得算） ---------- */

function measureSeeCost(XQ, fen, side) {
  const b = XQ.parseBoard(fen);
  /* 挑一个吃子多一点的走法集合：把每个「吃子」都跑一遍 SEE */
  const caps = XQ.genCaptures(b, side);
  if (caps.length === 0) return null;
  const ITER = 20000;
  const t0 = Date.now();
  let sink = 0;
  for (let i = 0; i < ITER; i++) {
    for (const m of caps) sink += XQ.seeCapture(b, m[0], m[1], side);
  }
  const dt = Date.now() - t0;
  const calls = ITER * caps.length;
  /* 自证：校验和必须不是恒 0，否则说明循环被优化掉/根本没跑 */
  if (dt === 0) return { usPerCall: 0, calls, sink, suspicious: true };
  return { usPerCall: (dt * 1000) / calls, calls, sink, suspicious: sink === 0 };
}

/* ---------- 主表 ---------- */

console.log('==================================================================');
console.log('排序拆解：固定深度节点数（越小越好）');
console.log('==================================================================');

const rows = [];
let scoreMismatch = false;

for (const p of POSITIONS) {
  if (ONLY_POS && !ONLY_POS.includes(p.name)) continue;
  for (const d of DEPTHS) {
    const rec = { position: p.name, depth: d, byVariant: {} };
    for (const v of VARIANTS) {
      const XQ = engines[v];
      XQ.resetSearch();
      const b = XQ.parseBoard(p.fen);
      const t0 = Date.now();
      const r = XQ.searchRoot(b, 'r', d, 300000, null, null);
      const dt = Date.now() - t0;
      rec.byVariant[v] = { nodes: r.nodes, ms: dt, score: r.score, see: XQ.seeCalls(), depth: r.depth };
    }
    const scores = new Set(VARIANTS.map(v => rec.byVariant[v].score));
    if (scores.size !== 1) scoreMismatch = true;
    rows.push(rec);
  }
}

const pad = (s, n) => String(s).padStart(n);
const SCEN = rows.map(r => `${r.position.slice(-2)}·${r.depth}`);

/* 一行一个变体、一列一个场景。
   变体有十几个，横着摆 14 列会挤成一片看不出差；竖着摆每列只有一个数字，反而好比较。 */
console.log(`  ${'变体'.padEnd(11)} | ${SCEN.map(s => s.padStart(9)).join(' ')} | ${'平均'.padStart(7)}`);
console.log(`  ${'—'.repeat(11)}-+-${SCEN.map(() => '—'.repeat(9)).join('-')}-+-${'—'.repeat(7)}`);
const summary = [];
for (const v of VARIANTS) {
  let sum = 0, wins = 0;
  const cells = rows.map(rec => {
    const ratio = rec.byVariant[v].nodes / rec.byVariant.legacy.nodes;
    sum += ratio;
    if (ratio < 1) wins++;
    return `${(ratio * 100).toFixed(1)}%`.padStart(9);
  });
  const avg = sum / rows.length;
  summary.push({ v, avg, wins, n: rows.length });
  console.log(`  ${v.padEnd(11)} | ${cells.join(' ')} | ${(avg * 100).toFixed(1)}%`.padEnd(90) + ` ${wins}/${rows.length}`);
}
console.log('  （每格是「该变体节点数 ÷ legacy 节点数」，<100% 就是变快了；最后一列是等权平均）');

console.log();
console.log('==================================================================');
console.log('原始节点数（便于核对上面的百分比）');
console.log('==================================================================');
console.log(`  ${'变体'.padEnd(11)} | ${SCEN.map(s => s.padStart(9)).join(' ')}`);
for (const v of VARIANTS) {
  console.log(`  ${v.padEnd(11)} | ${rows.map(rec => pad(rec.byVariant[v].nodes, 9)).join(' ')}`);
}

console.log();
console.log('==================================================================');
console.log('耗时（毫秒，同一进程同一时刻）');
console.log('==================================================================');
console.log(`  ${'变体'.padEnd(11)} | ${SCEN.map(s => s.padStart(9)).join(' ')}`);
for (const v of VARIANTS) {
  console.log(`  ${v.padEnd(11)} | ${rows.map(rec => pad(rec.byVariant[v].ms, 9)).join(' ')}`);
}

console.log();
console.log('==================================================================');
console.log('排名（按平均节点数，越小越好）');
console.log('==================================================================');
summary.sort((a, b) => a.avg - b.avg)
  .forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.v.padEnd(11)} ${(s.avg * 100).toFixed(1)}%　（${s.wins}/${s.n} 个场景优于 legacy）`));

console.log();
console.log('==================================================================');
console.log('SEE 单项成本（中局局面，每个吃子各跑一遍）');
console.log('==================================================================');
for (const v of ['legacy', 'shipped']) {
  const c = measureSeeCost(engines[v], POSITIONS[1].fen, 'r');
  if (!c) { console.log(`  ${v.padEnd(9)} 该局面没有吃子可用`); continue; }
  console.log(`  ${v.padEnd(9)} ${c.usPerCall.toFixed(2)} µs/次　（${c.calls} 次，校验和 ${c.sink}）${c.suspicious ? '  ← 校验和为 0，可能没真的跑' : ''}`);
}

console.log();
if (scoreMismatch) {
  console.error('❌ 有场景的分数在不同排序下不一致 —— 排序不该改变搜索结果，这是 bug，上面的节点数对比全部作废');
  process.exit(1);
}
console.log(`✓ ${rows.length} 个场景 × ${VARIANTS.length} 个变体的**分数全部一致**：排序只改变了搜索的速度，没有改变它的答案`);
