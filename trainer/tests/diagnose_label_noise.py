"""
标签噪声天花板诊断。

问题背景：均势档（|cp|<100）的相关系数在 8 轮训练里一直平在 0.51~0.54，
而整体相关系数一路爬到 0.865。在投入去换更强特征之前，必须先分清：

  (a) 特征表达力不够 —— 换更强的特征（将位条件 / 成对关系）应当能提升
  (b) 标签本身带噪 —— 天花板就在那里，换什么特征都没用

做法：数据里有大量重复局面（同一局面在多局棋里反复出现），
它们的标签来自**不同的搜索历史** —— Pikafish 的重复局面检测依赖历史，
所以同一局面在不同对局中可能给出不同的 cp。把「同一局面的多条记录」
看成对同一个真值的重复测量，组内方差就是对标签噪声的直接估计。

由此得到相关系数的理论上限。设某个局面的组均值为 mu、组内噪声标准差为
sigma_w、组均值之间的标准差为 sigma_b，则即使预测器完美地预测出每个局面的
mu，它和「单条带噪标签」的相关系数也只有：

        corr_max = sigma_b / sqrt(sigma_b^2 + sigma_w^2)

训练集和验证集按局面去重后都只保留第一次出现的标签，两边用的都是带噪标签，
所以这个上限对训练和评估同时成立。

用法:
    python tests/diagnose_label_noise.py --data ../data
    python tests/diagnose_label_noise.py --data ../data --limit 5000000
"""
import argparse
import glob
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                os.pardir, 'src'))
from gen_data import REC_DTYPE, REC_SIZE, position_hashes   # noqa: E402


def load(data_dir, limit):
    files = sorted(set(glob.glob(os.path.join(data_dir, 'part_*.bin')) +
                        glob.glob(os.path.join(data_dir, '*.bin'))))
    if not files:
        raise SystemExit('在 %s 里没找到 part_*.bin' % data_dir)
    arrays = []
    total = 0
    for p in files:
        n = os.path.getsize(p) // REC_SIZE
        if n == 0:
            continue
        arrays.append(np.fromfile(p, dtype=REC_DTYPE, count=n))
        total += n
    d = np.concatenate(arrays) if len(arrays) > 1 else arrays[0]
    print('读取 %d 个分片 / %d 条记录' % (len(files), total))
    if limit and limit < len(d):
        d = d[:limit]
        print('按 --limit 截断到 %d 条' % len(d))
    return d


def group_stats(data):
    """把记录按局面分组，返回 (条数, 均值, 总体方差) 三个组级数组。"""
    h = position_hashes(data)
    order = np.argsort(h, kind='stable')
    hs = h[order]
    cp = data['cp'][order].astype(np.float64)
    del h, order

    new = np.empty(len(hs), dtype=bool)
    new[0] = True
    new[1:] = hs[1:] != hs[:-1]
    gid = np.cumsum(new, dtype=np.int64) - 1
    ng = int(gid[-1]) + 1
    print('唯一局面 %d 个（重复率 %.2f%%）' % (ng, 100.0 * (1 - ng / len(hs))))

    n = np.bincount(gid, minlength=ng).astype(np.float64)
    s1 = np.bincount(gid, weights=cp, minlength=ng)
    s2 = np.bincount(gid, weights=cp * cp, minlength=ng)
    mean = s1 / n
    var_pop = np.maximum(s2 / n - mean * mean, 0.0)
    return n, mean, var_pop


def ceiling(n, mean, var_pop, label):
    """
    在「组条数 >= 2」的组上算组内噪声与组间信号，给出相关系数上限。

    sigma_w^2 用无偏的合并估计：sum(n_i * var_pop_i) / sum(n_i - 1)
    sigma_b^2 用按记录加权的组均值方差（与记录级的相关系数口径一致）
    """
    m = n >= 2
    n_d, mu_d, vp_d = n[m], mean[m], var_pop[m]
    if len(mu_d) == 0:
        print('  [%s] 没有重复局面，无法估计' % label)
        return

    ss = float(np.sum(n_d * vp_d))                 # 组内平方和
    dof = float(np.sum(n_d - 1))
    w = n_d / n_d.sum()
    mu_bar = float(np.sum(w * mu_d))
    sig_w2 = ss / max(dof, 1.0)
    sig_b2 = float(np.sum(w * (mu_d - mu_bar) ** 2))

    sig_w = sig_w2 ** 0.5
    sig_b = sig_b2 ** 0.5
    ceil = sig_b / (sig_b2 + sig_w2) ** 0.5 if (sig_b2 + sig_w2) > 0 else float('nan')

    # 组内完全一致的组占比：标签有多"死"
    exact = float(np.mean(vp_d <= 0.0))
    n_rec = float(n_d.sum())

    print('  [%s]' % label)
    print('     组数 %d（占 %d 条记录，%.1f%%）'
          % (len(n_d), int(n_rec), 100.0 * n_rec / n.sum()))
    print('     组内标准差 sigma_w = %8.2f 分   （标签噪声）' % sig_w)
    print('     组间标准差 sigma_b = %8.2f 分   （可学信号）' % sig_b)
    print('     -> 相关系数上限         = %8.4f' % ceil)
    print('     组内完全一致的组占 %.1f%%' % (100.0 * exact))


def main():
    ap = argparse.ArgumentParser(description='标签噪声天花板诊断')
    ap.add_argument('--data', default='data', help='数据目录（相对 trainer/）')
    ap.add_argument('--limit', type=int, default=0, help='只用前 N 条（0=全部）')
    ap.add_argument('--bal', type=float, default=100.0,
                    help='均势档阈值（|组均值| < 该值算均势），默认 100')
    args = ap.parse_args()

    t0 = time.time()
    data = load(args.data, args.limit)
    print('算哈希并分组…')
    n, mean, var_pop = group_stats(data)
    del data

    print('')
    print('=' * 66)
    print('相关系数上限估计（基于重复局面的组内方差）')
    print('=' * 66)

    ceiling(n, mean, var_pop, '全部重复局面')

    bal = np.abs(mean) < args.bal
    ceiling(n[bal], mean[bal], var_pop[bal], '均势档 |组均值| < %.0f' % args.bal)

    # 分布参考：均势档在数据里占多大比重
    print('')
    print('参考：')
    print('     记录中「所在局面组均值落在均势档」的占 %.1f%%'
          % (100.0 * n[bal].sum() / n.sum()))
    print('     用时 %.1f 秒' % (time.time() - t0))


if __name__ == '__main__':
    main()
