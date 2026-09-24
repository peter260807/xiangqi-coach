#!/usr/bin/env node
/* 各难度档「能独立解出多少道杀法题」—— 比 Elo 更好感知的水平刻度。
 *
 * ── 判据（这一版是修正过的，前一版作废）────────────────────────────────
 * 走**整条解法路线**：轮到我方（红）就让引擎自己搜、黑方按题库强制应着，
 * 每一个红方着法都必须与题库解法一致，中途错一步即判失败。
 *
 * ❌ 前一版只比对「首着」—— 结果是入门档（1 层）在 17 手杀上 2/2 命中。
 *    1 层的引擎不可能算出 17 手杀：很多题的杀棋首着是**唯一的将军**，
 *    随便搜一层也能撞上。首着命中测的是「有没有撞对」，不是「会不会解题」。
 *
 * ❌ 前一版还用「该手数命中率 >= 80% 的最大手数」当「能稳定解开到几手」——
 *    深杀题每档只有 1~2 道，命中 1 道就是 100%，小分母直接把指标毁成
 *    「所有档都能解 30 手杀」。改成**累计口径**：手上限 K 时，所有 mateIn<=K
 *    的题合起来解出了几成，并强制该区间的题目数不少于 --min-n 道。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────
 * 深度上限、时间预算取该档自己的（与用户实际下棋时同一套参数），
 * 每次搜索前清置换表（不清的话结果会依赖前面刚跑过哪几题，不可复现）。
 *
 * 用法：
 *   node tools/level-match/puzzle-rate.js                  # 全部 981 题 x 5 档
 *   node tools/level-match/puzzle-rate.js --sample 300      # 分层抽样
 *   node tools/level-match/puzzle-rate.js --ms-cap 2000 --min-n 15
 */

'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const lib = require(path.join(ROOT, 'shared/library.json'));

const argv = process.argv.slice(2);
function argNum(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
}
const SAMPLE = argNum('--sample', 0);
const MS_CAP = argNum('--ms-cap', 2000);
const MIN_N = argNum('--min-n', 15);

const LEVELS = [['easy', XQ.LEVELS.easy], ['normal', XQ.LEVELS.normal],
                ['hard', XQ.LEVELS.hard], ['expert', XQ.LEVELS.expert]];

/* 分层抽样：按 mateIn 各取若干道，固定取样（可复现） */
let puzzles = lib.mates;
if (SAMPLE > 0) {
  const byMate = new Map();
  for (const m of puzzles) {
    const k = m.mateIn || 0;
    if (!byMate.has(k)) byMate.set(k, []);
    byMate.get(k).push(m);
  }
  const per = Math.max(1, Math.floor(SAMPLE / byMate.size));
  const picked = [];
  for (const k of [...byMate.keys()].sort((a, b) => a - b)) picked.push(...byMate.get(k).slice(0, per));
  puzzles = picked;
}

console.log(`题库 ${lib.mates.length} 道，本次测 ${puzzles.length} 道`
  + `（${SAMPLE > 0 ? '按 mateIn 分层抽样' : '全量'}）；`
  + `每题时间上限 ${MS_CAP}ms；判据 = 走完整条解法路线\n`);

/** 让引擎独立解一道题：红方回合自己搜，黑方回合按题库强制走。
 *  返回 { ok, redTotal, redWant, ms, truncated } —— 走到第几个红方着法才错。 */
function solve(m, cfg) {
  let b = XQ.parseBoard(m.fen);
  let side = 'r';
  const history = [];
  const line = m.line || [];
  let redWant = 0, ms = 0, truncated = 0;
  for (let i = 0; i < line.length; i++) {
    const want = XQ.findMoveByLabel(b, side, line[i]);
    if (!want) return { ok: false, redTotal: redWant, bad: 'line 里的着法在当前局面不合法' };
    if (side === 'r') {
      redWant++;
      XQ.resetSearch();
      const t0 = Date.now();
      const r = XQ.searchRoot(b, 'r', cfg.depth, Math.min(cfg.time, MS_CAP), null, history.slice());
      ms += Date.now() - t0;
      if (ms >= MS_CAP * 0.9 && (r.depth || 0) < cfg.depth) truncated = 1;
      if (!r.move || r.move[0] !== want[0] || r.move[1] !== want[1]) {
        return { ok: false, redTotal: redWant, ms, truncated };
      }
    }
    XQ.makeMove(b, want);
    history.push(want);
    side = XQ.other(side);
  }
  return { ok: true, redTotal: redWant, ms, truncated };
}

const results = {};
for (const [name, cfg] of LEVELS) {
  const t0 = Date.now();
  const byMate = new Map();       // mateIn -> [solved, total]
  let bad = 0, trunc = 0;
  for (const m of puzzles) {
    const k = m.mateIn || 0;
    if (!byMate.has(k)) byMate.set(k, [0, 0]);
    const cell = byMate.get(k);
    cell[1]++;
    let r;
    try { r = solve(m, cfg); } catch (e) { bad++; continue; }
    if (r.bad) { bad++; continue; }
    if (r.ok) cell[0]++;
    if (r.truncated) trunc++;
  }
  const hit = [...byMate.values()].reduce((s, c) => s + c[0], 0);
  const tot = [...byMate.values()].reduce((s, c) => s + c[1], 0);
  results[name] = { byMate, bad, trunc, secs: ((Date.now() - t0) / 1000).toFixed(0) };
  console.log(`  ${name.padEnd(7)} ${String(cfg.depth).padStart(2)} 层 / ${String(cfg.time).padStart(4)}ms`
    + `　解出 ${String(hit).padStart(3)}/${tot}（${(100 * hit / tot).toFixed(1)}%）`
    + `　撞时间上限 ${trunc} 道　数据异常 ${bad} 道　耗时 ${results[name].secs}s`);
}

/* ---------- 按 mateIn 分组的解出率 ---------- */
const mateKeys = [...new Set(puzzles.map((m) => m.mateIn || 0))].sort((a, b) => a - b);
console.log('\n按「几手杀」看解出率（解出/题数）：');
console.log(['几手杀', '题数', ...LEVELS.map(([n]) => n)].join('\t'));
for (const k of mateKeys) {
  const tot = (results[LEVELS[0][0]].byMate.get(k) || [0, 0])[1];
  const cells = LEVELS.map(([n]) => {
    const c = results[n].byMate.get(k);
    return c ? `${c[0]}/${c[1]}` : '-';
  });
  console.log([`${k} 手`, String(tot), ...cells].join('\t'));
}

/* ---------- 累计口径：「K 手以内解出几成」 ---------- *
 * 分母强制 >= MIN_N 道，避免小分母把指标毁掉（前一版就是栽在这）。 */
console.log(`\n累计解出率（mateIn <= K 的全部题合并；只报题数 >= ${MIN_N} 的区间）：`);
const cumKeys = [];
let cumN = 0;
for (const k of mateKeys) {
  cumN += (results[LEVELS[0][0]].byMate.get(k) || [0, 0])[1];
  if (cumN >= MIN_N) cumKeys.push(k);
}
console.log(['K（含）', '题数', ...LEVELS.map(([n]) => n)].join('\t'));
for (const K of cumKeys) {
  let tot = 0;
  const hits = LEVELS.map(() => 0);
  for (const k of mateKeys) {
    if (k > K) continue;
    LEVELS.forEach(([n], i) => {
      const c = results[n].byMate.get(k) || [0, 0];
      if (i === 0) tot += c[1];
      hits[i] += c[0];
    });
  }
  console.log([`${K} 手`, String(tot),
    ...hits.map((h) => `${(100 * h / tot).toFixed(0)}%`)].join('\t'));
}

console.log('\n各档解出的题数（应随档位单调不减）：');
const totals = LEVELS.map(([n]) => [...results[n].byMate.values()].reduce((s, c) => s + c[0], 0));
console.log('  ' + totals.map((t, i) => `${LEVELS[i][0]}=${t}`).join('  '));

let bad = 0;
for (let i = 1; i < totals.length; i++) {
  if (totals[i] < totals[i - 1]) {
    console.log(`❌ ${LEVELS[i][0]}（${totals[i]}）比 ${LEVELS[i - 1][0]}（${totals[i - 1]}）解出的还少 —— 档位顺序有问题`);
    bad++;
  }
}
const badTotal = LEVELS.reduce((s, [n]) => s + results[n].bad, 0);
if (badTotal > 0) {
  console.log(`⚠️  跨档累计 ${badTotal} 次因题库局面非法 / 解法着法对不上而跳过 —— 对应既有的 6 处非法局面`);
}
console.log(bad === 0 ? '\n✅ 档位顺序自证通过' : `\n❌ 自证失败：${bad} 处`);
process.exit(bad === 0 ? 0 : 1);
