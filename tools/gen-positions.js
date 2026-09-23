'use strict';
/* 生成「局面清单」，给 tools/precompute.js 的 --positions 用。
 *
 *   node tools/gen-positions.js --out positions.txt --count 600 [--seed 7]
 *
 * 为什么要有这个：质量曲线要按**阶段**分开看（开局段评估弱、杀法段搜索主导，
 * 两段结论经常相反），所以采样必须**分层**，而且必须**可复现** —— 否则两批数据
 * 不可比，而「不可比的跨批次数字」正是这个项目反复踩过的坑。
 *
 * 分层与做法：
 *   开局   2~12 手    25%  从标准开局推
 *   中局  14~40 手    40%  从标准开局推
 *   中后  42~80 手    25%  从标准开局推
 *   残局 82~140 手    10%  从标准开局推（子力自然减少）
 * 另把库里的杀法/残局（战术局面）全部并进来 —— 它们代表另一个极端的分支因子。
 *
 * 多样性靠「前 k 手随机」（种子确定），之后用浅搜索走完 —— 同一 seed 永远同结果。
 */
const fs = require('fs');
const path = require('path');
const XQ = require(path.resolve(__dirname, '../web/js/engine.js'));

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf('--' + k);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : d;
  };
  return {
    out: get('out', '/tmp/positions.txt'),
    count: parseInt(get('count', '600'), 10),
    seed: parseInt(get('seed', '7'), 10),
  };
}

/* mulberry32：小而稳的确定性伪随机 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 推 plies 手：前 randPlies 手从合法着法里随机挑，之后走 2 层搜索 */
function playTo(plies, randPlies, rand) {
  const b = XQ.parseBoard(XQ.START);
  let side = 'r';
  const idx = [];
  for (let i = 0; i < plies; i++) {
    let mv = null;
    const legal = XQ.legalMoves(b, side);
    if (!legal.length) return null;
    if (i < randPlies) {
      mv = legal[(rand() * legal.length) | 0];
    } else {
      XQ.resetSearch();
      const r = XQ.searchRoot(b, side, 2, 30, null, idx);
      mv = r.move || legal[0];
    }
    XQ.makeMove(b, mv);
    idx.push(mv);
    side = XQ.other(side);
  }
  return { board: XQ.boardToString(b), side };
}

const TIERS = [
  { name: '开局', lo: 2, hi: 12, w: 0.25 },
  { name: '中局', lo: 14, hi: 40, w: 0.40 },
  { name: '中后', lo: 42, hi: 80, w: 0.25 },
  { name: '残局', lo: 82, hi: 140, w: 0.10 },
];

const cfg = args();
const rand = rng(cfg.seed);
const rows = [];
const seen = new Set();
const push = (fen, tag) => {
  if (seen.has(fen)) return false;
  seen.add(fen);
  rows.push(fen + '\t' + tag);
  return true;
};

/* 库里的战术局面先放进来（数量少、价值高） */
const lib = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../shared/library.json'), 'utf8'));
for (const sec of ['studies', 'mates']) {
  for (const it of lib[sec]) push(it.fen + ' r', sec + ':' + it.id);
}

let guard = 0;
while (rows.length < cfg.count && guard < cfg.count * 40) {
  guard++;
  const t = TIERS[(rand() * TIERS.length) | 0] || TIERS[1];
  const plies = t.lo + ((rand() * (t.hi - t.lo + 1)) | 0);
  const randPlies = 2 + ((rand() * 10) | 0);
  const g = playTo(plies, randPlies, rand);
  if (!g) continue;
  const fen = g.board + ' ' + g.side;
  /* 终局（无子可动）要跳过 —— 引擎会回 bestmove 0000，下游处理不了 */
  if (!XQ.hasLegalMove(XQ.parseBoard(g.board), g.side)) continue;
  push(fen, t.name + ':' + plies);
}

fs.writeFileSync(cfg.out, rows.join('\n') + '\n');
const byTier = {};
for (const r of rows) {
  const t = r.split('\t')[1].split(':')[0];
  byTier[t] = (byTier[t] || 0) + 1;
}
process.stdout.write('已写出 ' + rows.length + ' 个局面 → ' + cfg.out + '\n');
for (const k of Object.keys(byTier)) process.stdout.write('  ' + k + ': ' + byTier[k] + '\n');
