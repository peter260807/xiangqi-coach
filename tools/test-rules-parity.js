#!/usr/bin/env node
'use strict';
/* 规则层对数：Kotlin 引擎 vs Swift 引擎，在**棋谱库里每一个局面**上逐一对数。
 *
 * 为什么不能只对起始局面做 perft：`docs/android-plan.md` §5.3 的第一关要求
 * 「规则一致」，而起始局面只覆盖常规子力。真正的杀法题里有单帅、三黑士、
 * 边线老将、被将军的起始局面 —— 那些才是规则实现的边界。
 *
 * 做法：给两个引擎各喂一遍 `position fen <FEN>` + `perft 2`，逐局面比总节点数，
 * 再比深度 2 时的**逐根着法**分布。总数相同但分布不同的情况是存在的
 * （两种错误互相抵消），所以分布那一层不能省。
 *
 * 用法：
 *   node tools/test-rules-parity.js            # 全部局面，深度 1 与 2
 *   node tools/test-rules-parity.js --depth 3  # 只跑深度 1 与 3（3 会明显更慢）
 *   node tools/test-rules-parity.js --limit 50 # 先拿 50 个局面试跑
 *
 * ⚠️ 两个引擎都是长驻子进程：981 个局面 × 每次冷启动一个 JVM 是几分钟的事，
 * 长驻之后只要十几秒。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_START_FEN = 'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR';
const KOTLIN = path.join(ROOT, 'android/tools/uci/build/xq-uci-kotlin');
const SWIFT = path.join(ROOT, 'tools/uci/build/xq-uci');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const MAX_DEPTH = parseInt(getArg('depth', '2'), 10);
const LIMIT = parseInt(getArg('limit', '0'), 10);

for (const [name, p] of [['Kotlin', KOTLIN], ['Swift', SWIFT]]) {
  if (!fs.existsSync(p)) {
    console.error(`${name} 的 UCI 前端不存在：${p}`);
    console.error(name === 'Kotlin'
      ? '  先跑：./android/tools/uci/run.sh'
      : '  先跑：./tools/uci/run.sh');
    process.exit(1);
  }
}

/* ---------- 长驻引擎 ---------- */

class EngineProc {
  constructor(bin, name) {
    this.name = name;
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
    this.proc.stderr.on('data', (d) => {
      process.stderr.write(`[${this.name} stderr] ${d.toString().slice(0, 200)}`);
    });
  }

  send(line) { this.proc.stdin.write(line + '\n'); }

  waitFor(test, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
      this.pending = { test, resolve };
      const t = setTimeout(() => {
        this.pending = null;
        reject(new Error(`${this.name} 等待超时`));
      }, timeoutMs);
      const orig = resolve;
      this.pending.resolve = (v) => { clearTimeout(t); orig(v); };
    });
  }

  /** 一个局面的 perft：返回 { total, map: { uci: nodes } } */
  async perft(fen, depth) {
    this.buf = [];
    this.send(`position fen ${fen}`);
    this.send(`perft ${depth}`);
    const lines = await this.waitFor((l) => l.startsWith('perft '));
    const map = {};
    let total = -1;
    for (const l of lines) {
      let m = l.match(/^perft-move (\S+) (\d+)$/);
      if (m) { map[m[1]] = parseInt(m[2], 10); continue; }
      m = l.match(/^perft (\d+) nodes (\d+) time/);
      if (m) total = parseInt(m[2], 10);
    }
    return { total, map };
  }

  quit() { try { this.send('quit'); } catch (e) { /* 已退出 */ } }
}

/* ---------- 主流程 ---------- */

(async () => {
  const lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/library.json'), 'utf8'));

  /* 局面集合：981 道杀法题 + 3 个残局 + 标准开局。
   * 杀法题里既有「红方先行」也有排局式的怪局面，正好是规则实现的边界。 */
  const positions = [];
  positions.push({ id: 'startpos', fen: LIB_START_FEN, note: '标准开局' });
  for (const m of lib.mates) positions.push({ id: m.id, fen: m.fen, note: m.name });
  for (const s of lib.studies) positions.push({ id: s.id, fen: s.fen, note: s.name });

  const list = LIMIT > 0 ? positions.slice(0, LIMIT) : positions;
  console.log('='.repeat(72));
  console.log(`规则层对数：Kotlin vs Swift，共 ${list.length} 个局面，深度 1…${MAX_DEPTH}`);
  console.log('='.repeat(72));

  const kt = new EngineProc(KOTLIN, 'Kotlin');
  const sw = new EngineProc(SWIFT, 'Swift');
  // ⚠️ 必须先挂上 waiter 再发命令。反过来的话（先 send 再 waitFor），
  // 如果 uciok 在挂 waiter 之前就到了，这一等就是等到超时。
  const ktReady = kt.waitFor((l) => l === 'uciok', 60000);
  const swReady = sw.waitFor((l) => l === 'uciok', 60000);
  kt.send('uci'); sw.send('uci');
  await Promise.all([ktReady, swReady]);
  kt.buf = []; sw.buf = [];

  let checked = 0;
  const diffs = [];

  for (const pos of list) {
    for (let d = 1; d <= MAX_DEPTH; d++) {
      const [a, b] = [await kt.perft(pos.fen, d), await sw.perft(pos.fen, d)];
      checked++;
      if (a.total !== b.total) {
        diffs.push(`${pos.id}（${pos.note}）深度 ${d}：Kotlin ${a.total} / Swift ${b.total}  「${pos.fen}」`);
        continue;
      }
      // 总数相同也要比分布：两种错误互相抵消时总数会一样
      const ka = Object.keys(a.map);
      if (ka.length !== Object.keys(b.map).length) {
        diffs.push(`${pos.id} 深度 ${d}：着法条数不同 Kotlin ${ka.length} / Swift ${Object.keys(b.map).length}`);
        continue;
      }
      for (const mv of ka) {
        if (a.map[mv] !== b.map[mv]) {
          diffs.push(`${pos.id} 深度 ${d}：着法 ${mv} Kotlin ${a.map[mv]} / Swift ${b.map[mv]}`);
          break;
        }
      }
    }
    if ((checked % 400) === 0) console.log(`  … 已对比 ${checked} 项`);
  }

  kt.quit(); sw.quit();

  console.log();
  console.log(`共对比 ${checked} 项（局面 × 深度）。`);
  if (diffs.length === 0) {
    console.log('全部一致 ✅');
    process.exit(0);
  }
  console.log(`不一致 ${diffs.length} 项：`);
  for (const d of diffs.slice(0, 40)) console.log('  ' + d);
  if (diffs.length > 40) console.log(`  …（还有 ${diffs.length - 40} 项）`);
  process.exit(1);
})().catch((e) => {
  console.error('对数失败：', e.message);
  process.exit(2);
});
