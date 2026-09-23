#!/usr/bin/env node
/*
 * 对局台并行调度的自证测试。
 *
 * 为什么必须有它：并行版最危险的失败方式是**静默**的。局号派错、落盘顺序乱、
 * worker 卡住，都可能产出一份「看着正常、但局号与局面已经错位」的 gamelog，
 * 而 Elo 照样算得出来、照样给一个像模像样的置信区间。靠肉眼读日志发现不了。
 *
 * 所以这里用两条断言把这条路钉死：
 *
 *   【正面】串行 / 并行 4 路 / 并行 8 路跑同一批局，gamelog 必须**逐字节相同**。
 *           这个测试成立的两个前提缺一不可：
 *             - `--clear-tt`：置换表跨局累积会让结果依赖「前面跑过哪几局」，
 *               不清表时并行（每个 worker 自带空表）与串行必然分叉；
 *             - `--depth`：固定深度与时间无关。用 `--ms` 的话本身就不逐位可复现。
 *
 *   【自证】把其中一份的**一个字节**改掉，比对必须报出差异。
 *           没有这一条，上面的「相同」可能只是因为我的比对根本没在比 ——
 *           一个永远返回「一致」的检查器，比没有检查器更危险。
 *
 * 用法：node tools/test-parallel.js
 * 退出码：0 = 全部通过，1 = 有失败
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MATCH = path.join(__dirname, 'match.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xq-parallel-'));

let pass = 0;
let fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

/* 刻意用很小的批次：这个测试要能在几十秒内跑完，才有人愿意每次都跑。
   一致性不靠局数多，靠 --clear-tt + 固定深度带来的确定性。 */
const BASE = [
  '--a', 'js', '--b', 'js',
  '--depth', '3',
  '--games', '4',
  '--openings', '4', '--open-plies', '8',
  '--random-plies', '3',
  '--max-ply', '40',
  '--clear-tt',
];

const JOBS = Math.min(8, Math.max(2, os.cpus().length));

function runMatch(tag, jobs) {
  const log = path.join(TMP, tag + '.jsonl');
  const args = [MATCH].concat(BASE).concat(['--gamelog', log, '--fresh']);
  if (jobs > 1) args.push('--jobs', String(jobs));
  const t0 = Date.now();
  let err = null;
  try {
    execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    /* 对局台自己报错退出时不要在这里崩掉 —— 否则拿不到「是哪一档、错在哪」 */
    err = String(e.stderr || e.message).trim().split('\n')[0];
  }
  return {
    log, err, ms: Date.now() - t0,
    text: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  };
}

/** 只比「局」那几行 —— header 里有引擎指纹之类的，但也应当一致 */
function games(text) {
  return text.split('\n').filter((l) => l.trim() && !l.includes('"_header"'));
}

/** 逐字节比对。抽成函数是为了能在 [3/3] 里自证它**真的有分辨力** ——
 *  一个永远返回「一致」的比对函数，会让 [2/3] 毫无成本地全绿。 */
function sameBytes(a, b) { return a === b; }

console.log('对局台并行调度自证');
console.log('='.repeat(64));

console.log('\n[1/3] 跑三档并行度（串行 / 4 路 / ' + JOBS + ' 路）');
const seq = runMatch('seq', 1);
console.log(`      串行      ${(seq.ms / 1000).toFixed(1)}s${seq.err ? '  ⚠️ ' + seq.err : ''}`);
const par4 = runMatch('par4', 4);
console.log(`      4 路      ${(par4.ms / 1000).toFixed(1)}s${par4.err ? '  ⚠️ ' + par4.err : ''}`);
const parN = runMatch('parN', JOBS);
console.log(`      ${JOBS} 路      ${(parN.ms / 1000).toFixed(1)}s${parN.err ? '  ⚠️ ' + parN.err : ''}`);
/* 先确认三档都跑完了。少了这一条，「三份都缺同一局」会被读成「三份完全一致」——
   真踩过：并行版把第 1 局塞进了错误的缓冲键，三档都只落了 3 局，横向比对全绿。 */
check(!seq.err && !par4.err && !parN.err,
  `三档都正常退出（${[seq.err, par4.err, parN.err].filter(Boolean).join(' | ') || '无报错'}）`);

console.log('\n[2/3] 正面：三份 gamelog 必须逐字节相同');
check(sameBytes(seq.text, par4.text), '串行 === 4 路');
check(sameBytes(seq.text, parN.text), `串行 === ${JOBS} 路`);

/* 局数对得上，才说明真的跑完了而不是「两边都空着」 */
const nSeq = games(seq.text).length;
check(nSeq === 4, `串行产出 4 局（实际 ${nSeq}）`);
check(games(parN.text).length === 4, `${JOBS} 路产出 4 局`);

/* 局号必须是 1..4 且顺序正确 —— 并行最容易错的就是这个 */
const gs = games(parN.text).map((l) => JSON.parse(l).g);
check(JSON.stringify(gs) === '[1,2,3,4]', `并行产出的局号严格递增 1..4（实际 ${JSON.stringify(gs)}）`);
check(JSON.parse(seq.text.split('\n').find((l) => l.includes('"_header"'))).clearTt === 1,
  '日志头记下了 clearTt=1（配置指纹完整）');

console.log('\n[3/3] 自证：比对函数与局号检查必须能发现差异');
/* 改一个字节。**这一节是 [2/3] 的底气** —— 如果比对函数被写成永远返回 true，
   [2/3] 会全绿而实际上什么都没检查。所以这里必须证明它分辨得出来。 */
const tampered = parN.text.replace('"g":3', '"g":4');
check(tampered !== parN.text, '篡改确实改变了内容（前提成立）');
check(!sameBytes(tampered, seq.text), '篡改一个字节后，与串行的比对**必须**判为不同');
const tamperedGames = games(tampered).map((l) => JSON.parse(l).g);
check(JSON.stringify(tamperedGames) !== JSON.stringify(gs),
  `局号检查同样抓得到（${JSON.stringify(gs)} → ${JSON.stringify(tamperedGames)}）`);

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + '='.repeat(64));
console.log(`${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('并行调度可能已经出错 —— 在修好之前，用 --jobs 1 跑的结果才可信。');
}
process.exit(fail ? 1 : 0);
