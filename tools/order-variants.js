/* 生成「排序改动的对照组」引擎副本 —— 用来做「每一项到底值多少」的拆解实验。
 *
 *   node tools/order-variants.js              # 输出到 /tmp/xq-order-variants/
 *   node tools/order-variants.js --out DIR
 *
 * 为什么需要它：
 *   「改完之后节点数少了」只能证明「这一堆改动合起来有用」，不能证明**其中每一项**有用。
 *   P1-2 塞了两样东西 —— SEE 和位置表增量（静态棋理）—— 而且它们的说法不一样：
 *     · SEE 针对的是「亏本吃排在前面」这个具体毛病（中局/残局为主）
 *     · 位置表增量针对的是「开局安静着法排序退化成随机」这个根因
 *   那就得分开量。做法是把正本源码里两处开关各自的**关**版本生成出来，
 *   再用同一台 order-bench 量四份：都不开 / 只开一个 / 都开。
 *
 * 为什么是「生成源码副本」而不是「在引擎里留开关」：
 *   正式代码里留 `if (USE_SEE)` 这种永不改变的常量开关，等于把实验脚手架焊进产品。
 *   这里在测量阶段读源码、做**有限次字符串替换**、写到 /tmp —— 正本一行不动。
 *
 * ⚠️ 替换必须自证次数。写错一个字，String.replace 会「一次都没替换」却**不报错**，
 *   于是四个变体其实是同一份代码，四个数字一模一样 —— 看起来像「改动无效」。
 *   所以下面每处替换都断言「恰好命中 1 次」。
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const SRC = path.join(__dirname, '..', 'web', 'js', 'engine.js');

let OUT = '/tmp/xq-order-variants';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i] === '--out') OUT = path.resolve(argv[++i]);

const source = fs.readFileSync(SRC, 'utf8');

/** 断言「恰好替换 1 次」—— 没替换到和替换到多处都是错误 */
function patch(text, from, to, label) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`替换失败：${label} —— 源码里命中 ${n} 处（应为 1 处）：${JSON.stringify(from)}`);
  return text.replace(from, to);
}

/* 可用的替换原料。每一条都是「正本 → 变体」的单向改写。 */
const P = {
  pstOff:  ['var PST_W = 8;', 'var PST_W = 0;'],
  pstW4:   ['var PST_W = 8;', 'var PST_W = 4;'],
  pstW16:  ['var PST_W = 8;', 'var PST_W = 16;'],
  pstW32:  ['var PST_W = 8;', 'var PST_W = 32;'],
  seeOff:  ['if (capVal >= attVal || ply > SEE_MAX_PLY) {', 'if (true) {'],
  /* 反过来：把 ply 门控拆掉，退回「整棵树都算 SEE」。
     这一版**实测劣于不改**（150 个随机局面 300ms 平均深度 14:3 落后，中局每千节点/秒掉 19%），
     所以门控是正本的一部分。留这个变体是为了随时能复现那条否定结论。 */
  seeAll:  ['if (capVal >= attVal || ply > SEE_MAX_PLY) {', 'if (capVal >= attVal) {'],
  /* 把「将/帅也算攻击者」**加回去**（正本里是**不算**的）。
     将的吃回常常是**非法**的（那个格子被自己人挡住时将在原地就违规，或者格子另外被守住），
     但 SEE 不知道这些，于是把很多正常吃子算成 -60000 级的巨亏、再打到安静着法后面去 ——
     实测这就是 SEE 单独用反而变慢的原因。
     注意方向：正本已经不含将/帅，所以这个补丁是**反向**的（加回去），不是「关掉」。 */
  withKing:['两端必须同一套算法。 */\n    return null;',
            "两端必须同一套算法。 */\n"
          + "    var kc = red ? 'K' : 'k';\n"
          + "    for (i = 0; i < 4; i++) {\n"
          + "      var kr = r + DIR4[i][0], kcl = c + DIR4[i][1];\n"
          + "      if (kr < 0 || kr > 9 || kcl < 3 || kcl > 5) continue;\n"
          + "      if (red ? (kr < 7) : (kr > 2)) continue;\n"
          + "      if (b[kr * 9 + kcl] === kc) return { from: kr * 9 + kcl, value: 60000 };\n"
          + "    }\n"
          + "    return null;"],
  /* 只把 SEE 用在「吃子之间排序」，不把亏本吃降到安静着法之后 */
  rankOnly:['s = see >= 0 ? SCORE_GOOD_CAP + mvv : SCORE_BAD_CAP + see;',
            's = SCORE_GOOD_CAP + (see >= 0 ? mvv : see);'],
  noCap:   ['var HIST_CAP = 4096;', 'var HIST_CAP = 0;'],
  bigCap:  ['var HIST_CAP = 4096;', 'var HIST_CAP = 1000000;'],
};

function build(patches) {
  let t = source;
  for (const [from, to] of patches) t = patch(t, from, to, JSON.stringify(from).slice(0, 40));
  return t;
}

/* 注：这一批在「排除将/帅」和「SEE 只用浅层」成为**正本默认**之后清理过一次 ——
   原来的 see_nk / both_nk / both_nkrk 变成了「和正本一样」（那两个行为已经在正本里），
   留着只会让人以为它们在测不同的东西。现在是「正本 = shipped」+ 各个方向的偏离。 */
const VARIANTS = [
  { name: 'legacy',   patches: [P.pstOff, P.seeOff], note: '两项都关 —— 等价于改之前的排序' },
  { name: 'pst',      patches: [P.seeOff],           note: '只开位置表增量（SEE 关掉）' },
  { name: 'see',      patches: [P.pstOff],           note: '只开（浅层）SEE' },
  { name: 'shipped',  patches: [],                   note: '★ 正本：位置表增量 + 浅层 SEE' },
  { name: 'seeAll',   patches: [P.seeAll],           note: '整棵树都算 SEE —— 实测劣于不改' },
  { name: 'withKing', patches: [P.withKing],         note: '把将/帅算回攻击者 —— 实测更慢' },
  { name: 'see_rk',   patches: [P.pstOff, P.rankOnly], note: '只开 SEE，且只排序不降级' },
  { name: 'both_rk',  patches: [P.rankOnly],         note: '位置表增量 + SEE（只排序不降级）' },
  { name: 'w4',       patches: [P.pstW4],            note: '位置表增量权重减半' },
  { name: 'w16',      patches: [P.pstW16],           note: '位置表增量权重加倍' },
  { name: 'w32',      patches: [P.pstW32],           note: '位置表增量权重四倍' },
  { name: 'cap0',     patches: [P.noCap],            note: '历史分不许封顶（位置表增量会被压掉）' },
  { name: 'capbig',   patches: [P.bigCap],           note: '历史分上限放到很大（等于不封顶）' },
];

fs.mkdirSync(OUT, { recursive: true });

console.log(`正本：${SRC}（${source.length} 字节）`);
console.log(`输出：${OUT}`);
console.log();

const digests = new Map();
for (const v of VARIANTS) {
  const text = build(v.patches);
  fs.writeFileSync(path.join(OUT, `${v.name}.js`), text);
  /* 用内容摘要做指纹，不用字节数：`var PST_W = 8; → 0;` 长度一模一样，
     只比字节数会把「开了 PST」和「没开 PST」看成同一份。 */
  digests.set(v.name, crypto.createHash('sha256').update(text).digest('hex').slice(0, 12));
  console.log(`  ${v.name.padEnd(9)} ${String(text.length).padStart(7)} 字节  ${digests.get(v.name)}  ${v.note}`);
}

/* 自证 1：每个变体必须是内容不同的一份代码。
   这一步拦的是「替换没命中」—— String.replace 一次都没替换时不报错，
   结果是十几个变体其实是同一份代码、十几个一模一样的数字，
   看起来像「这些改动都无效」。 */
if (new Set(digests.values()).size !== VARIANTS.length) {
  const dup = [...digests.entries()].filter(([k, d]) => [...digests.values()].filter(x => x === d).length > 1);
  console.error(`\n自证失败：变体内容有重复 —— ${JSON.stringify(dup)}。某处替换没生效。`);
  process.exit(1);
}

/* 判断「这个变体把 SEE 关掉了吗」必须看补丁的**目标值**（`if (true) {`），
   不能看来源串 —— P.seeOff 与 P.seeAll 的来源串是同一个（都从 ply 门控那行出发），
   按来源串判断会把 seeAll（SEE 开得更宽）误判成「关掉了 SEE」，
   于是自证检查会对着一个正确的变体报错。 */
const hasPatch = (v, p) => v.patches.some(x => x[1] === p[1]);

/* 自证 2：真加载一遍，确认每个变体都能跑、并且开关状态与预期一致 */
const probe = new Map();
for (const v of VARIANTS) {
  const XQ = require(path.join(OUT, `${v.name}.js`));
  const b = XQ.parseBoard(XQ.START);
  XQ.resetSearch();
  const r = XQ.searchRoot(b, 'r', 5, 60000, null, null);
  probe.set(v.name, { nodes: r.nodes, score: r.score, see: XQ.seeCalls() });
}
console.log();
console.log('自证：标准开局深度 5');
for (const v of VARIANTS) {
  const s = probe.get(v.name);
  console.log(`  ${v.name.padEnd(9)} 节点 ${String(s.nodes).padStart(8)}　SEE 调用 ${String(s.see).padStart(7)} 次　分数 ${s.score}`);
}
if (probe.get('legacy').nodes === probe.get('shipped').nodes) {
  console.error('\n自证失败：legacy 与 shipped（正本）的节点数完全相同 —— 改动对搜索没有任何影响，先查替换');
  process.exit(1);
}
for (const v of VARIANTS) {
  const seeExpectedOn = !hasPatch(v, P.seeOff);
  const got = probe.get(v.name).see;
  if (seeExpectedOn && got === 0) {
    console.error(`\n自证失败：${v.name} 应该是开着 SEE 的，却一次都没调用`);
    process.exit(1);
  }
  if (!seeExpectedOn && got !== 0) {
    console.error(`\n自证失败：${v.name} 应该关掉了 SEE，却调用了 ${got} 次`);
    process.exit(1);
  }
}
/* 自证 3：每一处「想验证的替换」都必须真的改变了节点数 ——
   否则那两个变体其实是重复测量，对比出来的「无差别」是假的。 */
const MUST_DIFFER = [
  ['legacy', 'pst'], ['legacy', 'see'],
  ['shipped', 'seeAll'], ['shipped', 'withKing'], ['shipped', 'see_rk'],
  ['shipped', 'w4'], ['shipped', 'w16'], ['shipped', 'w32'],
];
for (const [a, b] of MUST_DIFFER) {
  if (probe.get(a).nodes === probe.get(b).nodes) {
    console.error(`\n自证失败：${a} 与 ${b} 节点数相同 —— 那一处替换没有影响到排序，两个数字是重复测量`);
    process.exit(1);
  }
}
/* 硬约束：排序只许变快，不许变分 */
const sc = new Set([...probe.values()].map(x => x.score));
if (sc.size !== 1) {
  console.error(`\n⚠️ 变体之间分数不一致（${[...sc].join(' / ')}）—— 排序不该改变搜索结果，这是 bug`);
  process.exit(1);
}
console.log('  （分数全部一致 ✓ —— 排序只改变了搜索的**速度**，没有改变它的**答案**）');
console.log();
console.log('下一步：node tools/order-ab.js');
