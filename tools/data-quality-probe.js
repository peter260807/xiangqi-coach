// 训练数据质量 vs 产出速率的权衡：对比 movetime / depth 两种限流方式
const { spawn } = require('child_process');
const path = require('path');
const EXE = process.env.PIKAFISH_BIN || '/tmp/xq-engine/Pikafish/src/pikafish';
const CWD = process.env.PIKAFISH_CWD || path.dirname(EXE);

function mk(threads, hash) {
  const p = spawn(EXE, [], { cwd: CWD });
  let buf = [], waiters = [];
  p.stdout.on('data', d => d.toString().split('\n').forEach(l => {
    const s = l.trim(); if (s) { buf.push(s); pump(); }
  }));
  function pump() {
    for (const w of waiters.slice()) {
      const i = buf.findIndex(w.pred); if (i < 0) continue;
      const line = buf[i]; buf.splice(0, i + 1);
      waiters = waiters.filter(x => x !== w); w.resolve(line);
    }
  }
  const send = c => { p.stdin.write(c + '\n'); return Promise.resolve(); };
  const waitFor = (pred, t = 300000) => new Promise((res, rej) => {
    const w = { pred, resolve: res }; waiters.push(w); pump();
    setTimeout(() => { waiters = waiters.filter(x => x !== w); rej(new Error('timeout')); }, t);
  });
  return {
    init: async () => {
      await send('uci'); await waitFor(l => l === 'uciok');
      await send('setoption name Threads value ' + threads);
      await send('setoption name Hash value ' + hash);
      await send('isready'); await waitFor(l => l === 'readyok');
    },
    newGame: async () => { await send('ucinewgame'); await send('isready'); await waitFor(l => l === 'readyok'); },
    goCmd: async (moves, cmd) => {
      buf.length = 0;
      const seq = moves.length ? ' moves ' + moves.join(' ') : '';
      const t0 = Date.now();
      await send('position startpos' + seq);
      await send(cmd);
      const bm = await waitFor(x => x.startsWith('bestmove'), 290000);
      return { bestmove: bm.split(/\s+/)[1], ms: Date.now() - t0 };
    },
    quit: () => p.kill()
  };
}

(async () => {
  const e = mk(1, 64);
  await e.init();
  const PLIES = 60;   // 每个配置走 60 步取样，避免开局重复
  console.log('单进程，每个配置采样 ' + PLIES + ' 步（从开局起走）');
  console.log('');
  console.log('限流方式            单步均耗    吞吐(局面/秒)   8进程/一周      数据质量');
  const configs = [
    ['go movetime 20',    'go movetime 20',   '低（浅搜索，噪声大）'],
    ['go movetime 50',    'go movetime 50',   '中低'],
    ['go movetime 200',   'go movetime 200',  '中'],
    ['go depth 8',        'go depth 8',       '中高（官方常用档）'],
    ['go depth 12',       'go depth 12',      '高'],
    ['go nodes 50000',    'go nodes 50000',   '中高（按算力定量）'],
  ];
  for (const [label, cmd, quality] of configs) {
    await e.newGame();
    const moves = [];
    let total = 0, n = 0;
    for (let i = 0; i < PLIES; i++) {
      const r = await e.goCmd(moves, cmd);
      if (!r.bestmove || r.bestmove === '(none)') break;
      moves.push(r.bestmove); total += r.ms; n++;
    }
    const avg = total / n;
    const perSec = 1000 / avg;
    const week8 = perSec * 8 * 86400 * 7 / 1e6;
    console.log(
      label.padEnd(20) + (avg.toFixed(0) + 'ms').padEnd(12) +
      perSec.toFixed(1).padEnd(16) +
      (week8.toFixed(1) + 'M').padEnd(16) + quality
    );
  }
  e.quit(); process.exit(0);
})().catch(err => { console.error('失败:', err.message); process.exit(1); });
