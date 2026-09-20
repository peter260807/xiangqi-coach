#!/usr/bin/env node
/* 为每个杀法练习算出「双方都走最强」的解法路线，写回 shared/library.json。
 *
 * 为什么要预生成：演示给初学者看的路线必须是正确的 ——
 * 红方每步走引擎首选，黑方也每步走引擎首选（也就是最顽强的防守）。
 * 这样得到的才是「最顽强防守下仍然成立的最短杀法」。
 * 随手走一遍凑出来的路线会把人教坏，所以宁可离线算好存进库里。
 *
 * 同时它也是一道校验：算不出杀棋的局面会在这里被标出来。
 *
 * 运行：node tools/gen-lines.js [最大层数]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const XQ = require(path.join(root, 'web/js/engine.js'));

const jsonPath = path.join(root, 'shared/library.json');
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const DEPTH = parseInt(process.argv[2] || '7', 10);
const BUDGET_MS = 12000;
const MAX_PLY = 26;

/** 从给定局面出发，双方都由引擎挑最佳着法，直到分出胜负或超出手数上限 */
function solve(fen, startSide) {
  const b = XQ.parseBoard(fen);
  let side = startSide || 'r';
  const steps = [];

  for (let i = 0; i < MAX_PLY; i++) {
    if (!XQ.hasLegalMove(b, side)) break;
    const r = XQ.searchRoot(b, side, DEPTH, BUDGET_MS);
    if (!r.move) break;

    const label = XQ.moveLabel(b, r.move);
    const wasCheck = XQ.inCheck(b, side);
    XQ.makeMove(b, r.move);
    const nowChecks = XQ.inCheck(b, XQ.other(side));
    const opponentStuck = !XQ.hasLegalMove(b, XQ.other(side));

    steps.push({
      ply: i + 1,
      side: side,
      label: label,
      score: r.score,
      depth: r.depth,
      check: nowChecks,
      mate: opponentStuck
    });

    side = XQ.other(side);
    if (opponentStuck) break;
    if (wasCheck && !nowChecks) { /* 解将之后继续 */ }
  }

  const finished = !XQ.hasLegalMove(b, side);
  return { steps, finished, finalFen: XQ.boardToString(b), toMove: side };
}

let fail = 0;
const report = [];

for (const m of data.mates) {
  const res = solve(m.fen, 'r');
  const mateStep = res.steps.find((s) => s.mate);
  const ok = res.finished && mateStep && mateStep.side === 'r';

  if (ok) {
    m.line = res.steps.map((s) => s.label);
    m.lineSides = res.steps.map((s) => (s.side === 'r' ? 'red' : 'black'));
    m.solvePlies = res.steps.length;
    m.mateIn = Math.ceil(res.steps.length / 2);
  } else {
    fail++;
    delete m.line;
    delete m.lineSides;
    delete m.solvePlies;
    delete m.mateIn;
  }

  report.push(
    (ok ? 'PASS ' : 'FAIL ') +
      m.id.padEnd(4) +
      m.name.padEnd(6) +
      ' 路线 ' +
      String(res.steps.length).padStart(2) +
      ' 步  ' +
      res.steps.map((s) => s.label).join(' ') +
      (ok ? '' : '   ← 未能成杀，已清空路线')
  );
}

// 开局库顺带记录着法条数，界面展示用
for (const o of data.openings) {
  o.plies = o.line.trim().split(/\s+/).length;
}

console.log('引擎深度 ' + DEPTH + '，时间上限 ' + BUDGET_MS + 'ms\n');
report.forEach((r) => console.log(r));
console.log('\n' + (fail === 0 ? '全部 ' + data.mates.length + ' 个杀局都算出了成杀路线' : fail + ' 个杀局没能算出成杀'));

data.note = '中国象棋棋谱库。杀法局的 line 字段是由 tools/gen-lines.js 用引擎离线算出的最短杀法路线（双方均走最强）。';
fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
console.log('已写回 ' + path.relative(root, jsonPath));

process.exitCode = fail === 0 ? 0 : 1;
