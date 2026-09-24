#!/usr/bin/env node
'use strict';
/* 题库导入工具的自证测试。
 *
 *   node tools/test-import.js
 *
 * 这套逻辑里有三处「错了也不报错」的地方，必须单独测：
 *   ① 标准 FEN → 内部格式的转换 —— 外部用 `3a5`（数字压缩），我们逐格取字符。
 *      不转换的话 '3' 会被当成一枚棋子，**引擎照算不误**，只是算的是另一盘棋。
 *   ② 去重键 —— 用 (棋盘串, 走子方)，不是哈希。键写错就是「重复题悄悄进库」。
 *   ③ 杀棋手数 —— 从引擎的杀棋分读（MATE - ply），不是数线路长度。
 *      数长度会被浅深度拉长，mateIn 偏大，题目的难度分档跟着全错。
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const PC = require(path.join(ROOT, 'tools/lib/position-check.js'));
const IMP = require(path.join(ROOT, 'tools/import-puzzles.js'));

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function eq(a, b, msg) { check(a === b, msg + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }

console.log('[1] 标准 FEN → 内部格式');
{
  const r = PC.stdFenToInternal('3a5/4ak3/9/3R5/5P3/9/r8/7C1/r2p5/4K4 w - - 0 1');
  eq(r.board.split('/').length, 10, '10 行');
  eq(r.board.split('/')[0], '...a.....', '第 0 行 `3a5` → `...a.....`');
  eq(r.board.split('/')[0].length, 9, '第 0 行展开后 9 格');
  eq(r.side, 'r', '`w` 判成红先');
  eq(PC.stdFenToInternal('4k4/9/9/9/9/9/9/9/9/4K4 b').side, 'b', '`b` 判成黑先');
  /* 每一行都必须正好 9 格 —— 这是最容易静默出错的地方 */
  let allNine = true;
  for (const row of r.board.split('/')) if (row.length !== 9) allNine = false;
  check(allNine, '所有行都是 9 格');

  /* 自证：不转换会怎样 —— 证明这一步不是多余的 */
  const raw = XQ.parseBoard('3a5/4ak3/9/3R5/5P3/9/r8/7C1/r2p5/4K4');
  const wrong = raw.filter((p) => p === '3' || p === '5' || p === '9');
  check(wrong.length > 0, '自证：直接喂标准 FEN 会造出 ' + wrong.length + ' 个假棋子（所以转换必要）');
}

console.log('\n[2] 坏输入必须抛错，不能静默产出');
{
  /* 前两个是外部题库里真实存在的坏 FEN（审计报告里那两条）。
     ⚠️ `9/9/9/9/9/9/9/9/9/9` 看着像坏的，其实是**合法**的空棋盘 FEN ——
        第一版把它当坏输入写进断言，结果「期望 4 个抛错、实际 3 个」。
        校验器没写错，是断言写错了；这正好说明断言也要能被证伪。 */
  const shouldThrow = [
    '339/9/4k4/9/9/9/9/3pppR2/5pR2/4K1B2 w',
    '302ck5/4P4/3r3P1/6C2/6C2/2p3R2/8R/B2p4B/4p4/3K5 w',
    'x/9/9/9/9/9/9/9/9/9 w',
    '9/9/9/9/9/9/9/9/9 w',
  ];
  let threw = 0;
  for (const bad of shouldThrow) {
    try { PC.stdFenToInternal(bad); } catch (e) { threw++; }
  }
  eq(threw, shouldThrow.length, shouldThrow.length + ' 个坏 FEN 全部抛错');
  /* 反向自证：合法的空棋盘不该被误判为坏 */
  let okEmpty = true;
  try { PC.stdFenToInternal('9/9/9/9/9/9/9/9/9/9 w'); } catch (e) { okEmpty = false; }
  check(okEmpty, '自证：合法的空棋盘 FEN 不抛错（校验器两边都有分辨力）');
}

console.log('\n[3] 去重键：必须区分「同一局面不同走子方」');
{
  const a = PC.stdFenToInternal('4k4/9/9/9/9/9/9/9/9/R3K4 w');
  const b = PC.stdFenToInternal('4k4/9/9/9/9/9/9/9/9/R3K4 b');
  eq(a.board, b.board, '两个局面棋盘相同');
  check(PC.positionKey(a.board, a.side) !== PC.positionKey(b.board, b.side),
    '但键不同（红先/黑先是两道不同的题）');
  const c = PC.stdFenToInternal('4k4/9/9/9/9/9/9/9/9/R3K4 w');
  eq(PC.positionKey(c.board, c.side), PC.positionKey(a.board, a.side), '同一局面 + 同一走子方 → 同键（用于去重）');
}

console.log('\n[4] 杀棋手数：从引擎的杀棋分读出来（不是数线路长度）');
{
  /* 拿库里**已知手数**的题当基准 —— 这是同一口径下的地面真值。
     一开始我手写了一个「一步杀」的局面（`4k4/9/.../R3K4 w`），
     结果红帅与黑将同在第 4 列且中间无子 —— 那是**飞将的非法局面**，
     引擎给出的自然不是杀棋分。用库里的题就没有这种自造坑。 */
  const lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/library.json'), 'utf8'));
  const cases = lib.mates.filter((m) => m.mateIn >= 1 && m.mateIn <= 3).slice(0, 4);
  check(cases.length >= 2, '库里有 ' + cases.length + ' 道已知手数的杀法题可用作基准');
  let agree = 0;
  for (const m of cases) {
    const b = XQ.parseBoard(m.fen);
    XQ.resetSearch();
    const r = XQ.searchRoot(b, 'r', 2 * m.mateIn + 3, 8000);
    const mi = IMP.mateInOfScore(r.score);
    if (mi === m.mateIn) agree++;
    console.log('      ' + m.id + ' ' + m.name.padEnd(6) + ' 库里 mateIn=' + m.mateIn
      + '  分数=' + r.score + '  读出=' + mi);
  }
  eq(agree, cases.length, '从分数读出的手数与库里已知手数全部一致');

  /* 自证：分数确实在编码步数 —— 更远的杀分数应当更小 */
  const scores = cases.map((m) => {
    const bb = XQ.parseBoard(m.fen);
    XQ.resetSearch();
    return { mi: m.mateIn, score: XQ.searchRoot(bb, 'r', 2 * m.mateIn + 3, 8000).score };
  }).sort((a, b) => a.mi - b.mi);
  let mono = true;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i].mi > scores[i - 1].mi && scores[i].score > scores[i - 1].score) mono = false;
  }
  check(mono, '手数越大分数越小（自证：杀棋分里真的带着步数信息）');
}

console.log('\n[5] 外部题库文件在不在、格式对不对');
{
  const dir = path.join(ROOT, 'shared/external');
  if (!fs.existsSync(dir)) {
    check(false, 'shared/external 不存在（先跑 tools/import-puzzles.js fetch）');
  } else {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, 'basic-checkmates.json'), 'utf8'));
    check(Array.isArray(arr) && arr.length > 0, 'basic-checkmates.json 是数组且非空（' + arr.length + ' 条）');
    check(arr.every((x) => typeof x.fen === 'string'), '每条都有 fen 字段');
    /* 外部不给解法 —— 我们的解法是自己算的，所以 bestMove 空着是**预期**的 */
    const emptyBest = arr.filter((x) => !x.bestMove).length;
    eq(emptyBest, arr.length, '全部条目的 bestMove 都是空的（解法由我们自己的引擎算）');
  }
}

console.log('\n[6] 与现有库的重复检查：库里的局面必须全部能被解析');
{
  const lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/library.json'), 'utf8'));
  let bad = 0;
  for (const sec of ['mates', 'studies']) {
    for (const it of lib[sec] || []) {
      if (!it.fen) continue;
      try { PC.stdFenToInternal(it.fen + ' r'); } catch (e) { bad++; }
    }
  }
  eq(bad, 0, '库里 ' + ((lib.mates || []).length + (lib.studies || []).length) + ' 个局面的 FEN 都能解析');
  const ids = lib.mates.map((m) => m.id);
  eq(new Set(ids).size, ids.length, 'mates 的 id 无重复（' + ids.length + ' 条）');
  /* 导入进来的条目必须有解法 —— 没有解法的题在界面上会显示不出来 */
  const imported = lib.mates.filter((m) => m.id[0] === 'x');
  if (imported.length) {
    check(imported.every((m) => Array.isArray(m.line) && m.line.length === m.solvePlies),
      '已导入的 ' + imported.length + ' 条都有完整解法路线');
    check(imported.every((m) => m.solvePlies === 2 * m.mateIn - 1),
      '已导入条目的路线长度都等于 2*mateIn-1（路线是最优的）');
    /* `set` 是界面分组的依据；缺了会让所有导入的题挤进同一个"无来源"分组 */
    check(imported.every((m) => typeof m.set === 'string' && m.set.length > 0),
      '已导入条目都带 set（界面按它分组）');
    /* 体积守卫：`lineSides` 是 `line` 的纯派生量、全项目没人读，
       实测占整个库的 21.8%（35 KB / 162 KB）。写回来就是白占首屏加载。
       这条断言是为了防止它被"顺手补上"。 */
    check(imported.every((m) => m.lineSides === undefined),
      '已导入条目不带 lineSides（派生量，且全项目无人读取 —— 体积守卫）');
    /* iOS 的 MatePuzzle.idea 是可选类型；如果哪天又改成必填，
       整个 library.json 会解码失败、题库变空 —— 这条守着那个前提。 */
    check(imported.some((m) => m.idea === undefined),
      '已导入条目确实没有 idea 字段（iOS 的 MatePuzzle.idea 必须是可选，见其注释）');
  } else {
    check(true, '（提示）还没有导入任何条目，第 6 节后半段未执行');
  }
}

console.log('\n──────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exitCode = fail ? 1 : 0;
