#!/usr/bin/env node
/* 让 Pikafish 和本项目的引擎真下一局，量一量棋力差距。
 *
 * 结论靠嘴说没用，得让它俩坐下来下。这里做的是：
 *   1. 以子进程方式拉起 Pikafish，走 UCI 协议；
 *   2. 红方交给 Pikafish，黑方交给 web/js/engine.js（本项目引擎）；
 *   3. 每一手都用本项目自己的规则引擎复验合法性 —— 顺带也算给规则层做了一次实弹检验；
 *   4. 判将死 / 困毙 / 60 回合无吃子判和，统计胜负。
 *
 * 用法：
 *   node tools/pk-match.js --pika /path/to/pikafish --nnue /path/to/pikafish.nnue \
 *                          --games 4 --pika-ms 100 --my-ms 1000
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const XQ = require(path.join(ROOT, 'web/js/engine.js'));
const EMPTY = XQ.EMPTY || '.';

/* ---------- 坐标转换 ----------
 * Pikafish 用 UCI 坐标：列 a-i 从观察者左到右，行 0-9 从红方底线往上。
 * 本项目棋盘索引是 r*9+c，r=0 是黑方底线、r=9 是红方底线。
 */
function idxToUci(i) {
  const r = (i / 9) | 0, c = i % 9;
  return String.fromCharCode(97 + c) + (9 - r);
}
function uciToIdx(s) {
  const c = s.charCodeAt(0) - 97;
  const r = 9 - parseInt(s.slice(1), 10);
  return r * 9 + c;
}

/* ---------- UCI 进程包装 ---------- */
class UciEngine {
  constructor(bin, nnue, opts = {}) {
    this.bin = bin;
    this.nnue = nnue;
    this.opts = opts;
    this.buf = [];
    this.waiters = [];
  }

  start() {
    this.proc = spawn(this.bin, [], { cwd: path.dirname(this.bin), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => {
      d.toString().split('\n').forEach((l) => {
        const s = l.trim();
        if (!s) return;
        if (process.env.PKM_DEBUG) console.error('[<<] ' + s.slice(0, 100));
        this.buf.push(s);
        this._pump();
      });
    });
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', (e) => { throw e; });

    return this.id()
      .then(() => this.setOption('EvalFile', this.nnue))
      .then(() => this.setOption('Threads', String(this.opts.threads || 1)))
      .then(() => this.setOption('Hash', String(this.opts.hash || 128)))
      .then(() => this.send('isready'))
      .then(() => this.waitFor((l) => l === 'readyok'));
  }

  /** 先 uci 拿到 id / options，顺手把引擎名记下来 */
  id() {
    return this.send('uci')
      .then(() => this.waitFor((l) => l === 'uciok'))
      .then(() => {
        const nameLine = this.buf.concat([]).find((l) => l.startsWith('id name'));
        this.engineName = nameLine ? nameLine.replace('id name ', '') : 'Pikafish';
      });
  }

  send(cmd) {
    if (process.env.PKM_DEBUG) console.error('[>>] ' + cmd);
    this.proc.stdin.write(cmd + '\n');
    return Promise.resolve();
  }
  setOption(name, value) { return this.send(`setoption name ${name} value ${value}`); }

  /** 新对局必须等 readyok —— ucinewgame 后不跟 isready，引擎可能不认后续的 position */
  newGame() {
    return this.send('ucinewgame')
      .then(() => this.send('isready'))
      .then(() => this.waitFor((l) => l === 'readyok'));
  }

  waitFor(pred, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error('等待 UCI 响应超时：' + pred.toString()));
      }, timeoutMs);
      this.waiters.push(w);
      this._pump();
    });
  }

  _pump() {
    for (const w of this.waiters.slice()) {
      const idx = this.buf.findIndex(w.pred);
      if (idx < 0) continue;
      const line = this.buf[idx];
      this.buf.splice(0, idx + 1);
      clearTimeout(w.timer);
      this.waiters = this.waiters.filter((x) => x !== w);
      w.resolve(line);
    }
  }

  /** 让引擎在给定着法历史之后走一步，返回 UCI 着法。
   *  byDepth 为真时用 `go depth N`（固定层数），否则用 `go movetime N`。
   *  固定层数能测出「搜索深度一样时，评估质量的差距」。 */
  go(moves, limit, byDepth) {
    this.buf.length = 0;   // 丢掉上一轮积压的 info 行
    // UCI 语法是 `position startpos moves a0a1 b0b1` —— 那个 moves 关键字不能省。
    // 省掉之后引擎会把着法串当成 FEN 去解析，然后报「Illegal move: xxx」，
    // 看上去像坐标转换错了，实际上跟坐标没关系。
    const seq = moves.length ? ' moves ' + moves.join(' ') : '';
    const goCmd = byDepth ? `go depth ${limit}` : `go movetime ${limit}`;
    return this.send(`position startpos${seq}`)
      .then(() => this.send(goCmd))
      .then(() => this.waitFor((l) => l.startsWith('bestmove'), 180000))
      .then((l) => l.split(/\s+/)[1]);
  }

  quit() {
    try { this.proc.stdin.write('quit\n'); } catch (e) { /* 忽略 */ }
    setTimeout(() => { try { this.proc.kill(); } catch (e) {} }, 300);
  }
}

/* ---------- 走一局 ---------- */
async function playGame(pika, cfg, round) {
  await pika.newGame();
  const board = XQ.parseBoard(XQ.START);
  let side = 'r';
  const uciMoves = [];
  const log = [];
  let ply = 0;
  let lastCapture = 0;
  let myTotalMs = 0;
  let myDepths = [];

  while (ply < cfg.maxPly) {
    if (!XQ.hasLegalMove(board, side)) {
      return {
        loser: side,
        reason: XQ.inCheck(board, side) ? '将死' : '困毙（无子可动）',
        ply, log, myTotalMs,
        avgDepth: myDepths.length ? (myDepths.reduce((a, b) => a + b, 0) / myDepths.length) : 0
      };
    }

    let mv;
    if (side === 'r') {
      const byDepth = cfg.pikaDepth > 0;
      const best = await pika.go(uciMoves, byDepth ? cfg.pikaDepth : cfg.pikaMs, byDepth);
      const from = uciToIdx(best.slice(0, 2));
      const to = uciToIdx(best.slice(2, 4));
      const legal = XQ.legalMoves(board, 'r');
      if (!legal.some((m) => m[0] === from && m[1] === to)) {
        return { loser: 'r', reason: 'Pikafish 给出非法着法 ' + best, ply, log, myTotalMs, avgDepth: 0 };
      }
      mv = [from, to];
    } else {
      const t0 = Date.now();
      const r = XQ.searchRoot(board, 'b', 99, cfg.myMs);
      myTotalMs += Date.now() - t0;
      if (!r.move) {
        return { loser: 'b', reason: '本引擎找不到着法', ply, log, myTotalMs, avgDepth: 0 };
      }
      myDepths.push(r.depth);
      mv = r.move;
    }

    const label = XQ.moveLabel(board, mv);
    const cap = board[mv[1]] !== EMPTY;
    log.push({ side, label, cap });
    if (cap) lastCapture = ply;
    uciMoves.push(idxToUci(mv[0]) + idxToUci(mv[1]));
    XQ.makeMove(board, mv);
    ply++;
    side = side === 'r' ? 'b' : 'r';

    if (ply - lastCapture >= 120) {
      return { draw: true, reason: '60 回合无吃子', ply, log, myTotalMs, avgDepth: 0 };
    }
  }
  return { draw: true, reason: `达到手数上限 ${cfg.maxPly}`, ply, log, myTotalMs, avgDepth: 0 };
}

/* ---------- 参数 ---------- */
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf('--' + k);
    return i >= 0 && a[i + 1] ? a[i + 1] : d;
  };
  return {
    pika: get('pika', '/tmp/xq-engine/Pikafish/src/pikafish'),
    nnue: get('nnue', '/tmp/xq-engine/Pikafish/src/pikafish.nnue'),
    games: parseInt(get('games', '2'), 10),
    pikaMs: parseInt(get('pika-ms', '100'), 10),
    pikaDepth: parseInt(get('pika-depth', '0'), 10),
    myMs: parseInt(get('my-ms', '1000'), 10),
    maxPly: parseInt(get('max-ply', '200'), 10),
    verbose: a.includes('--verbose')
  };
}

/* ---------- 主流程 ---------- */
(async function main() {
  const cfg = parseArgs();
  console.log('=== Pikafish vs 本项目引擎 ===');
  const pikaLimit = cfg.pikaDepth > 0 ? `固定 ${cfg.pikaDepth} 层` : `每步 ${cfg.pikaMs}ms`;
  console.log(`Pikafish ${pikaLimit} ｜ 本项目引擎每步 ${cfg.myMs}ms ｜ 共 ${cfg.games} 局`);
  console.log();

  const pika = new UciEngine(cfg.pika, cfg.nnue, { threads: 1, hash: 128 });
  await pika.start();
  console.log(`Pikafish 就绪：${pika.engineName}`);
  console.log();

  const tally = { pikaWin: 0, myWin: 0, draw: 0 };
  const rows = [];

  for (let g = 1; g <= cfg.games; g++) {
    const r = await playGame(pika, cfg, g);
    let result;
    if (r.draw) { tally.draw++; result = '和棋'; }
    else if (r.loser === 'b') { tally.pikaWin++; result = 'Pikafish 胜'; }
    else { tally.myWin++; result = '本项目引擎胜'; }

    rows.push({
      局: g, 结果: result, 结束原因: r.reason, 手数: r.ply,
      '本引擎平均层数': r.avgDepth.toFixed(1),
      '本引擎总耗时': (r.myTotalMs / 1000).toFixed(1) + 's'
    });

    console.log(`第 ${g} 局：${result}（${r.reason}，共 ${r.ply} 手）`);
    if (cfg.verbose) {
      r.log.forEach((s, i) => {
        process.stdout.write(`${i % 2 === 0 ? (i / 2 + 1) + '. ' : '   '}${s.label}${s.cap ? '(吃)' : ''}  `);
        if (i % 2 === 1) process.stdout.write('\n');
      });
      console.log();
    }
  }

  console.log();
  console.table(rows);
  console.log(`汇总：Pikafish 胜 ${tally.pikaWin} ／ 本项目引擎胜 ${tally.myWin} ／ 和 ${tally.draw}`);
  pika.quit();
  process.exit(0);
})().catch((e) => {
  console.error('出错：', e.message);
  process.exit(1);
});
