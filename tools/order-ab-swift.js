/* Swift 引擎的排序对照：**同一会话内**同时驱动多份引擎，比「固定深度节点数」与「固定时间深度」
 *
 *   ./tools/uci/run.sh                          # 编出当前正本（tools/uci/build/xq-uci）
 *   node tools/order-ab-swift.js --engines /tmp/xq-order-swift/legacy,/tmp/xq-order-swift/both --depths 4,5,6,7
 *   node tools/order-ab-swift.js --engines a,b,c --mode time --depths 1200,2200,3500
 *
 * 为什么必须同会话交替测：
 *   同一台机器不同时间的「千节点/秒」能差 30% —— 实测未改动的 legalMoves 在两次
 *   search-bench 里是 5.58µs 和 7.38µs。所以拿文档里的历史数字当对照组，
 *   等于在测机器的脾气而不是引擎的改动。这里所有引擎在同一次会话里轮流跑，
 *   每个场景还跑两轮交错（1→2→…→n→1→2→…→n），取各自最好的一次。
 *
 * 为什么两种模式都要看：
 *   · **固定深度**量的是「排序质量」：alpha-beta 的剪枝率完全取决于排序，
 *     节点数掉了就是排序变好了。这个指标与机器负载无关，最稳。
 *   · **固定时间**量的是「用户实际感受到的东西」：App 里就是给 N 毫秒。
 *     它会把「每节点更贵」这类代价也算进去。
 *   ⚠️ 两种模式**可能给出相反的结论**（实测就是这样：固定深度全面变少，
 *     固定时间下开局/中局却持平）。只看一个必错。
 *
 * 硬约束（脚本会当场报错）：
 *   固定深度下每份引擎的**分数与最佳着法必须完全相同** —— 排序不该改变搜索结果，
 *   不同就说明改动越界了（例如 SEE 把棋盘改坏了），此时上面的节点数对比全部作废。
 */
'use strict';

const path = require('path');
const { UciEngine } = require('./lib/uci-engine.js');

/* 与 tools/search-bench/main.swift 同一批局面，两端数字可直接对照 */
const POSITIONS = [
  { name: '标准开局', fen: null, note: '22 个棋子，最宽的分支' },
  {
    name: '中局',
    fen: 'r.nbakar./........./.cn...n.c/p.p.p...p/......p..'
       + '/..P....../P...P.P.P/.C..C.N../........./RNBAKABR.',
    note: '中炮对屏风马 8 手',
  },
  {
    name: '残局',
    fen: '..bakab.r/........./........./........./....P....'
       + '/...R...../........./....N..../........./....K....',
    note: '车马兵 vs 车士象全',
  },
];

const argv = process.argv.slice(2);
let ENGINES = [
  { label: '改前', bin: '/tmp/xq-uci-p2-before' },
  { label: '改后', bin: path.join(__dirname, 'uci', 'build', 'xq-uci') },
];
let DEPTHS = [4, 5, 6, 7];
let TIME_MS = 300000;
let MODE = 'depth';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--engines' || a === '--before' || a === '--after') {
    const v = argv[++i];
    if (a === '--before') { ENGINES[0].bin = path.resolve(v); continue; }
    if (a === '--after') { ENGINES[1].bin = path.resolve(v); continue; }
    ENGINES = v.split(',').map((s) => {
      /* 支持 name=path，方便把变体名字带进表格 */
      const eq = s.indexOf('=');
      const bin = path.resolve(eq >= 0 ? s.slice(eq + 1) : s);
      return { label: eq >= 0 ? s.slice(0, eq) : path.basename(bin), bin };
    });
  }
  else if (a === '--depths') DEPTHS = argv[++i].split(',').map(Number);
  else if (a === '--time') TIME_MS = Number(argv[++i]);
  else if (a === '--mode') MODE = argv[++i];
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}
if (MODE !== 'depth' && MODE !== 'time') { console.error('--mode 只能是 depth 或 time'); process.exit(2); }
if (ENGINES.length < 2) { console.error('至少要两份引擎'); process.exit(2); }

function limitFor(key) {
  return MODE === 'depth' ? { depth: key, movetime: TIME_MS } : { depth: 64, movetime: key };
}

(async () => {
  const engs = ENGINES.map((e) => new UciEngine(e.bin, { name: e.label }));
  for (const e of engs) await e.start();

  console.log('  模式：' + (MODE === 'depth'
    ? `固定深度 ${DEPTHS.join('/')}（时间上限 ${TIME_MS}ms 只当保险丝）`
    : `固定时间 ${DEPTHS.join('/')}ms —— 看同样预算能搜到第几层`));
  for (const e of engs) console.log(`  ${e.name.padEnd(10)} ${e.bin}`);
  console.log();

  const rows = [];
  let bad = [];

  for (const pos of POSITIONS) {
    for (const key of DEPTHS) {
      const limit = limitFor(key);
      if (pos.fen) limit.fen = pos.fen;
      const got = engs.map(() => null);
      /* 交错跑两轮：谁先跑谁吃亏（缓存预热、机器升温），两轮取各自最好的一次 */
      for (let rep = 0; rep < 2; rep++) {
        for (let i = 0; i < engs.length; i++) {
          const r = await engs[i].go([], limit);
          if (r.nodes <= 0) {
            console.error(`量到 0 个节点（${engs[i].name} / ${pos.name} / ${key}）—— 这是量错了，不是跑得快`);
            process.exit(1);
          }
          const cur = got[i];
          const better = !cur
            || (MODE === 'depth' ? r.nodes < cur.nodes : r.depth > cur.depth
                || (r.depth === cur.depth && r.nodes < cur.nodes));
          if (better) got[i] = r;
        }
      }
      /* 硬约束：固定深度下所有引擎的分数与最佳着法必须一致 */
      if (MODE === 'depth') {
        const ref = got[0];
        got.forEach((r, i) => {
          if (r.score !== ref.score || r.best !== ref.best) {
            bad.push(`${pos.name} d${key}：${engs[0].name} ${ref.best}/${ref.score} vs ${engs[i].name} ${r.best}/${r.score}`);
          }
        });
      }
      rows.push({ pos: pos.name, key, got });
    }
  }

  const pad = (s, n) => String(s).padStart(n);
  console.log('==================================================================');
  console.log(MODE === 'depth' ? '固定深度节点数（越小越好）' : '固定时间到达的深度（越深越好）');
  console.log('==================================================================');
  const scen = rows.map(r => (MODE === 'depth' ? `${r.pos}d${r.key}` : `${r.pos}${r.key}ms`));
  console.log(`  ${'引擎'.padEnd(9)} | ${scen.map(s => s.padStart(11)).join(' ')} | ${'合计'.padStart(9)}`);
  for (let i = 0; i < engs.length; i++) {
    if (MODE === 'depth') {
      const cells = rows.map(r => `${(r.got[i].nodes / r.got[0].nodes * 100).toFixed(1)}%`.padStart(11));
      const avg = rows.reduce((s, r) => s + r.got[i].nodes / r.got[0].nodes, 0) / rows.length;
      console.log(`  ${engs[i].name.padEnd(9)} | ${cells.join(' ')} | ${pad((avg * 100).toFixed(1) + '%', 9)}`);
    } else {
      const cells = rows.map(r => `${r.got[i].depth}层`.padStart(11));
      const sum = rows.reduce((s, r) => s + r.got[i].depth, 0);
      console.log(`  ${engs[i].name.padEnd(9)} | ${cells.join(' ')} | ${pad('共' + sum + '层', 9)}`);
    }
  }
  if (MODE === 'depth') {
    console.log('  （每格是「该引擎节点数 ÷ 第一份引擎节点数」，<100% 就是变快了）');
  }

  if (MODE === 'depth') {
    console.log();
    console.log('==================================================================');
    console.log('原始节点数 / 耗时');
    console.log('==================================================================');
    console.log(`  ${'引擎'.padEnd(9)} | ${rows.map((r) => (`${r.pos.slice(-2)}d${r.key}`).padStart(15)).join(' ')}`);
    for (let i = 0; i < engs.length; i++) {
      console.log(`  ${engs[i].name.padEnd(9)} | ${rows.map(r => `${r.got[i].nodes}/${r.got[i].timeMs}ms`.padStart(15)).join(' ')}`);
    }
  }

  console.log();
  console.log('==================================================================');
  console.log('按局面汇总');
  console.log('==================================================================');
  for (const pos of POSITIONS) {
    const rs = rows.filter(r => r.pos === pos.name);
    const parts = [];
    for (let i = 1; i < engs.length; i++) {
      if (MODE === 'depth') {
        const avg = rs.reduce((s, r) => s + r.got[i].nodes / r.got[0].nodes, 0) / rs.length;
        parts.push(`${engs[i].name} ${(avg * 100).toFixed(1)}%`);
      } else {
        const dd = rs.reduce((s, r) => s + (r.got[i].depth - r.got[0].depth), 0);
        parts.push(`${engs[i].name} ${dd >= 0 ? '+' : ''}${dd} 层`);
      }
    }
    console.log(`  ${pos.name.padEnd(9)} ${parts.join('　|　')}`);
  }

  console.log();
  if (bad.length) {
    console.error('❌ 固定深度下「分数 / 最佳着法」不一致 —— 排序不该改变搜索结果，这是 bug：');
    for (const m of bad) console.error('   ' + m);
    process.exit(1);
  }
  if (MODE === 'depth') {
    console.log(`✓ ${rows.length} 个场景、${engs.length} 份引擎的**分数与最佳着法完全相同**：排序只改变了搜索的速度，没有改变它的答案`);
  }

  engs.forEach(e => e.quit());
  setTimeout(() => process.exit(0), 400);
})().catch((e) => { console.error(e); process.exit(1); });
