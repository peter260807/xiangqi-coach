"""
验证训练出来的网络，产出一份人能看懂的结果报告。

    python verify.py --data ../data --net ../logs/xq-v2.xqnn --samples 5000

看四件事：
1. 整体相关系数 —— 网络输出分值与 Pikafish 判断的一致程度
2. **均势档相关系数** —— |cp|<100 的局面单独算一次。这一项才是关键指标：
   整体相关系数会被少量一边倒的局面撑得虚高（v1 报 0.9797），而均势局面
   占了样本的 57%，恰恰是排序最需要分辨力的地方（v1 实际只有 0.62）
3. 分档表现 —— 各分值区间内预测得准不准
4. 抽样对照 —— 随机挑几个局面，把棋盘、引擎评分、网络预测并排打出来看

    python verify.py --data ../data --net ../logs/xq-v2.xqnn --samples 4000 --show 3
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
from model import PAD_INDEX                      # noqa: E402
from train import compute_features, load_dataset  # noqa: E402


def render(rows):
    """把 90 格渲染成 10 行 9 列，带行号，方便肉眼核对。"""
    out = []
    for r in range(10):
        cells = ' '.join(chr(int(c)) for c in rows[r * 9:(r + 1) * 9])
        out.append('   %d  %s' % (9 - r, cells))
    out.append('      a b c d e f g h i')
    return '\n'.join(out)


def corr(a, b):
    if len(a) < 10 or a.std() == 0 or b.std() == 0:
        return float('nan')
    return float(np.corrcoef(a, b)[0, 1])


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
    cps = data['cp'][idxs].astype(np.float64)

    net = NumpyNet(args.net)
    print()
    print('  网络结构：%d -> %d -> %d -> 1，输出 1.0 = %.0f 分'
          % (net.feat_dim, net.l1, net.l2, net.output_scale))

    feats = compute_features(boards, sides)
    feat_lists = [[int(v) for v in row if v != PAD_INDEX] for row in feats]
    pred_cp = net.cp(feat_lists, sides.tolist()).astype(np.float64)

    mae = float(np.mean(np.abs(pred_cp - cps)))
    rmse = float(np.sqrt(np.mean((pred_cp - cps) ** 2)))
    m_bal = np.abs(cps) < 100

    print()
    print('整体指标（%d 个抽样局面）' % n)
    print('  整体相关系数         : %.4f' % corr(pred_cp, cps))
    print('  均势档相关系数       : %.4f   （|cp|<100，%d 个局面 —— 这一项才是关键）'
          % (corr(pred_cp[m_bal], cps[m_bal]), int(m_bal.sum())))
    print('  平均绝对偏差         : %.1f 分   （一个兵约 100 分）' % mae)
    print('  均势档平均绝对偏差   : %.1f 分'
          % float(np.mean(np.abs(pred_cp[m_bal] - cps[m_bal]))))
    print('  均方根偏差           : %.1f 分' % rmse)

    print()
    print('分档表现')
    print('  %-20s %8s %10s %10s' % ('局面类型', '样本数', '相关系数', '平均偏差'))
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
            print('  %-20s %8d %10s %10s' % (name, k, '-', '-'))
            continue
        print('  %-20s %8d %10.4f %10.1f'
              % (name, k, corr(pred_cp[m], cps[m]),
                 float(np.mean(np.abs(pred_cp[m] - cps[m])))))

    if args.show > 0:
        print()
        print('抽样对照（引擎分与网络预测）')
        picks = rng.choice(n, size=min(args.show, n), replace=False)
        for k, j in enumerate(picks, 1):
            print()
            print('  ── 样本 %d ──  走子方：%s' %
                  (k, '红' if sides[j] == 0 else '黑'))
            print(render(boards[j]))
            print('     引擎：%+6d 分    网络：%+6.0f 分   （偏差 %+.0f 分）'
                  % (cps[j], pred_cp[j], pred_cp[j] - cps[j]))

    print()
    print('=' * 64)
    print('说明：网络是对 Pikafish 评估的近似，相关系数高说明它学到了引擎的判断。')
    print('      但它只是个评估函数，还需要接到拥有完整规则的搜索引擎里才能下棋。')
    print('      要判断它能不能挑对棋，跑 tests/eval_net_strength.py。')
    print('=' * 64)


if __name__ == '__main__':
    main()
