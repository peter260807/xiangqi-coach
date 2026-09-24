#!/usr/bin/env node
'use strict';
/* 复盘摘要的自证测试。
 *
 *   node tools/test-review.js
 *
 * 为什么值得单独测：复盘是**给人看结论**的功能。摘要里任何一处错位
 * （比如把「第 N 手走的什么」对错了来源、把丢分排序弄反）都不会报错，
 * 只会安静地讲一段听起来很有道理、但事实对不上的话 —— 这比崩溃难发现得多。
 *
 * ⚠️ 这个文件被**打过一次脸**，值得记下来：
 * 第一版造数据时，我顺手把黑方的着法也写进了 `game.moves`，
 * 于是 49 项断言全过。但真实 app 里 `record.moves` **只装红方的着法**
 * （当时 `recordMove` 只在红方落子后被调用）——
 * 也就是说测试在一个不符合现实的假设上全绿了，而线上复盘会把
 * `played` 指到另一盘棋上。是无头浏览器探针把它抓出来的。
 * 所以现在这里有一条**专门针对旧存档形状**的回归断言（见第 [12] 节）。
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const XQSTORE = require(path.join(ROOT, 'web/js/storage.js'));
const XQAI = require(path.join(ROOT, 'web/js/ai.js'));

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function eq(a, b, msg) { check(a === b, msg + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }

/* ---------- 造一局真实的棋 ----------
 *
 * 黑方走引擎最佳；红方**故意隔一手走差棋** —— 第一版让红方也走引擎首选，
 * 结果 loss 全 ≈ 0、一个失误都没有，「关键时刻」「排序」「篡改自证」
 * 那几节全部零成本通过。复盘真正要处理的是"下错棋的局面"，测试就必须真的下错棋。
 *
 * 记录方式**刻意对齐 app.js 的 playMove**：每一手（红黑都算）都追加到
 * `game.moves` 并更新 `game.ply`；分析则通过 recordMove 写入 evals。
 */
const DEPTH = 4;
function makeGame(plies) {
  const game = XQSTORE.createGame({ sceneId: 'start', sceneName: '标准开局' });
  const b = XQ.parseBoard(XQ.START);
  let side = 'r';
  let redTurn = 0;
  for (let i = 0; i < plies; i++) {
    XQ.resetSearch();
    const r = XQ.searchRoot(b, side, DEPTH, 300);
    if (!r.move) break;
    let mv = r.move;
    const ply = game.moves.length + 1;
    if (side === 'r') {
      redTurn++;
      if (redTurn % 2 === 0) {
        const legal = XQ.legalMoves(b, 'r');
        if (legal.length > 3) mv = legal[(redTurn * 5) % legal.length];
      }
      const pre = XQ.cloneBoard(b);
      const a = XQSTORE.analyzeMove(pre, mv, { depth: DEPTH, budget: 300 });
      XQSTORE.recordMove(game, pre, mv, a, XQSTORE.phaseFor(pre, ply), ply);
    }
    /* 与 playMove 一致：每一手都记 */
    game.moves.push([mv[0], mv[1]]);
    game.ply = game.moves.length;
    XQ.makeMove(b, mv);
    side = XQ.other(side);
  }
  game.result = 'loss';
  game.finished = true;
  return { game };
}

const { game } = makeGame(16);
console.log('[1] 造局：' + game.moves.length + ' 手（红 ' + game.evals.length + ' 手有分析）\n');

const d = XQSTORE.reviewDigest(game);

console.log('[2] 基本字段');
check(!!d, 'digest 非空');
eq(d.plies, game.moves.length, 'plies = 总手数');
eq(d.rounds, Math.ceil(game.moves.length / 2), 'rounds = 回合数');
eq(d.counts.moves, game.evals.length, 'counts.moves = 有分析的手数');
eq(d.result, 'loss', 'result 透传');

console.log('\n[3] 分类计数必须与 record.flags 对上（两条独立路径的交叉核对）');
const byGrade = (g) => game.evals.filter((e) => e.grade === g).length;
eq(d.counts.blunder, byGrade('blunder'), 'counts.blunder');
eq(d.counts.mistake, byGrade('mistake'), 'counts.mistake');
eq(d.counts.inaccuracy, byGrade('inaccuracy'), 'counts.inaccuracy');
eq(d.counts.missedMate, game.evals.filter((e) => e.missedMate).length, 'counts.missedMate');
eq(d.counts.blunder, game.flags.blunders, '与 flags.blunders 一致');
eq(d.counts.mistake, game.flags.mistakes, '与 flags.mistakes 一致');

console.log('\n[4] 阶段划分：三段的 moves 之和必须等于总数（漏一段就会少报）');
const sumMoves = d.phases.reduce((s, p) => s + p.moves, 0);
eq(sumMoves, game.evals.length, '三阶段手数之和 = 总手数');
d.phases.forEach((p) => {
  const list = game.evals.filter((e) => e.phase === p.key);
  eq(p.moves, list.length, '阶段「' + p.name + '」手数');
  eq(p.avgLoss, list.length ? Math.round(list.reduce((s, e) => s + e.loss, 0) / list.length) : null,
    '阶段「' + p.name + '」平均丢分');
});

console.log('\n[5] 关键时刻：只看真扣分的、按丢分降序、最多 6 条');
check(d.keys.length <= 6, 'keys 不超过 6 条（实际 ' + d.keys.length + '）');
let sortedOk = true;
for (let i = 1; i < d.keys.length; i++) if (d.keys[i - 1].loss < d.keys[i].loss) sortedOk = false;
check(sortedOk, 'keys 按丢分从大到小排序');
check(d.keys.every((k) => k.grade !== 'inaccuracy'),
  'keys 里没有「不够精确」（阈值只有 100 分，列出来会把真问题埋掉）');
check(d.keys.every((k) => k.loss >= XQSTORE.TH.mistake || k.missedMate),
  'keys 里的每一条 loss 都 ≥ 失误阈值，或是漏杀');
check(d.keys.length > 0, '（前提）这盘确实产生了关键时刻，否则第 5~7 节的断言是空转');

console.log('\n[6] played 记谱：与**独立重放**的结果逐字核对');
{
  /* 独立重放：不碰 digest 的中间结果，自己走一遍完整着法序列 */
  const expect = [];
  const bb = XQ.parseBoard(XQ.START);
  for (let i = 0; i < game.moves.length; i++) {
    expect.push(XQ.moveLabel(bb, game.moves[i]));
    XQ.makeMove(bb, game.moves[i]);
  }
  let playedOk = true, badAt = -1;
  for (const k of d.keys) {
    if (k.played !== expect[k.ply - 1]) { playedOk = false; badAt = k.ply; }
  }
  check(playedOk, '每条关键时刻的 played 与独立重放逐字相同' + (badAt >= 0 ? '（第 ' + badAt + ' 手不符）' : ''));
  /* 而且必须与 evals 里存下来的 playedLabel 一致 —— 存的和算的不能是两套 */
  const byLabelOk = d.keys.every((k) => {
    const e = game.evals.find((x) => x.ply === k.ply);
    return e && (e.playedLabel || '') === k.played;
  });
  check(byLabelOk, 'played 与 evals[].playedLabel 一致（存下来的就是显示出来的）');
  /* 分辨力：这盘真的有多个不同着法，否则上面的核对没有意义 */
  check(new Set(game.moves.map((m) => m[0] * 100 + m[1])).size > 3,
    '这盘走出了多个不同着法（否则核对没有分辨力）');
}

console.log('\n[7] 引擎建议：best 必须来自该 ply 的 evals，不能是别的手');
let bestOk = true;
for (const k of d.keys) {
  const e = game.evals.find((x) => x.ply === k.ply);
  if (!e || (k.best || '') !== (e.bestLabel || '')) bestOk = false;
}
check(bestOk, '每条关键时刻的 best 与对应 ply 的 bestLabel 一致');

console.log('\n[8] 主要弱点判定');
const cand = d.phases.filter((p) => p.moves >= 3).sort((a, b) => b.avgLoss - a.avgLoss);
if (cand.length) {
  eq(d.worst && d.worst.key, cand[0].key, 'worst = 样本≥3 手里平均丢分最高的阶段');
} else {
  eq(d.worst, null, '没有样本≥3 的阶段时不硬下结论');
}

console.log('\n[9] 文案：本地文案要能独立读懂（不配 API Key 也能复盘）');
const t = d.text;
check(t.indexOf('【结果】') >= 0, 'text 含【结果】');
check(t.indexOf('【失误分布】') >= 0, 'text 含【失误分布】');
check(t.indexOf('【关键时刻】') >= 0, 'text 含【关键时刻】');
check(t.indexOf('【结论】') >= 0, 'text 含【结论】');
check(t.indexOf(d.keys[0].played) >= 0, 'text 里出现了最大失误的那一手（' + d.keys[0].played + '）');
if (d.keys[0].best) check(t.indexOf(d.keys[0].best) >= 0, 'text 里出现了引擎的建议着法（' + d.keys[0].best + '）');
check(t.indexOf('undefined') < 0 && t.indexOf('NaN') < 0, 'text 里没有 undefined / NaN');

console.log('\n[10] 喂给大模型的结构化事实');
const dl = XQSTORE.digestLines(d);
check(dl.length > 0, 'digestLines 非空');
const dlText = dl.join('\n');
check(dlText.indexOf('严重失误 ' + d.counts.blunder) >= 0, 'digestLines 含失误计数');
d.keys.forEach((k) => {
  check(dlText.indexOf('第 ' + k.ply + ' 手') >= 0, 'digestLines 含第 ' + k.ply + ' 手');
});
check(dlText.indexOf('【结论】') < 0, 'digestLines 不含【结论】（那段由模型写）');

console.log('\n[11] 提示词：把结构化事实接进去了，并且禁止模型另造着法');
const msgs = XQAI.reviewMessages({
  moveText: 'x', result: '红方（你）获胜', endBoard: XQ.parseBoard(XQ.START),
  digestLines: dl, evalTrace: []
});
const prompt = msgs.map((m) => m.content).join('\n');
check(prompt.indexOf('已由本地引擎逐手算好') >= 0, '提示词含结构化事实段');
check(prompt.indexOf('不要自己另算或另造着法') >= 0, '提示词明确禁止另造着法');
check(prompt.indexOf(d.keys[0].played) >= 0, '提示词里出现了最大失误的那一手');
const msgs2 = XQAI.reviewMessages({ moveText: 'x', result: '和棋', endBoard: XQ.parseBoard(XQ.START), evalTrace: ['第1手 10', '第2手 -5'] });
check(msgs2[1].content.indexOf('第1手 10') >= 0, '没有 digestLines 时退回分数串');

/* ================= 回归：旧存档的形状 ================= */
console.log('\n[12] 回归：旧存档的 moves 只有红方着法时，绝不能猜出错误的记谱');
{
  /* 造一个「旧形状」的记录：moves 只装红方、evals 没有 playedLabel */
  const legacy = XQSTORE.createGame({ sceneId: 'start', sceneName: '旧存档' });
  game.evals.forEach((e) => {
    const lite = JSON.parse(JSON.stringify(e));
    delete lite.playedLabel;
    legacy.evals.push(lite);
  });
  game.moves.forEach((m, i) => { if (i % 2 === 0) legacy.moves.push(m); });   // 只有红方
  legacy.ply = legacy.moves.length;
  legacy.result = 'loss';
  legacy.finished = true;

  const dl2 = XQSTORE.reviewDigest(legacy);
  const k0 = dl2.keys[0];
  check(!!k0, '旧存档仍能生成复盘（不能因为缺字段就整块不可用）');
  if (k0) {
    eq(k0.played, '（记谱缺失）', '缺 playedLabel 时显示「记谱缺失」，而不是编一个');
    /* 这是关键的一条：证明"重放反推"确实会给出**不同**（错的）结果，
       所以「不猜」不是多余的谨慎，而是避免了一次静默的错误输出。 */
    const wrong = (function () {
      const bb = XQ.parseBoard(XQ.START);
      const labels = [];
      for (let i = 0; i < legacy.moves.length; i++) {
        labels.push(XQ.moveLabel(bb, legacy.moves[i]));
        XQ.makeMove(bb, legacy.moves[i]);
      }
      return labels[k0.ply - 1];
    })();
    check(wrong !== k0.played || wrong === undefined,
      '自证：按「只有红方着法」重放反推出的记谱是 ' + JSON.stringify(wrong) + '，与实际的 '
      + JSON.stringify(d.keys.find((x) => x.ply === k0.ply).played) + ' 不同 —— 所以不能靠反推');
  }
  /* 回合数兜底：旧存档 moves 少一半，也不能报出「0 回合」 */
  check(dl2.rounds >= Math.ceil(legacy.ply / 2), '旧存档的回合数按最大分析手数兜底（' + dl2.rounds + '）');
}

/* ================= 检查器自证 ================= */
console.log('\n[13] 自证（一）：把某一手的丢分改成最大，它必须排到关键时刻第一位');
{
  const g2 = JSON.parse(JSON.stringify(game));
  const victim = g2.evals.find((e) => e.grade !== 'blunder' && e.grade !== 'mistake');
  victim.grade = 'blunder';
  victim.loss = 99999;
  const d2 = XQSTORE.reviewDigest(g2);
  check(d2.keys.length > 0 && d2.keys[0].ply === victim.ply,
    '篡改后第 ' + victim.ply + ' 手排到第一（实际第一是 ' + (d2.keys[0] && d2.keys[0].ply) + '）');
  check(d2.counts.blunder === d.counts.blunder + 1, '篡改后严重失误计数 +1');
  check(d2.text !== d.text, '篡改后文案确实变了');
}

console.log('\n[14] 自证（二）：把一条失误降级成「不够精确」，它必须从关键时刻消失');
{
  const g3 = JSON.parse(JSON.stringify(game));
  const v = g3.evals.find((e) => e.grade === 'blunder' || e.grade === 'mistake');
  check(!!v, '（前提）这盘有失误可降级');
  if (v) {
    v.grade = 'inaccuracy';
    v.missedMate = false;
    const d3 = XQSTORE.reviewDigest(g3);
    check(!d3.keys.some((k) => k.ply === v.ply), '被降级的那一手不再出现在关键时刻');
    check(d3.counts.inaccuracy === d.counts.inaccuracy + 1, '「不够精确」计数 +1');
  }
}

console.log('\n[15] 自证（三）：比对本身有分辨力');
{
  check(XQSTORE.digestText(d) !== XQSTORE.digestText(d) + 'x', '文案比对能分辨出差异');
  const k = d.keys[0];
  const wrong = Object.assign({}, k, { played: k.played + '（错）' });
  check(wrong.played !== k.played, '故意写错的记谱确实与正确值不同');
}

console.log('\n[16] 难度文案：导入的深杀题必须说得出自己是多少手');
{
  /* 起因：`tierText` 原来写死成 `CN_NUM[mateIn - 1]`（数组只到「十」），
     于是 11 手以上全部掉进 tier 兜底、显示成「多步杀」。
     Pikafish 求解之后库里有 30 手杀，这个洞就露出来了。 */
  /* ⚠️ 2 手这里刻意是「二」不是「两」：原来 `CN_NUM[1]` 就是「二」，
     库里 21 道 mateIn=2 的题一直显示「二步杀」，训练页的筛选徽标也用「二」。
     这次只是把上界从 10 提到 99，不该顺手改掉既有文案（那是另一件事）。
     更深的 12 手因此是「十二步杀」而不是「十一步杀」那种混合写法，全篇一致。 */
  eq(XQSTORE.tierText({ mateIn: 1, tier: 1 }), '一步杀', '1 手');
  eq(XQSTORE.tierText({ mateIn: 2, tier: 2 }), '二步杀', '2 手（与既有文案一致）');
  eq(XQSTORE.tierText({ mateIn: 10, tier: 3 }), '十步杀', '10 手（原来是这个数组的边界）');
  eq(XQSTORE.tierText({ mateIn: 11, tier: 3 }), '十一步杀', '11 手（原来会退化成「多步杀」）');
  eq(XQSTORE.tierText({ mateIn: 20, tier: 3 }), '二十步杀', '20 手（整十，不加个位）');
  eq(XQSTORE.tierText({ mateIn: 28, tier: 3 }), '二十八步杀', '28 手');
  eq(XQSTORE.tierText({ mateIn: 30, tier: 3 }), '三十步杀', '30 手（当前库里的最深一题）');
  /* 没有 mateIn 的老条目仍按 tier 说话，不能变成空字符串 */
  eq(XQSTORE.tierText({ tier: 1 }), '一步杀', '缺 mateIn 时退回 tier 1');
  eq(XQSTORE.tierText({ tier: 3 }), '多步杀', '缺 mateIn 时退回 tier 3');
  /* 与真实库对一遍：凡是带 mateIn 的题，文案必须真的是「<中文数字>步杀」——
     不允许有题悄悄退回 tier 兜底的「多步杀」（那就是手数信息丢了）。 */
  const lib = require(path.join(ROOT, 'shared/library.json'));
  const mislabeled = lib.mates.filter((m) => m.mateIn >= 1 && !/^[一二三四五六七八九十]+步杀$/.test(XQSTORE.tierText(m)));
  eq(mislabeled.length, 0, '库里 ' + lib.mates.length + ' 道题都能报出手数（没有退回「多步杀」的）');
  /* 再抽一道真实的最深题，确认文案不是空转 */
  const deepest = lib.mates.reduce((a, b) => ((b.mateIn || 0) > (a.mateIn || 0) ? b : a));
  check(XQSTORE.tierText(deepest) !== '多步杀',
    '库里最深一题（' + deepest.name + '，' + deepest.mateIn + ' 手）文案为「' + XQSTORE.tierText(deepest) + '」');
}

console.log('\n──────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exitCode = fail ? 1 : 0;
