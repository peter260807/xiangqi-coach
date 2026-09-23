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
 *   --openings <n>     用开局库前 n 个开局（默认 8，0 表示全从标准开局开始）
 *   --open-plies <n>   每个开局先摆前 n 手（默认 8）
 *   --random-plies <n> 开局之后各走 n 手**随机合法着法**（默认 0 = 不随机）
 *                      ⚠️ 不随机的话，一对里的两局共用同一开局，实际不同的棋
 *                      只有「开局数 x 2」盘 —— 跑 1400 局也只是把它重放。
 *                      要量棋力请设 4~8，让每对的起手局面都不同（同一对内仍相同）
 *   --max-ply <n>      单局手数上限（默认 200）
 *   --seed <n>         开局的取用顺序（默认 1）
 *   --gamelog <路径>    把每局结果**边跑边落盘**（JSONL），支持中断后续跑
 *   --fresh            忽略已有 gamelog，从第 1 局重来
 *   --verbose          打印每局的着法（中文记谱）
 *
 * 断点续跑：给了 `--gamelog` 时，每局结束就把结果 append + fsync 落盘；
 * 再次启动发现该文件存在，就**跳过已完成的局**接着跑，最后按全部局汇总。
 * 每局的起手局面只由「对局序号」决定（开局取用顺序 + 随机着法种子都只依赖它），
 * 所以续跑时第 N 局与第一次跑时的第 N 局是同一个局面 —— 断点不会错位。
 * 配置变了（每手时间 / 开局数 / 随机手数 / 引擎文件）会**拒绝续跑**，
 * 因为把两种配置的局混在一起汇总，得到的 Elo 没有意义。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

/** 网页版 JS 引擎：进程内直接调，不用起子进程。
 *
 *  可以指定 engine.js 的路径 —— 用来对比**两个 JS 版本**。
 *  这条路径是为「机器上没有 Swift 编译器」准备的（例如 Windows）：
 *  把旧版 engine.js 拷成 engine-baseline.js，就能在那边跑 A/B，
 *  不必先装 Swift 工具链。 */
class JsEngine {
  constructor(jsPath) {
    this.XQ = jsPath ? require(path.resolve(ROOT, jsPath)) : XQ;
    this.name = jsPath
      ? 'JS 引擎（' + path.relative(ROOT, path.resolve(ROOT, jsPath)) + '）'
      : 'JS 引擎（web/js/engine.js）';
    this.board = null;
    this.side = 'r';
    this.idx = [];       // 内部索引形式的着法历史，给「重复局面判和」用
  }
  init() { return Promise.resolve(); }
  newGame() { return Promise.resolve(); }
  /** 把 UCI 着法历史重放一遍，得到当前局面 —— 接口和 UCI 引擎保持一致 */
  sync(uciMoves) {
    this.board = this.XQ.parseBoard(this.XQ.START);
    this.side = 'r';
    this.idx = [];
    for (const u of uciMoves) {
      const from = uciToIdx(u.slice(0, 2)), to = uciToIdx(u.slice(2, 4));
      this.XQ.makeMove(this.board, [from, to]);
      this.idx.push([from, to]);
      this.side = this.XQ.other(this.side);
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
    const r = this.XQ.searchRoot(this.board, toMove, 99,
                                 Math.max(1, limit.movetime || 300), null, this.idx);
    return { uci: r.move ? idxToUci(r.move[0]) + idxToUci(r.move[1]) : null,
             depth: r.depth, nodes: r.nodes };
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
  if (spec === 'js') return new JsEngine();
  // js:<路径>：用指定的 engine.js 当引擎。这条是为「机器上没有 Swift 编译器」
  // 准备的（例如 Windows）—— 把旧版 engine.js 拷一份过去就能跑 A/B，
  // 不必先装 Swift 工具链。
  // ⚠️ 这个分支必须在 UciSpec **之前**拦下来：否则 'js:xxx' 会落进
  // UciSpec 的 else 分支被当成 pika，报出的错完全指不到真正的原因。
  if (spec.startsWith('js:')) return new JsEngine(spec.slice(3));
  return new UciSpec(spec);
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

/* 确定性伪随机（mulberry32）：同一 seed 必得同一串数，整轮结果可复现。
   用自带的而不是 Math.random，是为了「跑完能重放同一批对局」。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 走一局 ---------- */

async function playGame(engines, cfg, gameIndex, opening, pairSeed) {
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

  /* 开局多样性：光靠棋谱库远远不够 —— 库里只有 8 条棋路，去重后也就 8~16 盘不同的棋，
     跑 1400 局等于把同一盘重放一百多遍，样本量是假的。这里在开局前缀之后再走 n 手
     **随机合法着法**，把真正不同的起手局面拉开到几百上千个。

     种子只取决于「对局对号」（floor(g/2)），所以一对里的两局（A 执红 / A 执黑）
     面对的是**同一个局面**，比较依然成对；而整轮结果完全可复现。 */
  if (!openingError && cfg.randomPlies > 0) {
    const rnd = mulberry32(pairSeed);
    for (let i = 0; i < cfg.randomPlies; i++) {
      const legal = XQ.legalMoves(board, side);
      if (!legal.length) break;
      const mv = legal[Math.floor(rnd() * legal.length)];
      if (!apply(idxToUci(mv[0]) + idxToUci(mv[1]))) break;
    }
  }

  /* 引擎开始独立思考前的手数 —— 用它给「这一局从哪个局面开始」做指纹 */
  const prefixLen = moves.length;
  const done = (o) => Object.assign(
    { ply: moves.length, labels, stats, opening, prefix: moves.slice(0, prefixLen) }, o);
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
    openings: parseInt(get('openings', '8'), 10),
    openPlies: parseInt(get('open-plies', '8'), 10),
    randomPlies: parseInt(get('random-plies', '0'), 10),
    maxPly: parseInt(get('max-ply', '200'), 10),
    seed: parseInt(get('seed', '1'), 10),
    gamelog: get('gamelog', null),
    fresh: a.includes('--fresh'),
    perft: parseInt(get('perft', '0'), 10),
    verbose: a.includes('--verbose'),
  };
}

/* ---------- 断点续跑：每局结果边跑边落盘 ---------- */

/** 引擎文件指纹。续跑时要确认「引擎没被换过」—— 否则两种版本的对局会被混在一起汇总。 */
function specFingerprint(spec) {
  let p = null;
  if (spec.startsWith('js:')) p = path.resolve(ROOT, spec.slice(3));
  else if (spec === 'js') p = path.join(ROOT, 'web/js/engine.js');
  else if (spec.startsWith('uci:')) p = path.resolve(ROOT, spec.slice(4));
  if (!p || !fs.existsSync(p)) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  } catch (e) { return null; }
}

/**
 * 读 gamelog。
 *
 * 两处刻意容错，都是为了「进程被强杀 / 机器重启」这种真实场景：
 *   - 最后一行大概率写到一半，JSON.parse 会失败 —— 跳过它，不要整个文件报废
 *   - 只认「从第 1 局开始连续」的那一段。中间缺局说明文件被动过，
 *     接着往后跑会让「第 N 局」与实际局面错位，那比重跑更糟
 */
function loadGamelog(file) {
  const out = { header: null, games: [], junk: 0, dropped: 0 };
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch (e) { out.junk++; continue; }
    if (o && o._header) out.header = o;
    else if (o && typeof o.g === 'number') out.games.push(o);
    else out.junk++;
  }
  out.games.sort((x, y) => x.g - y.g);
  let k = 0;
  while (k < out.games.length && out.games[k].g === k + 1) k++;
  out.dropped = out.games.length - k;
  out.games = out.games.slice(0, k);
  return out;
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

  /* ---- 断点续跑：先读日志，决定从第几局开始 ---- */
  let glogFd = null;
  let doneGames = [];
  let resumeFrom = 0;
  if (cfg.gamelog) {
    const file = path.resolve(ROOT, cfg.gamelog);
    if (cfg.fresh && fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`  --fresh：已删除旧日志 ${path.relative(ROOT, file)}`);
    }
    const log = loadGamelog(file);
    const fp = {
      msA: cfg.msA, msB: cfg.msB, openings: cfg.openings, openPlies: cfg.openPlies,
      randomPlies: cfg.randomPlies, seed: cfg.seed, maxPly: cfg.maxPly,
      a: cfg.a, b: cfg.b, fpA: specFingerprint(cfg.a), fpB: specFingerprint(cfg.b),
    };
    if (log.header) {
      const diff = Object.keys(fp).filter((k) => String(log.header[k]) !== String(fp[k]));
      if (diff.length) {
        console.error('  拒绝续跑：日志里的配置与本次不一致 ——');
        for (const k of diff) console.error(`    ${k}：日志 ${log.header[k]} / 本次 ${fp[k]}`);
        console.error('  把两种配置的对局混在一起汇总，得到的 Elo 没有意义。');
        console.error('  真要重来请加 --fresh（会删掉旧日志）。');
        process.exit(3);
      }
    }
    glogFd = fs.openSync(file, 'a');
    if (!log.header) {
      fs.writeSync(glogFd, JSON.stringify(Object.assign({ _header: 1 }, fp, { games })) + '\n');
      fs.fsyncSync(glogFd);
    }
    doneGames = log.games.slice(0, games);
    resumeFrom = doneGames.length;
    if (resumeFrom > 0) {
      console.log(`  断点续跑：${path.relative(ROOT, file)} 里已有 ${resumeFrom} 局，`
        + `从第 ${resumeFrom + 1} 局继续`
        + (log.junk ? `（跳过 ${log.junk} 行残损记录）` : '')
        + (log.dropped ? `，另有 ${log.dropped} 条不连续记录被忽略` : ''));
    } else {
      console.log(`  逐局落盘：${path.relative(ROOT, file)}（中断后重跑本脚本即可续上）`);
    }
    if (resumeFrom >= games) {
      console.log(`  日志里已有 ${resumeFrom} 局，本次要求 ${games} 局 —— 没有新局要跑，直接汇总。`);
    }
  }

  console.log('='.repeat(72));
  console.log('对局台：A vs B');
  console.log('='.repeat(72));
  console.log(`  A：${cfg.a}   每手 ${cfg.msA}ms`);
  console.log(`  B：${cfg.b}   每手 ${cfg.msB}ms`);
  console.log(`  共 ${games} 局｜开局 ${openings.length} 组（各取前 ${cfg.openPlies} 手）`
    + (cfg.randomPlies > 0 ? ` + 之后各走 ${cfg.randomPlies} 手随机着法` : '')
    + `｜轮流执先｜手数上限 ${cfg.maxPly}`);
  if (cfg.randomPlies === 0) {
    console.log(`  ⚠️  --random-plies 为 0：两局一对共用同一开局，实际不同的棋只有`
      + ` ${openings.length * 2} 盘，跑再多局也只是把它重放。`
      + `\n      要量棋力请加 --random-plies 4~8。`);
  }
  console.log();

  const engines = { a: makeEngine(cfg.a), b: makeEngine(cfg.b) };
  await engines.a.init();
  await engines.b.init();
  console.log(`  A 实际引擎名：${engines.a.name}`);
  console.log(`  B 实际引擎名：${engines.b.name}`);
  console.log();

  const perGame = [];
  const rows = [];
  const starts = new Set();   /* 每局引擎开始独立思考时的局面指纹，用来查「重复同一盘」 */
  const tally = { a: 0, b: 0, draw: 0 };
  const reasons = {};
  const broken = [];
  const sumD = { a: 0, b: 0 };   /* 层数之和，用于按**全部**局（含续跑继承的）算平均 */
  const sumN = { a: 0, b: 0 };
  let elapsed = 0;
  const t0 = Date.now();

  /* 把一局的记录累加进统计。续跑继承的局与新跑的局都走这一条路径 ——
     两条路各写一遍累加逻辑，迟早会漏掉某个计数器。 */
  const accum = (rec) => {
    if (rec.result === 'a') tally.a++;
    else if (rec.result === 'b') tally.b++;
    else tally.draw++;
    perGame.push(rec.result === 'a' ? 1 : rec.result === 'b' ? 0 : 0.5);
    reasons[rec.reason] = (reasons[rec.reason] || 0) + 1;
    if (rec.prefix) starts.add(rec.prefix);
    if (rec.broken) broken.push(`第 ${rec.g} 局：${rec.reason}`);
    sumD.a += rec.dA || 0; sumN.a += rec.nA || 0;
    sumD.b += rec.dB || 0; sumN.b += rec.nB || 0;
  };

  for (let g = 0; g < games; g++) {
    if (g < resumeFrom) { accum(doneGames[g]); continue; }

    const pair = Math.floor(g / 2);
    const opening = openings[(pair + cfg.seed) % openings.length];
    await engines.a.newGame();
    await engines.b.newGame();
    const started = Date.now();
    const r = await playGame(engines, cfg, g, opening, (cfg.seed + pair * 2654435761) >>> 0);
    elapsed += Date.now() - started;
    starts.add(r.prefix.join(' '));

    const aIsRed = g % 2 === 0;
    const aColor = aIsRed ? '红' : '黑';
    const result = r.winner === 'a' ? 'A 胜' : r.winner === 'b' ? 'B 胜' : '和棋';

    /* 先落盘、再打印。反过来的话，一次崩溃就可能出现
       「屏幕上看到了这局、日志里没有」—— 续跑时它会再下一遍，白等 30 秒。 */
    const rec = {
      g: g + 1, aIsRed, result: r.winner === 'a' ? 'a' : r.winner === 'b' ? 'b' : 'd',
      reason: r.reason, ply: r.ply, prefix: r.prefix.join(' '),
      dA: r.stats.a.depth, nA: r.stats.a.n,
      dB: r.stats.b.depth, nB: r.stats.b.n,
      broken: !!r.broken,
    };
    if (glogFd !== null) {
      fs.writeSync(glogFd, JSON.stringify(rec) + '\n');
      fs.fsyncSync(glogFd);
    }
    accum(rec);

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
  if (glogFd !== null) fs.closeSync(glogFd);

  const n = perGame.length;
  const scoreA = perGame.reduce((x, y) => x + y, 0) / n;
  const ci = eloInterval(perGame, scoreA);

  console.log();
  console.log('='.repeat(72));
  console.log('结果');
  console.log('='.repeat(72));
  console.log(`  A ${tally.a} 胜 / ${tally.draw} 和 / ${tally.b} 负　（共 ${n} 局）`);
  console.log(`  A 的得分率：${(scoreA * 100).toFixed(1)}%`);
  const avgAll = (t) => (sumN[t] ? (sumD[t] / sumN[t]).toFixed(2) : '—');
  console.log(`  平均层数：A ${avgAll('a')} / B ${avgAll('b')}`
    + (resumeFrom ? `　（含续跑继承的 ${resumeFrom} 局）` : ''));

  /* 自证：报告「真正不同的起手局面有几组」。
     对局台是确定性的，若开局不随机，名义局数会远大于独立样本数 ——
     脚本一旦在这一点上沉默，读结果的人就会把重放当成大样本。

     期望值是「对数」（= 局数/2）：一对里的两局**故意**共用同一局面、只交换执色，
     这是成对比较的设计，不算重复。真正的问题是 distinct 比对数还少 ——
     那说明不同对之间撞了同一局面，名义局数被注水。 */
  const distinct = starts.size;
  const pairs = Math.floor(n / 2);
  console.log(`  独立起手局面：${distinct} 组 / ${n} 局（成对设计，期望 ${pairs} 组）`);
  if (distinct < pairs) {
    console.log(`  ⚠️  比期望少 ${pairs - distinct} 组：有不同对撞了同一局面，`
      + '实际独立样本数少于局数的一半。');
    if (cfg.randomPlies === 0) {
      console.log('      根因很可能是 --random-plies 为 0 —— 此时只有'
        + ` ${cfg.openings} 个开局 x 2 种执色，跑再多局都是重放。加 --random-plies 4~8 即可。`);
    }
  }
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
