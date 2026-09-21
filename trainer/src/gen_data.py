"""
自对弈数据生成：多进程拉起 Pikafish，记录每个局面的棋盘 + 引擎评估。

    python gen_data.py --engine /path/to/pikafish --nnue /path/to/pikafish.nnue \
                       --workers 14 --depth 8 --minutes 180 --out ../data

产出：out/part_00.bin, part_01.bin, ...（每个 worker 一个分片，避免并发写冲突）

关于「为什么用 depth 而不是 movetime」：
`go movetime N` 会让引擎把时间用满，哪怕 2ms 就已经找到最优着法了。
用它来估算产出速率会低估一个数量级以上。生成训练数据要用 `go depth N`
或 `go nodes N` 这类**确定性限流**，衡量的是计算量而不是时间预算。

关于「为什么要做开局随机」：
如果每步都走引擎的最优解，几百局下来的开头会长得一模一样，
网络根本见不到足够多样的局面。Pikafish 没有 RandomMove / Skill Level 选项，
所以这里用 MultiPV：开局阶段让引擎给出若干候选，按分数加权随机选一个。
"""

# 控制台编码兜底：Windows 的 cmd 默认是 GBK(936)，遇到它表示不了的字符
# 会抛 UnicodeEncodeError 而中断整个脚本。这里退化成替换而不是崩溃。
import sys as _sys
for _s in (_sys.stdout, _sys.stderr):
    try:
        _s.reconfigure(errors='replace')
    except Exception:
        pass
del _sys, _s
import argparse
import glob
import math
import os
import random
import sys
import time

import numpy as np
from multiprocessing import Event, Process, Value

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xq                                    # noqa: E402
from uci import EngineError, UciEngine       # noqa: E402

# 每条记录 93 字节：棋盘 90 + cp 分 2（int16）+ 走子方 1
REC_DTYPE = np.dtype([('board', 'S90'), ('cp', '<i2'), ('side', 'u1')])
REC_SIZE = REC_DTYPE.itemsize

# 记录内部各字段的字节偏移。写成常量并做断言校验，字段顺序一旦被改动
# 会立刻炸出来，而不是安静地算出一个错的哈希。
_OFF_BOARD = 0
_OFF_CP = 90
_OFF_SIDE = 92
_HASH_CHUNK = 4_000_000


def position_hashes(data):
    """
    给每条记录算一个基于 (棋盘, 走子方) 的 64 位哈希。

    放在这个模块里而不是 train.py，是因为它只依赖 numpy 和记录布局：
    和 REC_DTYPE 待在一起能保证字节偏移不会跟记录格式脱节，
    也避免「只想统计一下数据集」的人被 torch 依赖挡住。

    刻意**不含 cp**：同一个局面分值应当一致，但去重和划分要按「局面」做，
    把分值混进来会让本该认出来的重复漏掉。

    实现上不逐字节哈希，而是把 91 个字节补到 96 字节后按 8 字节一组
    折叠 —— 同样的结果，少一个数量级的循环。分块处理避免一次性
    分配几 GB 的临时缓冲。
    """
    n = len(data)
    raw = np.ascontiguousarray(data).view(np.uint8).reshape(n, REC_SIZE)

    assert REC_SIZE == 93, '记录长度变了（%d），请同步下面的偏移常量' % REC_SIZE
    assert int(raw[0, _OFF_SIDE]) == int(data['side'][0]), \
        'side 字段的字节偏移不是 %d，字段顺序被改动过' % _OFF_SIDE

    h = np.zeros(n, dtype=np.uint64)
    for s in range(0, n, _HASH_CHUNK):
        e = min(s + _HASH_CHUNK, n)
        m = e - s
        buf = np.zeros((m, 96), dtype=np.uint8)
        buf[:, :90] = raw[s:e, _OFF_BOARD:_OFF_BOARD + 90]
        buf[:, 90] = raw[s:e, _OFF_SIDE]
        u = buf.view(np.uint64).reshape(m, 12)
        hh = u[:, 0].copy()
        for k in range(1, 12):
            hh = hh * np.uint64(1000003) + u[:, k]
        h[s:e] = hh
    return h


# 训练包根目录（src 的上一层），引擎固定放在它下面的 engine/
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_DIR = os.path.join(ROOT, 'engine')


def find_engine(explicit=None):
    """找 Pikafish 可执行文件，找不到返回 None。

    这件事刻意放在 Python 里做，而不是放在 .bat 里 —— 在 cmd 里靠 for
    遍历加延迟展开去拼路径，既难写又难测，出错时的表现还只是"变量是空的"。
    这里用 glob，规则一目了然，而且允许用户多套一层目录。
    """
    if explicit:
        return explicit if os.path.isfile(explicit) else None

    patterns = [
        os.path.join(ENGINE_DIR, 'pikafish*.exe'),
        os.path.join(ENGINE_DIR, 'Pikafish*.exe'),
        os.path.join(ENGINE_DIR, '**', 'pikafish*.exe'),
        os.path.join(ENGINE_DIR, '**', 'Pikafish*.exe'),
        os.path.join(ENGINE_DIR, 'pikafish'),
        os.path.join(ENGINE_DIR, '**', 'pikafish'),
    ]
    for pat in patterns:
        hits = sorted(glob.glob(pat, recursive=True))
        if hits:
            return hits[0]

    # 兜底：目录里任何一个 exe。从官网下载下来通常叫
    # Pikafish-Windows-x86-64-universal.exe，用户不一定会改名。
    # 引擎目录里一般就这一个可执行文件，用它基本不会错。
    for pat in (os.path.join(ENGINE_DIR, '*.exe'),
                os.path.join(ENGINE_DIR, '**', '*.exe')):
        hits = sorted(glob.glob(pat, recursive=True))
        if hits:
            return hits[0]
    return None


def find_nnue(engine_path, explicit=None):
    """找 NNUE 权重。

    必须让引擎能找到它：要么和 exe 同目录（引擎默认会找同目录的 .nnue），
    要么显式设 EvalFile。所以优先在 exe 旁边找。
    """
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    if not engine_path:
        return None
    d = os.path.dirname(os.path.abspath(engine_path))
    hits = sorted(glob.glob(os.path.join(d, '*.nnue')))
    if not hits:
        # 有些发布包解压出来会多一层目录
        hits = sorted(glob.glob(os.path.join(d, '..', '*.nnue')))
    return hits[0] if hits else None


def describe_engine_dir():
    """找不到引擎时把现场情况说清楚，省得用户来回猜。"""
    lines = ['引擎目录：%s' % ENGINE_DIR]
    if not os.path.isdir(ENGINE_DIR):
        lines.append('这个目录还不存在 —— 需要先手动创建，再把引擎放进去。')
        return '\n'.join(lines)

    entries = sorted(os.listdir(ENGINE_DIR))
    if not entries:
        lines.append('目录是空的 —— 需要把 Pikafish 的 exe 和 .nnue 复制进来。')
        return '\n'.join(lines)

    lines.append('目录里现有 %d 项：' % len(entries))
    for name in entries[:20]:
        full = os.path.join(ENGINE_DIR, name)
        if os.path.isdir(full):
            lines.append('  [目录] %s' % name)
        else:
            lines.append('  %-46s %8.1f MB'
                         % (name, os.path.getsize(full) / 1024 / 1024))
    if len(entries) > 20:
        lines.append('  ...（还有 %d 项）' % (len(entries) - 20))
    return '\n'.join(lines)
BATCH = 8192             # 攒够这么多条再落盘，减少 IO 次数
MULTIPV_N = 6            # 开局随机阶段的候选数


def board_bytes(board):
    return ''.join(board).encode('ascii')


def clamp_cp(cp):
    return max(-30000, min(30000, int(cp)))


def choose_from_candidates(cands, rng, temperature=80.0, max_gap=250):
    """
    从候选着法里加权随机挑一个。

    权重按与最优分的差距做 softmax：差得越远权重越低，
    差距超过 max_gap 的直接排除（不让引擎走出明显坏棋，
    否则数据里会混进大量无意义的败局）。
    """
    usable = [c for c in cands if c.get('pv')]
    if len(usable) <= 1:
        return usable[0]['pv'] if usable else None

    top = usable[0]['cp']
    weights = []
    for c in usable:
        gap = c['cp'] - top           # <= 0
        weights.append(0.0 if -gap > max_gap else math.exp(gap / temperature))

    total = sum(weights)
    if total <= 0:
        return usable[0]['pv']

    r = rng.random() * total
    acc = 0.0
    for c, w in zip(usable, weights):
        acc += w
        if r <= acc:
            return c['pv']
    return usable[-1]['pv']


def play_game(eng, start_fen, depth, max_plies, opening_plies, rng):
    """跑一局，返回记录列表 [(board_bytes, cp, side_int), ...]"""
    board = xq.parse_fen(start_fen)
    moves = []
    side = 'r'
    records = []
    n_rand = rng.randint(0, opening_plies) if opening_plies > 0 else 0
    cur_multi = 1

    for ply in range(max_plies):
        want_multi = MULTIPV_N if ply < n_rand else 1
        if want_multi != cur_multi:
            eng.set_multipv(want_multi)
            cur_multi = want_multi

        bestmove, cands = eng.go(moves, depth=depth)
        if not bestmove:
            break                      # 无着可走：将死或困毙，本局结束

        top = cands[0] if cands else None
        if top is not None:
            records.append((board_bytes(board), clamp_cp(top['cp']),
                            0 if side == 'r' else 1))

        if cur_multi > 1 and len(cands) > 1:
            mv = choose_from_candidates(cands, rng) or bestmove
        else:
            mv = bestmove

        # 记录里的评估是「走子前」的，着法要接着应用
        xq.apply_move(board, mv)
        moves.append(mv)
        side = xq.mirror_side(side)

    return records


def worker(wid, args, counter, stop_event):
    rng = random.Random(args.seed * 1000 + wid * 7919)
    out_path = os.path.join(args.out, 'part_%02d.bin' % wid)
    eng = None
    f = None
    buf = np.empty(BATCH, dtype=REC_DTYPE)
    n = 0
    games = 0
    written = 0
    t0 = time.time()
    deadline = t0 + args.minutes * 60
    errors = 0

    def flush():
        nonlocal n, written
        if n > 0:
            buf[:n].tofile(f)
            f.flush()
            written += n
            n = 0

    try:
        eng = UciEngine(args.engine, args.nnue, threads=1,
                        hash_mb=args.hash, show_wdl=False)
        f = open(out_path, 'ab')

        while not stop_event.is_set() and time.time() < deadline:
            if args.records and counter.value >= args.records:
                break
            try:
                eng.new_game()
                recs = play_game(eng, xq.START_FEN, args.depth,
                                 args.max_plies, args.opening_plies, rng)
            except EngineError as e:
                # 偶发超时不致命：重启引擎继续，别让整晚的算力浪费在退出上
                errors += 1
                print('[worker %02d] 引擎异常，重启: %s' % (wid, e), flush=True)
                try:
                    eng.quit()
                except Exception:
                    pass
                time.sleep(2)
                eng = UciEngine(args.engine, args.nnue, threads=1,
                                hash_mb=args.hash, show_wdl=False)
                continue

            for rec in recs:
                buf[n] = rec
                n += 1
                if n == BATCH:
                    flush()
            games += 1
            with counter.get_lock():
                counter.value += len(recs)

            if games % 20 == 0:
                el = time.time() - t0
                rate = written_count(written, n) / max(el, 1e-9)
                print('[worker %02d] %d 局 / %d 局面 / %.0f 局面每秒'
                      % (wid, games, written_count(written, n), rate), flush=True)

        flush()
    except Exception as e:
        print('[worker %02d] 停止: %s' % (wid, e), flush=True)
        try:
            flush()
        except Exception:
            pass
    finally:
        if f:
            f.close()
        if eng:
            eng.quit()
        el = time.time() - t0
        print('[worker %02d] 结束：%d 局，%d 局面，用时 %.0f 秒，异常 %d 次'
              % (wid, games, written, el, errors), flush=True)


def written_count(written, n):
    return written + n


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description='Pikafish 自对弈生成 NNUE 训练数据')
    ap.add_argument('--engine', default=None,
                    help='Pikafish 可执行文件路径；省略时自动在 engine/ 目录里找')
    ap.add_argument('--nnue', default=None,
                    help='NNUE 权重文件路径（引擎在同目录找得到时可省略）')
    ap.add_argument('--out', default='../data', help='输出目录')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 4) - 2),
                    help='并行进程数，默认 CPU 核数减 2')
    ap.add_argument('--depth', type=int, default=8,
                    help='每步搜索深度（默认 8；调大质量更高但更慢）')
    ap.add_argument('--hash', type=int, default=64,
                    help='每个引擎实例的置换表大小 MB')
    ap.add_argument('--max-plies', type=int, default=220,
                    help='单局最多走多少手')
    ap.add_argument('--opening-plies', type=int, default=12,
                    help='开局随机步数上限（0 表示关闭随机，全部走最优着法）。'
                         '默认 12 是实测调上去的：原来只给 6，平均才 3 手随机，'
                         '后续着法完全由引擎决定，生成的两千万条里重复率高达 63%%')
    ap.add_argument('--minutes', type=float, default=180,
                    help='每个 worker 运行多少分钟')
    ap.add_argument('--records', type=int, default=0,
                    help='总局面数上限（0 表示不限，按时间跑）')
    ap.add_argument('--seed', type=int, default=20260921)
    return ap.parse_args(argv)


def main():
    args = parse_args()

    if args.engine and not os.path.isfile(args.engine):
        print('[失败] --engine 指定的文件不存在：%s' % args.engine)
        return 1

    args.engine = find_engine(args.engine)
    if not args.engine:
        print('=' * 64)
        print('[失败] 没找到 Pikafish 引擎')
        print('=' * 64)
        print()
        print('请把解压出来的这两个文件放进 engine/ 目录（两者必须在同一层）：')
        print('  Pikafish-Windows-x86-64-universal.exe   （改名为 pikafish.exe 更省事）')
        print('  pikafish.nnue                           （约 50 MB）')
        print()
        print('下载：https://github.com/official-pikafish/Pikafish/releases')
        print()
        print(describe_engine_dir())
        return 1

    args.engine = os.path.abspath(args.engine)

    args.nnue = find_nnue(args.engine, args.nnue)
    if args.nnue:
        args.nnue = os.path.abspath(args.nnue)
    else:
        print('[提示] engine/ 里没找到 .nnue 权重，交给引擎自己去旁边找。')
        print('       若随后报权重加载失败，把 pikafish.nnue 放到 exe 同目录。')

    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)

    print('=' * 64)
    print('自对弈数据生成')
    print('  引擎      : %s' % args.engine)
    print('  权重      : %s' % (args.nnue or '（引擎自动查找）'))
    print('  输出目录  : %s' % args.out)
    print('  并行进程  : %d' % args.workers)
    print('  搜索深度  : %d' % args.depth)
    print('  运行时长  : %.0f 分钟' % args.minutes)
    print('  开局随机  : %d 手' % args.opening_plies)
    print('=' * 64)

    stop = Event()
    counter = Value('q', 0)
    procs = []
    for wid in range(args.workers):
        p = Process(target=worker, args=(wid, args, counter, stop), daemon=False)
        p.start()
        procs.append(p)

    t0 = time.time()
    try:
        while any(p.is_alive() for p in procs):
            time.sleep(20)
            el = time.time() - t0
            recs = counter.value
            eta = (args.minutes * 60 - el)
            print('>>> 汇总：%d 局面，已跑 %.0f 分钟，速率 %.0f 局面每秒，剩余 %.0f 分钟'
                  % (recs, el / 60, recs / max(el, 1e-9), max(eta, 0) / 60), flush=True)
    except KeyboardInterrupt:
        print('\n收到中断信号，正在让各 worker 收尾…')
        stop.set()
    finally:
        for p in procs:
            p.join(timeout=120)

    total = counter.value
    el = time.time() - t0
    print()
    print('=' * 64)
    print('完成：共 %d 局面，用时 %.1f 分钟，平均 %.0f 局面每秒' % (total, el / 60, total / max(el, 1e-9)))
    print('数据分片：')
    grand = 0
    for wid in range(args.workers):
        path = os.path.join(args.out, 'part_%02d.bin' % wid)
        if os.path.isfile(path):
            size = os.path.getsize(path)
            cnt = size // REC_SIZE
            grand += cnt
            print('  part_%02d.bin  %12d 条  %8.1f MB' % (wid, cnt, size / 1024 / 1024))
    print('合计 %d 条记录，%.2f GB' % (grand, grand * REC_SIZE / 1024 / 1024 / 1024))
    print('=' * 64)


if __name__ == '__main__':
    # 让 exit code 反映成功与否，bat 那边才能用 errorlevel 判断
    sys.exit(main() or 0)
