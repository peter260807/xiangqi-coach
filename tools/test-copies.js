#!/usr/bin/env node
/*
 * 副本同步的自证测试：把「哪几份必须一致、哪几份必须**不**一致」钉死在代码里。
 *
 * 为什么必须有它
 * ──────────────
 * 这个项目已经被同一类 bug 咬过两次，都是**静默**的：
 *
 *   ① iOS 的 `Resources/library.json` 曾是手工 cp 的独立副本。题库 11 → 981 道
 *      之后，网页端 981、iOS 还是 11，而**两端单测全绿** —— 它们只断言「mates 非空」，
 *      那 11 道也非空。（后由 tools/sync-library.js 收进同步链。）
 *   ② `tools/ab-package/` 是给 Windows 长跑用的整包拷件。它是**手工 cp** 出来的，
 *      没有任何东西守着它。改了 `web/js/engine.js` 却忘了拷，长跑包就在悄悄比
 *      一个已经不存在的版本 —— 而跑出来的 Elo 照样像模像样。
 *
 * 光「写下来」不够（README 里写了，照样会忘）。所以这里两条一起钉：
 *
 *   【正面】SYNCED 里的每一对必须**逐字节相同**。
 *   【反面】DIVERGENT 里的每一对必须**逐字节不同**。这一半同样重要：
 *          - `baseline/engine.js` 若与线上引擎相同，A/B 就成了自己跟自己下，
 *            必定跑出 Elo = 0，然后被读成「这次改动没用」；
 *          - `ab-package/web/js/library-data.js` 是**有意**的简版（8 组开局 10 KB，
 *            对局台只读 XQLIB.OPENINGS）。一刀切 cp 会把它撑成 408 KB，包白胖 390 KB。
 *
 * 用法：node tools/test-copies.js
 * 退出码：0 = 全部通过，1 = 有失败
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/* 必须逐字节相同：一份源 + 它的拷贝（改动后要一起 cp） */
const SYNCED = [
  ['web/js/engine.js', 'tools/ab-package/web/js/engine.js'],
  ['tools/match.js', 'tools/ab-package/tools/match.js'],
  ['tools/lib/coord.js', 'tools/ab-package/tools/lib/coord.js'],
  ['tools/lib/uci-engine.js', 'tools/ab-package/tools/lib/uci-engine.js'],
];

/* 必须不同：冻结点 / 有意收窄的副本。相同 = 有人一刀切覆盖了，实验前提没了 */
const DIVERGENT = [
  ['web/js/engine.js', 'tools/ab-package/baseline/engine.js',
   'baseline 是 A/B 的对照组，被线上引擎覆盖后对比恒为 0'],
  ['web/js/library-data.js', 'tools/ab-package/web/js/library-data.js',
   'ab-package 那份是**有意**的 8 组开局简版，同步过去会让包白胖 390 KB'],
  ['web/js/engine.js', 'tools/net-in-engine/engine.js',
   'net-in-engine 是「网络接进引擎」实验的冻结快照，不是线上副本'],
];

let pass = 0;
let fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
}

console.log('【正面】这些副本必须逐字节相同');
for (const [src, copy] of SYNCED) {
  let miss = null;
  for (const p of [src, copy]) if (!fs.existsSync(path.join(ROOT, p))) miss = p;
  if (miss) {
    check(false, `${miss} 不存在 —— 副本清单过期了，先修本文件`);
    continue;
  }
  const a = sha(src), b = sha(copy);
  check(a === b, a === b
    ? `${copy} 与 ${src} 一致（${a.slice(0, 12)}）`
    : `${copy} 与 ${src} **不一致** —— 改完源文件要 cp 过去\n      ${src.padEnd(30)} ${a.slice(0, 12)}\n      ${copy.padEnd(30)} ${b.slice(0, 12)}`);
}

console.log('\n【反面】这些副本必须**不**相同（否实验前提就没了）');
for (const [src, other, why] of DIVERGENT) {
  let miss = null;
  for (const p of [src, other]) if (!fs.existsSync(path.join(ROOT, p))) miss = p;
  if (miss) {
    check(false, `${miss} 不存在 —— 副本清单过期了，先修本文件`);
    continue;
  }
  const a = sha(src), b = sha(other);
  check(a !== b, a !== b
    ? `${other} 与 ${src} 不同（符合预期）`
    : `${other} 与 ${src} **完全相同**！${why}`);
}

console.log('\n【自证】比对器本身必须能发现差异');
/* 没有这一条，上面的「相同」可能只是因为我的比对根本没在比 ——
   一个永远返回「一致」的检查器，比没有检查器更危险。 */
const probe = path.join(ROOT, 'web/js/engine.js');
const orig = fs.readFileSync(probe);
const tampered = Buffer.from(orig);
tampered[tampered.length >> 1] = tampered[tampered.length >> 1] ^ 0x01;   /* 翻一个 bit */
check(!tampered.equals(orig), '篡改确实改变了内容（前提成立）');
const hOrig = crypto.createHash('sha256').update(orig).digest('hex');
const hTampered = crypto.createHash('sha256').update(tampered).digest('hex');
check(hOrig !== hTampered, '翻一个 bit 后哈希必须不同 —— 比对器是活的');
check(orig.equals(fs.readFileSync(probe)), '磁盘上的源文件没被这次自证动过');

console.log('\n' + '='.repeat(64));
console.log(`${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('副本不同步 —— 在修好之前，从 ab-package 跑出来的结论都不可信。');
}
process.exit(fail ? 1 : 0);
