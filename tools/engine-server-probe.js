// 最小原型：把 Pikafish 包成 HTTP 服务，测「客户端 → 服务端 → 引擎 → 返回」的端到端耗时
// 目的：量化「引擎放服务器」这个方案里，网络开销相对于引擎思考时间占多大比例
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const EXE = process.env.PIKAFISH_BIN || '/tmp/xq-engine/Pikafish/src/pikafish';
const CWD = process.env.PIKAFISH_CWD || path.dirname(EXE);

// ---- 常驻引擎（进程隔离的关键：引擎是独立进程，不是被链接进来的库）----
function mkEngine(threads, hash) {
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
  const waitFor = (pred, t = 120000) => new Promise((res, rej) => {
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
    // 收集本轮的 info 行，用于统计「协议流量」
    go: async (moves, ms) => {
      buf.length = 0;
      const seq = moves.length ? ' moves ' + moves.join(' ') : '';
      const t0 = Date.now();
      await send('position startpos' + seq);
      await send('go movetime ' + ms);
      const l = await waitFor(x => x.startsWith('bestmove'), ms + 90000);
      const think = Date.now() - t0;
      // 统计本轮 info 流量
      let bytes = 0, infos = 0;
      for (const line of waiters.__drained || []) { bytes += line.length; infos++; }
      return { bestmove: l.split(/\s+/)[1], bestmoveLine: l, thinkMs: think };
    },
    quit: () => p.kill()
  };
}

(async () => {
  const eng = mkEngine(4, 128);
  await eng.init();
  await eng.newGame();

  // 记录引擎原始输出，用来估算协议流量
  let rawBytes = 0, rawLines = 0;
  const origWrite = process.stdout;
  eng.__stats = () => ({ rawBytes, rawLines });

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    for await (const c of req) body += c;
    let q;
    try { q = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end('bad json'); }
    const moves = q.moves || [];
    const ms = q.movetime || 200;
    try {
      const r = await eng.go(moves, ms);
      const payload = JSON.stringify({ bestmove: r.bestmove, serverThinkMs: r.thinkMs });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });

  const PORT = 8899;
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('引擎服务已启动于 127.0.0.1:' + PORT + '（引擎为独立子进程，通过 UCI 文本协议通信）');
  console.log('');

  // ---- 客户端：模拟手机端请求 ----
  const post = (payload) => new Promise((res, rej) => {
    const data = JSON.stringify(payload);
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => res({ ms: Date.now() - t0, body: JSON.parse(b) }));
    });
    req.on('error', rej);
    req.write(data); req.end();
  });

  console.log('=== 端到端耗时拆解（本机回环，网络开销≈0）===');
  console.log('思考时间   服务端耗时   客户端往返   往返开销   占比');
  const rows = [];
  for (const ms of [50, 200, 500, 1000, 2000]) {
    await post({ moves: [], movetime: 50 }); // 预热
    const r = await post({ moves: [], movetime: ms });
    const overhead = r.ms - r.body.serverThinkMs;
    rows.push({ ms, think: r.body.serverThinkMs, e2e: r.ms, overhead });
    console.log(
      String(ms + 'ms').padEnd(10) +
      String(r.body.serverThinkMs + 'ms').padEnd(12) +
      String(r.ms + 'ms').padEnd(12) +
      String(overhead + 'ms').padEnd(10) +
      (overhead / r.ms * 100).toFixed(1) + '%'
    );
  }

  // ---- 一局完整对弈的往返次数与总耗时 ----
  console.log('');
  console.log('=== 一局完整对弈（模拟 40 手，每步 200ms）===');
  const t0 = Date.now();
  let roundTrips = 0, totalClientMs = 0, totalThinkMs = 0;
  const moves = [];
  for (let i = 0; i < 40; i++) {
    const r = await post({ moves, movetime: 200 });
    roundTrips++; totalClientMs += r.ms; totalThinkMs += r.body.serverThinkMs;
    if (!r.body.bestmove || r.body.bestmove === '(none)') break;
    moves.push(r.body.bestmove);
  }
  console.log('手数 ' + moves.length + ' ｜ HTTP 往返次数 ' + roundTrips);
  console.log('客户端累计等待 ' + (totalClientMs / 1000).toFixed(1) + 's ｜ 引擎累计思考 ' + (totalThinkMs / 1000).toFixed(1) + 's');
  console.log('协议开销占比 ' + ((totalClientMs - totalThinkMs) / totalClientMs * 100).toFixed(1) + '%');
  console.log('墙钟总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  server.close();
  eng.quit();
  process.exit(0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
