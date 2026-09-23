'use strict';
/* 读 quality 模式的 JSONL，出「深度 → 质量」曲线。
 *
 *   node tools/precompute-report.js <quality.jsonl> [--app-depth 4]
 *
 * 三个口径要先说清，否则数字会被误读：
 *
 *   1. **质量用「丢分」，不用相关系数。** 丢分 = 裁判(Pikafish)给最佳着法的分
 *      减去它给我们的建议手的分。两边都出自裁判，**同一把尺子**，可以直接比。
 *   2. **不要把我们的 cp 和裁判的 cp 放在一起比。** 我们自己那列 score 是手写评估
 *      的量纲，和 Pikafish 的分数不是一回事 —— 只有 loss / sameAsRef 是跨引擎可比的。
 *   3. **按子力数分期再看一遍。** 开局段分支大、评估最弱，杀法/残局段搜索主导 ——
 *      两段的结论经常完全相反，混在一起平均会把两边都抹平。
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('用法: node tools/precompute-report.js <quality.jsonl>'); process.exit(2); }
const appDepth = parseInt((process.argv.indexOf('--app-depth') >= 0
  ? process.argv[process.argv.indexOf('--app-depth') + 1] : '4'), 10);

const recs = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/* 分期：按子力总数 */
function phaseOf(fen) {
  const board = fen.split(' ')[0];
  const n = board.split('').filter((c) => /[a-zA-Z]/.test(c)).length;
  if (n >= 24) return '开局';
  if (n >= 12) return '中局';
  return '残局';
}

const depths = new Set();
for (const r of recs) if (r.ours) for (const d of Object.keys(r.ours)) depths.add(parseInt(d, 10));
const ds = [...depths].sort((a, b) => a - b);

function stat(list) {
  if (!list.length) return null;
  const sum = (f) => list.reduce((a, x) => a + f(x), 0);
  const losses = list.map((x) => x.loss).sort((a, b) => a - b);
  return {
    n: list.length,
    same: sum((x) => (x.same ? 1 : 0)) / list.length,
    loss: sum((x) => x.loss) / list.length,
    median: losses[losses.length >> 1],
    ms: sum((x) => x.ms) / list.length,
    mate: sum((x) => (x.mate ? 1 : 0)),
  };
}

const pad = (s, w) => String(s).padStart(w);
const pads = (s, w) => String(s).padEnd(w);

console.log('文件: ' + file);
console.log('局面: ' + recs.length + ' 个    （app 现在的分析深度 = ' + appDepth + '）');
console.log('');

function table(title, subset) {
  console.log('=== ' + title + ' ===');
  console.log(pads('深度', 6) + pad('局面', 6) + pad('着法一致率', 11) + pad('平均丢分', 10)
    + pad('中位丢分', 10) + pad('平均耗时', 11));
  for (const d of ds) {
    const rows = [];
    for (const r of subset) {
      const o = r.ours && r.ours[d];
      if (!o || !o.move) continue;
      /* 裁判没给出分数的记录（例如局面被裁判判为非法而自杀）整条跳过 ——
         少了这层判断，`r.ref.score` 会直接抛 TypeError，报告脚本先崩。 */
      if (!r.ref || typeof r.ref.score !== 'number' || typeof o.judged !== 'number') continue;
      /* 裁判给出杀棋分数时不参与丢分统计 —— 折算过的杀棋分会把均值拉飞 */
      const isMate = Math.abs(r.ref.score) >= 29000 || Math.abs(o.judged) >= 29000;
      rows.push({ loss: isMate ? 0 : o.loss, same: o.sameAsRef, ms: o.ms, mate: isMate });
    }
    const nonMate = rows.filter((x) => !x.mate);
    const s = stat(nonMate.length >= 3 ? nonMate : rows);
    if (!s) continue;
    console.log(pads('d' + d, 6) + pad(s.n, 6)
      + pad((s.same * 100).toFixed(1) + '%', 11)
      + pad(s.loss.toFixed(1), 10)
      + pad(String(s.median), 10)
      + pad(s.ms < 1000 ? s.ms.toFixed(0) + 'ms' : (s.ms / 1000).toFixed(1) + 's', 11));
  }
  console.log('');
}

const withOurs = recs.filter((r) => r.ours);
table('全体', withOurs);

const phases = ['开局', '中局', '残局'];
for (const p of phases) {
  const sub = withOurs.filter((r) => phaseOf(r.fen) === p);
  if (sub.length < 5) { console.log('=== ' + p + ' === （样本 ' + sub.length + ' 个，太少，跳过）\n'); continue; }
  table(p, sub);
}

/* 取某个深度的有效丢分。**必须和上面表格用同一套过滤** ——
   表格里排掉了杀棋局面，而这里原来没排，于是把折算过的杀棋分（±29000+）平均进去，
   直接算出「d4 平均丢分 2395.8」这种一眼假的数。 */
function lossOf(r, d) {
  const o = r.ours && r.ours[d];
  if (!o || !o.move) return null;
  if (!r.ref || typeof r.ref.score !== 'number' || typeof o.judged !== 'number') return null;
  if (Math.abs(r.ref.score) >= 29000 || Math.abs(o.judged) >= 29000) return null;
  return o.loss;
}

const errored = recs.filter((r) => r.error);
if (errored.length) {
  console.log('⚠️  有 ' + errored.length + ' 条记录带错误（多半是局面被裁判判为非法），已从统计中剔除：');
  for (const r of errored.slice(0, 5)) {
    console.log('   ' + (r.tag || r.key).slice(0, 40) + '  ← ' + String(r.error).slice(0, 90));
  }
  if (errored.length > 5) console.log('   …还有 ' + (errored.length - 5) + ' 条');
  console.log('');
}

console.log('=== 相对 app 当前深度（d' + appDepth + '）的改善 ===');
const baseLosses = withOurs.map((r) => lossOf(r, appDepth)).filter((x) => x !== null);
if (!baseLosses.length) {
  console.log('  没有 d' + appDepth + ' 的数据，跳过');
} else {
  const bl = baseLosses.reduce((a, b) => a + b, 0) / baseLosses.length;
  console.log('  d' + appDepth + ' 平均丢分 ' + bl.toFixed(1) + '（' + baseLosses.length + ' 个局面）');
  for (const d of ds) {
    if (d === appDepth) continue;
    const v = withOurs.map((r) => lossOf(r, d)).filter((x) => x !== null);
    if (!v.length) continue;
    const tl = v.reduce((a, b) => a + b, 0) / v.length;
    const delta = bl - tl;
    const pct = bl > 0 ? (delta / bl * 100) : 0;
    console.log('  d' + pads(d, 3) + ' 平均丢分 ' + pad(tl.toFixed(1), 6)
      + '   相对 d' + appDepth + ' ' + (delta >= 0 ? '少丢 ' : '多丢 ')
      + pad(Math.abs(delta).toFixed(1), 6) + ' 分（' + Math.abs(pct).toFixed(0) + '%）'
      + '   [' + v.length + ' 个局面]');
  }
}

console.log('');
console.log('=== 每个深度的中位丢分 / 一致率（更能代表"用户感受到的"）===');
for (const d of ds) {
  const v = withOurs.map((r) => ({ loss: lossOf(r, d), same: r.ours && r.ours[d] && r.ours[d].sameAsRef }))
    .filter((x) => x.loss !== null);
  if (!v.length) continue;
  const sorted = v.map((x) => x.loss).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const bad = v.filter((x) => x.loss >= 100).length;
  const good = v.filter((x) => x.loss <= 20).length;
  console.log('  d' + pads(d, 3) + ' 中位 ' + pad(med, 4) + ' 分   丢分≥100 的局面 '
    + pad(bad, 3) + '/' + v.length + '（' + (bad / v.length * 100).toFixed(0) + '%）'
    + '   丢分≤20 的 ' + pad(good, 3) + '（' + (good / v.length * 100).toFixed(0) + '%）');
}
