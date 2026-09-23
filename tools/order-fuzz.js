/* 随机局面 · 固定深度「对分」探针
 *
 *   node tools/order-fuzz.js --a uci:/tmp/xq-uci-p2-before --b uci:tools/uci/build/xq-uci
 *   node tools/order-fuzz.js --b uci:/tmp/xq-order-swift/see4 --depth 5 --positions 200
 *
 * 为什么需要它：
 *   P1-2 给排序加了 SEE，而 SEE 是「就地改棋盘 → 再逐格还原」的写法。
 *   还原漏一格的代价不是报错，是**搜索算到一盘不存在的棋** —— 它会安静地
 *   给出一个错的分数、选出一手烂棋，而「引擎跑起来了、棋路看着还行」全都成立。
 *
 *   固定深度下 alpha-beta 的**根节点分数与着法顺序无关**，所以有一条硬约束：
 *   两份只在「排序」上不同的引擎，在同一局面同一深度必须给出**完全相同的分数
 *   与最佳着法**。只要有一处不同，就说明排序改动越界了（多半是棋盘被改坏）。
 *
 * 为什么不能只测几个固定局面：
 *   手写的 3 个局面（开局/中局/残局）覆盖面太窄 —— SEE 的还原路径取决于
 *   「被吃子在哪儿、谁来回吃、回吃之后还有没有人接」，随机走出来的局面才能撞到。
 *
 * 结果判定：任何一处不一致 → 打印详情并以非零码退出。
 */
'use strict';

const path = require('path');
const XQ = require(path.join(__dirname, '..', 'web', 'js', 'engine.js'));
const { UciEngine } = require('./lib/uci-engine.js');

/* ---------- 参数 ---------- */

const argv = process.argv.slice(2);
let SPEC_A = 'uci:/tmp/xq-uci-p2-before';
let SPEC_B = 'uci:tools/uci/build/xq-uci';
let DEPTH = 5;
let POSITIONS = 150;
let SEED = 20260923;
let MAX_PLY = 60;
/* depth = 固定深度「对分」（必须同分同着法）；time = 固定时间「平均有效深度」 */
let MODE = 'depth';
/* time 模式下的每手思考时间；给几个就往每个局面上各测一遍 */
let TIME_BUDGETS = [300];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--a') SPEC_A = argv[++i];
  else if (a === '--b') SPEC_B = argv[++i];
  else if (a === '--depth') DEPTH = Number(argv[++i]);
  else if (a === '--positions') POSITIONS = Number(argv[++i]);
  else if (a === '--seed') SEED = Number(argv[++i]);
  else if (a === '--max-ply') MAX_PLY = Number(argv[++i]);
  else if (a === '--mode') MODE = argv[++i];
  else if (a === '--ms') TIME_BUDGETS = argv[++i].split(',').map(Number);
  else { console.error('未知参数: ' + a); process.exit(2); }
}
if (MODE !== 'depth' && MODE !== 'time') {
  console.error('--mode 只能是 depth 或 time');
  process.exit(2);
}

function specToEngine(spec) {
  if (!spec.startsWith('uci:')) {
    console.error('本探针只能驱动 uci: 引擎，收到：' + spec);
    process.exit(2);
  }
  return path.resolve(spec.slice(4));
}

/* ---------- 随机走子，攒局面 ---------- */

/* 用自带的线性同余发生器，种子固定 → 每次跑出来的局面序列完全一样。
   用 Math.random() 的话「这次没测出问题」就说明不了任何事。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/* 项目内部是 r*9+c（r=0 是黑方底线）→ UCI 的 <列 a-i><行 0-9>，行 = 9 - r。
 *
 * ⚠️ 这里第一版是绕 XQ 的辅助函数算的（`String.fromCharCode(97 + XQ.colOf(idx))`），
 * 结果拿到 NaN：着法名被拼成 "\0 9" 这种**肉眼看着正常、引擎却解析不了**的字符串。
 * 引擎解析失败后停在开局，于是「两份引擎在随机局面上不一致」——
 * 报出来的分数恰好是开局的 8 / 12，看着像引擎有 bug，其实全是探针自己的假阳性。
 * 所以：直接用下标算，并且**必须**在开跑前验证着法名合法（见 checkMoveNames）。
 */
function uciName(idx) {
  const row = Math.floor(idx / 9);
  const col = idx - row * 9;
  return String.fromCharCode(97 + col) + String(9 - row);
}

/* 自证：着法名必须是「两格、每格 = 列 a-i + 行 0-9」。零匹配的检查工具比不检查更危险。 */
function checkMoveNames(positions) {
  const bad = [];
  for (const p of positions) {
    for (const u of p) if (!/^[a-i][0-9][a-i][0-9]$/.test(u)) bad.push(u);
  }
  return bad;
}

function randomPositions(count, maxPly, seed) {
  const rnd = makeRng(seed);
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 8) {
    const board = XQ.parseBoard(XQ.START);
    let side = 'r';
    const moves = [];
    /* 每局走多少手也随机，这样能覆盖开局/中局/残局各个阶段 */
    const target = 4 + Math.floor(rnd() * maxPly);
    for (let ply = 0; ply < target; ply++) {
      const legal = XQ.legalMoves(board, side);
      if (!legal.length) break;
      const m = legal[Math.floor(rnd() * legal.length)];
      XQ.makeMove(board, m);
      /* ⚠️ JS 引擎里着法是 `[from, to]` 数组（`makeMove` 里就是 `b[m[0]]`），
         不是带字段的对象。第一版写了 `m.from` → undefined → 着法名成了 "\u0000NaN"，
         **肉眼看着像正常字符串**（NUL 不可见），引擎却解析不了。 */
      moves.push(uciName(m[0]) + uciName(m[1]));
      side = XQ.other(side);
      /* 存局面：不能是空着法列表（那不算「随机」），也不能太浅。
         另外必须有子被吃过或走到过河 —— 否则测的全是「什么都没发生」的局面 */
      if (ply >= 3 && rnd() < 0.22 && XQ.boardToString(board) !== XQ.START) out.push(moves.slice());
      if (moves.length >= maxPly) break;
    }
  }
  return out.slice(0, count);
}

/* ---------- 主流程 ---------- */

(async () => {
  const binA = specToEngine(SPEC_A);
  const binB = specToEngine(SPEC_B);

  console.log('='.repeat(72));
  console.log(MODE === 'time'
    ? '随机局面固定时间的平均有效深度'
    : '随机局面固定深度对分：同分同着法才算「排序没越界」');
  console.log('='.repeat(72));
  console.log('  A  ' + binA);
  console.log('  B  ' + binB);
  console.log('  局面 ' + POSITIONS + ' 个（种子 ' + SEED + '，最长 ' + MAX_PLY + ' 手）'
    + (MODE === 'time' ? '｜预算 ' + TIME_BUDGETS.join('/') + 'ms' : '｜深度 ' + DEPTH));
  console.log();

  const positions = randomPositions(POSITIONS, MAX_PLY, SEED);
  if (positions.length < POSITIONS) {
    console.error('只攒到 ' + positions.length + ' 个局面（应为 ' + POSITIONS + ' 个）');
    process.exit(1);
  }
  if (!positions.some((p) => p.length > 20)) {
    console.error('局面全都很浅 —— 随机走子没走起来，这个探针等于没测');
    process.exit(1);
  }
  /* 开跑之前先自证着法名合法。少了这一步，「引擎解析不了着法、停在开局」
     会伪装成「两份引擎在随机局面上给出不同答案」—— 一次假阳性足以让人去改好代码。 */
  const badNames = checkMoveNames(positions);
  if (badNames.length) {
    console.error('生成的着法名不合法（前 5 个：' + JSON.stringify(badNames.slice(0, 5)) + '）');
    console.error('引擎会解析失败并一直停在开局 —— 此时「对不上」是探针自己的 bug，不是引擎的');
    process.exit(1);
  }

  const ea = new UciEngine(binA);
  const eb = new UciEngine(binB);
  await ea.start();
  await eb.start();

  /* ---------------- time 模式：固定预算下的平均有效深度 ----------------
   *
   * 为什么不能只看那 3 个固定局面：整数层这个分辨率太粗 ——
   * 「开局 5 层」两边都一样，看不出谁在预算里先把第 6 层搜完。
   * 而 App 里用户感受到的恰恰是这个「不到一层」的余量：多搜完一层就是多一层战术。
   * 所以在**几十个真实局面**上各测一遍，再取平均 —— 平均深度是连续量，
   * 分辨率够，而且方差远小于对局（对局还受判和/长将这些非棋力因素干扰）。
   */
  if (MODE === 'time') {
    const rows = [];
    for (let i = 0; i < positions.length; i++) {
      const moves = positions[i];
      for (const ms of TIME_BUDGETS) {
        ea.newGame();
        eb.newGame();
        const ra = await ea.go(moves, { depth: 64, movetime: ms });
        const rb = await eb.go(moves, { depth: 64, movetime: ms });
        rows.push({ i, ply: moves.length, ms, a: ra, b: rb });
      }
      if ((i + 1) % 25 === 0) process.stdout.write('  已测 ' + (i + 1) + '/' + positions.length + '\n');
    }
    ea.quit();
    eb.quit();

    const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    console.log();
    console.log('='.repeat(72));
    console.log('固定预算平均有效深度（同一批局面、同一次会话内交替测）');
    console.log('='.repeat(72));
    console.log('  预算     局面数      A平均深度      B平均深度      A更深/B更深/同深');
    for (const ms of TIME_BUDGETS) {
      const sub = rows.filter((r) => r.ms === ms);
      const da = mean(sub.map((r) => r.a.depth));
      const db = mean(sub.map((r) => r.b.depth));
      const deeperA = sub.filter((r) => r.a.depth > r.b.depth).length;
      const deeperB = sub.filter((r) => r.b.depth > r.a.depth).length;
      const tie = sub.length - deeperA - deeperB;
      const delta = da - db;
      const tag = Math.abs(delta) < 0.02 ? '（看不出来）' : (delta > 0 ? 'A 更深' : 'B 更深');
      console.log('  ' + String(ms).padStart(4) + 'ms' + '  ' + String(sub.length).padStart(6)
        + '  ' + (da.toFixed(3) + ' 层').padStart(12) + '  ' + (db.toFixed(3) + ' 层').padStart(12)
        + '  ' + (deeperA + '/' + deeperB + '/' + tie).padStart(14) + '   Δ ' + delta.toFixed(3) + ' ' + tag);
    }
    console.log();
    console.log('  平均只差 0.0x 层就是「没差别」；另外平均每节点的耗时也一并列出：');
    for (const ms of TIME_BUDGETS) {
      const sub = rows.filter((r) => r.ms === ms);
      const nps = (k) => mean(sub.map((r) => r[k].nodes / Math.max(1, r[k].timeMs)));
      const an = mean(sub.map((r) => r.a.nodes));
      const bn = mean(sub.map((r) => r.b.nodes));
      console.log('  ' + String(ms).padStart(4) + 'ms   平均节点 A ' + Math.round(an) + ' / B '
        + Math.round(bn) + '  （A ' + (an / bn * 100).toFixed(1) + '%）'
        + '   平均千节点/秒 A ' + nps('a').toFixed(0) + ' / B ' + nps('b').toFixed(0));
    }
    console.log();
    console.log('  ⚠️ 这条不是「棋力」。它量的是「同预算能搜多深」，是棋力的主要来源，');
    console.log('     但最终仍要对局台验收（见 docs/strength-plan.md 的验收口径）。');
    return;
  }

  let same = 0;
  const diffs = [];
  for (let i = 0; i < positions.length; i++) {
    const moves = positions[i];
    /* 每问一次先 ucinewgame：置换表跨调用是留着的，两边表内容不同时
       会让「同深度同分数」这条约束出现假阳性 */
    ea.newGame();
    eb.newGame();
    /* ⚠️ 必须给 movetime。只发 `go depth N` 时引擎的时间兜底是 80ms，
       慢一点点的那份会在第 N 层搜完之前被掐断，于是报出来的是「第 N-1 层的分数」
       —— 对分就悄悄变成了「比谁快」，而不是「比谁对」。
       这个坑 uci-engine.js 的注释里写着，第一版还是踩了。 */
    const limit = { depth: DEPTH, movetime: 300000 };
    const ra = await ea.go(moves, limit);
    const rb = await eb.go(moves, limit);
    if (ra.best === rb.best && ra.score === rb.score) {
      same++;
    } else {
      diffs.push({ i, ply: moves.length, a: ra, b: rb, moves });
    }
    if ((i + 1) % 25 === 0) process.stdout.write('  已比 ' + (i + 1) + '/' + positions.length + '\n');
  }

  ea.quit();
  eb.quit();

  console.log();
  console.log('='.repeat(72));
  if (!diffs.length) {
    console.log('✓ ' + positions.length + ' 个随机局面、深度 ' + DEPTH
      + '：**分数与最佳着法全部相同** —— 排序没有越界');
    console.log('  （这条不成立时，所有节点数对比都作废）');
    return;
  }

  console.log('✗ ' + diffs.length + '/' + positions.length + ' 个局面不一致：');
  for (const d of diffs.slice(0, 10)) {
    console.log('  第 ' + d.i + ' 个（' + d.ply + ' 手）：A ' + d.a.best + '/' + d.a.score
      + '　B ' + d.b.best + '/' + d.b.score);
    console.log('    着法：' + d.moves.join(' '));
  }
  if (diffs.length > 10) console.log('  …还有 ' + (diffs.length - 10) + ' 处');
  process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
