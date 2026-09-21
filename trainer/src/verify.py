"""
验证训练出来的网络，产出一份人能看懂的结果报告。

    python verify.py --data ../data --net ../logs/xq-v1.xqnn --samples 5000

看三件事：
1. 相关系数 —— 网络输出的胜率与 Pikafish 判断的一致程度，这是最核心的指标
2. 分档准确度 —— 均势局面和一边倒局面，各自预测得准不准
3. 抽样对照 —— 随机挑几个局面，把棋盘、引擎评分、网络预测并排打出来看
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
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export import NumpyNet                      # noqa: E402
from gen_data import REC_DTYPE                   # noqa: E402
from model import CP_SCALE, PAD_INDEX            # noqa: E402
from train import compute_features, load_dataset  # noqa: E402


def render(rows):
    """把 90 格渲染成 10 行 9 列，带行号，方便肉眼核对。"""
    out = []
    for r in range(10):
        cells = ' '.join(chr(int(c)) for c in rows[r * 9:(r + 1) * 9])
        out.append('   %d  %s' % (9 - r, cells))
    out.append('      a b c d e f g h i')
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser(description='验证训练好的网络')
    ap.add_argument('--data', default='../data', help='数据目录')
    ap.add_argument('--net', required=True, help='导出后的 .xqnn 文件')
    ap.add_argument('--samples', type=int, default=4000, help='抽样条数')
    ap.add_argument('--show', type=int, default=6, help='打印多少个具体局面')
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()

    if not os.path.isfile(args.net):
        raise SystemExit('找不到网络文件: %s' % args.net)

    print('=' * 64)
    print('验证网络：%s' % args.net)
    print('=' * 64)

    data = load_dataset(args.data)
    total = len(data)
    n = min(total, args.samples)
    rng = np.random.default_rng(args.seed)
    idxs = np.sort(rng.choice(total, size=n, replace=False))

    boards = np.ascontiguousarray(data['board'][idxs]).view(np.uint8).reshape(n, 90)
    sides = data['side'][idxs].astype(np.uint8)
    cps = data['cp'][idxs].astype(np.int32)
    target = 1.0 / (1.0 + np.exp(-cps.astype(np.float32) / CP_SCALE))

    net = NumpyNet(args.net)
    feats = compute_features(boards, sides)
    feat_lists = [[int(v) for v in row if v != PAD_INDEX] for row in feats]
    pred = net.prob(feat_lists, sides.tolist())

    corr = float(np.corrcoef(pred, target)[0, 1])
    mae = float(np.mean(np.abs(pred - target)))
    rmse = float(np.sqrt(np.mean((pred - target) ** 2)))

    print()
    print('整体指标（%d 个抽样局面）' % n)
    print('  与引擎评分的相关系数 : %.4f   （越接近 1 越好，0.8 以上说明学得不错）' % corr)
    print('  平均绝对偏差         : %.4f   （胜率尺度，0.05 约等于 5 个百分点）' % mae)
    print('  均方根偏差           : %.4f' % rmse)

    print()
    print('分档表现')
    print('  %-18s %8s %10s %10s' % ('局面类型', '样本数', '相关系数', '平均偏差'))
    bands = [
        (0, 50, '均势 |cp|<50'),
        (50, 200, '稍优 50~200'),
        (200, 800, '明显优势 200~800'),
        (800, 10 ** 9, '大优/杀棋 >800'),
    ]
    for lo, hi, name in bands:
        m = (np.abs(cps) >= lo) & (np.abs(cps) < hi)
        k = int(m.sum())
        if k < 10:
            print('  %-18s %8d %10s %10s' % (name, k, '-', '-'))
            continue
        c = float(np.corrcoef(pred[m], target[m])[0, 1]) if pred[m].std() > 0 else float('nan')
        e = float(np.mean(np.abs(pred[m] - target[m])))
        print('  %-18s %8d %10.4f %10.4f' % (name, k, c, e))

    # 评估分转回 cp，看引擎侧用起来偏差多大
    p = np.clip(pred.astype(np.float64), 1e-6, 1 - 1e-6)
    pred_cp = CP_SCALE * np.log(p / (1 - p))
    cap = np.abs(cps) < 2000
    cp_mae = float(np.mean(np.abs(pred_cp[cap] - cps[cap])))
    print()
    print('  换算成引擎分值：平均偏差 %.1f 分（只统计 |引擎分|<2000 的局面）' % cp_mae)
    print('  （作为参考：一个兵约 100 分，所以这个偏差大致是 %.1f 个兵的量级）' % (cp_mae / 100))

    if args.show > 0:
        print()
        print('抽样对照（引擎分与网络预测）')
        picks = rng.choice(n, size=min(args.show, n), replace=False)
        for k, j in enumerate(picks, 1):
            src = int(idxs[j])
            print()
            print('  ── 样本 %d ──  走子方：%s' %
                  (k, '红' if sides[j] == 0 else '黑'))
            print(render(boards[j]))
            tgt = float(target[j])
            print('     引擎：%+6d 分  →  胜率 %.3f' % (cps[j], tgt))
            print('     网络：%+6.0f 分  →  胜率 %.3f   （偏差 %+.3f）'
                  % (pred_cp[j], pred[j], pred[j] - tgt))

    print()
    print('=' * 64)
    print('说明：网络是对 Pikafish 评估的近似，相关系数高说明它学到了引擎的判断。')
    print('      但它只是个评估函数，还需要接到拥有完整规则的搜索引擎里才能下棋。')
    print('=' * 64)


if __name__ == '__main__':
    main()
