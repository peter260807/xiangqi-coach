#!/usr/bin/env node
'use strict';
/* 用 Pikafish 求解「我们自己的引擎看不到」的杀法题，并顺手给未通过的题做体检。
 *
 *   node tools/solve-mates-pika.js --out F.jsonl [--shard i/N] [--limit N]
 *                                  [--depth 64] [--movetime 2000] [--sets A,B]
 *                                  [--engine 路径] [--nnue 路径] [--follow 400]
 *   node tools/solve-mates-pika.js report --in F1.jsonl,F2.jsonl [--top 10] [--json]
 *
 *   批量跑分片用 `bash tools/solve-puzzles-pika.sh [ms] [分片数] [depth上限]`，
 *   跑完先 `report` 看体检、再 `import-puzzles.js emit --dry` 看落库数量。
 *
 * 为什么需要它：`import-puzzles.js solve` 用**我们自己的引擎**在 depth 13 求解，
 * 1310 个候选只过 445（34%）；剩下 865 条里 740 条是「已经搜到 depth 13 仍看不到杀」，
 * 也就是杀得比 6.5 手更深。要继续加深度到 d17~d21 按之前标定的代价不成立
 * （d16 单局面曾到 179 秒）。Pikafish 在标准开局 3ms 就走到 18.8 层，
 * 稀疏残局里更深 —— 实测未通过的题里 11/15 在 1 秒内报出 `score mate N`。
 *
 * ## 与 import-puzzles.solveLine 的关系：四条判据原样保留，只换「谁来算」
 *
 *   ① 走子方**每一步**都看得到杀棋分       → Pikafish 在该步 `score mate > 0`
 *   ② 对手**每一步**都是最顽强防守         → 该步让 Pikafish 自己挑（它的首选）
 *   ③ 最终局面确实无合法着法               → 仍用**我们自己的规则层**判（不靠引擎）
 *   ④ 线路长度 === 2*mateIn−1              → 见下
 *
 * ## 口径校准（2026-09-24 实测，别想当然）
 *
 * Pikafish 的 `score mate N` 是**手**（不是步），与我们的 `mateIn` 完全同口径：
 * 拿库里 mateIn 已知的 6 道题逐条问，N 分别等于 1/2/3/4/5/6，而库里存的线路长度
 * 正好是 2N−1。所以 ④ 直接比较即可。**顺手也验证了「它的着法与我们同解」**。
 *
 * ⚠️ 走子方用 `mate N` 时**同一行的 `score cp` 是垃圾**（实测 cp=0 / cp=-158），
 * 必须读 `scoreMate`；反过来 `scoreMate` 为空时 `cp` 才是分数。见 uci-engine.js。
 *
 * ## 非杀的局面怎么记
 *
 * Pikafish 没报出杀棋时，这一条多半**根本不是杀法题**（古谱里的残局技巧题，
 * 例如「海底捞月」是车炮胜单车的取胜技巧，不是 N 手杀）。记 `verdict`：
 *   · `mate`  看到杀棋分 → 可入册
 *   · `win`   cp 明显为正但未见杀 → 残局/技巧题（不该进 mates）
 *   · `flat`  cp 接近 0 → 疑似无解/和棋题（源题库里的坏数据）
 * 这三种都要出现在报告里 —— 「未通过」不等于「坏数据」，也不等于「题目有问题」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const PC = require(path.join(ROOT, 'tools/lib/position-check.js'));
const COORD = require(path.join(ROOT, 'tools/lib/coord.js'));
const { UciEngine } = require(path.join(ROOT, 'tools/lib/uci-engine.js'));
const IP = require(path.join(ROOT, 'tools/import-puzzles.js'));

const LIB_PATH = path.join(ROOT, 'shared/library.json');
const DEFAULT_BIN = path.join(ROOT, 'trainer/engine/pikafish');
const DEFAULT_NNUE = path.join(ROOT, 'trainer/engine/pikafish.nnue');

/* 一条线路最长几步。Pikafish 报出 mate 30+ 也照收，但别让它无限跑下去。 */
const MAX_PLY = 90;
/* 判定「明显为正」的门槛（厘兵）。Pikafish 的 cp 与我们的不是同一量纲，
   这里只用来给非杀的局面分类，不参与任何与自研引擎的比对。 */
const WIN_CP = 300;

function get(k, d) {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
}
function has(k) { return process.argv.includes('--' + k); }

/* ---------- 局面/线路的自证（不依赖任何引擎） ---------- */

/* 把一条中文记谱线路走一遍，检查：每一手都能解析、走完确实无着法。
 * 这是「落库前最后一次独立核对」——它只看规则层，所以引擎换成谁都不影响它。 */
function verifyLine(fen, side, labels) {
  const b = XQ.parseBoard(String(fen).split(' ')[0]);
  let s = side;
  for (const lb of labels) {
    const mv = XQ.findMoveByLabel(b, s, lb);
    if (!mv) return '记谱无法解析：' + lb;
    XQ.makeMove(b, mv);
    s = XQ.other(s);
  }
  return XQ.hasLegalMove(b, s) ? '走完线路后对方仍有着法（不是杀）' : '';
}

/* 把一串 UCI 着法在**我们的规则层**走一遍，产出中文记谱线路。
 * 每一步都要求是我们认的合法着法 —— 坐标方向/走子方写反时只有这里拦得住。 */
function replayLine(fen, side, uciMoves) {
  const b = XQ.parseBoard(String(fen).split(' ')[0]);
  let s = side;
  const steps = [];
  let err = '';
  for (const u of uciMoves) {
    if (!XQ.hasLegalMove(b, s)) { err = '线路已走完但仍有着法'; break; }
    const mv = COORD.uciToMove(u);
    const legal = XQ.legalMoves(b, s);
    if (!legal.some((m) => m[0] === mv[0] && m[1] === mv[1])) { err = '着法在规则层非法：' + u; break; }
    const label = XQ.moveLabel(b, mv);
    XQ.makeMove(b, mv);
    const oppStuck = !XQ.hasLegalMove(b, XQ.other(s));
    steps.push({ side: s, label, mateN: null, mate: oppStuck });
    s = XQ.other(s);
    if (oppStuck) break;
  }
  return { steps, err };
}

/* ---------- 求解器 ---------- */

class PikaSolver {
  constructor(opts) {
    this.bin = opts.bin || DEFAULT_BIN;
    this.nnue = opts.nnue || DEFAULT_NNUE;
    this.depth = opts.depth || 64;
    this.movetime = opts.movetime || 2000;
    /* 兜底路径每一步的时间上限：根搜索已经给出 mateIn，剩下几手是在
       「已经知道有杀」的前提下走的，不需要再烧一次完整预算。 */
    this.followMs = opts.followMs || 400;
    this.restarts = 0;
  }

  async ensure() {
    if (this.eng && !this.eng.exited) return;
    if (this.eng) { try { this.eng.quit(); } catch (e) { /* 忽略 */ } }
    this.eng = new UciEngine(this.bin, {
      options: { EvalFile: this.nnue, Threads: 1, Hash: 128 },
    });
    await this.eng.start();
    if (this.started) this.restarts++;
    this.started = true;
  }

  async ask(fen, ms) {
    await this.ensure();
    return this.eng.go([], {
      fen: COORD.toStdFen(fen),
      depth: this.depth,
      movetime: ms || this.movetime,
    });
  }

  /* 逐手搜索的兜底路径：Python 之外的老路（与 import-puzzles.solveLine 同构）。
   * PV 不够长 / 不能用时才走这里 —— 它每手都要重搜一次，慢 N 倍。 */
  async solveBySteps(cand, rootSide, mateIn) {
    const board = XQ.parseBoard(String(cand.fen).split(' ')[0]);
    let side = rootSide;
    const steps = [];
    let reason = '';
    for (let i = 0; i < MAX_PLY; i++) {
      if (!XQ.hasLegalMove(board, side)) break;
      const fen = XQ.boardToString(board) + ' ' + side;
      let r;
      try {
        r = await this.ask(fen, this.followMs);
      } catch (e) {
        reason = '引擎异常：' + String(e.message).replace(/\s+/g, ' ').slice(0, 120);
        break;
      }
      if (!r.best || r.best === '0000' || r.best === '(none)') { reason = '引擎未给出着法'; break; }
      const mv = COORD.uciToMove(r.best);
      const legal = XQ.legalMoves(board, side);
      if (!legal.some((m) => m[0] === mv[0] && m[1] === mv[1])) {
        reason = '引擎着法在规则层非法：' + r.best;
        break;
      }
      const mN = r.scoreMate;
      if (side === rootSide) {
        if (!(mN !== null && mN !== undefined && mN > 0)) {
          reason = '兜底路径中途看不到杀棋（cp=' + r.score + '）';
          break;
        }
      } else if (mN !== null && mN !== undefined && mN > 0) {
        /* 轮到对手时分数是**对手视角**：它看到杀棋分 > 0 就是我们要被反杀，
           这条「杀法」是假的。⚠️ 必须是 `> 0`：mN 为空表示看不到杀棋，
           写成 `>= 0` 会让每一条都在这里被判成「对手有反杀」。 */
        reason = '对手有反杀';
        break;
      }
      const label = XQ.moveLabel(board, mv);
      XQ.makeMove(board, mv);
      const oppStuck = !XQ.hasLegalMove(board, XQ.other(side));
      steps.push({ side, label, mateN: mN, mate: oppStuck });
      side = XQ.other(side);
      if (oppStuck) break;
    }
    const finished = !XQ.hasLegalMove(board, side);
    const last = steps[steps.length - 1];
    const ok = finished && !!last && last.mate && last.side === rootSide
      && steps.length === 2 * mateIn - 1;
    if (!ok && !reason) reason = '兜底路径未走出最优线路（' + steps.length + ' 步 vs 应 ' + (2 * mateIn - 1) + ' 步）';
    return { ok, steps, reason };
  }

  /* 返回 { ok, mateIn, steps, reason, rootCp, rootDepth, nodes, verdict, path }
   *
   * 时间账：这条题真正贵的只有**根搜索一次**。根搜索报出 `score mate N` 时，
   * 它的 PV 里就躺着完整的最短杀法线路（N 手 = 2N−1 步），所以默认走 PV 路径：
   * 1 次搜索 + 一次纯规则层重放。逐手重搜只在 PV 被截断时才用得上。 */
  async solveOne(cand) {
    const rootSide = cand.side;
    const rootFen = String(cand.fen).split(' ').slice(0, 2).join(' ');
    let r;
    try {
      r = await this.ask(rootFen);
    } catch (e) {
      return {
        ok: false, mateIn: 0, steps: [], verdict: 'error', path: '',
        reason: '引擎异常：' + String(e.message).replace(/\s+/g, ' ').slice(0, 120),
        rootCp: 0, rootDepth: 0, nodes: 0,
      };
    }
    const rootCp = r.score, rootDepth = r.depth, nodes = r.nodes;
    const mN = r.scoreMate;
    if (!(mN !== null && mN !== undefined && mN > 0)) {
      /* 没报杀棋 —— 大概率**根本不是杀法题**（古谱里的残局技巧题），
         按 cp 分个类，让报告能把这个区分说清楚。 */
      return {
        ok: false, mateIn: 0, steps: [], path: 'root',
        reason: 'Pikafish 亦未见杀（cp=' + rootCp + ' d=' + rootDepth + '）',
        rootCp, rootDepth, nodes,
        verdict: rootCp >= WIN_CP ? 'win' : (rootCp <= -WIN_CP ? 'lost' : 'flat'),
      };
    }
    const want = 2 * mN - 1;

    /* --- 路径 A：根搜索的 PV 一次到底 --- */
    let reason = '';
    if (r.pv && r.pv.length >= want) {
      const rep = replayLine(rootFen, rootSide, r.pv);
      const last = rep.steps[rep.steps.length - 1];
      if (!rep.err && rep.steps.length === want && last.mate && last.side === rootSide) {
        const bad = verifyLine(cand.fen, rootSide, rep.steps.map((x) => x.label));
        if (!bad) {
          return {
            ok: true, mateIn: mN, steps: rep.steps, reason: '', path: 'pv',
            rootCp, rootDepth, nodes, verdict: 'mate',
          };
        }
        reason = bad;
      } else {
        reason = rep.err || ('PV 长度 ' + r.pv.length + ' 步，但走出来的杀在第 '
          + rep.steps.length + ' 步（应 ' + want + ' 步）');
      }
    } else {
      reason = 'PV 不够长（' + (r.pv ? r.pv.length : 0) + ' < ' + want + '）';
    }

    /* --- 路径 B：PV 不能用，逐手重搜 --- */
    const alt = await this.solveBySteps(cand, rootSide, mN);
    if (alt.ok) {
      const bad = verifyLine(cand.fen, rootSide, alt.steps.map((x) => x.label));
      if (!bad) {
        return {
          ok: true, mateIn: mN, steps: alt.steps, reason: '', path: 'steps',
          rootCp, rootDepth, nodes, verdict: 'mate',
        };
      }
      reason = bad;
    } else if (alt.reason) {
      reason = reason + '；' + alt.reason;
    }
    return { ok: false, mateIn: 0, steps: alt.steps, path: 'fail', reason, rootCp, rootDepth, nodes, verdict: 'mate-unverified' };
  }
}

/* ---------- 主流程 ---------- */

function unsolvedCandidates(setFilter) {
  const lib = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
  const have = new Set();
  for (const sec of ['mates', 'studies']) {
    for (const it of lib[sec]) {
      if (!it.fen) continue;
      try {
        const c = PC.stdFenToInternal(it.fen + ' r');
        have.add(PC.positionKey(c.board, c.side));
      } catch (e) { /* 库里本就有的问题条目 */ }
    }
  }
  let { cands } = IP.loadCandidates();
  /* 只解「红先的杀法题」：杀法练习假定用户执红（与 import-puzzles.solve 同口径） */
  cands = cands.filter((c) => c.kind === 'mate' && c.side === 'r');
  cands = cands.filter((c) => !have.has(c.key));
  if (setFilter) {
    const want = setFilter.split(',');
    cands = cands.filter((c) => want.indexOf(c.set) >= 0);
  }
  return cands;
}

async function run() {
  const out = get('out', null);
  if (!out) throw new Error('必须给 --out（分片文件路径）');
  const depth = parseInt(get('depth', '64'), 10);
  const movetime = parseInt(get('movetime', '2000'), 10);
  const limit = parseInt(get('limit', '0'), 10);
  const shard = get('shard', '0/1').split('/').map(Number);

  let cands = unsolvedCandidates(get('sets', null));
  const total = cands.length;
  if (shard[1] > 1) cands = cands.filter((c, i) => i % shard[1] === shard[0]);
  if (limit > 0) cands = cands.slice(0, limit);

  const solver = new PikaSolver({
    bin: get('engine', DEFAULT_BIN),
    nnue: get('nnue', DEFAULT_NNUE),
    depth,
    movetime,
    followMs: parseInt(get('follow', '400'), 10),
  });
  await solver.ensure();

  const fd = fs.openSync(out, 'a');
  const t0 = Date.now();
  let done = 0, solved = 0;
  const reasons = {}, verdicts = {}, mates = {}, paths = {};
  for (const c of cands) {
    const t = Date.now();
    let res;
    try {
      res = await solver.solveOne(c);
    } catch (e) {
      res = { ok: false, mateIn: 0, steps: [], reason: '异常：' + e.message, rootCp: 0, rootDepth: 0, nodes: 0, verdict: 'error', path: '' };
    }
    const rec = {
      key: c.key, fen: c.fen, name: c.name, set: c.set,
      ok: res.ok, mateIn: res.mateIn,
      line: res.ok ? res.steps.map((s) => s.label) : [],
      lineSides: res.ok ? res.steps.map((s) => (s.side === 'r' ? 'red' : 'black')) : [],
      solvePlies: res.ok ? res.steps.length : 0,
      reachedDepth: res.rootDepth,
      failReason: res.ok ? '' : res.reason,
      /* 以下字段只进分片文件、不进库（emit 只读它认识的字段）：
         `solver` 让「这条题是谁算出来的」永远查得到；`path` 是「一次搜索的 PV」
         还是「逐手重搜」；`rootCp`/`verdict` 是给非杀的局面做体检用的。 */
      solver: 'pikafish',
      path: res.path || '',
      rootCp: res.rootCp,
      nodes: res.nodes,
      verdict: res.verdict,
      ms: Date.now() - t,
    };
    /* 落盘排在打印之前 —— 反过来的话，一次崩溃可能出现「屏幕上看到了、文件里没有」 */
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(fd);
    if (!rec.ok) reasons[rec.failReason] = (reasons[rec.failReason] || 0) + 1;
    verdicts[rec.verdict] = (verdicts[rec.verdict] || 0) + 1;
    if (rec.path) paths[rec.path] = (paths[rec.path] || 0) + 1;
    if (rec.ok) { solved++; mates[rec.mateIn] = (mates[rec.mateIn] || 0) + 1; }
    done++;
    const elapsed = (Date.now() - t0) / 1000;
    const eta = done ? (elapsed / done * (cands.length - done)) : 0;
    console.log((rec.ok ? 'PASS' : 'FAIL') + ' ' + String(done).padStart(4) + '/' + cands.length
      + '  ' + (rec.ok ? ('杀' + rec.mateIn + '手  ' + rec.line.join(' ').slice(0, 40))
        : ('未通过：' + rec.failReason).slice(0, 56))
      + '  [' + c.set + '] ' + String(c.name).replace(/ - .*$/, '').slice(0, 18)
      + '  ' + (rec.ms / 1000).toFixed(1) + 's  ETA ' + Math.round(eta / 60) + 'min');
  }
  fs.closeSync(fd);

  console.log('\n分片 ' + shard[0] + '/' + shard[1] + '：本片 ' + done + '，通过 ' + solved
    + '（' + (done ? (solved / done * 100).toFixed(1) : '0') + '%），耗时 '
    + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒 → ' + out);
  if (Object.keys(verdicts).length) {
    console.log('体检结论：' + Object.keys(verdicts).sort().map((k) => k + ' ' + verdicts[k]).join('  ')
      + '（mate=看到杀  win=必胜但未见杀  flat=接近均势  lost=反而落后  error=异常）');
  }
  if (Object.keys(paths).length) {
    console.log('求解路径：' + Object.keys(paths).sort().map((k) => k + ' ' + paths[k]).join('  ')
      + '（pv=一次搜索的 PV 就够  steps=PV 不能用、逐手重搜  root=根搜索就没看到杀）');
  }
  if (solver.restarts) console.log('⚠️ 引擎崩过 ' + solver.restarts + ' 次（已自动重启）');
  if (Object.keys(mates).length && shard[1] === 1) {
    console.log('手数分布：' + Object.keys(mates).sort((a, b) => a - b).map((k) => k + '手:' + mates[k]).join('  '));
  }
  if (Object.keys(reasons).length) {
    console.log('未通过原因：');
    for (const k of Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a])) {
      console.log('  ' + String(reasons[k]).padStart(5) + '  ' + k);
    }
  }
}

/* ---------- 体检报告 ---------- */

/* 未通过的题**不等于坏数据**，也不等于题目有问题 —— 把它们分成几类看清楚，
 * 才知道下一步该干什么（换 engine？换题库？还是放弃这批）。
 *
 *   node tools/solve-mates-pika.js report --in shard0.jsonl,shard1.jsonl [--json] [--top 10]
 *
 * `--json` 是给文档/流水线用的（数值可核对）；默认输出是给人看的。
 * 报告里的「已落库」按**局面键**比，不是按文件名或 id —— 落库之后重跑一次报告，
 * 这一列会告诉你有多少条真的进去了。 */
function report() {
  const inp = get('in', null);
  if (!inp) throw new Error('必须给 --in（多个文件用逗号分隔）');
  const topN = parseInt(get('top', '10'), 10);

  const recs = [];
  const files = [];
  for (const f of inp.split(',')) {
    const txt = fs.readFileSync(f, 'utf8');
    const lines = txt.split('\n').filter((l) => l.trim());
    files.push({ file: f, n: lines.length });
    for (const l of lines) recs.push(JSON.parse(l));
  }

  /* 库里已有哪些局面 —— 用来判断「这份报告是在落库前还是落库后跑的」 */
  const lib = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
  const inLib = new Set();
  for (const sec of ['mates', 'studies']) {
    for (const it of lib[sec]) {
      if (!it.fen) continue;
      try {
        const c = PC.stdFenToInternal(it.fen + ' r');
        inLib.add(PC.positionKey(c.board, c.side));
      } catch (e) { /* 库里本就有的问题条目 */ }
    }
  }

  const ok = recs.filter((r) => r.ok);
  const bad = recs.filter((r) => !r.ok);
  const tally = (arr, pick) => {
    const m = {};
    for (const r of arr) { const k = pick(r); m[k] = (m[k] || 0) + 1; }
    return m;
  };
  const dist = (m) => Object.keys(m).sort((a, b) => Number(a) - Number(b))
    .map((k) => k + ':' + m[k]).join('  ');
  const distByCount = (m) => Object.keys(m).sort((a, b) => m[b] - m[a])
    .map((k) => k + ' ' + m[k]).join('  ');

  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : 0);
  /* 原因归并：里面带着 cp / 深度 / 长度这些每次都不同的数字，
     不归并的话同一条原因会被拆成几十行。 */
  const normReason = (s) => String(s || '').replace(/[0-9]+/g, 'N').trim();
  const reasons = tally(bad, (r) => normReason(r.failReason));

  const bySetOk = tally(ok, (r) => r.set);
  const bySetBad = tally(bad, (r) => r.set);
  const sets = Object.keys(Object.assign({}, bySetOk, bySetBad)).sort();

  const summary = {
    读入: recs.length,
    分片: files,
    通过: ok.length,
    未通过: bad.length,
    通过率: recs.length ? Number((ok.length / recs.length * 100).toFixed(1)) : 0,
    已落库: ok.filter((r) => inLib.has(r.key)).length,
    求解路径: tally(recs, (r) => r.path || '(无)'),
    通过手数分布: tally(ok, (r) => r.mateIn),
    未通过体检: tally(bad, (r) => r.verdict || '(无)'),
    未通过原因: reasons,
    按来源: sets.map((s) => ({ 来源: s, 通过: bySetOk[s] || 0, 未通过: bySetBad[s] || 0 })),
    耗时ms: { 中位: pct(0.5), 平均: ok.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0, 最长: pct(1) },
  };

  console.log('读入 ' + recs.length + ' 条（' + files.map((f) => f.file.split('/').pop() + ' ' + f.n).join('，') + '）');
  console.log('通过 ' + ok.length + '（' + summary.通过率 + '%）  未通过 ' + bad.length
    + '  其中已落库 ' + summary.已落库 + ' 条');
  if (ok.length) {
    const mi = ok.map((r) => r.mateIn).sort((a, b) => a - b);
    console.log('通过题手数：最短 ' + mi[0] + ' 手  中位 ' + mi[Math.floor(mi.length / 2)]
      + ' 手  最深 ' + mi[mi.length - 1] + ' 手');
    console.log('  分布：' + dist(summary.通过手数分布));
    console.log('单题耗时：中位 ' + summary.耗时ms.中位 + 'ms  平均 ' + summary.耗时ms.平均
      + 'ms  最长 ' + summary.耗时ms.最长 + 'ms');
  }
  console.log('求解路径：' + distByCount(summary.求解路径)
    + '（pv=一次搜索的 PV 就够  steps=PV 不能用、逐手重搜  root=根搜索就没看到杀）');
  if (bad.length) {
    console.log('\n未通过体检：' + distByCount(summary.未通过体检)
      + '（mate=看到杀但线路没验过  win=必胜但未见杀  flat=接近均势  lost=反而落后  error=异常）');
    console.log('未通过原因（同类已归并）：');
    const rk = Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a]);
    for (const k of rk) console.log('  ' + String(reasons[k]).padStart(5) + '  ' + k.slice(0, 100));
  }
  if (sets.length) {
    console.log('\n按来源：');
    for (const s of sets) {
      const o = bySetOk[s] || 0, b = bySetBad[s] || 0;
      console.log('  ' + String(s).padEnd(12) + ' 通过 ' + String(o).padStart(4)
        + '  未通过 ' + String(b).padStart(4) + '  （' + (o + b ? (o / (o + b) * 100).toFixed(0) : '0') + '%）');
    }
  }
  if (bad.length && topN > 0) {
    console.log('\n未通过举例（按 verdict 分组，各取前 ' + topN + ' 条）：');
    for (const v of Object.keys(summary.未通过体检).sort()) {
      const sample = bad.filter((r) => (r.verdict || '(无)') === v).slice(0, topN);
      console.log('  [' + v + ']');
      for (const r of sample) {
        console.log('    ' + String(r.name).replace(/ - .*$/, '').slice(0, 20).padEnd(22)
          + ' cp=' + String(r.rootCp).padStart(7) + '  ' + String(r.failReason).slice(0, 60));
      }
    }
  }
  if (has('json')) console.log('\n' + JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'report') {
    try { report(); } catch (e) { console.error(e.message); process.exitCode = 2; }
  } else {
    run().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
  }
}

module.exports = { PikaSolver, verifyLine, unsolvedCandidates, MAX_PLY };
