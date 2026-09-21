// 在真实网络条件下「引擎放服务器」的体验影响：注入不同 RTT，看对局总时长的影响
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const EXE = process.env.PIKAFISH_BIN || '/tmp/xq-engine/Pikafish/src/pikafish';
const CWD = process.env.PIKAFISH_CWD || path.dirname(EXE);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    go: async (moves, ms) => {
      buf.length = 0;
      const seq = moves.length ? ' moves ' + moves.join(' ') : '';
      const t0 = Date.now();
      await send('position startpos' + seq);
      await send('go movetime ' + ms);
      const l = await waitFor(x => x.startsWith('bestmove'), ms + 90000);
      return { bestmove: l.split(/\s+/)[1], thinkMs: Date.now() - t0 };
    },
    quit: () => p.kill()
  };
}

(async () => {
  const eng = mkEngine(4, 128);
  await eng.init();

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    let q; try { q = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
    const r = await eng.go(q.moves || [], q.movetime || 200);
    const payload = JSON.stringify({ bestmove: r.bestmove, serverThinkMs: r.thinkMs });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  await new Promise(r => server.listen(8899, '127.0.0.1', r));

  // 客户端：注入人为网络往返延迟 rttMs（去程 + 回程各一半）
  const post = (payload, rttMs) => new Promise((res, rej) => {
    const data = JSON.stringify(payload);
    const t0 = Date.now();
    sleep(rttMs / 2).then(() => {
      const req = http.request({ host: '127.0.0.1', port: 8899, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
        let b = '';
        r.on('data', c => b += c);
        r.on('end', async () => { await sleep(rttMs / 2); res({ ms: Date.now() - t0, body: JSON.parse(b) }); });
      });
      req.on('error', rej);
      req.write(data); req.end();
    });
  });

  const THINK = 200, PLIES = 40;
  console.log('一局 40 手、每步引擎思考 ' + THINK + 'ms ｜ 纯引擎时间 = ' + (THINK * PLIES / 1000).toFixed(1) + 's');
  console.log('');
  console.log('网络场景                     RTT    对局墙钟   额外耗时   相对增幅   单步体感');
  const scenes = [
    ['同机回环（引擎在本地）', 0],
    ['同城机房 / 家里同网段', 5],
    ['同区域云服务器', 30],
    ['跨省服务器', 60],
    ['海外服务器', 200],
    ['跨境弱网（4G 抖动）', 400],
  ];
  for (const [name, rtt] of scenes) {
    await eng.newGame();
    const moves = [];
    const t0 = Date.now();
    for (let i = 0; i < PLIES; i++) {
      const r = await post({ moves, movetime: THINK }, rtt);
      if (!r.body.bestmove || r.body.bestmove === '(none)') break;
      moves.push(r.body.bestmove);
    }
    const wall = Date.now() - t0;
    const ideal = THINK * PLIES;
    const extra = wall - ideal;
    console.log(
      name.padEnd(28) + (rtt + 'ms').padEnd(8) +
      ((wall / 1000).toFixed(1) + 's').padEnd(11) +
      ('+' + (extra / 1000).toFixed(1) + 's').padEnd(11) +
      ('+' + (extra / ideal * 100).toFixed(0) + '%').padEnd(11) +
      (THINK + rtt) + 'ms/步'
    );
  }

  server.close(); eng.quit(); process.exit(0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
