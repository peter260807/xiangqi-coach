#!/usr/bin/env node
/* 把古谱名局并入 shared/library.json 的 classics 字段。
 *
 * 为什么单独拿出来：名局的着法序列是「史料」，不能靠引擎算出来，
 * 只能人肉录入。录入难免有误，所以本脚本会**逐手用引擎校验合法性**，
 * 并且要求最后一手确实构成将死 —— 任何一条不过关就直接报错退出，
 * 不会把可疑的棋谱写进库里去教人。
 *
 * 运行：node tools/add-classics.js
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const XQ = require(path.join(root, 'web/js/engine.js'));
const jsonPath = path.join(root, 'shared', 'library.json');

/* 名局数据。line 为空格分隔的中文棋谱着法，红先。 */
const CLASSICS = [
  {
    id: 'c1',
    name: '弃马十三着',
    source: '《橘中秘》全局谱·第一局',
    desc: '中国象棋最有名的一局入门谱。红方中炮直车，故意让右马被吃，'
        + '换来车炮联手直捣九宫，第十三回合以重炮成杀。'
        + '全谱只有十三着，却很完整地演示了「弃子抢先」的思路。',
    line: '炮二平五 炮8平5 马二进三 马8进7 车一进一 车9平8 '
        + '车一平六 车8进6 车六进七 马2进1 车九进一 炮2进7 '
        + '炮八进五 马7退8 炮五进四 士6进5 车九平六 将5平6 '
        + '前车进一 士5退4 车六平四 炮5平6 车四进六 将6平5 炮八平五',
    highlights: [
      { ply: 12, text: '炮2进7 吃马 —— 黑方看着是白得一子，其实正落进红方的圈套。这就是「弃马」的由来。' },
      { ply: 13, text: '炮八进五 —— 弃马之后立刻反扑，炮沉底线，黑方右翼整条防线被牵住。' },
      { ply: 19, text: '前车进一 —— 弃车砍士，硬砸九宫。这一步是全谱的杀着起点。' },
      { ply: 23, text: '车四进六 —— 车压将门，黑将已被赶到中路，双车一炮形成合围。' },
      { ply: 25, text: '炮八平五 —— 重炮照将，黑方无解，第十三着成杀。' }
    ]
  }
];

/* ---------- 校验 ---------- */

let failed = 0;
const verified = [];

for (const c of CLASSICS) {
  const tokens = c.line.trim().split(/\s+/);
  let b = XQ.parseBoard(XQ.START);
  let side = 'r';
  const problems = [];

  tokens.forEach(function (t, i) {
    if (!XQ.hasLegalMove(b, side)) {
      problems.push('第 ' + (i + 1) + ' 着之前' + (side === 'r' ? '红' : '黑') + '方已无子可动');
      return;
    }
    const m = XQ.findMoveByLabel(b, side, t);
    if (!m) {
      problems.push('第 ' + (i + 1) + ' 着「' + t + '」不合法');
      return;
    }
    XQ.makeMove(b, m);
    side = XQ.other(side);
  });

  if (problems.length === 0) {
    const mated = !XQ.hasLegalMove(b, side);
    const checked = XQ.inCheck(b, side);
    if (!mated) problems.push('走完全谱后对方仍有子可动，名局应当以将死收尾');
    if (!checked) problems.push('最后一着没有将军');
    if (tokens.length % 2 !== 1) problems.push('红先行的话着法总数应为奇数');
  }

  // highlights 里的 ply 不能超出实际着法数
  for (const h of (c.highlights || [])) {
    if (h.ply < 1 || h.ply > tokens.length) problems.push('解说 ply=' + h.ply + ' 超出着法范围');
  }

  if (problems.length) {
    failed++;
    console.log('FAIL ' + c.name + '（' + c.source + '，' + tokens.length + ' 着）');
    problems.forEach(function (p) { console.log('       ' + p); });
  } else {
    console.log('PASS ' + c.name.padEnd(8) + ' ' + String(tokens.length).padStart(2) + ' 着  '
      + '第 ' + Math.ceil(tokens.length / 2) + ' 回合将死  ' + c.source);
    verified.push(Object.assign({}, c, {
      plies: tokens.length,
      mateIn: Math.ceil(tokens.length / 2)
    }));
  }
}

if (failed > 0) {
  console.log('\n有 ' + failed + ' 个名局没通过校验，未写入 library.json');
  process.exit(1);
}

/* ---------- 写入 ---------- */

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const byId = new Map(verified.map(function (c) { return [c.id, c]; }));
const kept = (data.classics || []).filter(function (c) { return !byId.has(c.id); });
data.classics = kept.concat(verified).sort(function (a, b) { return a.id < b.id ? -1 : 1; });

fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
console.log('\n已写入 ' + verified.length + ' 个名局到 shared/library.json');
console.log('下一步：node tools/sync-library.js');
