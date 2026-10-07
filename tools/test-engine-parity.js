#!/usr/bin/env node
'use strict';
/* 引擎三项等价性对照：**Kotlin（新）vs JS（web/js/engine.js）**。
 *
 * 这一层查的不是「能不能下棋」，而是「移植有没有抄错一行」——
 * 它比 Elo 对局**确定性强得多**：同样的局面必然给出同样的数字，
 * 不一致就一定是代码差异，不会被对局随机性掩盖。
 *
 * 三项：
 *   1. **静态评估**：库里每个局面的 evaluate 分数必须逐位相同
 *      （PST 表少抄一行、行列镜像写反，都会在这里暴露，而棋力测试看不出来）
 *   2. **着法生成**：genMoves 的数量与**排序后**的着法集合必须相同
 *   3. **中文记谱**：同一手棋的记谱文本必须相同（红黑方向、前后区分）
 *
 * 用法：
 *   node tools/test-engine-parity.js            # 全量 985 个局面
 *   node tools/test-engine-parity.js --limit 50
 *   node tools/test-engine-parity.js --games    # 顺带跑随机对局逐局面比对评估分
 *
 * ⚠️ 为什么拿 JS 当基准而不是 Swift：JS 那边有现成的、能直接被 Node 载入的
 * 模块边界；Swift 要经过 UCI 前端，只暴露 perft 与搜索着法，拿不到评估分。
 * 而 JS 与 Swift 的规则一致性已经由 perft 三方对数守着（tools/match.js --perft）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KOTLIN = path.join(ROOT, 'android/tools/uci/build/xq-uci-kotlin');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const LIMIT = parseInt(getArg('limit', '0'), 10);

/* ---------- Kotlin 侧：走 UCI 前端，加两个只用于比对的调试命令 ---------- */

class KotlinSide {
  constructor(bin) {
    this.buf = [];
    this.pending = null;
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const s = line.trim();
        if (!s) continue;
        this.buf.push(s);
        if (this.pending && this.pending.test(s)) {
          const p = this.pending;
          this.pending = null;
          p.resolve(this.buf.slice());
        }
      }
    });
  }
  send(l) { this.proc.stdin.write(l + '\n'); }
  waitFor(test, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending = null; reject(new Error('Kotlin 等待超时')); }, timeoutMs);
      this.pending = { test, resolve: (v) => { clearTimeout(t); resolve(v); } };
    });
  }
  async start() {
    const w = this.waitFor((l) => l === 'uciok', 60000);
    this.send('uci');
    await w;
    this.buf = [];
  }
  quit() { try { this.send('quit'); } catch (e) { /* 已退出 */ } }
}

/* ---------- 比对 ---------- */

(async () => {
  if (!fs.existsSync(KOTLIN)) {
    console.error('Kotlin UCI 前端不存在，先跑：./android/tools/uci/run.sh');
    process.exit(1);
  }
  const lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/library.json'), 'utf8'));
  const positions = [{ id: 'startpos', fen: XQ.START, note: '标准开局' }];
  for (const m of lib.mates) positions.push({ id: m.id, fen: m.fen, note: m.name });
  const list = LIMIT > 0 ? positions.slice(0, LIMIT) : positions;

  const kt = new KotlinSide(KOTLIN);
  await kt.start();

  console.log('='.repeat(72));
  console.log(`引擎等价性：Kotlin vs JS，共 ${list.length} 个局面`);
  console.log('='.repeat(72));

  const diffs = [];
  let evalChecked = 0;
  let moveChecked = 0;

  for (const pos of list) {
    // --- 1) 静态评估 ---
    kt.buf = [];
    kt.send(`eval ${pos.fen}`);
    const el = await kt.waitFor((l) => l.startsWith('eval '));
    const ktEval = parseInt(el.find((l) => l.startsWith('eval ')).split(' ')[1], 10);
    const jsEval = XQ.evaluate(XQ.parseBoard(pos.fen));
    evalChecked++;
    if (ktEval !== jsEval) {
      diffs.push(`[评估] ${pos.id}（${pos.note}）：Kotlin ${ktEval} / JS ${jsEval}  「${pos.fen}」`);
    }

    // --- 2) 着法生成（数量 + 集合）---
    for (const side of ['r', 'b']) {
      kt.buf = [];
      kt.send(`moves ${side} ${pos.fen}`);
      const ml = await kt.waitFor((l) => l.startsWith('moves '));
      const ktMoves = ml.find((l) => l.startsWith('moves ')).split(' ').slice(2).sort();
      const jsBoard = XQ.parseBoard(pos.fen);
      // 同样打包成整数再排序，与 Kotlin 侧口径一致
      const jsMoves = XQ.genMoves(jsBoard, side).map((m) => String(m[0] * 90 + m[1])).sort();
      moveChecked++;
      if (ktMoves.length !== jsMoves.length) {
        diffs.push(`[着法] ${pos.id} ${side}：条数 Kotlin ${ktMoves.length} / JS ${jsMoves.length}`);
      } else if (ktMoves.join(',') !== jsMoves.join(',')) {
        const only = ktMoves.filter((m) => !jsMoves.includes(m));
        const miss = jsMoves.filter((m) => !ktMoves.includes(m));
        diffs.push(`[着法] ${pos.id} ${side}：Kotlin 多 ${only.join('/') || '-'}，少 ${miss.join('/') || '-'}`);
      }
    }

    // --- 3) 中文记谱：拿红方全部合法着法逐一对文本 ---
    kt.buf = [];
    kt.send(`labels r ${pos.fen}`);
    const ll = await kt.waitFor((l) => l === 'labels-end');
    // Kotlin 侧按 (from*90+to) 排序输出，这里对齐同一顺序，逐位比文本
    const ktLabels = ll.filter((l) => l.startsWith('label ')).map((l) => l.slice(6));
    const jsBoard2 = XQ.parseBoard(pos.fen);
    const jsOrdered = XQ.legalMoves(jsBoard2, 'r').slice().sort((a, b) => (a[0] * 90 + a[1]) - (b[0] * 90 + b[1]));
    const jsLabels = jsOrdered.map((m) => XQ.moveLabel(jsBoard2, m));
    if (ktLabels.length !== jsLabels.length) {
      diffs.push(`[记谱] ${pos.id}：条数 Kotlin ${ktLabels.length} / JS ${jsLabels.length}`);
    } else {
      for (let i = 0; i < ktLabels.length; i++) {
        if (ktLabels[i] !== jsLabels[i]) {
          diffs.push(`[记谱] ${pos.id}：第 ${i} 项 Kotlin「${ktLabels[i]}」/ JS「${jsLabels[i]}」`);
          break;
        }
      }
    }

    if ((evalChecked % 200) === 0) process.stdout.write(`  … 已比对 ${evalChecked} 个局面\n`);
  }

  kt.quit();

  console.log();
  console.log(`评估比对 ${evalChecked} 项，着法生成 ${moveChecked} 项，记谱 ${evalChecked} 项。`);
  if (diffs.length === 0) {
    console.log('全部一致 ✅');
    process.exit(0);
  }
  console.log(`不一致 ${diffs.length} 项：`);
  for (const d of diffs.slice(0, 30)) console.log('  ' + d);
  if (diffs.length > 30) console.log(`  …（还有 ${diffs.length - 30} 项）`);
  process.exit(1);
})().catch((e) => { console.error('对照失败：', e.message); process.exit(2); });

/** JS 引擎内部坐标 → UCI 坐标（与 UCI 前端的 squareName 同一套：rank = 9 - row） */
function uci(m) {
  const s = (i) => String.fromCharCode(97 + (i % 9)) + (9 - Math.floor(i / 9));
  return s(m[0]) + s(m[1]);
}
