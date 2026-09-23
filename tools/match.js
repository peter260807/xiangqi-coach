#!/usr/bin/env node
/* 对局台 —— 让两个引擎真下一批棋，把「改完搜索是不是变强了」量出来。
 *
 * 为什么需要它：在这之前，App 里在用的 Swift 引擎**没有任何对外对局接口**，
 * 于是每次改完搜索只能说「感觉变强了 / 看着没报错」。这个工具补上那个缺环：
 *
 *   1. 引擎可以是本项目 Swift 引擎（走 tools/uci 的 UCI 前端）、网页版 JS 引擎、
 *      或者 Pikafish —— 一律按统一接口驱动；
 *   2. **每手棋都用项目自己的规则引擎复验合法性**（裁判独立于双方选手）；
 *   3. 判将死 / 困毙 / 三次重复 / 60 回合无吃子 / 手数上限；
 *   4. 同一组开局、轮流执先（A 红 B 黑 ↔ A 黑 B 红），出胜负与 Elo 差 + 95% 置信区间。
 *
 * 用法：
 *   # 自我对局：同一个引擎的两个构建 A/B（改前 vs 改后）
 *   node tools/match.js --a uci:tools/uci/build/xq-uci --b uci:/tmp/xq-uci-old --ms 300
 *
 *   # 和 Pikafish 比（Pikafish 固定 100ms，我们 500ms）
 *   node tools/match.js --a uci:tools/uci/build/xq-uci --ms-a 500 --b pika --ms-b 100
 *
 *   # 顺带验规则：两份规则实现 + Pikafish 三方的 perft 对数
 *   node tools/match.js --perft 3
 *
 * 参数：
 *   --a / --b <spec>   引擎：uci:<路径> | js | pika[|<权重路径>]
 *   --ms <毫秒>        每手思考时间（默认 300）
 *   --ms-a / --ms-b    分别指定两边的思考时间（做「时间预算」A/B 时用）
 *   --depth            改成固定深度（不用时限）—— 测「同深度下评估质量」时才用
 *   --games <n>        总局数（默认 8；偶数才会两边执先次数相同）
 *   --openings <n>     用开局库前 n 个开局（默认 4，0 表示全从标准开局开始）
 *   --open-plies <n>   每个开局先摆前 n 手（默认 6）
 *   --max-ply <n>      单局手数上限（默认 200）
 *   --seed <n>         开局的取用顺序（默认 1）
 *   --verbose          打印每局的着法（中文记谱）
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { UciEngine } = require('./lib/uci-engine.js');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'trainer/engine');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const XQLIB = require(path.join(ROOT, 'web/js/library.js'));

/* ---------- 坐标：UCI 的 a0-i9 ↔ 内部索引 r*9+c ---------- */

function idxToUci(i) {
  return String.fromCharCode(97 + (i % 9)) + (9 - Math.floor(i / 9));
}
function uciToIdx(s) {
  return (9 - parseInt(s.slice(1), 10)) * 9 + (s.charCodeAt(0) - 97);
}

/* ---------- 引擎适配层 ---------- */

/** 网页版 JS 引擎：进程内直接调，不用起子进程 */
class JsEngine {
  constructor() {
    this.name = 'JS 引擎（web/js/engine.js）';
    this.board = null;
    this.side = 'r';
    this.idx = [];       // 内部索引形式的着法历史，给「重复局面判和」用
  }
  init() { return Promise.resolve(); }
  newGame() { return Promise.resolve(); }
  /** 把 UCI 着法历史重放一遍，得到当前局面 —— 接口和 UCI 引擎保持一致 */
  sync(uciMoves) {
    this.board = XQ.parseBoard(XQ.START);
    this.side = 'r';
    this.idx = [];
    for (const u of uciMoves) {
      const from = uciToIdx(u.slice(0, 2)), to = uciToIdx(u.slice(2, 4));
      XQ.makeMove(this.board, [from, to]);
      this.idx.push([from, to]);
      this.side = XQ.other(this.side);
    }
  }
  async move(uciMoves, limit, side) {
    this.sync(uciMoves);
    // side 不能省：着法历史重放完，红先手，偶数手轮到红。
    // 早先这里直接用了调用方传的 side，而调用方没传 → undefined →
    // searchRoot 找不到任何着法，被误报成「引擎没有给出着法」。
    const toMove = side || (uciMoves.length % 2 === 0 ? 'r' : 'b');
    // 第 6 个参数是着法历史：没有它，搜索不知道哪些局面已经出现过，
    // 优势时会把「绕圈」当成正分继续走。UCI 那边走的是 position+go 的历史，
    // 这里得自己把同一份东西喂进去，两边才可比。
    const r = XQ.searchRoot(this.board, toMove, 99, Math.max(1, limit.movetime || 300), null, this.idx);
    return { uci: r.move ? idxToUci(r.move[0]) + idxToUci(r.move[1]) : null, depth: r.depth, nodes: r.nodes };
  }
  quit() {}
}

/** UCI 子进程：本项目 Swift 引擎、Pikafish 都走它 */
class UciSpec {
  constructor(spec) {
    const parts = spec.split('|');
    const kind = parts[0];
    if (kind.startsWith('uci:')) {
      this.bin = path.resolve(ROOT, kind.slice(4));
      this.options = {};
    } else {
      // pika[|权重路径]：默认用仓库里那份
      this.bin = parts[1] ? path.resolve(parts[1]) : path.join(ENGINE_DIR, 'pikafish');
      const nnue = parts[2] ? path.resolve(parts[2]) : path.join(ENGINE_DIR, 'pikafish.nnue');
      this.options = { EvalFile: nnue, Threads: 1, Hash: 128 };
    }
    if (!fs.existsSync(this.bin)) throw new Error('引擎不存在：' + this.bin);
    this.name = path.basename(this.bin);
  }
  async init() {
    this.eng = new UciEngine(this.bin, { options: this.options });
    await this.eng.start();
    this.name = this.eng.name;
  }
  newGame() { return this.eng.newGame(); }
  async move(uciMoves, limit) {
    const r = await this.eng.go(uciMoves, limit);
    return { uci: r.best, depth: r.depth, nodes: r.nodes, score: r.score };
  }
  quit() { this.eng && this.eng.quit(); }
}

function makeEngine(spec) {
  return spec === 'js' ? new JsEngine() : new UciSpec(spec);
}

/* ---------- 开局集：取自项目自带的开局库，确定性 ---------- */

/* 注意：不同开局棋谱前 n 手可能同形（例：「中炮对屏风马」与「五七炮对屏风马」
 * 前 6 手完全一样）。截断到这个长度后两局会从**相同局面 + 相同执色**出发，
 * 确定性引擎于是走出逐字节相同的两局 —— 看起来跑满 16 局，实际只有 8 局独立。
 * 所以这里必须去重，并在数量不足时明确告警（不许静默）。 */
function buildOpenings(count, plies) {
  if (count <= 0) return [[]];
  const list = [];
  const seen = new Set();
  const dropped = [];
  for (const o of XQLIB.OPENINGS.slice(0, count)) {
    const resolved = XQLIB.resolveLine(o.line, XQ.START);
    const seq = [];
    for (const m of resolved.moves.slice(0, plies)) {
      seq.push(idxToUci(m[0]) + idxToUci(m[1]));
    }
    const key = seq.join(' ');
    if (seen.has(key)) { dropped.push(`${o.name || '?'}（前 ${plies} 手与已有开局同形）`); continue; }
    seen.add(key);
    list.push(seq);
  }
  /* 自证：去重后必须真的互不相同，否则说明上面这段逻辑本身写错了 */
  if (new Set(list.map((s) => s.join(' '))).size !== list.length) {
    throw new Error('buildOpenings 去重失败：仍存在同形开局');
  }
  if (dropped.length) {
    console.error(`  ⚠️  开局截断至前 ${plies} 手后有 ${dropped.length} 组与其它开局同形，`
      + `已剔除（否则会白跑重复局）：${dropped.join('、')}`);
    console.error('      → 想全部用上请加大 --open-plies（本库需 ≥8 手才能把 8 组开局完全分开）');
  }
  return list.length ? list : [[]];
}

/* ---------- 走一局 ---------- */

async function playGame(engines, cfg, gameIndex, opening) {
  const aIsRed = gameIndex % 2 === 0;
  const mine = aIsRed ? engines.a : engines.b;      // 先手方
  const theirs = aIsRed ? engines.b : engines.a;
  const msOf = (isA) => (isA ? cfg.msA : cfg.msB);
  const limitOf = (isA) => (cfg.depth > 0 ? { depth: cfg.depth, movetime: 0 }
                                          : { depth: 0, movetime: msOf(isA) });
  /* 裁判按「红/黑」判，对局台要的是「A/B」—— 转换必须认准这一局 A 执什么颜色 */
  const toAB = (w) => (w === null || w === undefined ? null : ((w === 'r') === aIsRed ? 'a' : 'b'));

  let board = XQ.parseBoard(XQ.START);
  let side = 'r';
  const moves = [];        /* UCI 字符串，给引擎重放用 */
  const movesIdx = [];     /* 内部索引形式，给「判和/长将」判定用 */
  const labels = [];
  const stats = { a: { depth: 0, n: 0, nodes: 0 }, b: { depth: 0, n: 0, nodes: 0 } };
  let openingError = null;

  const apply = (uci) => {
    const from = uciToIdx(uci.slice(0, 2)), to = uciToIdx(uci.slice(2, 4));
    const legal = XQ.legalMoves(board, side);
    const mv = legal.find((m) => m[0] === from && m[1] === to);
    if (!mv) return false;
    labels.push(XQ.moveLabel(board, mv));
    XQ.makeMove(board, mv);
    moves.push(uci);
    movesIdx.push([mv[0], mv[1]]);
    side = XQ.other(side);
    return true;
  };

  for (const u of opening) {
    if (!apply(u)) { openingError = '开局着法在裁判这里不合法：' + u; break; }
  }

  const done = (o) => Object.assign({ ply: moves.length, labels, stats, opening }, o);
  if (openingError) return done({ winner: null, reason: openingError, broken: true });

  while (moves.length < cfg.maxPly) {
    if (!XQ.hasLegalMove(board, side)) {
      const loserIsA = (side === 'r') === aIsRed;
      return done({
        winner: loserIsA ? 'b' : 'a',
        reason: XQ.inCheck(board, side) ? '将死' : '困毙（无子可动）',
      });
    }
    /* 判和 / 长将判负：**直接调 App 里那一份规则**（web/js/engine.js 的 adjudicate），
       不在这儿另写一套 —— 否则台子验的就不是用户真正会撞上的那句判定。
       顺带也把「长将判负」这条象棋特有规则纳入了对局统计。 */
    const verdict = XQ.adjudicate(XQ.START, movesIdx);
    if (verdict) return done({ winner: toAB(verdict.winner), reason: verdict.reason });

    const isA = (side === 'r') === aIsRed;
    const engine = isA ? engines.a : engines.b;
    let r;
    try {
      r = await engine.move(moves, limitOf(isA), side);
    } catch (e) {
      return done({ winner: isA ? 'b' : 'a', reason: '引擎出错：' + e.message, broken: true });
    }
    if (!r || !r.uci) {
      return done({ winner: isA ? 'b' : 'a', reason: '引擎没有给出着法', broken: true });
    }
    const tag = isA ? 'a' : 'b';
    stats[tag].depth += r.depth || 0;
    stats[tag].nodes += r.nodes || 0;
    stats[tag].n += 1;

    if (!apply(r.uci)) {
      return done({
        winner: isA ? 'b' : 'a',
        reason: `给出非法着法 ${r.uci}（${engine.name}）`,
        broken: true,
      });
    }
  }
  return done({ winner: null, reason: `达到手数上限 ${cfg.maxPly}` });
}

/* ---------- Elo 与置信区间 ---------- */

/** 胜率 → Elo 差。0 或 1 的时候算不出来（对数发散），这时只报胜率 */
function eloDiff(score) {
  if (score <= 0 || score >= 1) return null;
  return -400 * Math.log10(1 / score - 1);
}

/**
 * 95% 置信区间：先算每局得分的样本方差，再用 delta 法换到 Elo 尺度。
 * 用「每局得分」（胜 1 / 和 0.5 / 负 0）而不是「胜率」，这样和棋多的时候
 * 区间会诚实地变宽 —— 和棋是不提供信息的。
 */
function eloInterval(perGame, score) {
  const n = perGame.length;
  if (n < 2 || score <= 0 || score >= 1) return null;
  const mean = perGame.reduce((x, y) => x + y, 0) / n;
  const varSum = perGame.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
  // 每局得分完全一样（典型：全是和棋 → 全是 0.5）时样本方差为 0，
  // 区间会退化成 [0,0]。那看着像「精确测得差距为 0」，其实是**没有信息**。
  // 返回 null 让主流程单独说明，别把一个退化的数字当结论用。
  if (varSum === 0) return null;
  const seScore = Math.sqrt(varSum / n);
  const slope = 400 / (Math.LN10 * score * (1 - score));
  const half = 1.96 * slope * seScore;
  const elo = eloDiff(score);
  return { elo, low: elo - half, high: elo + half };
}

/* ---------- perft：三方规则实现对数 ---------- */

function perftJs(board, side, depth) {
  if (depth === 0) return 1;
  const moves = XQ.legalMoves(board, side);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) {
    const cap = XQ.makeMove(board, m);
    total += perftJs(board, XQ.other(side), depth - 1);
    XQ.undoMove(board, m, cap);
  }
  return total;
}

function perftUci(bin, depth, extraArgs = []) {
  const input = `position startpos\nperft ${depth}\nquit\n`;
  const out = spawnSync(bin, extraArgs, { input, encoding: 'utf8', maxBuffer: 1 << 28 });
  const map = {};
  let total = 0;
  for (const line of (out.stdout || '').split('\n')) {
    let m = line.match(/^perft-move (\S+) (\d+)/);
    if (m) { map[m[1]] = parseInt(m[2], 10); continue; }
    m = line.match(/^perft \d+ nodes (\d+)/);
    if (m) { total = parseInt(m[1], 10); }
  }
  return { map, total, ok: total > 0, err: out.stderr };
}

function perftPika(depth) {
  const bin = path.join(ENGINE_DIR, 'pikafish');
  const out = spawnSync(bin, [], {
    cwd: ENGINE_DIR, input: `position startpos\ngo perft ${depth}\nquit\n`,
    encoding: 'utf8', maxBuffer: 1 << 28,
  });
  const map = {};
  let total = 0;
  for (const line of (out.stdout || '').split('\n')) {
    const m = line.match(/^([a-i][0-9][a-i][0-9]): (\d+)$/);
    if (m) { map[m[1]] = parseInt(m[2], 10); continue; }
    const t = line.match(/^Nodes searched: (\d+)/);
    if (t) total = parseInt(t[1], 10);
  }
  return { map, total, ok: total > 0, err: out.stderr };
}

function runPerft(depth) {
  console.log('='.repeat(72));
  console.log(`规则层对数（perft，标准开局）`);
  console.log('='.repeat(72));
  const swift = perftUci(path.join(__dirname, 'uci/build/xq-uci'), depth);
  const pika = perftPika(depth);

  console.log('逐深度总节点数：');
  console.log('  深度   本项目(Swift)     本项目(JS)         Pikafish');
  for (let d = 1; d <= depth; d++) {
    const s = perftUci(path.join(__dirname, 'uci/build/xq-uci'), d);
    const j = perftJs(XQ.parseBoard(XQ.START), 'r', d);
    const p = perftPika(d);
    const mark = (s.total === p.total && j === p.total) ? '' : '   ← 不一致';
    console.log(`  ${String(d).padStart(3)}   ${String(s.total).padStart(12)}  `
      + `${String(j).padStart(14)}  ${String(p.total).padStart(12)}${mark}`);
  }
  console.log();

  if (!pika.ok) {
    console.log('（Pikafish 没跑起来，跳过逐着法比对）');
    return;
  }
  const diffs = [];
  for (const mv of Object.keys(pika.map)) {
    const a = pika.map[mv], b = swift.map[mv];
    if (a !== b) diffs.push(`${mv}: Pikafish ${a} / Swift ${b === undefined ? '缺失' : b}`);
  }
  console.log(`深度 ${depth} 的逐着法比对：Pikafish ${Object.keys(pika.map).length} 手，`
    + `本项目 ${Object.keys(swift.map).length} 手`);
  console.log(diffs.length ? '不一致：\n  ' + diffs.join('\n  ') : '  全部一致 ✅');
}

/* ---------- 参数与主流程 ---------- */

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf('--' + k);
    return i >= 0 && a[i + 1] ? a[i + 1] : d;
  };
  return {
    a: get('a', 'js'),
    b: get('b', 'js'),
    ms: parseInt(get('ms', '300'), 10),
    msA: get('ms-a', null),
    msB: get('ms-b', null),
    depth: parseInt(get('depth', '0'), 10),
    games: parseInt(get('games', '8'), 10),
    openings: parseInt(get('openings', '4'), 10),
    openPlies: parseInt(get('open-plies', '6'), 10),
    maxPly: parseInt(get('max-ply', '200'), 10),
    seed: parseInt(get('seed', '1'), 10),
    perft: parseInt(get('perft', '0'), 10),
    verbose: a.includes('--verbose'),
  };
}

async function main() {
  const cfg = parseArgs();
  const uciBin = path.join(__dirname, 'uci/build/xq-uci');

  if (cfg.perft > 0) { runPerft(cfg.perft); return; }

  // --ms-a/--ms-b 没给就都用 --ms
  cfg.msA = cfg.msA !== null ? parseInt(cfg.msA, 10) : cfg.ms;
  cfg.msB = cfg.msB !== null ? parseInt(cfg.msB, 10) : cfg.ms;

  // 用 uci: 指到还没编译的前端时，先替用户把话说清楚
  for (const spec of [cfg.a, cfg.b]) {
    if (spec.startsWith('uci:') && spec.endsWith('tools/uci/build/xq-uci')
        && !fs.existsSync(path.resolve(ROOT, spec.slice(4)))) {
      console.error('还没编译 UCI 前端，先跑：./tools/uci/run.sh');
      process.exit(1);
    }
  }

  const openings = buildOpenings(cfg.openings, cfg.openPlies);
  const games = Math.max(2, cfg.games);

  console.log('='.repeat(72));
  console.log('对局台：A vs B');
  console.log('='.repeat(72));
  console.log(`  A：${cfg.a}   每手 ${cfg.msA}ms`);
  console.log(`  B：${cfg.b}   每手 ${cfg.msB}ms`);
  console.log(`  共 ${games} 局｜开局 ${openings.length} 组（各取前 ${cfg.openPlies} 手）`
    + `｜轮流执先｜手数上限 ${cfg.maxPly}`);
  console.log();

  const engines = { a: makeEngine(cfg.a), b: makeEngine(cfg.b) };
  await engines.a.init();
  await engines.b.init();
  console.log(`  A 实际引擎名：${engines.a.name}`);
  console.log(`  B 实际引擎名：${engines.b.name}`);
  console.log();

  const perGame = [];
  const rows = [];
  const tally = { a: 0, b: 0, draw: 0 };
  const reasons = {};
  const broken = [];
  let elapsed = 0;
  const t0 = Date.now();

  for (let g = 0; g < games; g++) {
    const opening = openings[(Math.floor(g / 2) + cfg.seed) % openings.length];
    await engines.a.newGame();
    await engines.b.newGame();
    const started = Date.now();
    const r = await playGame(engines, cfg, g, opening);
    elapsed += Date.now() - started;

    const aIsRed = g % 2 === 0;
    const aColor = aIsRed ? '红' : '黑';
    let result, score;
    if (r.winner === 'a') { tally.a++; result = 'A 胜'; score = 1; }
    else if (r.winner === 'b') { tally.b++; result = 'B 胜'; score = 0; }
    else { tally.draw++; result = '和棋'; score = 0.5; }
    perGame.push(score);
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    if (r.broken) broken.push(`第 ${g + 1} 局：${r.reason}`);

    const avg = (s) => (s.n ? (s.depth / s.n).toFixed(1) : '—');
    rows.push({
      局: g + 1, A执: aColor, 结果: result, 结束原因: r.reason, 手数: r.ply,
      'A平均层数': avg(r.stats.a), 'B平均层数': avg(r.stats.b),
      用时: ((Date.now() - started) / 1000).toFixed(1) + 's',
    });
    console.log(`第 ${String(g + 1).padStart(2)} 局（A 执${aColor}）：${result}`
      + `　${r.reason}　${r.ply} 手　`
      + `层数 A ${avg(r.stats.a)} / B ${avg(r.stats.b)}`);
    if (cfg.verbose && r.labels.length) {
      const line = r.labels.map((l, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + l).join('  ');
      console.log('        ' + line);
    }
  }

  const n = perGame.length;
  const scoreA = perGame.reduce((x, y) => x + y, 0) / n;
  const ci = eloInterval(perGame, scoreA);

  console.log();
  console.log('='.repeat(72));
  console.log('结果');
  console.log('='.repeat(72));
  console.log(`  A ${tally.a} 胜 / ${tally.draw} 和 / ${tally.b} 负　（共 ${n} 局）`);
  console.log(`  A 的得分率：${(scoreA * 100).toFixed(1)}%`);
  if (ci) {
    const sign = (v) => (v > 0 ? '+' : '') + v.toFixed(0);
    console.log(`  Elo 差（A - B）：${sign(ci.elo)}　95% 置信区间 [${sign(ci.low)}, ${sign(ci.high)}]`);
    const crossesZero = ci.low <= 0 && ci.high >= 0;
    console.log(crossesZero
      ? '  → 区间跨过 0：这批次**看不出差别**（要么确实没差别，要么局数不够）'
      : `  → 区间不含 0：差别是**真的**，方向为 ${ci.elo > 0 ? 'A 更强' : 'B 更强'}`);
  } else if (scoreA <= 0 || scoreA >= 1) {
    console.log('  一边倒（0 或 100% 得分），Elo 差算不出来 —— 只报胜率');
  } else {
    console.log(`  每局得分完全相同（${n} 局结果一模一样，典型是全和棋）：`);
    console.log('  这一批**不提供任何强弱信息** —— 注意这不是「测出差距为 0」，');
    console.log('  别拿它当 A≈B 的证据。要出结论得换开局集或加局数。');
  }
  console.log();
  console.log('  结束原因分布：');
  Object.keys(reasons).sort((x, y) => reasons[y] - reasons[x])
    .forEach((k) => console.log(`    ${String(reasons[k]).padStart(3)} 局　${k}`));
  if (broken.length) {
    console.log();
    console.log('  ⚠️ 有异常终止（引擎出错 / 非法着法，结果不可信）：');
    broken.forEach((b) => console.log('    ' + b));
  }
  console.log();
  console.log(`  纯对局耗时 ${(elapsed / 1000).toFixed(0)}s（总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  if (n < 40) {
    console.log(`  提示：本批次只有 ${n} 局，能分辨的差距约 ±${Math.round(400 / Math.sqrt(n) * 1.2)} Elo。`);
    console.log('        要判定「小改进」得把局数加上去（N 局的分辨力大致按 1/√N 变好）。');
  }
  console.log();

  engines.a.quit();
  engines.b.quit();
}

main().catch((e) => {
  console.error('出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
