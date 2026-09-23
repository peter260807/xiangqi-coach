'use strict';
/* 离线预计算：用自研引擎把局面分析好，存成数据随 app 发布。
 *
 *   node tools/precompute.js quality  --out results/q.jsonl [--jobs N] [--max-positions N]
 *   node tools/precompute.js library  --depth 12 --multipv 3 --out results/lib.jsonl [--jobs N]
 *
 * 三个必须记住的前提（都是踩出来的）：
 *
 *   1. **`go depth N` 单独用时不是固定深度。** 本项目引擎把缺省的 movetime 兜底成
 *      80ms，实测 time 恒为 81ms、depth 只到 6、节点数每次抖动 ±1.5%。
 *      要真固定深度必须同时给一个很大的 movetime（这里给 1 小时）。
 *   2. **Swift 与 JS 在真固定深度下同解**（15/15，含分数）→ 可以把活儿拆给两台机器。
 *      但这条只在给了 movetime 之后才成立；不给的时候两边都在 80ms 截断，结论不算数。
 *   3. **不生成 .bat 当启动器**，也不依赖 cwd —— 见技能 robust-longrun-pipeline。
 *
 * 输出一律 JSONL，**边算边落盘 + fsync**，支持中断续跑（按 key 去重）。并行用
 * `--shard i/N` 分片，父进程 fork N 个自己，各自写 out.partI.jsonl，最后合并。
 */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { UciEngine } = require('./lib/uci-engine.js');

const ROOT = path.resolve(__dirname, '..');
const WIN_ENGINE = path.join(ROOT, 'trainer/engine/pikafish');
const WIN_NNUE = path.join(ROOT, 'trainer/engine/pikafish.nnue');
const SWIFT_ENGINE = path.join(ROOT, 'tools/uci/build/xq-uci');
const JS_ENGINE = path.join(ROOT, 'web/js/engine.js');

/* 大 movetime：depth 才是真上限。别删，删了搜索会被 80ms 截断。 */
const BIG_MS = 3600000;

/* ---------- 参数 ---------- */

function parseArgs(argv) {
  const a = argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf('--' + k);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : d;
  };
  /* mode 就是第一个位置参数。别用「第一个不以 -- 开头的参数」去猜 ——
     那样 `quality --source c1` 会把 `c1` 认成 mode（选项值是位置参数的天然陷阱）。 */
  const mode = (a[0] && !a[0].startsWith('--')) ? a[0] : null;
  /* ⚠️ 分片输出必须用**独立参数名**。原来是在 fork 时 concat 一个 `--out <分片>`，
     而 `get('out')` 只认**第一个** `--out` —— 于是子进程全程拿到父进程的输出路径，
     4 个 worker 一起往同一个文件写（还没有分片文件），最后合并那一步再用空的分片
     文件把它截断成 0 字节。整批结果静默丢失。 */
  return {
    mode,
    out: get('shardout', null) || get('out', null),
    depth: parseInt(get('depth', '10'), 10),
    depths: get('depths', null),
    multipv: parseInt(get('multipv', '1'), 10),
    refDepth: parseInt(get('ref-depth', '18'), 10),
    maxPositions: parseInt(get('max-positions', '200'), 10),
    source: get('source', 'c1'),
    /* 显式局面清单：一行一个 `fen` 或 `fen <TAB> tag`。跨机分工靠它 ——
       Windows 上没有 Swift 版自研引擎（只有 JS，慢约 6 倍），但**可以当裁判**。
       把同一批局面一分为二、两台各跑一半，是最省事的横向扩展方式。 */
    positions: get('positions', null),
    /* 裁判（Pikafish）的位置。Windows 上用 release 解出来的那份，
       路径不同，所以必须可配。 */
    judge: get('judge', null),
    judgeNnue: get('judge-nnue', null),
    jobs: parseInt(get('jobs', '1'), 10),
    engine: get('engine', null),
    shard: get('shard', null),
    fresh: a.includes('--fresh'),
    worker: a.includes('--worker'),
    /* 只做「我们引擎给什么着法」这一段，不请裁判 —— 配合 judge 模式把两段
       分到两台机器上（分析必须在 Swift 上做，裁判谁跑都行）。 */
    noJudge: a.includes('--no-judge'),
    input: get('in', null),
  };
}

/* ---------- 局面与着法 ---------- */

const XQ = require(JS_ENGINE);

const sqName = (i) => String.fromCharCode(97 + (i % 9)) + (9 - Math.floor(i / 9));
const toUci = (m) => sqName(m[0]) + sqName(m[1]);
function fromUci(s) {
  const c = (t) => (9 - parseInt(t[1], 10)) * 9 + (t.charCodeAt(0) - 97);
  return [c(s.slice(0, 2)), c(s.slice(2, 4))];
}
const boardKey = (b, side) => b + ' ' + side;

/* 本项目内部用 `.` 表示空格，**Pikafish 不认** —— 它会报
 * `CRITICAL ERROR: Invalid FEN. Invalid piece: .` 然后**直接退出进程**，
 * 而调用方只会以为搜索还没结束，一直等下去（实测把整个任务拖到被系统杀掉）。
 * 标准 FEN 用数字表示连续空格，走子方是 w/b。行序两边一致（第 0 行都是黑方底线）。 */
function toStdFen(fen) {
  const parts = fen.split(' ');
  const rows = parts[0].split('/').map((row) => row.replace(/\.+/g, (m) => String(m.length)));
  return rows.join('/') + ' ' + (parts[1] === 'b' ? 'b' : 'w');
}

/* 杀棋分数：Pikafish 发 `score mate N` 而不是 `score cp N`。不折算的话
 * 「将死」会被读成 0 分，和「完全均势」无法区分。 */
const MATE_CP = 30000;
function normScore(r) {
  if (r.scoreMate !== null && r.scoreMate !== undefined) {
    const n = Math.max(1, Math.abs(r.scoreMate));
    return (r.scoreMate > 0 ? 1 : -1) * (MATE_CP - n);
  }
  return r.score;
}

/* 这个局面还有没有子可走。**必须筛掉终局**：被将死的局面引擎会回 `bestmove 0000`，
 * 而 `fromUci('0000')` 会算出越界的格子号（'0'-97 是负数），一路带到 makeMove 里
 * 变成 `Cannot read properties of undefined` —— 报错点离真正的原因很远。
 * 另：也不能只靠 `best` 是否为空判断，得在生成局面时就拦掉，免得白跑裁判。 */
function playable(fen) {
  const parts = fen.split(' ');
  return XQ.hasLegalMove(XQ.parseBoard(parts[0]), parts[1] === 'b' ? 'b' : 'r');
}

/* 把库里的中文记谱 line 走成局面序列（只保留还能走的局面） */
function walkLine(fen, line, sideToMove) {
  const labels = String(line).trim().split(/\s+/).filter(Boolean);
  let b = XQ.parseBoard(fen);
  let side = sideToMove;
  const out = [];
  const snap = (ply, label) => {
    const f = XQ.boardToString(b) + ' ' + side;
    if (playable(f)) out.push({ fen: f, ply, label, board: XQ.boardToString(b), side });
  };
  snap(0, null);
  for (let i = 0; i < labels.length; i++) {
    const mv = XQ.findMoveByLabel(b, side, labels[i]);
    if (!mv) { out.push({ error: '记谱无法解析：' + labels[i], ply: i + 1 }); break; }
    XQ.makeMove(b, mv);
    side = XQ.other(side);
    snap(i + 1, labels[i]);
  }
  return out;
}

/* ---------- 引擎适配 ---------- */

class EngineAdapter {
  constructor(spec) { this.spec = spec; this.eng = null; this.kind = null; this.stdFen = false; }
  async init() {
    if (this.spec === 'js' || !this.spec) {
      this.kind = 'js';
      return;
    }
    this.kind = 'uci';
    this.eng = new UciEngine(this.spec, this.options || {});
    await this.eng.start();
  }
  /* 返回 { best, score, depth, nodes, candidates:[{move,score}] } */
  async analyze(fen, depth, multipv) {
    const n = Math.max(1, multipv || 1);
    if (this.kind === 'js') {
      const parts = fen.split(' ');
      const b = XQ.parseBoard(parts[0]);
      const side = parts[1] === 'b' ? 'b' : 'r';
      const excluded = [];
      const cands = [];
      XQ.resetSearch();
      for (let k = 0; k < n; k++) {
        const r = XQ.searchRoot(b, side, depth, BIG_MS, excluded, []);
        if (!r.move) break;
        cands.push({ move: toUci(r.move), score: r.score, depth: r.depth });
        excluded.push(r.move);
        if (Math.abs(r.score) > XQ.MATE - 1000) break;
      }
      if (!cands.length) return { best: null, score: 0, depth: 0, nodes: 0, candidates: [] };
      return { best: cands[0].move, score: cands[0].score, depth: cands[0].depth,
               nodes: 0, candidates: cands };
    }
    const wire = this.stdFen ? toStdFen(fen) : fen;
    const r = await this.eng.go([], { fen: wire, depth, movetime: BIG_MS, multipv: n });
    return { best: r.best, score: normScore(r), depth: r.depth, nodes: r.nodes,
             candidates: r.candidates && r.candidates.length
               ? r.candidates.map((c) => ({ move: c.move, score: c.score }))
               : [{ move: r.best, score: normScore(r) }] };
  }
  quit() { if (this.eng) this.eng.quit(); }
}

/* Pikafish：基准/裁判用。EvalFile + 单线程（要量算法，不是核数）。
 * stdFen = true —— 它只吃标准 FEN。
 * 路径可被 --judge / --judge-nnue 覆盖（Windows 上那份是 release 解出来的）。 */
function makeJudge(cfg) {
  const bin = (cfg && cfg.judge) || WIN_ENGINE;
  const nnue = (cfg && cfg.judgeNnue) || WIN_NNUE;
  if (!fs.existsSync(bin)) throw new Error('裁判引擎不存在：' + bin);
  const e = new EngineAdapter(bin);
  e.options = { EvalFile: nnue, Threads: 1, Hash: 128 };
  e.stdFen = true;
  return e;
}

/* ---------- 工作项生成 ---------- */

function loadLibrary() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/library.json'), 'utf8')); }

/* 从标准开局推 N 手，取中局样本（用 JS 引擎低深度走，确定性） */
function midgame(plies) {
  XQ.resetSearch();
  const b = XQ.parseBoard(XQ.START);
  let side = 'r';
  const idx = [];
  for (let i = 0; i < plies; i++) {
    const r = XQ.searchRoot(b, side, 2, 40, null, idx);
    if (!r.move) break;
    XQ.makeMove(b, r.move);
    idx.push(r.move);
    side = XQ.other(side);
    XQ.resetSearch();
  }
  return { board: XQ.boardToString(b), side, fen: XQ.boardToString(b) + ' ' + side };
}

function buildJobs(cfg) {
  const lib = loadLibrary();
  /* 显式清单优先。一行 = `fen` 或 `fen<TAB>tag`；`#` 开头当注释。 */
  if (cfg.positions) {
    const lines = fs.readFileSync(cfg.positions, 'utf8').split('\n');
    const jobs = [];
    const seen = new Set();
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const parts = line.split('\t');
      const fen = parts[0].trim();
      if (!fen || seen.has(fen)) continue;
      seen.add(fen);
      jobs.push({ key: fen, fen, tag: (parts[1] || '').trim() || fen.slice(0, 24) });
      if (jobs.length >= cfg.maxPositions) break;
    }
    return jobs;
  }
  if (cfg.mode === 'quality') {
    const jobs = [];
    if (cfg.source === 'c1') {
      for (const p of walkLine(XQ.START, lib.classics[0].line, 'r')) {
        if (p.error) continue;
        if (jobs.length >= cfg.maxPositions) break;   // 小规模验证用
        jobs.push({ key: p.fen, fen: p.fen, tag: 'c1#' + p.ply });
      }
    } else {
      /* 采样：中局为主，掺一批残局/杀法（它们代表不同的分支因子） */
      const seen = new Set();
      let n = 0;
      for (let plies = 6; plies <= 60 && jobs.length < cfg.maxPositions; plies += 2) {
        for (const s of [0, 1, 2, 3]) {
          if (jobs.length >= cfg.maxPositions) break;
          const m = midgame(plies + s * 3);
          if (seen.has(m.fen)) continue;
          seen.add(m.fen);
          jobs.push({ key: m.fen, fen: m.fen, tag: 'mid' + (plies + s * 3) });
          n++;
        }
      }
      for (const sec of ['studies', 'mates']) {
        for (const it of lib[sec]) {
          if (jobs.some((j) => j.key === it.fen + ' r')) continue;
          jobs.push({ key: it.fen + ' r', fen: it.fen + ' r', tag: it.id });
        }
      }
    }
    return jobs;
  }
  if (cfg.mode === 'library') {
    const jobs = [];
    const push = (fen, tag) => {
      if (!jobs.some((j) => j.key === fen)) jobs.push({ key: fen, fen, tag });
    };
    for (const c of lib.classics) {
      for (const p of walkLine(XQ.START, c.line, 'r')) if (!p.error) push(p.fen, c.id + '#' + p.ply);
    }
    for (const o of lib.openings) {
      for (const p of walkLine(XQ.START, o.line, 'r')) if (!p.error) push(p.fen, o.id + '#' + p.ply);
    }
    for (const it of lib.studies) push(it.fen + ' r', it.id);
    for (const it of lib.mates) push(it.fen + ' r', it.id);
    return jobs;
  }
  throw new Error('未知 mode: ' + cfg.mode);
}

/* ---------- 输出（可续跑） ---------- */

class Sink {
  constructor(file, fresh) {
    this.file = file;
    this.done = new Set();
    if (!fresh && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.done.add(JSON.parse(line).key); } catch (e) { /* 半条记录，忽略 */ }
      }
    }
    this.fd = fs.openSync(file, fresh ? 'w' : 'a');
  }
  has(key) { return this.done.has(key); }
  write(rec) {
    fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(this.fd);       // 先落盘再继续 —— 崩了也不丢
    this.done.add(rec.key);
  }
  close() { fs.closeSync(this.fd); }
}

/* ---------- worker ---------- */

async function runWorker(cfg) {
  const all = buildJobs(cfg);
  const [si, sn] = (cfg.shard || '0/1').split('/').map(Number);
  const mine = all.filter((_, i) => i % sn === si);

  const our = new EngineAdapter(cfg.engine || (fs.existsSync(SWIFT_ENGINE) ? SWIFT_ENGINE : 'js'));
  await our.init();
  /* 让 judge 可重新赋值：裁判会因为「局面非法」自杀（Pikafish 校验不过就 CRITICAL
     ERROR 然后退出进程），遇到就重启一个继续 —— 不能让整批数据因为一个坏局面全废。 */
  let judge = (cfg.mode === 'quality' && !cfg.noJudge) ? makeJudge(cfg) : null;
  if (judge) await judge.init();

  const sink = new Sink(cfg.out, cfg.fresh);
  let did = 0, skipped = 0;
  const t0 = Date.now();
  /* 要测哪些深度。默认覆盖 app 现在的 d4 到 d12；想看「更深还有没有用」时
     用 --depths 12,14,16 单独跑一批（d16 大约是 d12 的十几倍开销）。 */
  const depths = cfg.mode === 'quality'
    ? (cfg.depths ? cfg.depths.split(',').map((x) => parseInt(x, 10))
                  : [4, 6, 8, 10, 12])
    : [cfg.depth];

  for (const job of mine) {
    if (sink.has(job.key)) { skipped++; continue; }
    const rec = { key: job.key, fen: job.fen, tag: job.tag, engine: path.basename(cfg.engine || our.spec || 'js') };

    if (cfg.mode === 'quality') {
      rec.ours = {};
      /* 一整条记录包在 try 里：裁判挂掉（多半是它认为局面非法）时，把原因记在这条上、
         重启裁判、继续下一条。原来没有这层保护，一个坏局面会让整批任务静默卡死。 */
      try {
        /* 裁判可关（--no-judge）。两段式的由来：**分析必须用 Swift 做**
           （iOS 上的引擎就是它，用 JS 产出的数据会和 app 自己的本地分析互相矛盾 ——
           JS 的置换表有条数上限 TT_MAX，顶到之后搜索退化，d10 以上就会和 Swift 挑不同的
           着法），而**裁判谁跑都行**（Pikafish 与实现无关）。所以把判分整段拆出去，
           可以丢给另一台机器。 */
        let ref = null;
        if (!cfg.noJudge) {
          const refT = Date.now();
          ref = await judge.analyze(job.fen, cfg.refDepth, 1);
          rec.ref = { move: ref.best, score: ref.score, depth: ref.depth, ms: Date.now() - refT };
        }
        for (const d of depths) {
          const t = Date.now();
          const r = await our.analyze(job.fen, d, 1);
          const ms = Date.now() - t;
          /* 终局（无子可动）时引擎回 `0000`。必须在这里挡住 —— 它传到 fromUci 会算出
             越界格子号，最后炸在 makeMove 里，报错点离原因很远。 */
          if (!r.best || !/^[a-i][0-9][a-i][0-9]$/.test(r.best)) {
            rec.ours[d] = { move: null, score: 0, ms, terminal: true };
            continue;
          }
          if (cfg.noJudge) {
            rec.ours[d] = { move: r.best, score: r.score, ms };
            continue;
          }
          /* 裁判给「我们建议的那一手」打分：走完之后从原走子方视角取负 */
          const parts = job.fen.split(' ');
          const b = XQ.parseBoard(parts[0]);
          const side = parts[1] === 'b' ? 'b' : 'r';
          XQ.makeMove(b, fromUci(r.best));
          const after = await judge.analyze(XQ.boardToString(b) + ' ' + XQ.other(side), cfg.refDepth, 1);
          const ourScoreByJudge = -after.score;
          rec.ours[d] = { move: r.best, score: r.score, ms, judged: ourScoreByJudge,
                          sameAsRef: r.best === ref.best, loss: ref.score - ourScoreByJudge };
        }
      } catch (e) {
        rec.error = (rec.error ? rec.error + ' / ' : '') + e.message;
        process.stderr.write('[shard ' + si + '] ' + job.tag + ' 出错：' + e.message + '\n');
        if (judge) {
          try { judge.quit(); } catch (x) { /* */ }
          try { judge = makeJudge(cfg); await judge.init(); } catch (x) { /* */ }
        }
      }
    } else {
      const t = Date.now();
      const r = await our.analyze(job.fen, cfg.depth, cfg.multipv);
      rec.depth = cfg.depth;
      rec.ms = Date.now() - t;
      rec.best = r.best;
      rec.score = r.score;
      rec.reached = r.depth;
      rec.candidates = r.candidates.map((c) => ({ move: c.move, score: c.score }));
    }
    sink.write(rec);
    did++;
    if (did % 10 === 0 || Date.now() - t0 > 60000) {
      process.stderr.write('[shard ' + si + '] ' + did + '/' + mine.length
        + '  跳过 ' + skipped + '  用时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's\n');
    }
  }
  our.quit();
  if (judge) judge.quit();
  sink.close();
  process.stderr.write('[shard ' + si + '] 完成：算了 ' + did + '，跳过 ' + skipped + '（共 ' + mine.length + '）\n');
}

/* ---------- judge：只补裁判分数 ---------- */

/* 读一份 `--no-judge` 产出的 JSONL，把 `ref` / `judged` / `loss` 补上。
 *
 * 这一段**不依赖我们的引擎**，所以可以整段搬到另一台机器上跑 —— 这正是
 * 把两台机器的算力合起来用的方式（分析必须用 Swift，裁判谁跑都行）。
 * 已带 `ref` 的记录会原样透传（续跑安全）。 */
async function runJudge(cfg) {
  if (!cfg.input) throw new Error('judge 模式需要 --in <分析结果.jsonl>');
  const lines = fs.readFileSync(cfg.input, 'utf8').split('\n').filter((l) => l.trim());
  const [si, sn] = (cfg.shard || '0/1').split('/').map(Number);
  let judge = makeJudge(cfg);
  await judge.init();
  const sink = new Sink(cfg.out, cfg.fresh);
  let did = 0, skipped = 0;
  const t0 = Date.now();
  for (let i = 0; i < lines.length; i++) {
    if (sn > 1 && i % sn !== si) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch (e) { continue; }
    if (sink.has(rec.key)) { skipped++; continue; }
    if (rec.ref) { sink.write(rec); continue; }          // 已经判过
    /* 同样要逐条包 try：裁判会因为「局面非法」自杀，一个坏局面不能废掉整批。
       （quality 模式里加了这层，judge 模式一开始漏了 —— 实测整批 600 条被一个非法局面
       直接终止在 12 个 worker 全部退出码 1。） */
    try {
      const refT = Date.now();
      const ref = await judge.analyze(rec.fen, cfg.refDepth, 1);
      rec.ref = { move: ref.best, score: ref.score, depth: ref.depth, ms: Date.now() - refT };
      const parts = rec.fen.split(' ');
      for (const d of Object.keys(rec.ours || {})) {
        const o = rec.ours[d];
        if (!o || !o.move || !/^[a-i][0-9][a-i][0-9]$/.test(o.move)) continue;
        const b = XQ.parseBoard(parts[0]);
        const side = parts[1] === 'b' ? 'b' : 'r';
        XQ.makeMove(b, fromUci(o.move));
        const after = await judge.analyze(XQ.boardToString(b) + ' ' + XQ.other(side), cfg.refDepth, 1);
        o.judged = -after.score;
        o.sameAsRef = o.move === ref.best;
        o.loss = ref.score - o.judged;
      }
    } catch (e) {
      rec.error = (rec.error ? rec.error + ' / ' : '') + e.message;
      process.stderr.write('[judge ' + si + '] ' + String(rec.tag || rec.key).slice(0, 30)
        + ' 出错：' + e.message.slice(0, 110) + '\n');
      try { judge.quit(); } catch (x) { /* */ }
      try { judge = makeJudge(cfg); await judge.init(); } catch (x) { /* */ }
    }
    sink.write(rec);
    did++;
    if (did % 20 === 0 || Date.now() - t0 > 60000) {
      process.stderr.write('[judge ' + si + '] ' + did + ' 条  用时 '
        + ((Date.now() - t0) / 1000).toFixed(0) + 's\n');
    }
  }
  judge.quit();
  sink.close();
  process.stderr.write('[judge ' + si + '] 完成：判了 ' + did + '，跳过 ' + skipped + '\n');
}

/* ---------- 主入口 ---------- */

async function main() {
  const cfg = parseArgs(process.argv);
  const run = () => (cfg.mode === 'judge' ? runJudge(cfg) : runWorker(cfg));
  if (cfg.worker) return run();
  if (!cfg.out) throw new Error('必须给 --out');
  if (!['quality', 'library', 'judge'].includes(cfg.mode)) {
    throw new Error('mode 只能是 quality / library / judge');
  }

  const total = cfg.mode === 'judge'
    ? (cfg.input ? fs.readFileSync(cfg.input, 'utf8').split('\n').filter((l) => l.trim()).length : 0)
    : buildJobs(cfg).length;
  process.stdout.write('工作项 ' + total + ' 个（mode=' + cfg.mode
    + '  depth=' + cfg.depth + '  multipv=' + cfg.multipv + '  jobs=' + cfg.jobs
    + (cfg.noJudge ? '  仅分析（不判分）' : '') + '）\n');

  if (cfg.jobs <= 1) {
    cfg.shard = '0/1';
    return run();
  }
  const parts = [];
  const kids = [];
  await new Promise((resolve, reject) => {
    let left = cfg.jobs;
    for (let i = 0; i < cfg.jobs; i++) {
      const p = cfg.out + '.part' + i;
      parts.push(p);
      const args = process.argv.slice(2).concat(['--worker', '--shard', i + '/' + cfg.jobs,
                                                 '--shardout', p]);
      /* fork 必须保留 ipc 槽位：显式给 stdio 时漏掉 'ipc' 会直接抛
         ERR_CHILD_PROCESS_IPC_REQUIRED（不用 IPC 消息也要留着这一格）。 */
      const k = fork(__filename, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      kids.push(k);
      k.on('exit', (code) => {
        if (code !== 0) { reject(new Error('worker ' + i + ' 退出码 ' + code)); return; }
        if (--left === 0) resolve();
      });
    }
  }).catch((e) => { kids.forEach((k) => { try { k.kill(); } catch (x) { /* */ } }); throw e; });

  /* 合并分片。**先确认真的有内容再动主文件** —— 原来无条件 `flags: 'w'`，
     一旦分片是空的（比如上面那个参数名 bug），就会把主文件直接截断成 0 字节，
     跑了半小时的数据一声不响地没了。 */
  let mergedBytes = 0;
  const bufs = [];
  for (const p of parts) {
    if (!fs.existsSync(p)) { bufs.push(null); continue; }
    const b = fs.readFileSync(p);
    mergedBytes += b.length;
    bufs.push(b);
  }
  if (mergedBytes === 0) {
    throw new Error('所有分片都是空的，拒绝覆盖 ' + cfg.out
      + '（主文件里可能有上一次的成果）');
  }
  const out = fs.createWriteStream(cfg.out, { flags: 'w' });
  for (const b of bufs) if (b) out.write(b);
  await new Promise((r) => out.end(r));
  for (const p of parts) { try { fs.unlinkSync(p); } catch (e) { /* */ } }
  process.stdout.write('合并完成 → ' + cfg.out + '（' + mergedBytes + ' 字节）\n');
}

main().catch((e) => {
  process.stderr.write('失败: ' + e.stack + '\n');
  process.exit(1);
});
