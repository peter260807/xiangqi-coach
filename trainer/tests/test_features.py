"""
特征编码与线性探针的自证测试。

两条主线：

1. 特征编码的正确性。向量化实现必须与「单局面参考实现」逐个相等，
   且 pst 必须与历史实现**逐位相等** —— 它是既有基线的口径，动了它
   所有历史对比数字就失效了。这条测试是防回归的关键。

2. 线性探针的正规方程。它用 bincount 拼出 X^T X，绕过了稠密矩阵
   （11340 维稠密要 400 GB）。这种「等价性优化」最容易静默算错，
   所以必须拿稠密最小二乘对拍。

   对拍有两个坑，踩过：
     - 参考实现必须只取 bucket == k 的行。用了桶内局部索引之后，
       不同桶的行落在同一个列空间里，混在一起算出来的 X^T X
       包含跨桶的交叉项，和分块解出来的根本不是一回事。
     - 参考实现的 ridge 必须和被测代码用同一个 λ，否则差异全来自
       正则化路径不同（lstsq 的 rcond 与加 λI 不等价），看着像 bug。

用法:
    python tests/test_features.py
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'src'))
sys.path.insert(0, HERE)

import features as F                                          # noqa: E402
import linear_probe as LP                                     # noqa: E402
from gen_data import REC_DTYPE, REC_SIZE                      # noqa: E402

FAILED = []


def check(name, ok, detail=''):
    print('  %s %s%s' % ('[OK]  ' if ok else '[FAIL]', name,
                         ('  ' + detail) if detail else ''))
    if not ok:
        FAILED.append(name)
    return ok


def find_data_file():
    for d in ('data', 'data/v2'):
        p = os.path.join(ROOT, d, 'part_00.bin')
        if os.path.isfile(p):
            return p
    return None


def load_records(path, n):
    cnt = min(n, os.path.getsize(path) // REC_SIZE)
    data = np.fromfile(path, dtype=REC_DTYPE, count=cnt)
    boards = np.ascontiguousarray(data['board']).view(np.uint8).reshape(cnt, 90)
    sides = data['side'].astype(np.uint8)
    return data, boards, sides


# ---------------- 1. 特征编码 ----------------

def historical_pst(boards, sides):
    """
    历史 pst 编码的**独立重写**（照 xq.py 的说明从零写，不引用 features.py）。

    重写而不是 import 旧函数，是因为旧函数已经删掉、改成转发到 features 了；
    重写一遍才真的在对照，而不是自己跟自己比。
    """
    base = np.full(256, -1, dtype=np.int16)
    is_red = np.zeros(256, dtype=bool)
    for i, ch in enumerate('KABNRCP'):
        base[ord(ch)] = i
        is_red[ord(ch)] = True
    for i, ch in enumerate('kabnrcp'):
        base[ord(ch)] = i
        is_red[ord(ch)] = False

    sq = np.arange(90, dtype=np.int16)[None, :]
    b = base[boards]
    occ = b >= 0
    own = (is_red[boards] == (sides == 0)[:, None])
    feat_all = sq * 14 + (b + np.where(own, 0, 7))
    order = np.argsort(~occ, axis=1, kind='stable')
    take = order[:, :32]
    cols = np.take_along_axis(feat_all, take, axis=1)
    valid = np.take_along_axis(occ, take, axis=1)
    return np.where(valid, cols, 1260).astype(np.int64)


def test_dims():
    print('维度常量')
    want = {'pst': (1260, 1), 'halfka': (11340, 9),
            'halfka_rand': (11340, 9), 'fullka': (102060, 81)}
    for m, (dim, nb) in want.items():
        check('%s: %d 维 / %d 桶' % (m, dim, nb),
              F.feature_dim(m) == dim and F.num_buckets(m) == nb
              and F.pad_index(m) == dim)
    check('fullka 维度 = 81 x 1260', F.feature_dim('fullka') == 81 * 1260)


def test_pst_matches_history(data, boards, sides):
    print('pst 与历史实现逐位一致（基线口径不能动）')
    got = F.compute_features(boards, sides, 'pst')
    ref = historical_pst(boards, sides)
    bad = int((got != ref).sum())
    check('%d 条记录逐元素相等' % len(boards), bad == 0, '不一致 %d 个' % bad)


def test_vector_matches_scalar(data, boards, sides):
    print('向量化实现 vs 单局面参考实现（逐条）')
    for mode in ('halfka', 'fullka'):
        f = F.compute_features(boards, sides, mode)
        pad = F.pad_index(mode)
        n = min(400, len(boards))
        bad = []
        for i in range(n):
            board = [chr(ch) for ch in data['board'][i]]
            side = 'r' if sides[i] == 0 else 'b'
            a = sorted(F.feature_indices(board, side, mode))
            b = sorted(int(v) for v in f[i] if v != pad)
            if a != b:
                bad.append(i)
        check('%s 对照 %d 条' % (mode, n), not bad,
              '' if not bad else '不一致 %d 条（例 #%d）' % (len(bad), bad[0]))
    try:
        F.feature_indices(['.'] * 90, 'r', 'halfka_rand')
        check('halfka_rand 拒绝标量参考调用', False)
    except ValueError:
        check('halfka_rand 拒绝标量参考调用（它是纯向量化对照组）', True)


def test_palace_bucket():
    print('宫格桶的含义与防御性校验')
    import xq
    start = list(xq.START_FEN.replace('/', ''))
    b0 = np.frombuffer(''.join(start).encode(), dtype=np.uint8).reshape(1, 90)
    for s, who in ((0, '红'), (1, '黑')):
        hk = F.king_buckets(b0, np.array([s], np.uint8), 'halfka')[0]
        fk = F.king_buckets(b0, np.array([s], np.uint8), 'fullka')[0]
        check('起点局面 %s方走：halfka=%d fullka=%d' % (who, hk, fk),
              hk == 1 and fk == 10, '期望 1 / 10（双方都在底线中路）')

    # 把红帅挪到九宫外（r=5），必须报错而不是算出一个越界桶号
    moved = list(start)
    moved[9 * 9 + 4] = '.'
    moved[5 * 9 + 4] = 'K'
    b1 = np.frombuffer(''.join(moved).encode(), dtype=np.uint8).reshape(1, 90)
    try:
        F.king_buckets(b1, np.array([0], np.uint8), 'halfka')
        check('将/帅出九宫时抛异常', False)
    except ValueError:
        check('将/帅出九宫时抛异常', True)

    # 找不到将/帅也要报错
    empty = np.full((1, 90), ord('.'), dtype=np.uint8)
    try:
        F.king_buckets(empty, np.array([0], np.uint8), 'halfka')
        check('棋盘没有将/帅时抛异常', False)
    except ValueError:
        check('棋盘没有将/帅时抛异常', True)


# ---------------- 2. 线性探针 ----------------

def test_clip_matches_model():
    print('探针的裁剪常量与训练标签同口径')
    import model
    want = model.VALUE_CLIP * model.OUTPUT_SCALE
    check('VALUE_CLIP_CP = %.0f（model: %.1f x %.1f）' % (LP.VALUE_CLIP_CP, model.VALUE_CLIP,
                                                         model.OUTPUT_SCALE),
          abs(LP.VALUE_CLIP_CP - want) < 1e-9)


def test_normal_equations(data, boards, sides):
    print('正规方程 vs 稠密最小二乘（逐块对拍）')
    compact, tr, va = LP.dedup_and_split(data, 0.05, 3000, 20260921)
    idx = tr[:600]
    LOCAL = F.PST_FEATURE_DIM
    Deff = LOCAL + 1
    # 等价关系对任意 lam 都成立，取 0.01 只是为了数值稳定：
    # 600 行样本里大量特征从未出现（对角为 0），λ 太小时参考方程会奇异。
    LAM = 0.01

    for mode in ('pst', 'halfka'):
        A, b = LP.build_normal_equations(compact, idx, mode, 1000000)
        W = LP.solve(A, b, LAM)
        f, bucket, y = LP._pieces(compact, idx, mode)
        pad = F.pad_index(mode)
        K = F.num_buckets(mode)
        cnt = np.bincount(bucket, minlength=K)
        ks = ([int(x) for x in np.argsort(-cnt)[:2] if cnt[x] > 0]
              if K > 1 else [0])

        worst_a = worst_b = worst_p = 0.0
        for k in ks:
            rows = np.nonzero(bucket == k)[0] if K > 1 else np.arange(len(idx))
            X = np.zeros((len(rows), Deff))
            X[:, LOCAL] = 1.0
            for i in range(32):
                vi = f[rows, i] != pad
                rr = np.nonzero(vi)[0]
                X[rr, f[rows[rr], i] - bucket[rows[rr]] * LOCAL] += 1.0
            Ak, bk = X.T @ X, X.T @ y[rows]

            worst_a = max(worst_a, np.abs(A[k] - Ak).max() / max(np.abs(Ak).max(), 1))
            worst_b = max(worst_b, np.abs(b[k] - bk).max() / max(np.abs(bk).max(), 1))

            # 列标准化 + lam*I 等价于原空间加 lam*diag(A)：
            #     (D^-1 A D^-1 + lam*I) w' = D^-1 b,  w' = D w
            #   两边左乘 D 得 (A + lam*D^2) w = b，而 D^2 = diag(A)。
            # 必须写 diag(diag(Ak)) 而不是 np.outer(s, s) —— 后者带非对角项，
            # 那不是 ridge，是另一回事（写错过一次，预测偏差 2e-2 才暴露出来）。
            #
            # 用 lstsq 而不是 solve：样本少时会有整列全 0（该特征没出现过），
            # 参考方程奇异。最小范数解把全 0 列的系数取 0，与被测代码
            # 「丢掉零对角列」的行为一致；就算 W 本身因共线性不唯一，
            # X @ W 这个拟合值也是唯一的，所以比对预测是安全的。
            Wk = np.linalg.lstsq(Ak + LAM * np.diag(np.diag(Ak)), bk, rcond=None)[0]
            # 注意 rows 是 idx **内部**的位置，不是 compact 的下标。
            # 直接把 rows 传给 predict 会去预测另一批局面（踩过：偏差 1.1）。
            pred = LP.predict(compact, idx[rows], mode, W, 1000000)
            scale = max(float(np.abs(pred).max()), 1e-9)
            worst_p = max(worst_p, float(np.abs(pred - X @ Wk).max()) / scale)

        check('%s 的 A 与稠密 X^T X 一致' % mode, worst_a < 1e-10,
              '最大相对偏差 %.1e' % worst_a)
        check('%s 的 b 与稠密 X^T y 一致' % mode, worst_b < 1e-10,
              '最大相对偏差 %.1e' % worst_b)
        check('%s 的预测与稠密解一致' % mode, worst_p < 1e-6,
              '最大相对偏差 %.1e（目标尺度 %.0f）' % (worst_p, np.abs(y).max()))


def main():
    path = find_data_file()
    print('=' * 68)
    print('特征编码与线性探针自证')
    print('=' * 68)
    test_dims()
    test_clip_matches_model()

    if path is None:
        print('\n[跳过] 找不到 part_*.bin，数据相关测试未执行')
    else:
        print('\n数据：%s' % os.path.relpath(path, ROOT))
        data, boards, sides = load_records(path, 20000)
        test_pst_matches_history(data, boards, sides)
        test_vector_matches_scalar(data, boards, sides)
        test_normal_equations(data, boards, sides)
    test_palace_bucket()

    print()
    print('=' * 68)
    if FAILED:
        print('失败 %d 项：%s' % (len(FAILED), '、'.join(FAILED)))
        return 1
    print('全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
