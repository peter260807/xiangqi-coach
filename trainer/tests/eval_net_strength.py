"""
量化网络的判断力。

相关系数只说明"网络分和引擎分同向变化"，不说明"网络能不能挑对棋"。
这个脚本直接测后者：

  给一个局面，让 Pikafish 用 MultiPV 排出 N 个候选着法（引擎已排好序），
  再让网络按「走完之后对手胜率最低」来排序，看网络挑中的那一步
  在引擎的排序里排第几。

⚠️ 但只有这个数字会误导人 —— 网络只做静态评估，而基准是 N 层搜索，
这本身就不公平。所以脚本同时跑一个**对照**：让引擎自己评估同样这些
候选着法，但只给 depth 1。同样的候选集、同样的任务，只换"谁来打分"。

两个数字放在一起才有意义：
  - 网络名次 ≈ 引擎 depth 1 名次  -> 网络学到了引擎那一层的判断，
                                    差距来自搜索深度，属正常
  - 网络名次 明显差于 depth 1     -> 网络本身学得不够准

刻意用导出后的 .xqnn 文件来评估，而不是训练中途的 .pt 权重 ——
这样测的是真正要交付的那个文件。

    python tests/eval_net_strength.py
    python tests/eval_net_strength.py --positions 200 --multipv 8 --depth 12
"""
import argparse
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'src'))

import numpy as np                                             # noqa: E402

import xq                                                      # noqa: E402
from export import NumpyNet                                    # noqa: E402
from gen_data import REC_DTYPE, find_engine, find_nnue         # noqa: E402
from uci import UciEngine                                      # noqa: E402

NO_CP = -30000.0


def sample_positions(data_dir, want, seed):
    """从数据里随机抽局面。

    在全部记录上均匀抽样，而不是从一个文件里连取 ——
    同一局棋的连续局面高度相似，集中取会高估网络的表现。
    """
    files = sorted(glob.glob(os.path.join(data_dir, 'part_*.bin')))
    if not files:
        raise SystemExit('在 %s 里没找到 part_*.bin' % data_dir)

    arrays = []
    for path in files:
        n = os.path.getsize(path) // REC_DTYPE.itemsize
        if n:
            arrays.append(np.fromfile(path, dtype=REC_DTYPE, count=n))
    data = np.concatenate(arrays)
    print('  数据总量：%d 条记录' % len(data))

    rng = np.random.default_rng(seed)
    idx = rng.choice(len(data), size=min(want, len(data)), replace=False)

    out = []
    for i in idx:
        cells = np.frombuffer(data['board'][i], dtype=np.uint8)
        out.append(([chr(c) for c in cells],
                    'r' if data['side'][i] == 0 else 'b'))
    return out


def judge(engine, net, positions, multipv, depth, verbose):
    ranks, base_ranks, details, skipped = [], [], [], 0

    for k, (board, side) in enumerate(positions):
        opp = 'b' if side == 'r' else 'r'
        opp_side = 0 if opp == 'r' else 1

        try:
            engine.set_multipv(multipv)
            _best, cands = engine.go(fen=xq.to_engine_fen(board, side),
                                     depth=depth)
        except Exception as exc:
            skipped += 1
            if verbose:
                print('  [跳过] 搜索失败：%s' % exc)
            continue

        # 将杀局面给的是 mate 而不是 cp，排序含义不同，按精度排除
        usable = [c for c in cands if c.get('cp') is not None and c.get('pv')]
        if len(usable) < 2:
            skipped += 1
            continue

        # ---- 网络的排序 ----
        feats, sides = [], []
        for c in usable:
            after = list(board)
            xq.apply_move(after, c['pv'])
            feats.append(xq.feature_indices(after, opp))
            sides.append(opp_side)
        # 网络给的是「走完之后轮到对手时」的对手胜率，
        # 换算成我方胜率才能和引擎分值同向比较
        our = 1.0 - net.prob(feats, sides)
        rank = int(np.argmax(our))
        ranks.append(rank)

        # ---- 对照组的排序：引擎只看 depth 1 ----
        base_scores = []
        for c in usable:
            after = list(board)
            xq.apply_move(after, c['pv'])
            cp2 = None
            try:
                engine.set_multipv(1)
                _bm, c2 = engine.go(fen=xq.to_engine_fen(after, opp), depth=1)
                if c2:
                    cp2 = c2[0].get('cp')
            except Exception:
                cp2 = None
            # 引擎分是对手视角，取负换回我方视角
            base_scores.append(-float(cp2) if cp2 is not None else NO_CP)
        base_rank = int(np.argmax(base_scores))
        base_ranks.append(base_rank)

        details.append({
            'rank': rank,
            'base_rank': base_rank,
            'picked': usable[rank]['pv'],
            'engine_best': usable[0]['pv'],
            'engine_cp': usable[0]['cp'],
            'picked_cp': usable[rank]['cp'],
            'gap': usable[0]['cp'] - usable[rank]['cp'],
            'base_gap': usable[0]['cp'] - usable[base_rank]['cp'],
            'side': side,
            'n': len(usable),
            # 下面三项是给手写评估做对照用的：同一批局面、同一组候选，
            # 换成 engine.js 里那套位置价值表来排序，就能回答
            # "训出来的网络到底有没有比原来手写的强"
            'board': xq.board_to_fen(board),
            'cands': [c['pv'] for c in usable],
            'cps': [c['cp'] for c in usable],
        })

        if verbose and (k + 1) % 25 == 0:
            print('  已评估 %d/%d' % (k + 1, len(positions)))

    return ranks, base_ranks, details, skipped


def describe(tag, ranks, multipv):
    arr = np.asarray(ranks)
    n = len(arr)
    print('  %s' % tag)
    print('    平均名次          ：%.2f   （随机瞎猜是 %.1f）'
          % (arr.mean(), (multipv + 1) / 2.0))
    print('    选中引擎首选      ：%.1f%%' % ((arr == 0).mean() * 100))
    print('    落在前三名内      ：%.1f%%' % ((arr <= 2).mean() * 100))
    print()
    for r in range(multipv):
        cnt = int((arr == r).sum())
        if cnt:
            print('      第 %d 名 %4d 个 %5.1f%%  %s'
                  % (r + 1, cnt, cnt / n * 100,
                     '#' * max(1, int(round(cnt / n * 40)))))
    print()


def main():
    ap = argparse.ArgumentParser(description='评估训练出的网络有多接近引擎判断')
    ap.add_argument('--data', default=os.path.join(ROOT, 'data'))
    ap.add_argument('--net', default=os.path.join(ROOT, 'logs', 'xq-v1.xqnn'))
    ap.add_argument('--engine', default=None)
    ap.add_argument('--positions', type=int, default=100)
    ap.add_argument('--multipv', type=int, default=8)
    ap.add_argument('--depth', type=int, default=10,
                    help='基准搜索深度（当作"标准答案"）')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--show', type=int, default=0)
    ap.add_argument('--dump', default=None,
                    help='把这些局面和候选导出成 JSON，供手写评估做对照')
    args = ap.parse_args()

    exe = find_engine(args.engine)
    if not exe:
        raise SystemExit('没找到 Pikafish 引擎，用 --engine 指定')
    nnue = find_nnue(exe)
    if not os.path.isfile(args.net):
        raise SystemExit('找不到网络文件：%s' % args.net)

    print('=' * 66)
    print('网络判断力评估')
    print('=' * 66)
    print('  引擎    : %s' % os.path.basename(exe))
    print('  网络    : %s' % os.path.basename(args.net))
    print('  样本    : %d 个局面   MultiPV=%d   基准深度=%d'
          % (args.positions, args.multipv, args.depth))
    print()

    net = NumpyNet(args.net)
    print('  网络结构：%d -> %d -> %d -> 1'
          % (net.feat_dim, net.l1, net.l2))

    positions = sample_positions(args.data, args.positions, args.seed)

    engine = UciEngine(exe, nnue, threads=1, hash_mb=64)
    try:
        engine.isready()
        ranks, base_ranks, details, skipped = judge(
            engine, net, positions, args.multipv, args.depth,
            verbose=args.positions > 40)
    finally:
        engine.quit()

    if not ranks:
        raise SystemExit('没有一个局面评估成功')

    print()
    print('=' * 66)
    print('结果（%d 个局面，跳过 %d 个）' % (len(ranks), skipped))
    print('=' * 66)
    print()
    print('  两个数字要放在一起看：')
    print('  网络只做静态评估，depth 1 只做一层搜索，两者层次接近；')
    print('  而基准是 %d 层搜索。' % args.depth)
    print()

    describe('【基准】引擎 %d 层搜索作为标准答案' % args.depth,
             ranks, args.multipv)
    describe('【对照】引擎只用 depth 1 评估同样这些候选',
             base_ranks, args.multipv)

    net_avg = float(np.mean(ranks))
    base_avg = float(np.mean(base_ranks))
    print('  对比：网络 %.2f  vs  引擎 depth 1  %.2f' % (net_avg, base_avg))
    print()

    gaps = np.array([d['gap'] for d in details], dtype=float)
    print('  网络选错时的平均分损：%.1f 分（%.2f 个兵）'
          % (gaps.mean(), gaps.mean() / 100))
    print()

    if args.dump:
        import json
        with open(args.dump, 'w', encoding='utf-8') as f:
            json.dump([{'board': d['board'], 'side': d['side'],
                        'cands': d['cands'], 'cps': d['cps'],
                        'net_rank': d['rank'], 'base_rank': d['base_rank']}
                       for d in details], f)
        print('  已导出 %d 个局面到 %s（供手写评估对照）'
              % (len(details), args.dump))
        print()

    if args.show:
        print('  抽样对照（前 %d 个）：' % args.show)
        for d in details[:args.show]:
            print('    走子方 %s ｜ 引擎首选 %s(%d) ｜ 网络选 %s(%d) 名次%d'
                  % (d['side'], d['engine_best'], d['engine_cp'],
                     d['picked'], d['picked_cp'], d['rank'] + 1))
        print()

    print('=' * 66)
    if net_avg <= base_avg + 0.5:
        print(' 网络与引擎同层次评估的表现相当 —— 它学到了引擎那一层的判断，')
        print(' 与基准的差距主要来自搜索深度，属正常。')
    else:
        print(' 网络的静态评估弱于引擎的浅层搜索。这本身不奇怪 ——')
        print(' depth 1 除了评估还会做一层战术验证（我走这步，对方能吃我什么），')
        print(' 而网络是纯静态的，看不到这一步。')
        print()
        print(' 静态评估的质量该拿「手写评估」来比，那才是它的竞争对手：')
        print('   python tests/eval_net_strength.py --dump positions.json')
        print('   node tests/eval_handcrafted.js positions.json')
        print(' 两者都是静态评估，同一批局面、同一组候选，比出来才有意义。')
    print()
    print(' 提醒：网络是评估函数，不是搜索引擎。用它下棋必须配搜索，')
    print(' 单靠静态评估挑着法，本来就不可能追上多层搜索。')
    print('=' * 66)
    return 0


if __name__ == '__main__':
    sys.exit(main())
