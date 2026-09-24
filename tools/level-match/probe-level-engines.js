#!/usr/bin/env node
/* 自证：档位 wrapper 真的把深度卡住了吗？各档实际到第几层、花多少毫秒？
 *
 * ── 为什么非要有这一步 ──────────────────────────────────────────────────
 * 反面教材（本项目踩过）：Swift 的 searchSync 把 `excluded` 写死成 `[]`，
 * 让「强制走某一手」实际跑的是自由搜索 —— 两次测量一模一样，看着像
 * 「新功能完全没作用」。测量工具坏掉的样子，长得跟否定结论一样。
 *
 * 所以这里**不信 wrapper 文件里写的常量**，而是拿它真跑，看报出来的 depth。
 *
 * 用法：node tools/level-match/probe-level-engines.js
 */

'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../..');
const BUILD = path.join(__dirname, 'build');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));

const levels = ['easy', 'normal', 'hard', 'expert', 'master'];
const engines = {};
for (const lv of levels) {
  const p = path.join(BUILD, `lv-${lv}.js`);
  if (!fs.existsSync(p)) {
    console.error(`缺 ${path.relative(ROOT, p)} —— 先跑 node tools/level-match/gen-level-engines.js`);
    process.exit(2);
  }
  engines[lv] = require(p);
}

/* 局面一律从题库取 —— 手写 FEN 极易踩 parseBoard 的坑：
   它按 `/` 分段后**逐字符**读满 9 列、用 `.` 表示空格子，
   不是标准 FEN 的数字记法。第一版按数字写了 `9/1c5c1/…`，
   字符 '9' 被当成棋子 → PI['9'] undefined → 崩在 computeHash 里。 */
const lib = require(path.join(ROOT, 'shared/library.json'));
const deepest = lib.mates.slice().sort((a, b) => (b.mateIn || 0) - (a.mateIn || 0))[0];
const study = lib.studies[0];

const cases = [
  ['标准开局', XQ.START, 'r'],
  [`深杀（${deepest.id}，${deepest.mateIn} 手）`, deepest.fen, 'r'],
  [`残局（${study.id}）`, study.fen, 'r'],
];

const cache = new Map();
function probe(XQe, label) {
  const key = `${XQe._level || 'raw'}|${label}`;
  if (cache.has(key)) return cache.get(key);
  const c = cases.find((x) => x[0] === label);
  const b = XQe.parseBoard(c[1]);
  if (XQe.resetSearch) XQe.resetSearch();
  const t0 = Date.now();
  /* depth 传 99、时间传一个用不完的值 —— 于是**只有 wrapper 的上限能拦住它**。
     这样测出来的层数才是 wrapper 真的在起作用的证据。 */
  const r = XQe.searchRoot(b, c[2], 99, 9999999, null, []);
  const out = { depth: r.depth, nodes: r.nodes, ms: Date.now() - t0 };
  cache.set(key, out);
  return out;
}

console.log(`每格 = 实际到达层数 / 节点数 / 耗时ms　（${path.relative(ROOT, BUILD)}/ 下的引擎，depth 请求 99）\n`);
console.log(['档位', 'depth上限', '时间预算', ...cases.map((c) => c[0])].join('\t'));
for (const lv of levels) {
  const row = [lv, String(engines[lv]._maxDepth), `${engines[lv]._budgetMs}ms`];
  for (const c of cases) {
    const r = probe(engines[lv], c[0]);
    row.push(`${r.depth}层/${r.nodes}/${r.ms}ms`);
  }
  console.log(row.join('\t'));
}

/* ---------- 断言 ---------- */
let bad = 0;
for (const lv of levels) {
  const cap = engines[lv]._maxDepth;
  for (const c of cases) {
    const r = probe(engines[lv], c[0]);
    if (r.depth > cap) {
      console.log(`❌ ${lv} 在「${c[0]}」到了 ${r.depth} 层，超过上限 ${cap} —— wrapper 没生效`);
      bad++;
    }
    /* 层数必须 ≥1：0 层意味着「连一步都没搜」，那是引擎坏了而不是档位弱。
       （残局里可能因为提前找到将死而层数偏低，但不会是 0。） */
    if (!(r.depth >= 1)) {
      console.log(`❌ ${lv} 在「${c[0]}」只到 ${r.depth} 层 —— 引擎没给出结果`);
      bad++;
    }
  }
}
/* 反向断言：最弱档必须**明显**低于最强档。否则「把上限烘进去」这件事
   根本没被验证到（可能所有档其实跑的都是同一份）。 */
const probeLabel = cases[1][0];
const e0 = probe(engines.easy, probeLabel).depth, e4 = probe(engines.master, probeLabel).depth;
if (!(e4 > e0)) { console.log(`❌ 入门 ${e0} 层、大师 ${e4} 层 —— 档位之间没有拉开`); bad++; }

console.log(bad === 0
  ? `\n✅ 自证通过：5 档在 3 个局面下都没越过各自上限；同一局面 入门 ${e0} 层 vs 大师 ${e4} 层`
  : `\n❌ 自证失败：${bad} 处异常`);
process.exit(bad === 0 ? 0 : 1);
