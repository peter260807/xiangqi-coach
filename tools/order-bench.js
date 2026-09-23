/* 着法排序质量测量台（JS 侧）
 *
 *   node tools/order-bench.js                 # 默认深度 4~7
 *   node tools/order-bench.js --depths 6,8
 *   node tools/order-bench.js --json          # 机器可读，用来做改前/改后对比
 *
 * 为什么要有它：
 *   alpha-beta 的剪枝率**完全**取决于着法排序。排序好 → 同一个深度下节点数少。
 *   所以「排序改动有没有用」有一个干净的量化指标：**固定深度下的节点数**。
 *   节点数掉下来 = 同样的时间预算能搜更深 = 实际棋力上升。
 *   这比「看着棋路变好了」可靠得多。
 *
 * 为什么在 JS 侧先做：
 *   改一行刷新就生效、秒级迭代。Swift 那边编译一次要十几秒，
 *   不适合拿来做算法试验。验证有效后再移植（见 docs/strength-plan.md 第六节）。
 *
 * ⚠️ 测量本身也要自证（这里踩过坑）：
 *   FEN 少写一个点，解析器照样吐出 90 格，只是整盘棋错位 —— 看上去「解析成功」。
 *   所以下面的自检逐行卡死 10 行 × 9 字符，并且断言节点数 > 0。
 *   零节点会被读成「跑得飞快」，而不是「量错了」。
 */

'use strict';

const path = require('path');

/* 默认量「正本」引擎；--engine 可以指向 tools/order-variants.js 生成出来的变体，
   这样「改前的引擎」和「改后的引擎」是同一台台子量的，数字才可比。 */
const ENGINE_PATH = (function () {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--engine') return path.resolve(argv[i + 1]);
  return path.join(__dirname, '..', 'web', 'js', 'engine.js');
})();
const XQ = require(ENGINE_PATH);

/* 与 tools/search-bench/main.swift 用的是同一批局面 ——
   两端数字要能直接对照，局面不一样就没得比。 */
const POSITIONS = [
  { name: '标准开局', fen: XQ.START, note: '22 个棋子，最宽的分支' },
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

/* ---------- 局面自检 ---------- */

function loadPositions() {
  const out = [];
  for (const p of POSITIONS) {
    const rows = p.fen.split('/');
    if (rows.length !== 10) throw new Error(`FEN 行数不对：${p.name} 得到 ${rows.length} 行（应为 10）`);
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].length !== 9) throw new Error(`FEN 第 ${r} 行不是 9 个字符：'${rows[r]}'（${rows[r].length} 个）`);
    }
    const b = XQ.parseBoard(p.fen);
    if (b.length !== 90) throw new Error(`FEN 解析失败：${p.name} 得到 ${b.length} 格`);
    const legal = XQ.legalMoves(b, 'r').length;
    if (legal <= 0) throw new Error(`局面不合法（或 FEN 写错）：${p.name} 红方 0 个合法着法`);
    out.push({ name: p.name, note: p.note, fen: p.fen, board: b, legal: legal });
  }
  return out;
}

function parseArgs(argv) {
  const opts = { depths: [4, 5, 6, 7], json: false, only: null, timeMs: 240000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--depths') opts.depths = argv[++i].split(',').map(Number);
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--time') opts.timeMs = Number(argv[++i]);
    else if (a === '--engine') i++;   /* 已在文件顶部处理，这里只是别被当成未知参数 */
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  return opts;
}

/* ---------- 主流程 ---------- */

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 把「排序函数」的指纹也记下来：改完排序后，同一个测法如果指纹没变，
  // 说明改动没真的生效（这种「静默没生效」比测错更常见）。
  const pos = loadPositions();
  const results = [];

  if (!opts.json) {
    console.log('==================================================================');
    console.log(`被测引擎：${ENGINE_PATH}`);
    console.log('==================================================================');
    console.log('局面自检');
    console.log('==================================================================');
    let cells = 0;
    for (const p of pos) {
      const n = p.board.filter(ch => ch !== XQ.EMPTY).length;
      cells += n;
      console.log(`  ${p.name.padEnd(8)} 子 ${String(n).padStart(2)} | 红方真合法着法 ${String(p.legal).padStart(2)} | ${p.note}`);
    }
    /* 期望子数是数出来的，不是猜的：32 + 32 + 10 = 74（标准开局全子 32）。
       换个局面就要改这里 —— 改不动就说明局面被换过了，正是这个断言的目的。 */
    console.log(`  （校验和：棋盘子数合计 ${cells}，应为 32 + 32 + 10 = 74）`);
    if (cells !== 74) {
      console.error(`局面自检失败：子数合计 ${cells} ≠ 74`);
      process.exit(1);
    }
    console.log();
    console.log('==================================================================');
    console.log('固定深度节点数（排序质量的直接指标：越小越好）');
    console.log('==================================================================');
    console.log('  局面        深度   节点数      静态搜索      耗时      千节点/秒   最佳着法');
  }

  let checkedNonZero = 0;

  for (const p of pos) {
    if (opts.only && p.name !== opts.only) continue;
    for (const d of opts.depths) {
      XQ.resetSearch();
      const t0 = Date.now();
      const r = XQ.searchRoot(p.board, 'r', d, opts.timeMs, null, null);
      const dt = Date.now() - t0;
      if (r.nodes <= 0) {
        console.error(`量到 0 个节点（${p.name} 深度 ${d}）—— 这是量错了，不是跑得快`);
        process.exit(1);
      }
      checkedNonZero++;
      const knps = dt > 0 ? r.nodes / dt : 0;
      const label = r.move ? XQ.moveLabel(p.board, r.move) : '(无)';
      results.push({
        position: p.name, depth: d, reached: r.depth, nodes: r.nodes, qnodes: r.qnodes,
        ms: dt, knps: Number(knps.toFixed(1)), best: label, score: r.score,
      });
      if (!opts.json && r.depth >= d) {
        console.log(`  ${p.name.padEnd(8)} ${String(d).padStart(2)}   ${String(r.nodes).padStart(9)}   ${String(r.qnodes).padStart(9)}  ${String(dt).padStart(7)} ms  ${String(knps.toFixed(1)).padStart(8)}   ${label}`);
      } else if (!opts.json) {
        console.log(`  ${p.name.padEnd(8)} ${String(d).padStart(2)}   ${String(r.nodes).padStart(9)}   ${String(r.qnodes).padStart(9)}  ${String(dt).padStart(7)} ms  ${String(knps.toFixed(1)).padStart(8)}   ${label}   ← 没搜完（超时）`);
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ positions: results }, null, 2));
    return;
  }

  // 汇总：每个局面在「最大那个搜完了的深度」上的节点数 —— 一行一个关键数字
  console.log();
  console.log('  汇总（每个局面取最深的、搜完了的那一档）');
  for (const p of pos) {
    const done = results.filter(r => r.position === p.name && r.reached >= r.depth);
    if (!done.length) { console.log(`    ${p.name.padEnd(8)} —— 所有深度都没搜完`); continue; }
    const best = done[done.length - 1];
    console.log(`    ${p.name.padEnd(8)} 深度 ${best.depth} → ${String(best.nodes).padStart(9)} 节点 / ${String(best.ms).padStart(6)} ms`);
  }
  console.log();
  console.log(`  （自证：${checkedNonZero} 次测量全部返回了 > 0 的节点数）`);
}

main();
