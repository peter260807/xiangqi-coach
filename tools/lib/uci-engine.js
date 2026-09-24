'use strict';
/* UCI 子进程封装 —— 够跑对局用：发命令、等某个响应、取 bestmove。
 *
 * 这套逻辑原本长在 pk-match.js 里，抽出来的原因是有第二个调用方了
 * （tools/match.js 的通用对局台），而且从「只驱动 Pikafish」扩到
 * 「也能驱动项目自己的 Swift 引擎」。
 *
 * 两个坑写在这里免得再踩：
 *   1. `position startpos moves a0a1 ...` 里那个 `moves` 关键字不能省。
 *      省掉之后引擎会把着法串当 FEN 解析，然后报 Illegal move —— 看着像坐标算错了。
 *   2. 每次 go 之前要丢掉积压的 info 行，否则会拿上一轮的结果（尤其是
 *      上一轮的 bestmove）当成这一轮的。
 */

const { spawn } = require('child_process');
const path = require('path');

class UciEngine {
  /**
   * @param {string} bin  可执行文件
   * @param {object} opts { name, options: {EvalFile, Threads, Hash}, cwd }
   */
  constructor(bin, opts = {}) {
    this.bin = bin;
    this.opts = opts;
    this.name = opts.name || path.basename(bin);
    this.buf = [];
    this.infoLines = [];
    this.waiters = [];
  }

  start() {
    this.proc = spawn(this.bin, [], {
      cwd: this.opts.cwd || path.dirname(this.bin),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => {
      d.toString().split('\n').forEach((l) => {
        const s = l.trim();
        if (!s) return;
        if (process.env.MATCH_DEBUG) process.stderr.write('[<<] ' + s.slice(0, 120) + '\n');
        // info 行单独留一份：waiters 命中后会把它之前的内容从 buf 里剪掉，
        // 所以想事后统计深度/节点数，就不能只靠 buf
        if (s.startsWith('info') && s.indexOf(' depth ') >= 0) {
          this.infoLines.push(s);
          if (this.infoLines.length > 400) this.infoLines.shift();
        }
        this.buf.push(s);
        this._pump();
      });
    });
    this.proc.stderr.on('data', (d) => {
      if (process.env.MATCH_DEBUG) process.stderr.write('[err] ' + d.toString().slice(0, 200));
    });
    this.proc.on('error', (e) => { this.startError = e; });
    /* ⚠️ 引擎**自己退出**时必须立刻把等待者叫醒。
     *
     * Pikafish 遇到它认为非法的局面会打印
     *   `info string CRITICAL ERROR: ... Reason: Unsupported position. ...`
     * 然后**直接结束进程**（实测：库里 s2 那个 3 个黑士的局面）。
     * 没有这个监听的话，waitFor 会一直等到它自己的超时 —— 而超时是按 movetime 折算的，
     * 给了 1 小时 movetime 就等于等 20 小时。现象是「任务静默卡住、零输出、零报错」，
     * 本次因此白烧了 40 分钟。把子进程最后几行带上，报错就能直接指到原因。 */
    this.proc.on('exit', (code, signal) => {
      this.exited = { code, signal };
      const tail = this.buf.slice(-4).join(' | ');
      const err = new Error('引擎进程已退出（code=' + code + ' signal=' + signal + '）'
        + (tail ? '  最后输出：' + tail : ''));
      const ws = this.waiters.slice();
      this.waiters = [];
      for (const w of ws) { clearTimeout(w.timer); w.reject(err); }
    });

    return this.send('uci')
      .then(() => this.waitFor((l) => l === 'uciok'))
      .then(() => {
        const line = this.buf.concat([]).find((l) => l.startsWith('id name'));
        if (line) this.name = line.replace('id name ', '');
      })
      .then(() => {
        const opts = this.opts.options || {};
        return Object.keys(opts).reduce(
          (p, k) => p.then(() => this.send(`setoption name ${k} value ${opts[k]}`)),
          Promise.resolve()
        );
      })
      .then(() => this.send('isready'))
      .then(() => this.waitFor((l) => l === 'readyok'))
      .catch((e) => {
        if (this.startError) throw new Error(`启动失败 ${this.bin}: ${this.startError.message}`);
        throw e;
      });
  }

  send(cmd) {
    if (process.env.MATCH_DEBUG) process.stderr.write('[>>] ' + cmd + '\n');
    this.proc.stdin.write(cmd + '\n');
    return Promise.resolve();
  }

  /** ucinewgame 后必须跟一次 isready —— 不跟的话引擎可能还不认后续的 position */
  newGame() {
    return this.send('ucinewgame')
      .then(() => this.send('isready'))
      .then(() => this.waitFor((l) => l === 'readyok'));
  }

  waitFor(pred, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error('引擎进程已经退出了，不可能再等到 ' + pred.toString()));
        return;
      }
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

  /**
   * 走一手，返回 { best, depth, nodes, timeMs, score }。
   * 用 movetime 而不是固定深度：用户在 App 里感受到的棋力就是「给我 N 毫秒」。
   *
   * `limit.fen` 给了就从那个局面起算（不给就是标准开局）。
   * 残局 / 名局不是从标准开局摆起来的，测固定深度的节点数时必须能指定局面 ——
   * 少了这个就只能量开局，而开局恰好是最不能代表全局的那个。
   */
  go(moves, limit) {
    this.buf.length = 0;
    this.infoLines = [];
    const seq = moves.length ? ' moves ' + moves.join(' ') : '';
    const position = limit.fen ? `position fen ${limit.fen}${seq}` : `position startpos${seq}`;
    /* 只给 depth 时是纯固定深度；同时给 depth 和 movetime 时**两个都要发**：
       本项目引擎内部把 depth 当上限、把时间当硬截止，而 movetime 缺省是 0，
       会被兜底成 80ms —— 于是「go depth 8」其实只搜 80 毫秒，
       量出来的节点数看着很正常，其实第 5 层就被掐了。 */
    const mpv = Math.max(1, limit.multipv || 1);
    const cmd = limit.depth > 0
      ? `go depth ${limit.depth}` + (limit.movetime ? ` movetime ${limit.movetime}` : '')
        + (mpv > 1 ? ` multipv ${mpv}` : '')
      : `go movetime ${Math.max(1, limit.movetime || 300)}`;
    const timeout = Math.max(20000, (limit.movetime || 1000) * 20);

    return this.send(position)
      .then(() => this.send(cmd))
      .then(() => this.waitFor((l) => l.startsWith('bestmove'), timeout))
      .then((line) => {
        const best = line.split(/\s+/)[1];
        const num = (l, key) => {
          const m = l.match(new RegExp(' ' + key + ' (-?\\d+)'));
          return m ? parseInt(m[1], 10) : 0;
        };
        /* 多路候选：`multipv N` 会为每个候选单独发一行 info，**第一行才是最佳着法**。
           下面那个「循环覆盖」的老写法只对单行 info 成立 —— 多路时它会把最后一路的
           分数当成最佳着法的分，静默出错。所以显式按 multipv 号收一份。 */
        const candidates = [];
        for (const l of this.infoLines) {
          const k = num(l, 'multipv');
          if (k >= 1) {
            const pv = l.match(/ pv (\S+)/);
            candidates.push({ multipv: k, move: pv ? pv[1] : null,
                              score: num(l, 'score cp'), depth: num(l, 'depth') });
          }
        }
        candidates.sort((x, y) => x.multipv - y.multipv);

        let depth = 0, nodes = 0, timeMs = 0, score = 0, scoreMate = null;
        /* 单路（或引擎不发 multipv 字段）时等价于原来的行为 */
        const src = candidates.length
          ? this.infoLines.filter((l) => num(l, 'multipv') === 1)
          : this.infoLines;
        /* 顺便把**完整 PV** 带出来（不只是第一手）。
         *
         * 用途：求解杀法题时，一条 N 手杀的完整线路就在根搜索这一行里 ——
         * 逐手重新搜索一遍要 N 次搜索（实测一条 13 手杀的题要几十秒），
         * 而 PV 一次就给全，剩下的只是拿规则层把它走一遍验证。
         * 取**最后一行**（最深的那次迭代）的 pv：浅迭代的 pv 是半截的。 */
        let pv = [];
        for (const l of src) {
          depth = num(l, 'depth') || depth;
          nodes = num(l, 'nodes') || nodes;
          timeMs = num(l, 'time') || timeMs;
          score = num(l, 'score cp') || score;
          /* 杀棋是 `score mate N` 而不是 `score cp N` —— 不打标记的话上面那行
             会把它读成 0，于是「将死」在数据里看起来和「完全均势」一模一样。 */
          const mm = l.match(/ score mate (-?\d+)/);
          if (mm) scoreMate = parseInt(mm[1], 10);
          const pm = l.match(/ pv (.+)$/);
          if (pm) pv = pm[1].trim().split(/\s+/);
        }
        return { best, depth, nodes, timeMs, score, scoreMate, candidates, pv };
      });
  }

  quit() {
    try { this.proc.stdin.write('quit\n'); } catch (e) { /* 忽略 */ }
    setTimeout(() => { try { this.proc.kill(); } catch (e) { /* 忽略 */ } }, 300);
  }
}

module.exports = { UciEngine };
