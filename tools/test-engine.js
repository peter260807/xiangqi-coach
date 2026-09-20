const XQ = require('../web/js/engine.js');

function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  return cond;
}

let ok = true;

// 1. 开局红方合法着法数应为 44（中国象棋公认值）
const start = XQ.parseBoard(XQ.START);
const m1 = XQ.legalMoves(start, 'r');
ok &= check('开局红方合法着法 = 44', m1.length === 44, m1.length);
const m1b = XQ.legalMoves(start, 'b');
ok &= check('开局黑方合法着法 = 44', m1b.length === 44, m1b.length);

// 2. 开局不应被将军
ok &= check('开局无将军', !XQ.inCheck(start, 'r') && !XQ.inCheck(start, 'b'));
ok &= check('开局无白脸将', !XQ.kingsFacing(start));

// 3. 局面评估开局应接近 0
const e0 = XQ.evaluate(start);
ok &= check('开局评估接近 0', Math.abs(e0) < 60, e0);

// 4. 残局：马后炮（红先，马跳至炮前作炮架成杀）
const E1 = '....k..../........./........./....C..../.....N.../........./........./........./........./...K.....';
// 5. 残局：重炮（红先，炮移入同列形成双炮杀）
const E2 = '...pkp.../........./C......../....C..../........./........./........./........./........./...K.....';
// 6. 残局：双车错（红先，双车交替照将）
const E3 = '....k..../........./........./........./........./R.......R/........./........./........./...K.....';

const endgames = [
  ['残局一 马后炮', E1],
  ['残局二 重炮', E2],
  ['残局三 双车错', E3],
];

for (const [name, fen] of endgames) {
  const b = XQ.parseBoard(fen);
  const legal = XQ.legalMoves(b, 'r');
  ok &= check(name + ' 局面合法（红有可行着法）', legal.length > 0, legal.length + ' 着');
  ok &= check(name + ' 黑方未被将军', !XQ.inCheck(b, 'b'));
  const t0 = Date.now();
  const res = XQ.searchRoot(b, 'r', 4, 4000);
  const ms = Date.now() - t0;
  const isMate = res.score > XQ.MATE - 1000;
  ok &= check(name + ' 四层内找到杀棋', isMate, 'score=' + res.score + ' depth=' + res.depth + ' ' + ms + 'ms 最佳=' + (res.move ? XQ.moveLabel(b, res.move) : 'none'));
}

// 7. AI 自战 40 回合不应崩溃，且不应出现非法着法
let b = XQ.parseBoard(XQ.START);
let side = 'r';
let moves = 0;
for (let i = 0; i < 60; i++) {
  const legal = XQ.legalMoves(b, side);
  if (legal.length === 0) break;
  const r = XQ.searchRoot(b, side, 2, 600);
  if (!r.move) break;
  const isLegal = legal.some(m => m[0] === r.move[0] && m[1] === r.move[1]);
  if (!isLegal) { ok &= check('自战第 ' + (i + 1) + ' 步着法合法', false); break; }
  XQ.makeMove(b, r.move);
  side = XQ.other(side);
  moves++;
}
ok &= check('AI 自战 ' + moves + ' 步无异常', moves >= 40, moves + ' 步');

// 8. 白脸将必须被判为非法
const face = XQ.parseBoard('....k..../........./........./........./........./........./........./........./........./....K....');
ok &= check('白脸将局面识别正确', XQ.kingsFacing(face));
const blocked = XQ.parseBoard('....k..../........./........./R......../........./........./........./........./........./....K....');
const free = XQ.parseBoard('....k..../........./........./R......../........./........./........./........./........./.....K...');
ok &= check('照面时车不能离开中线', XQ.legalMoves(blocked, 'r').length < XQ.legalMoves(free, 'r').length,
  XQ.legalMoves(blocked, 'r').length + ' < ' + XQ.legalMoves(free, 'r').length);

// 9. 棋谱库全量校验
const LIB = require('../web/js/library.js');
const rep = LIB.validateLibrary();
console.log('\n--- 棋谱库校验 ---');
rep.mates.forEach(r => { ok &= check('杀法「' + r.name + '」红先成杀', r.pass, '最佳 ' + r.best + '，杀着数 ' + r.solutions); });
rep.openings.forEach(r => { ok &= check('开局「' + r.name + '」着法合法', r.pass, r.moves + ' 着' + (r.error ? ' ' + r.error : '')); });
rep.studies.forEach(r => { ok &= check('残局「' + r.name + '」红方明显占优', r.pass, '评估 ' + r.score); });

// 10. 棋谱文本转换（数组与 FEN 字符串两种入参都要支持）
const t1 = XQ.movesToText(XQ.START, m1.length ? [m1[0]] : []);
const t2 = XQ.movesToText(XQ.START, []);
ok &= check('movesToText 接受 FEN 字符串', typeof t2 === 'string');

console.log('\n=== ' + (ok ? '全部通过' : '存在失败项') + ' ===');
process.exit(ok ? 0 : 1);
