#!/usr/bin/env node
/* 生成「档位引擎」：把每个难度档的 depth 上限与时间预算烘进一个 wrapper 文件。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * tools/match.js 的 `--depth` 是**全局**的（两侧共用 cfg.depth），所以拿现成工具
 * 没法让「高级」和「入门」互下 —— `--ms-a/--ms-b` 只能改时间，而档位的天花板
 * 是 depth 而不是时间：高级档（d8）在标准开局 2.9s 跑满 8 层就用完了，
 * 中局更是 97ms 就 8 层，预算却给了 3500ms。光改时间测不出档位差。
 *
 * 所以给每档造一个引擎：只覆写 searchRoot，把调用方给的 depth 夹到该档上限。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node tools/level-match/gen-level-engines.js            # 生成到 build/
 *   node tools/level-match/probe-level-engines.js          # 自证真的卡住了
 *   ./tools/level-match/run-levels.sh                      # 相邻档循环赛
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const outDir = path.join(__dirname, 'build');

/* 与 web/js/engine.js 的 LEVELS、ios/XiangqiCoach/Engine/Search.swift 的
 * SearchLevel.all **逐项一致**。三处任一处改了这里就得跟着改，
 * 否则量出来的「档位棋力」和用户实际下的不是同一盘棋。
 * probe-level-engines.js 会拿 engine.js 的 LEVELS 回来对一遍，防止走神。 */
const levels = [
  ['easy',   1,  600],
  ['normal', 3, 1200],
  ['hard',   5, 2200],
  ['expert', 8, 3500],
  ['master', 12, 6000],
];

/* 源头对账：engine.js 里的 LEVELS 必须和上面这张表一致 */
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
let mismatched = 0;
for (const [name, depth, time] of levels) {
  const cfg = XQ.LEVELS[name];
  if (!cfg) { console.error(`源里没有 ${name} 档`); mismatched++; continue; }
  if (cfg.depth !== depth || cfg.time !== time) {
    console.error(`${name}：源里是 depth=${cfg.depth} time=${cfg.time}，本表写的是 depth=${depth} time=${time}`);
    mismatched++;
  }
}
if (mismatched) {
  console.error('档位定义对不上 —— 先同步 web/js/engine.js 的 LEVELS，别继续。');
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const enginePath = path.join(ROOT, 'web/js/engine.js');
const written = [];
for (const [name, depth, time] of levels) {
  const src = `/* 自动生成：${name} 档（depth<=${depth}, time=${time}ms）。勿手改 ——
 * 由 tools/level-match/gen-level-engines.js 生成。 */
'use strict';
const path = require('path');
const base = require(path.join(__dirname, '..', '..', '..', 'web/js/engine.js'));
const api = Object.assign({}, base);
api.searchRoot = function (b, s, depth, timeMs, exclude, history) {
  return base.searchRoot(b, s, Math.min(depth, ${depth}), ${time}, exclude, history);
};
api._level = ${JSON.stringify(name)};
api._maxDepth = ${depth};
api._budgetMs = ${time};
module.exports = api;
`;
  const p = path.join(outDir, `lv-${name}.js`);
  fs.writeFileSync(p, src);
  written.push(`${name}\tdepth<=${depth}\ttime=${time}ms\t${p}`);
}
console.log('档位引擎已生成（源自 ' + path.relative(ROOT, enginePath) + '，LEVELS 已对账）：');
console.log(written.join('\n'));
