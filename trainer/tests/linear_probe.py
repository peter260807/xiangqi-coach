"""
线性探针：用闭式解量出每组特征里「可线性提取的信息量」。

为什么需要它
------------
神经网络的第一次前向是 `EmbeddingBag 求和` —— 也就是对激活特征做线性组合。
第一层之后虽然有 Clamp 引入非线性，但整体非常接近「线性模型 + 一层薄非线性」。
所以「这组特征里到底含多少能用的信息」可以用一个**最小二乘闭式解**直接量出来，
不必先花几十分钟训一个网络。

结论的对齐方式：探针给出的是**下界** —— 网络能靠非线性再多榨出一点，
但榨不出「特征里根本没有」的东西。所以：

    探针(corr) ≈ 网络(corr)  →  网络已经吃满了这组特征，要提升只能换特征
    探针(corr) 远低于网络    →  特征的潜力还没被网络用尽，先别换特征

比训练网络快两个数量级：1260 维的一次求解是亚秒级，11340 维也就一两分钟。

实现要点（为什么不用 scipy）
----------------------------
没有 scipy。而且**不需要**把 X 实体化 —— 4.7M x 11340 的稠密矩阵要 400 GB。
利用「每行最多 32 个 1」这个稀疏结构，直接算正规方程：

    A = X^T X = sum_rows  x x^T = sum_{slot pairs (i,j)}  (e_i e_j^T + e_j e_i^T)
    b = X^T y = sum_{slot i}  e_i * y

每个 (i,j) 对的贡献就是一次 `bincount` —— 512 次 bincount 换一个闭式解。

halfka 的正规方程是**分块对角**的：特征索引的高位就是将位桶，不同桶的行
不可能出现在同一个特征里，所以 9 个 1260 维的小块各自独立求解
（每块各有一个自己的截距项），而不是去解一个 11340 维的大矩阵。
矩阵总量因此从 1.29 亿个元素降到 9 x 1261^2 = 1430 万个。

用法:
    python tests/linear_probe.py --data data --mode pst
    python tests/linear_probe.py --data data --mode halfka
    python tests/linear_probe.py --data data --mode halfka_rand
"""
import argparse
import glob
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                os.pardir, 'src'))
import features as F                                          # noqa: E402
from gen_data import REC_DTYPE, REC_SIZE, position_hashes     # noqa: E402

VAL_BUCKETS = 10000        # 与 train.py 的 split_mask 保持一致

# 目标裁剪范围，必须与 model.VALUE_CLIP * OUTPUT_SCALE = 30 兵 x 100 = 3000 分一致。
# 这里不 import model 是为了让探针不依赖 torch（model.py 顶部 import torch）。
# tests/test_features.py 的 test_clip_matches_model 专门核对这个常量没跑偏。
VALUE_CLIP_CP = 3000


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


def dedup_and_split(data, val_frac, max_uniq, seed):
    """
    与 train.py 的 dedup_positions + split_mask 同协议：
    按局面去重（保留第一次出现）、按哈希分桶划分训练/验证。
    协议一致，探针的相关系数才能和训练日志里的数字直接比。
    """
    n_raw = len(data)
    h = position_hashes(data)
    uniq, first = np.unique(h, return_index=True)
    o = np.argsort(first, kind='stable')
    keep = first[o]
    hk = uniq[o]
    del h, uniq, first, o

    if max_uniq and len(keep) > max_uniq:
        rs = np.random.default_rng(seed)
        sel = rs.choice(len(keep), size=max_uniq, replace=False)
        sel.sort()
        keep = keep[sel]
        hk = hk[sel]

    compact = np.ascontiguousarray(data[keep])
    del data
    print('  去重：%d 条 -> %d 个唯一局面（重复率 %.1f%%）'
          % (n_raw, len(compact), 100.0 * (1 - len(compact) / max(n_raw, 1))))

    val_mask = (hk % np.uint64(VAL_BUCKETS)) < np.uint64(round(val_frac * VAL_BUCKETS))
    val_idx = np.nonzero(val_mask)[0]
    tr_idx = np.nonzero(~val_mask)[0]
    print('  划分：训练 %d 个局面 / 验证 %d 个局面' % (len(tr_idx), len(val_idx)))
    return compact, tr_idx, val_idx


def _pieces(compact, idxs, mode):
    """
    取出这一批的 (特征索引, 桶, 目标值)。

    目标值必须和训练标签**同一个口径**：`clip(cp, ±3000)`。

    踩过这个坑：直接用原始 cp 时，1% 的杀棋局面是 ±30000，最小二乘解
    会被它们整个拽偏 —— 表现为「均势档 MAE 98 分」，比「直接预测均值」
    的 25 分还差一倍。训练侧其实早就防住了这件事（VALUE_CLIP=30 兵），
    探针必须跟上，否则量出来的不是特征的信息量，是杀棋局面的信息量。
    """
    boards = np.ascontiguousarray(compact['board'][idxs]).view(np.uint8)
    boards = boards.reshape(len(idxs), 90)
    sides = compact['side'][idxs].astype(np.uint8)
    f = F.compute_features(boards, sides, mode)
    bucket = F.king_buckets(boards, sides, mode)     # pst 模式下恒为 0
    y = np.clip(compact['cp'][idxs], -VALUE_CLIP_CP, VALUE_CLIP_CP).astype(np.float64)
    return f, bucket, y


def build_normal_equations(compact, idxs, mode, chunk):
    """
    返回 (A, b)。A 形状 (K, 1261, 1261)，b 形状 (K, 1261)。
    索引 1260 是截距项，每个桶各有一个。

    关键：**每块只用桶内局部索引**（0~1259），不含桶偏移。

    特征索引的全局形式是 `bucket * 1260 + (square * 14 + type)`，
    所以不同桶的特征在全局索引上互不相交 —— 正规方程是分块对角的，
    每个桶独立求解即可。

    但块矩阵的边长必须按**桶内维度 1260** 算，不能按全局维度 11340 算。
    踩过这个坑：块矩阵 11341 x 11341 = 1.29 亿个元素，9 个块就是 9.3 GB，
    每次 bincount 还要开 1 GB 的 bin，400 个局面跑了十几分钟还没出来。
    改成桶内索引后 A 只有 9 x 1261^2 = 1430 万个元素（114 MB），
    同样 400 个局面 1.5 秒跑完。
    """
    LOCAL = F.PST_FEATURE_DIM            # 1260：桶内维度
    Deff = LOCAL + 1                     # 末尾加一列截距
    K = F.num_buckets(mode)              # pst=1, halfka=9, fullka=81
    pad = F.pad_index(mode)
    Q = Deff * Deff

    A = np.zeros((K, Deff, Deff), dtype=np.float64)
    b = np.zeros((K, Deff), dtype=np.float64)

    for s in range(0, len(idxs), chunk):
        sub = idxs[s:s + chunk]
        f, bucket, y = _pieces(compact, sub, mode)

        for k in range(K):
            if K == 1:
                fk, yk = f, y
            else:
                sel = np.nonzero(bucket == k)[0]
                if len(sel) == 0:
                    continue
                fk, yk = f[sel], y[sel]
            n = len(fk)

            # 槽位 0 是截距；槽位 1..32 是棋子，补齐位标记为无效
            valid = np.ones((n, 33), dtype=bool)
            valid[:, 1:] = (fk != pad)
            key = np.zeros((n, 33), dtype=np.int64)
            key[:, 0] = LOCAL
            # 换算到桶内局部索引（pst 的 k 恒为 0，等价于不变）
            key[:, 1:] = np.where(valid[:, 1:], fk - k * LOCAL, 0)

            for i in range(33):
                vi = valid[:, i]
                if not vi.any():
                    continue
                ki = key[:, i]
                # ---- b += x * y ----
                b[k] += np.bincount(ki[vi], weights=yk[vi], minlength=Deff)
                # ---- A += x x^T（只看 i <= j 的无序对，i < j 时补转置） ----
                for j in range(i, 33):
                    mj = vi & valid[:, j]
                    if not mj.any():
                        continue
                    C = np.bincount(ki[mj] * Deff + key[mj, j],
                                    minlength=Q).reshape(Deff, Deff)
                    A[k] += C if i == j else C + C.T

        print('    已处理 %d / %d 个局面' % (min(s + chunk, len(idxs)), len(idxs)),
              flush=True)
    return A, b


def solve(A, b, lam):
    """
    列标准化 + ridge 求解。

    为什么必须标准化：PST 计数特征之间有强共线性 —— 己方 16 个子的计数和
    恒等于「己方子数」，各格之间又高度相关，A 的条件数极大。直接对 A 加一个
    极小的 ridge 当 OLS 用，最小范数解会把极大的权重塞给**样本极少的稀有
    特征**：实测最大权重 ±1200，而那个特征在 47391 个局面里只出现 38 次。
    后果是均势档预测标准差 151 分、目标只有 35 分 —— 预测被放大 4.4 倍、
    回归斜率只剩 0.087，可相关系数看着还有 0.38，很容易被误读成「模型还行」。

    列标准化后 As 的对角线恒为 1，ridge 强度 lam 才有统一含义
    （「惩罚 1 个标准差的系数要付多少代价」），三种编码也才在同一把尺子上比。
    """
    K, Deff, _ = A.shape
    W = np.zeros((K, Deff), dtype=np.float64)
    for k in range(K):
        d = np.diag(A[k]).copy()
        ok = d > 0
        s = np.where(ok, np.sqrt(np.maximum(d, 1e-12)), 1.0)
        idx = np.nonzero(ok)[0]
        if len(idx) == 0:
            continue
        As = (A[k] / np.outer(s, s))[np.ix_(idx, idx)]
        bs = b[k][idx] / s[idx]
        try:
            wk = np.linalg.solve(As + lam * np.eye(len(idx)), bs)
        except np.linalg.LinAlgError:
            wk = np.linalg.lstsq(As + lam * np.eye(len(idx)), bs, rcond=None)[0]
        W[k, idx] = wk / s[idx]
    return W


def predict(compact, idxs, mode, W, chunk):
    LOCAL = F.PST_FEATURE_DIM
    pad = F.pad_index(mode)
    out = np.empty(len(idxs), dtype=np.float64)
    for s in range(0, len(idxs), chunk):
        sub = idxs[s:s + chunk]
        f, bucket, _ = _pieces(compact, sub, mode)
        p = W[bucket, LOCAL].copy()                        # 截距
        base = bucket * LOCAL                              # 全局索引 -> 桶内索引
        for i in range(32):
            vi = f[:, i] != pad
            if vi.any():
                p[vi] += W[bucket[vi], f[vi, i] - base[vi]]
        out[s:s + chunk] = p
    return out


def corr(a, b):
    if len(a) < 10 or a.std() == 0 or b.std() == 0:
        return float('nan')
    return float(np.corrcoef(a, b)[0, 1])


def report(name, pred, cp, quiet=False):
    m_bal = np.abs(cp) < 100
    c_all = corr(pred, cp)
    c_bal = corr(pred[m_bal], cp[m_bal])
    # R^2 用验证集自己的均值做基准，避免训练均值混进来
    ss_res = float(np.sum((pred - cp) ** 2))
    ss_tot = float(np.sum((cp - cp.mean()) ** 2))
    r = {
        'name': name,
        'corr': c_all,
        'corr_bal': c_bal,
        'n_bal': int(m_bal.sum()),
        'pct_bal': 100.0 * float(m_bal.mean()),
        'r2': 1 - ss_res / max(ss_tot, 1e-9),
        'mae_bal': (float(np.mean(np.abs(pred[m_bal] - cp[m_bal])))
                    if m_bal.any() else float('nan')),
    }
    if not quiet:
        print('  %-14s 整体 corr %.4f | 均势档 corr %.4f（%d 个局面，占 %.1f%%）'
              ' | R^2 %.4f | 均势档 MAE %.1f 分'
              % (name, r['corr'], r['corr_bal'], r['n_bal'], r['pct_bal'],
                 r['r2'], r['mae_bal']))
    return r


def main():
    ap = argparse.ArgumentParser(description='线性探针')
    ap.add_argument('--data', default='data')
    ap.add_argument('--mode', choices=tuple(F.MODES) + ('all',), default='all',
                    help='all = 依次跑 pst / halfka / halfka_rand 并出对比表'
                         '（不含 fullka：81 个桶要跑十几分钟，需要时显式指定）')
    ap.add_argument('--limit', type=int, default=0, help='只用前 N 条记录（0=全部）')
    ap.add_argument('--max-uniq', type=int, default=1200000,
                    help='去重后最多用多少个局面（0=全部）')
    ap.add_argument('--val-frac', type=float, default=0.05)
    ap.add_argument('--train-bal', type=float, default=300.0,
                    help='只用 |cp| <= 该值的局面做拟合（0=全部）。'
                         '默认 300：回归的目标是全区间 cp，而我们要问的是'
                         '「均势区里这些特征含多少信息」，全区间拟合会把'
                         '能力全花在极端局面上，均势档直接退化成噪声')
    ap.add_argument('--lambdas',
                    default='0.003,0.01,0.03,0.1,0.3,1,3,10,30,100',
                    help='列标准化后的 ridge 强度网格（逗号分隔），按验证集均势档 R^2 选最优。'
                         '列是单位 2-范数（不是单位方差），所以有意义的 λ 量级可以到几十上百')
    ap.add_argument('--chunk', type=int, default=400000)
    ap.add_argument('--seed', type=int, default=20260921)
    args = ap.parse_args()

    # 默认不跑 fullka：81 个桶的正规方程要 ~12 分钟，需要时用 --mode fullka 显式跑
    modes = (('pst', 'halfka', 'halfka_rand') if args.mode == 'all'
             else (args.mode,))

    t0 = time.time()
    print('=' * 70)
    print('线性探针：用闭式解量出「每组特征里可线性提取的信息量」')
    print('=' * 70)

    data = load(args.data, args.limit)
    print('去重与划分（只做一次，三种编码共用同一批局面）…')
    compact, tr_idx, val_idx = dedup_and_split(data, args.val_frac,
                                               args.max_uniq, args.seed)
    cp_val = np.clip(compact['cp'][val_idx], -VALUE_CLIP_CP, VALUE_CLIP_CP).astype(np.float64)

    lams = [float(x) for x in args.lambdas.split(',') if x.strip()]
    m_bal = np.abs(cp_val) < 100
    ss_tot_bal = float(np.sum((cp_val[m_bal] - cp_val[m_bal].mean()) ** 2))

    if args.train_bal > 0:
        keep = np.abs(compact['cp'][tr_idx]) <= args.train_bal
        tr_idx = tr_idx[keep]
        print('  拟合只用 |cp| <= %.0f 的局面：训练 %d 个（丢掉 %d 个大分值局面）'
              % (args.train_bal, len(tr_idx), int((~keep).sum())))

    rows = []
    for mode in modes:
        D = F.feature_dim(mode)
        print('')
        print('-' * 70)
        print('特征编码 %s（%d 维）' % (mode, D))
        print('-' * 70)
        t1 = time.time()
        A, b = build_normal_equations(compact, tr_idx, mode, args.chunk)
        print('  正规方程 %s（%.0f 秒）' % (A.shape, time.time() - t1))

        print('  %-9s %11s %11s %10s' % ('ridge', '均势档R^2', '均势档corr', '均势MAE'))
        best = None
        for lam in lams:
            W = solve(A, b, lam)
            pred = predict(compact, val_idx, mode, W, args.chunk)
            r = report(mode, pred, cp_val, quiet=True)
            r2_bal = 1 - (float(np.sum((pred[m_bal] - cp_val[m_bal]) ** 2))
                          / max(ss_tot_bal, 1e-9))
            print('  %-9.4g %11.4f %11.4f %10.1f'
                  % (lam, r2_bal, r['corr_bal'], r['mae_bal']))
            if best is None or r2_bal > best[1]:
                best = (r, r2_bal, lam)
        r, r2_bal, lam = best
        print('  -> 按均势档 R^2 选 ridge = %.4g：均势档 corr %.4f | R^2 %.4f'
              ' | MAE %.1f 分   （整区间 corr %.4f，仅供参考）'
              % (lam, r['corr_bal'], r2_bal, r['mae_bal'], r['corr']))
        r['dim'] = D
        r['lam'] = lam
        r['r2_bal'] = r2_bal
        rows.append(r)

    # 常数基线：相关系数恒为 0，用来确认口径没写错
    report('常数基线', np.full(len(cp_val), cp_val.mean()), cp_val)

    print('')
    print('=' * 70)
    print('对比（验证集 %d 个局面，其中均势档 %d 个 = %.1f%%）'
          % (len(cp_val), rows[0]['n_bal'], rows[0]['pct_bal']))
    print('=' * 70)
    print('%-12s %7s %7s %10s %11s %10s %9s'
          % ('编码', '维度', 'ridge', '整体corr', '均势档corr', '均势档R^2', '均势MAE'))
    for r in rows:
        print('%-12s %7d %7.3g %10.4f %11.4f %10.4f %9.1f'
              % (r['name'], r['dim'], r['lam'], r['corr'], r['corr_bal'],
                 r['r2_bal'], r['mae_bal']))
    if len(rows) >= 2:
        base = rows[0]
        print('')
        for r in rows[1:]:
            d = r['corr_bal'] - base['corr_bal']
            print('  %s 相对 %s：均势档 corr %+.4f -> %s'
                  % (r['name'], base['name'], d,
                     '有提升' if d > 0.01 else '基本无差别'))
    print('')
    print('用时 %.1f 分钟' % ((time.time() - t0) / 60))


if __name__ == '__main__':
    main()
