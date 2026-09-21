"""
训练单步的性能拆解与显存估算。

用途有两个：
  1. 复现 README 里那张「CPU 侧 / 加速器侧」占比表
  2. 换机器之后自己跑一遍，看瓶颈到底在哪、显存够不够

结论先写在前面：这个网络只有几十万参数（512/64 是 68 万），显存从来不是
约束，吞吐主要取决于 CPU 侧的特征编码。所以换一张更强的显卡，
训练时间不会有明显变化。

    python tests/bench_train_step.py
    python tests/bench_train_step.py --l1 256 --l2 32    # 复现 v1 的结构
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))

import numpy as np                                              # noqa: E402
import torch                                                    # noqa: E402

from gen_data import REC_DTYPE                                  # noqa: E402
from model import XQNet, huber_loss                             # noqa: E402
from train import compute_features, make_target                 # noqa: E402

BATCH = 8192
ROUNDS = 20
START = ('rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./'
         'P.P.P.P.P/.C.....C./........./RNBAKABNR')


def make_fake_data(nrow=200000, seed=1):
    """造与真实格式完全一致的数据，包括那个 93 字节的结构化记录。"""
    rng = np.random.default_rng(seed)
    data = np.zeros(nrow, dtype=REC_DTYPE)
    base = np.array([ord(c) for c in START.replace('/', '')], dtype=np.uint8)
    rows = np.tile(base, (nrow, 1))
    for i in range(nrow):
        k = int(rng.integers(0, 24))
        if k:
            rows[i, rng.choice(90, size=k, replace=False)] = ord('.')
    # board 字段是 S90，90 个字节一行
    data['board'] = rows.reshape(nrow * 90).view('S90')
    data['side'] = rng.integers(0, 2, size=nrow).astype(np.int8)
    data['cp'] = rng.integers(-2000, 2000, size=nrow).astype(np.int16)
    return data, rng


def bench(name, fn, rounds=ROUNDS):
    fn()
    t0 = time.perf_counter()
    for _ in range(rounds):
        out = fn()
    dt = (time.perf_counter() - t0) / rounds
    return dt, out


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='拆解训练单步的耗时')
    ap.add_argument('--l1', type=int, default=512)
    ap.add_argument('--l2', type=int, default=64)
    ap.add_argument('--device', default='cpu',
                    help='默认 cpu：这里要拆的是相对占比，用 CPU 计时更稳')
    return ap.parse_args(argv)


def main():
    args = parse_args()
    data, rng = make_fake_data()
    idxs = rng.permutation(len(data))[:BATCH]

    print('=' * 66)
    print('训练单步拆解（batch = %d，网络 %d/%d，设备 %s）'
          % (BATCH, args.l1, args.l2, args.device))
    print('=' * 66)
    print()
    print('  %-36s %9s %8s' % ('环节', 'ms/batch', '占比'))

    timings = {}

    dev = torch.device(args.device)
    net = XQNet(l1=args.l1, l2=args.l2).to(dev)
    n_param = sum(p.numel() for p in net.parameters())
    opt = torch.optim.Adam(net.parameters(), lr=1e-3)

    def raw_rows():
        return (data['board'][idxs], data['side'][idxs], data['cp'][idxs])

    t, raw = bench('1  结构化数组取行 data[field][idxs]', raw_rows)
    timings['1 取行'] = t
    boards_raw, sides, cps = raw

    t, boards = bench('2  view(uint8).reshape(B,90)',
                      lambda: boards_raw.view(np.uint8).reshape(BATCH, 90))
    timings['2 变形'] = t
    sides_u8 = sides.astype(np.uint8)

    t, feats = bench('3  compute_features（内含 argsort）',
                     lambda: compute_features(boards, sides_u8))
    timings['3 特征编码'] = t

    def target():
        return make_target(cps, 'value')

    t, tgt_np = bench('4  cp 换算成目标值（线性分值）', target)
    timings['4 目标值'] = t

    def to_tensor():
        return (torch.from_numpy(feats),
                torch.from_numpy(sides.astype(np.int64)),
                torch.from_numpy(tgt_np.astype(np.float32)))

    t, (idx_t, side_t, tgt_t) = bench('5  numpy 转 torch 张量', to_tensor)
    timings['5 转张量'] = t

    def fwd_bwd():
        opt.zero_grad(set_to_none=True)
        loss = huber_loss(net(idx_t, side_t), tgt_t)
        loss.backward()
        return loss

    t, _ = bench('6  前向 + 反向', fwd_bwd)
    timings['6 前向反向'] = t

    t, _ = bench('7  optimizer.step()（Adam）', opt.step)
    timings['7 优化器'] = t

    t, _ = bench('8  每批打乱索引', lambda: rng.permutation(BATCH))
    timings['8 打乱'] = t

    total = sum(timings.values())
    for k in sorted(timings):
        print('  %-36s %9.2f %7.1f%%' % (k, timings[k] * 1000,
                                         100 * timings[k] / total))
    print('  %-36s %9.2f %7.1f%%' % ('合计', total * 1000, 100.0))
    print()
    cpu_side = sum(v for k, v in timings.items() if not k.startswith('6'))
    print('  CPU 侧: %6.2f ms (%2.0f%%)    网络前向反向: %6.2f ms (%2.0f%%)'
          % (cpu_side * 1000, 100 * cpu_side / total,
             timings['6 前向反向'] * 1000,
             100 * timings['6 前向反向'] / total))
    print('  折算吞吐: %.0f 局面/秒（此为 CPU 训练的下限参考）' % (BATCH / total))

    print()
    print('=' * 66)
    print('显存估算（batch = %d）' % BATCH)
    print('=' * 66)
    pieces = [
        ('特征索引 (B,32) int64', feats.nbytes),
        # acc 和 h1 是两个独立的 (B,l1) 张量，别只算一个
        ('累加器 acc (B,%d) f32' % args.l1, BATCH * args.l1 * 4),
        ('激活 h1 (B,%d) f32' % args.l1, BATCH * args.l1 * 4),
        ('h2 (B,%d) f32' % args.l2, BATCH * args.l2 * 4),
        ('输出 (B,1) f32', BATCH * 4),
    ]
    single = 0
    for name, nb in pieces:
        single += nb
        print('  %-38s %8.2f MB' % (name, nb / 1024 / 1024))
    print('  %-38s %8.2f MB' % ('单份激活小计', single / 1024 / 1024))
    print('  %-38s %8.2f MB' % ('反向再存约两倍', single * 2 / 1024 / 1024))
    print('  %-38s %8.2f MB' % ('PyTorch 运行时（估）', 300))
    need_mb = single * 3 / 1024 / 1024 + 300
    print('  %-38s %8.2f MB' % ('合计约', need_mb))
    print()
    for gb in (8, 11, 12, 24):
        print('  %2d GB 显存 -> 裕度约 %5.1f 倍' % (gb, gb * 1024 / need_mb))
    print()
    print('  网络参数：%d 个' % n_param)
    print('  结论：显存不是约束。想省时间应该减少 CPU 侧的特征计算，')
    print('        或者用更大的 batch 摊薄每批的固定开销 —— 而不是换显卡。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
