"""
UCI 引擎封装（跨平台）。

跨平台的两个坑，这里都绕开了：
1. 不用 `select`（Windows 上不能用于管道），改用**独立读取线程 + 队列**
2. 不用 text 模式（Windows 的换行与缓冲行为不一致），走二进制手动解码
"""

import os
import queue
import re
import subprocess
import threading
import time

MULTIPV_RE = re.compile(r'\bmultipv (\d+)')
SCORE_CP_RE = re.compile(r'\bscore cp (-?\d+)')
SCORE_MATE_RE = re.compile(r'\bscore mate (-?\d+)')
WDL_RE = re.compile(r'\bwdl (\d+) (\d+) (\d+)')
DEPTH_RE = re.compile(r'\bdepth (\d+)')
PV_RE = re.compile(r'\bpv (\S+)')

# mate 分换算成的 cp 值：给一个足够饱和的数，避免污染训练目标
MATE_CP = 3000


class EngineError(RuntimeError):
    pass


class UciEngine:
    """一个 Pikafish 子进程。单线程使用，别在多线程间共享。"""

    def __init__(self, exe, nnue=None, threads=1, hash_mb=64, show_wdl=True):
        self.exe = os.path.abspath(exe)
        if not os.path.isfile(self.exe):
            raise EngineError('找不到引擎可执行文件: %s' % self.exe)
        cwd = os.path.dirname(self.exe) or '.'
        self.proc = subprocess.Popen(
            [self.exe],
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self._q = queue.Queue()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

        self.send('uci')
        self.wait_for(lambda l: l == 'uciok', timeout=60)

        if nnue:
            nnue = os.path.abspath(nnue)
            if not os.path.isfile(nnue):
                raise EngineError('找不到 NNUE 权重文件: %s' % nnue)
            self.set_option('EvalFile', nnue)
        self.set_option('Threads', threads)
        self.set_option('Hash', hash_mb)
        self.set_option('MultiPV', 1)
        if show_wdl:
            # 让引擎直接给出胜/和/负概率，比拿 cp 分自己换算更准
            self.set_option('UCI_ShowWDL', 'true')
        self.isready()

    # ---------- 底层 IO ----------

    def _read_loop(self):
        try:
            for raw in iter(self.proc.stdout.readline, b''):
                line = raw.decode('utf-8', 'ignore').strip()
                if line:
                    self._q.put(line)
        except Exception:
            pass
        finally:
            self._q.put(None)

    def send(self, cmd):
        if self.proc.poll() is not None:
            raise EngineError('引擎进程已退出（返回码 %s）' % self.proc.returncode)
        try:
            self.proc.stdin.write((cmd + '\n').encode('ascii'))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise EngineError('向引擎写入失败: %s' % e)

    def _next_line(self, timeout):
        try:
            line = self._q.get(timeout=timeout)
        except queue.Empty:
            raise EngineError('等待引擎响应超时（%.0f 秒）' % timeout)
        if line is None:
            raise EngineError('引擎输出已结束')
        return line

    def wait_for(self, pred, timeout=120):
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                raise EngineError('等待引擎响应超时（%.0f 秒）' % timeout)
            line = self._next_line(remain)
            if pred(line):
                return line

    # ---------- 常用命令 ----------

    def set_option(self, name, value):
        self.send('setoption name %s value %s' % (name, value))

    def isready(self, timeout=180):
        self.send('isready')
        self.wait_for(lambda l: l == 'readyok', timeout=timeout)

    def new_game(self):
        self.send('ucinewgame')
        self.isready()

    def set_multipv(self, n):
        self.set_option('MultiPV', n)
        self.isready()

    # ---------- 搜索 ----------

    def go(self, moves, depth=None, movetime=None, timeout_pad=180):
        """
        从开局走起，搜索一步。

        返回 (bestmove, candidates)
        candidates 是按 multipv 序号排列的候选列表，每项形如
            {'pv': 'h2e2', 'cp': 25, 'mate': None, 'wdl': (200, 700, 100), 'depth': 8}

        注意 UCI 的 `position` 命令必须带 `moves` 关键字 ——
        漏掉的话引擎会把着法串当 FEN 解析，然后报 "Illegal move"，
        看上去像坐标转换错了，实际跟坐标毫无关系。
        """
        if depth is None and movetime is None:
            raise ValueError('depth 和 movetime 必须给一个')
        seq = (' moves ' + ' '.join(moves)) if moves else ''
        self.send('position startpos' + seq)
        if depth is not None:
            self.send('go depth %d' % depth)
        else:
            self.send('go movetime %d' % movetime)

        best = {}
        bestmove = None
        deadline = time.time() + (movetime / 1000.0 if movetime else 0) + timeout_pad

        while True:
            remain = deadline - time.time()
            if remain <= 0:
                raise EngineError('搜索超时')
            line = self._next_line(remain)

            if line.startswith('bestmove'):
                parts = line.split()
                bestmove = parts[1] if len(parts) > 1 else None
                break
            if not line.startswith('info '):
                continue
            if ' pv ' not in line:
                continue

            # 只保留每个 multipv 序号的最新一行（后出现的覆盖先前的）
            mp = MULTIPV_RE.search(line)
            idx = int(mp.group(1)) if mp else 1

            cp = None
            mate = None
            m = SCORE_MATE_RE.search(line)
            if m:
                mate = int(m.group(1))
                cp = MATE_CP if mate > 0 else -MATE_CP
            else:
                m = SCORE_CP_RE.search(line)
                if m:
                    cp = int(m.group(1))
            if cp is None:
                continue

            wdl = None
            m = WDL_RE.search(line)
            if m:
                wdl = (int(m.group(1)), int(m.group(2)), int(m.group(3)))

            d = DEPTH_RE.search(line)
            pv = PV_RE.search(line)

            best[idx] = {
                'pv': pv.group(1) if pv else None,
                'cp': cp,
                'mate': mate,
                'wdl': wdl,
                'depth': int(d.group(1)) if d else None,
            }

        if bestmove is None or bestmove == '(none)':
            return None, []

        cands = [best[i] for i in sorted(best.keys())]
        return bestmove, cands

    def quit(self):
        try:
            self.send('quit')
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def describe_candidate(c):
    """给日志用的一行摘要。"""
    wdl = c.get('wdl')
    wdl_s = '' if not wdl else ' wdl=%d/%d/%d' % wdl
    return 'cp=%s mate=%s%s pv=%s' % (c.get('cp'), c.get('mate'), wdl_s, c.get('pv'))
