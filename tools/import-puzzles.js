#!/usr/bin/env node
'use strict';
/* 把公开题库导入成本项目的 library.json 格式。
 *
 *   node tools/import-puzzles.js fetch                 # 下载源题库到 shared/external/
 *   node tools/import-puzzles.js audit [--json]        # 审计：能转多少、多少非法、多少重复
 *   node tools/import-puzzles.js solve --out F.jsonl [--shard i/N] [--limit N] [--sets A,B]
 *   node tools/import-puzzles.js emit  --in F1.jsonl,F2.jsonl [--dry]
 *
 * ## 数据来源与许可
 *
 * 源：`dffge552/xiangqi-pwa-offline`（棋弈江湖），**MIT License**。
 * 含 basic/advanced-checkmates、梦入神机、适情雅趣、江湖残局等共 1884 个局面。
 * 《梦入神机》《适情雅趣》是明代古谱（公版）；仓库自身声明 MIT。
 * ⚠️ 该仓库 Acknowledgments 提到部分残局来自「从寬象棋」YouTube 频道 ——
 *    要对外经营的话，这一条的权属最好自己确认一次（见 docs/puzzle-sources.md）。
 *
 * ## 为什么"外部题库不给解法"反而是好事
 *
 * 外部只给局面（FEN）和名字，`bestMove` 字段是空的。所以解法由**我们自己的引擎**
 * 离线算出来 —— 是我们自己的产出，不存在"解法是否受版权保护"的问题；
 * 而且口径与 tools/gen-lines.js 一致：双方都走引擎首选，
 * 得到的是"最顽强防守下仍然成立的最短杀法"。
 *
 * ## 三个必须显式处理的差异
 *
 * 1. **FEN 方言不同**：外部用标准 FEN（连续空格压缩成数字，`3a5`），
 *    我们的 parseBoard 逐格取字符 —— 直接喂 `3a5` 会把 '3' 当成棋子**且不报错**。
 *    必须过一遍 stdFenToInternal()。
 * 2. **走子方**：标准 FEN 用 w/b。杀法练习假定**红先**，所以黑先的局面不进 mates。
 * 3. **合法性**：外部确实有非法局面（黑卒在自己底线、红兵在第 9 行、象不在象位）。
 *    这些在 Pikafish 那边会**直接让进程退出**，必须提前剔掉。
 *
 * ## 手数从哪来（这里踩过一次）
 *
 * 一开始我用"数线路长度"来定 mateIn —— 但线路长度取决于引擎在**每一步**的深度，
 * 深不到就看不到杀，红方会走出一手不杀的棋，线路因此被人为拉长，mateIn 偏大。
 * 正确做法：引擎的杀棋分是 `MATE - ply`（见 web/js/engine.js 的 `-MATE + ply`），
 * **从分数直接读出手数**，再用"线路长度是否等于 2*mateIn-1"去校验路线是否最优。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const PC = require(path.join(ROOT, 'tools/lib/position-check.js'));

const EXT_DIR = path.join(ROOT, 'shared/external');
const LIB_PATH = path.join(ROOT, 'shared/library.json');

const REPO = 'dffge552/xiangqi-pwa-offline';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/main/';

/* 题型 → 我们库里的归属。mate = 有杀，能进 mates；endgame = 残局，另说。 */
const SOURCES = [
  { file: 'basic-checkmates.json', set: '基本杀法', kind: 'mate' },
  { file: 'advanced-checkmates.json', set: '进阶杀法', kind: 'mate' },
  { file: 'meng-ru-shen-ji.json', set: '梦入神机', kind: 'mate' },
  { file: 'shi-qing-ya-qu.json', set: '适情雅趣', kind: 'mate' },
  { file: 'jianghu-endgames.json', set: '江湖残局', kind: 'endgame' },
  { file: 'extremely-challenging-endgames.json', set: '极难残局', kind: 'endgame' },
];

function get(k, d) {
  const a = process.argv;
  const i = a.indexOf('--' + k);
  return i >= 0 && i + 1 < a.length ? a[i + 1] : d;
}
function has(k) { return process.argv.includes('--' + k); }

/* ---------- fetch ---------- */

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        const n = fs.statSync(tmp).size;
        fs.renameSync(tmp, dest);
        resolve(n);
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchAll() {
  fs.mkdirSync(EXT_DIR, { recursive: true });
  for (const s of SOURCES) {
    const dest = path.join(EXT_DIR, s.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000 && !has('force')) {
      console.log('  跳过 ' + s.file + '（已存在 ' + fs.statSync(dest).size + ' 字节；要重下加 --force）');
      continue;
    }
    const n = await download(RAW + s.file, dest);
    console.log('  ' + s.file.padEnd(38) + n + ' 字节');
  }
  console.log('\n已下载到 ' + path.relative(ROOT, EXT_DIR));
}

/* ---------- 统一加载 + 清洗（纯数据转换，不搜索） ---------- */

function loadCandidates() {
  const ownKeys = new Set();
  const lib = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
  for (const sec of ['mates', 'studies']) {
    for (const it of lib[sec]) {
      if (!it.fen) continue;
      try {
        const c = PC.stdFenToInternal(it.fen + ' r');
        ownKeys.add(PC.positionKey(c.board, c.side));
      } catch (e) { /* 现有库里本来就有的问题条目 */ }
    }
  }

  const seen = new Set();
  const bad = [];
  const stats = [];
  const cands = [];
  for (const s of SOURCES) {
    const p = path.join(EXT_DIR, s.file);
    if (!fs.existsSync(p)) { console.error('缺少 ' + s.file + '，先跑 fetch'); continue; }
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = { set: s.set, kind: s.kind, n: 0, badFen: 0, illegal: 0, dup: 0, dupOwn: 0, redToMove: 0, ok: 0 };
    for (const item of arr) {
      r.n++;
      let conv;
      try { conv = PC.stdFenToInternal(item.fen); }
      catch (e) { r.badFen++; bad.push({ set: s.set, name: item.name, fen: item.fen, why: 'FEN 解析失败：' + e.message }); continue; }
      const key = PC.positionKey(conv.board, conv.side);
      if (seen.has(key)) { r.dup++; continue; }
      seen.add(key);
      if (ownKeys.has(key)) { r.dupOwn++; continue; }
      const probs = PC.check(conv.fen);
      if (probs.length) { r.illegal++; bad.push({ set: s.set, name: item.name, fen: conv.fen, why: probs[0] }); continue; }
      if (conv.side === 'r') r.redToMove++;
      r.ok++;
      cands.push({ key, fen: conv.fen, board: conv.board, side: conv.side, name: item.name, set: s.set, kind: s.kind });
    }
    stats.push(r);
  }
  return { stats, cands, bad };
}

/* ---------- audit ---------- */

function audit() {
  const { stats, cands, bad } = loadCandidates();
  const W = [16, 6, 6, 6, 6, 8, 6, 6];
  const head = ['题库', '总数', 'FEN坏', '非法', '重复', '与库重', '红先', '可用'];
  console.log('=== 外部题库审计（源：' + REPO + ' MIT）===\n');
  console.log('  ' + head.map((h, i) => h.padEnd(W[i])).join(''));
  console.log('  ' + '-'.repeat(W.reduce((a, b) => a + b, 0)));
  const tot = { n: 0, badFen: 0, illegal: 0, dup: 0, dupOwn: 0, redToMove: 0, ok: 0 };
  for (const r of stats) {
    console.log('  ' + [r.set, r.n, r.badFen, r.illegal, r.dup, r.dupOwn, r.redToMove, r.ok]
      .map((v, i) => String(v).padEnd(W[i])).join(''));
    for (const k of Object.keys(tot)) tot[k] += r[k] || 0;
  }
  console.log('  ' + '-'.repeat(W.reduce((a, b) => a + b, 0)));
  console.log('  ' + ['合计', tot.n, tot.badFen, tot.illegal, tot.dup, tot.dupOwn, tot.redToMove, tot.ok]
    .map((v, i) => String(v).padEnd(W[i])).join(''));
  console.log('');
  console.log('  通过合法性校验 ' + tot.ok + ' / ' + tot.n
    + '（' + (tot.ok / tot.n * 100).toFixed(1) + '%）');
  const mateRed = cands.filter((c) => c.kind === 'mate' && c.side === 'r').length;
  const endgame = cands.filter((c) => c.kind === 'endgame').length;
  console.log('  **可直接进 mates（杀法类 + 红先）**：' + mateRed + ' 条   ← 现在库里只有 '
    + JSON.parse(fs.readFileSync(LIB_PATH, 'utf8')).mates.length + ' 条');
  console.log('  残局类（需另做必胜/必和判定，见文末）：' + endgame + ' 条');
  console.log('');
  console.log('=== 被判非法/无法解析（前 10）===');
  for (const b of bad.slice(0, 10)) {
    console.log('  [' + b.set + '] ' + String(b.name).slice(0, 24));
    console.log('      ' + b.fen);
    console.log('      → ' + b.why);
  }
  if (has('json')) {
    fs.writeFileSync('/tmp/xq-import-audit.json', JSON.stringify({ stats, bad }, null, 1));
    console.log('\n完整清单已写 /tmp/xq-import-audit.json');
  }
}

/* ---------- solve ---------- */

const MAX_PLY = 30;

/* 从引擎的杀棋分读出手数。杀棋分是 MATE - plies，见 engine.js 的 `-MATE + ply`。 */
function mateInOfScore(score) {
  if (score > XQ.MATE - 1000) return Math.ceil((XQ.MATE - score) / 2);
  if (score < -XQ.MATE + 1000) return -Math.ceil((XQ.MATE + score) / 2);
  return 0;
}

/* 双方都走引擎首选，得到"最顽强防守下的最短杀法"（与 tools/gen-lines.js 同口径）。
 *
 * 返回到 `ok` 的四个条件，缺一条这条路线就不能给学生看：
 *   ① 走子方**每一步**都看得到杀棋分（否则它只是"碰巧赢"）
 *   ② 对手**每一步**都是引擎首选（否则不是最顽强防守）
 *   ③ 最终局面确实无合法着法（真成杀）
 *   ④ 线路长度 === 2*mateIn-1（说明路线是最优的，没被浅深度拉长）
 */
function solveLine(fen, side, depth, budget) {
  const b = XQ.parseBoard(fen.split(' ')[0]);
  let s = side;
  const steps = [];
  let mateIn = 0;
  let reason = '';
  for (let i = 0; i < MAX_PLY; i++) {
    if (!XQ.hasLegalMove(b, s)) break;
    XQ.resetSearch();
    const r = XQ.searchRoot(b, s, depth, budget);
    if (!r.move) { reason = '无着法'; break; }
    if (s === side) {
      const d = mateInOfScore(r.score);
      if (d <= 0) { reason = '深度内看不到杀棋（d=' + r.depth + '）'; break; }
      if (i === 0) mateIn = d;
    } else if (mateInOfScore(r.score) > 0) {
      /* 轮到黑方时，score 是**黑方视角**的。它看到杀棋分 > 0 就意味着
         红方要被反杀 —— 这条"杀法路线"是假的，丢掉。
         ⚠️ 判据必须是 `> 0`：mateInOfScore 在"看不到杀棋"时返回 0，
         写成 `>= 0` 会让**每一局**都在这里被误判成"对手有反杀"。 */
      reason = '对手有反杀';
      break;
    }
    const label = XQ.moveLabel(b, r.move);
    XQ.makeMove(b, r.move);
    const oppStuck = !XQ.hasLegalMove(b, XQ.other(s));
    steps.push({ side: s, label, score: r.score, depth: r.depth, mate: oppStuck });
    s = XQ.other(s);
    if (oppStuck) break;
  }
  const finished = !XQ.hasLegalMove(b, s);
  const mateStep = steps.find((x) => x.mate);
  const optimal = mateIn > 0 && steps.length === 2 * mateIn - 1;
  const ok = finished && !!mateStep && mateStep.side === side && mateIn > 0 && optimal;
  if (!ok && !reason) {
    reason = !finished ? '未走到死局'
      : (!mateStep ? '没有成杀着法' : (mateStep.side !== side ? '是对方成杀' : '路线不是最短（' + steps.length + ' 步 vs 最优 ' + (2 * mateIn - 1) + ' 步）'));
  }
  return { ok, steps, mateIn: ok ? mateIn : 0, reason, reachedDepth: steps.length ? steps[0].depth : 0 };
}

function runSolve() {
  const out = get('out', null);
  if (!out) throw new Error('必须给 --out');
  const depth = parseInt(get('depth', '9'), 10);
  const budget = parseInt(get('budget', '8000'), 10);
  const limit = parseInt(get('limit', '0'), 10);
  const shard = (get('shard', '0/1')).split('/').map(Number);
  const setFilter = get('sets', null);

  let { cands } = loadCandidates();
  /* 只解"红先的杀法题"：杀法练习假定用户执红。黑先的局面留着不动。 */
  cands = cands.filter((c) => c.kind === 'mate' && c.side === 'r');
  if (setFilter) {
    const want = setFilter.split(',');
    cands = cands.filter((c) => want.indexOf(c.set) >= 0);
  }
  const total = cands.length;
  if (shard[1] > 1) cands = cands.filter((c, i) => i % shard[1] === shard[0]);
  if (limit > 0) cands = cands.slice(0, limit);

  /* 用 openSync + writeSync + fsyncSync，**不要**用 createWriteStream().fd ——
     首写时那个 fd 还是 null（流还没 open），会直接抛 TypeError（踩过）。 */
  const fd = fs.openSync(out, 'a');
  const t0 = Date.now();
  let done = 0, solved = 0;
  const reasons = {};
  for (const c of cands) {
    const t = Date.now();
    let res;
    try { res = solveLine(c.fen, 'r', depth, budget); }
    catch (e) { res = { ok: false, steps: [], mateIn: 0, reason: '异常：' + e.message }; }
    const rec = {
      key: c.key, fen: c.fen, name: c.name, set: c.set,
      ok: res.ok, mateIn: res.mateIn,
      line: res.ok ? res.steps.map((s) => s.label) : [],
      lineSides: res.ok ? res.steps.map((s) => (s.side === 'r' ? 'red' : 'black')) : [],
      solvePlies: res.ok ? res.steps.length : 0,
      reachedDepth: res.reachedDepth,
      failReason: res.ok ? '' : res.reason,
      ms: Date.now() - t,
    };
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
    /* 落盘排在打印之前 —— 反过来的话，一次崩溃可能出现"屏幕上看到了、文件里没有" */
    fs.fsyncSync(fd);
    if (!rec.ok) reasons[rec.failReason] = (reasons[rec.failReason] || 0) + 1;
    done++; if (rec.ok) solved++;
    const elapsed = (Date.now() - t0) / 1000;
    const eta = done ? (elapsed / done * (cands.length - done)) : 0;
    console.log((rec.ok ? 'PASS' : 'FAIL') + ' ' + String(done).padStart(4) + '/' + cands.length
      + '  ' + (rec.ok ? ('杀' + rec.mateIn + '手  ' + rec.line.join(' ').slice(0, 44))
        : ('未通过：' + rec.failReason))
      + '  [' + c.set + '] ' + String(c.name).slice(0, 18)
      + '  ' + (rec.ms / 1000).toFixed(1) + 's  ETA ' + Math.round(eta / 60) + 'min');
  }
  fs.closeSync(fd);
  console.log('\n分片 ' + shard[0] + '/' + shard[1] + '：候选 ' + total + '，本片 ' + done
    + '，通过 ' + solved + '（' + (done ? (solved / done * 100).toFixed(1) : '0') + '%），耗时 '
    + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒 → ' + out);
  if (Object.keys(reasons).length) {
    console.log('未通过原因：');
    for (const k of Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a])) {
      console.log('  ' + String(reasons[k]).padStart(5) + '  ' + k);
    }
  }
}

/* ---------- emit ---------- */

function runEmit() {
  const inp = get('in', null);
  if (!inp) throw new Error('必须给 --in（多个文件用逗号分隔）');
  const dry = has('dry');
  const lib = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
  let solved = [];
  for (const f of inp.split(',')) {
    solved = solved.concat(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
  }
  /* **按 key 排序再编号** —— 分片跑出来的顺序取决于哪片先跑完，
     不排序的话同一批数据两次 emit 会得到不同的 id，测试没法断言。 */
  solved.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const have = new Set(lib.mates.map((m) => {
    try { const c = PC.stdFenToInternal(m.fen + ' r'); return PC.positionKey(c.board, c.side); }
    catch (e) { return 'bad:' + m.id; }
  }));
  const haveIds = new Set(lib.mates.map((m) => m.id));

  let n = 0, skippedFail = 0, skippedDup = 0;
  const added = [];
  for (const r of solved) {
    if (!r.ok) { skippedFail++; continue; }
    if (have.has(r.key)) { skippedDup++; continue; }
    have.add(r.key);
    let id;
    do { n++; id = 'x' + String(n).padStart(4, '0'); } while (haveIds.has(id));
    haveIds.add(id);
    /* 名字去掉尾部的" - 题库名"，只留题名 */
    const nm = String(r.name).replace(/\s*[-–]\s*[^-–]*$/, '').trim();
    added.push({
      id, name: nm || r.set, set: r.set,
      tier: r.mateIn <= 1 ? 1 : (r.mateIn <= 2 ? 2 : 3),
      fen: r.fen.split(' ')[0],
      /* 不写 `lineSides`：它是 `line` 的纯派生量（红黑交替、红先），
         而全项目**没有任何地方读它**（web 和 iOS 都不读，只有 gen-lines 写）。
         实测它占整个库的 21.8%（35 KB / 162 KB）—— 白占体积。
         手写那 11 道保留它，是为了不动 gen-lines.js 的既有输出。 */
      line: r.line, solvePlies: r.solvePlies, mateIn: r.mateIn,
    });
  }
  console.log('读入 ' + solved.length + ' 条 → 写入 ' + added.length
    + '（未通过 ' + skippedFail + '，库里已有同局面 ' + skippedDup + '）');
  const bySet = {}, byTier = {};
  for (const a of added) {
    bySet[a.set] = (bySet[a.set] || 0) + 1;
    byTier[a.tier] = (byTier[a.tier] || 0) + 1;
  }
  for (const k of Object.keys(bySet)) console.log('  ' + k.padEnd(12) + bySet[k]);
  console.log('  按杀法手数 tier：' + Object.keys(byTier).sort().map((t) => t + ':' + byTier[t]).join('  ')
    + '（1=一步杀 2=两步杀 3=三步及以上）');
  if (dry) { console.log('（--dry，未写回）'); return; }
  if (!added.length) { console.log('没有可写入的条目，拒绝改 library.json'); return; }

  lib.mates = lib.mates.concat(added);
  lib.note = '中国象棋棋谱库。杀法局的 line 是由引擎离线算出的最短杀法路线（双方均走最强）：'
    + 'm* 由 tools/gen-lines.js 生成；x* 由 tools/import-puzzles.js 从公开题库（MIT）导入并计算。';
  fs.writeFileSync(LIB_PATH, JSON.stringify(lib, null, 2) + '\n');
  console.log('已写回 shared/library.json（mates ' + (lib.mates.length - added.length)
    + ' → ' + lib.mates.length + '）');
  console.log('⚠️ 记得跑 tools/sync-library.js 重新生成 web/js/library-data.js');
}

/* ---------- main ---------- */

async function main() {
  const mode = process.argv[2];
  if (mode === 'fetch') return fetchAll();
  if (mode === 'audit') return audit();
  if (mode === 'solve') return runSolve();
  if (mode === 'emit') return runEmit();
  console.log('用法：\n'
    + '  node tools/import-puzzles.js fetch [--force]\n'
    + '  node tools/import-puzzles.js audit [--json]\n'
    + '  node tools/import-puzzles.js solve --out F.jsonl [--shard i/N] [--limit N] [--depth D] [--sets A,B]\n'
    + '  node tools/import-puzzles.js emit --in F1.jsonl,F2.jsonl [--dry]');
  process.exitCode = 2;
}

/* **只有作为入口脚本时才跑 main**。
 * 否则 `require('./import-puzzles.js')` 会把用法打一遍、还把退出码设成 2 ——
 * 测试想引用这里的 mateInOfScore / solveLine 就直接被这颗雷挡住。
 * （同类问题在 tools/check-library.js 上也踩过，那边是把规则抽成 lib 解决的。） */
if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
}

module.exports = { mateInOfScore, solveLine, loadCandidates, SOURCES };
