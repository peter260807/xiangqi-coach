"""
NNUE 训练器。

    python train.py --data ../data --epochs 8 --batch 8192 --out ../logs

训练目标是「蒸馏」Pikafish 的评估：让网络输出的**分差**（单位兵）去拟合
引擎自己给出的 cp 分。也就是说，最终产物是一个**近似 Pikafish 判断**的
轻量网络，接上一套搜索就能下棋。

--------------------------------------------------------------------------
v2 的三处改动（都写在 README 的「为什么相关系数会骗人」一节里）

1. 训练目标不再做 sigmoid 压缩，直接回归分值。理由见 model.py 顶部注释：
   压缩把 3 分的候选差距压成 0.0019 的胜率差，低于网络 0.0121 的误差，
   排序分辨率的信噪比只有 0.16。

2. 按「局面」而不是「记录」去重并划分训练/验证集。同一局面在一局棋里
   反复出现（实测重复率 63%），随机按记录切分会让同一局面同时落在两边，
   验证指标被自己见过的样本抬高 —— 这正是「相关系数会骗人」的帮凶。
   去重同时让训练样本量降到实际唯一局面数，训练显著变快。

3. 网络放大到 512/64。v1 只有 32 万参数。

性能上的关键点：特征编码必须向量化。一个 batch 8192 条、每条 90 格，
如果用 Python 循环逐格处理，每秒只能跑几百条，GPU 会一直饿着。
这里全部用 numpy 一次性算完。
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
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features                                              # noqa: E402
import resume                                                # noqa: E402
from gen_data import REC_DTYPE, REC_SIZE, position_hashes   # noqa: E402
from model import (CP_SCALE, MAX_FEATURES, OUTPUT_SCALE,     # noqa: E402
                   VALUE_CLIP, XQNet, huber_loss)


def compute_features(boards, sides, mode='pst'):
    """
    转发到 features.py —— 特征编码的唯一实现在那里。

    那里支持三种编码：
      pst         1260 维，格号 x 棋子类型（v1/v2 一直在用）
      halfka      11340 维，再乘上「己方将位」的 9 个宫格桶
      halfka_rand 11340 维，桶里装随机分组（对照用）

    这里保留同名的薄包装是为了不破坏 verify.py / bench_train_step.py
    的既有 import（它们按老签名 compute_features(boards, sides) 调用）。
    """
    return features.compute_features(boards, sides, mode)


# ---------------- 数据加载 ----------------

def load_dataset(data_dir):
    """读取所有 part_*.bin，返回拼接后的结构化数组。"""
    files = sorted(glob.glob(os.path.join(data_dir, 'part_*.bin')))
    files += sorted(glob.glob(os.path.join(data_dir, '*.bin')))
    files = sorted(set(files))
    if not files:
        raise SystemExit('在 %s 里没找到任何 part_*.bin' % data_dir)

    arrays = []
    total = 0
    for path in files:
        size = os.path.getsize(path)
        n = size // REC_SIZE
        if n == 0:
            print('  跳过空文件 %s' % os.path.basename(path))
            continue
        if size % REC_SIZE != 0:
            print('  警告：%s 尾部有 %d 字节残留，已忽略'
                  % (os.path.basename(path), size % REC_SIZE))
        a = np.fromfile(path, dtype=REC_DTYPE, count=n)
        arrays.append(a)
        total += n
        print('  %-20s %12d 条' % (os.path.basename(path), n))

    data = np.concatenate(arrays) if len(arrays) > 1 else arrays[0]
    print('合计 %d 条记录' % total)
    return data


# 按「局面」去重 / 划分用的哈希函数在 gen_data.py 里。
# 它只依赖 numpy 和记录布局，和 REC_DTYPE 放在一起能保证字节偏移不与
# 记录格式脱节；也避免「只想统计一下数据集」的人被 torch 依赖挡住。


def split_mask(hashes, val_frac):
    """
    用哈希本身决定一个局面归属训练集还是验证集。

    不能按顺序切：数据是按 worker 分片写的，一局棋的连续局面挤在一起，
    按顺序切等于把整块局面塞进验证集，验证集就不再是随机样本了。
    """
    buckets = 10000
    thr = int(round(val_frac * buckets))
    return (hashes % np.uint64(buckets)) < np.uint64(thr)


def dedup_positions(data, val_frac):
    """
    按局面去重，并把去重后的数据压紧成连续数组。

    返回 (压缩后的数据, 训练索引, 验证索引)。

    压紧不只是省内存：原始 3017 万条里 63% 是重复局面，不去重的话
    每个 epoch 有六成算力花在重复样本上，而且这些样本的权重被重复
    计算，等于给「开局附近那几十种走法」偷偷加了权重。
    """
    n_raw = len(data)
    h = position_hashes(data)
    uniq_h, first_idx = np.unique(h, return_index=True)

    # np.unique 返回的是按哈希排序的顺序，这里改回原始顺序，
    # 让 gather 时的磁盘/内存访问更顺序一些
    o = np.argsort(first_idx, kind='stable')
    keep = first_idx[o]
    hk = uniq_h[o]

    del h, uniq_h, first_idx, o
    compact = np.ascontiguousarray(data[keep])

    val_mask = split_mask(hk, val_frac)
    n_val = int(val_mask.sum())
    val_idx = np.nonzero(val_mask)[0]
    tr_idx = np.nonzero(~val_mask)[0]

    print('  去重：%d 条记录 -> %d 个唯一局面（重复率 %.1f%%）'
          % (n_raw, len(compact), 100.0 * (1 - len(compact) / max(n_raw, 1))))
    print('  划分：训练 %d 个局面 / 验证 %d 个局面' % (len(tr_idx), n_val))
    return compact, tr_idx, val_idx


# ---------------- 批次构造 ----------------

def make_target(cps, mode):
    """cp 分 -> 训练标签。value 模式是线性分值，winrate 模式是 v1 的压缩胜率。"""
    c = cps.astype(np.float32)
    if mode == 'value':
        return np.clip(c / OUTPUT_SCALE, -VALUE_CLIP, VALUE_CLIP).astype(np.float32)
    return (1.0 / (1.0 + np.exp(-np.clip(c, -30000, 30000) / CP_SCALE))
            ).astype(np.float32)


def make_batch(data, idxs, device, mode='value', feat='pst'):
    boards = data['board'][idxs].view(np.uint8).reshape(len(idxs), 90)
    sides = data['side'][idxs].astype(np.uint8)
    cps = data['cp'][idxs]

    feats = compute_features(boards, sides, feat)
    target = make_target(cps, mode)

    idx_t = torch.from_numpy(feats).to(device)
    side_t = torch.from_numpy(sides.astype(np.int64)).to(device)
    tgt_t = torch.from_numpy(target).to(device)
    return idx_t, side_t, tgt_t


def batch_loss(pred, tgt, mode):
    if mode == 'value':
        return huber_loss(pred, tgt)
    return F.binary_cross_entropy_with_logits(pred, tgt)


def to_display(pred, mode):
    """把网络输出转成「和标签同一尺度」的表示，供算相关系数用。"""
    if mode == 'value':
        return pred
    return torch.sigmoid(pred)


def pred_to_cp(pred_np, mode):
    """网络输出 -> cp 分，用来报「平均偏差多少个兵」。"""
    if mode == 'value':
        return np.clip(pred_np, -VALUE_CLIP, VALUE_CLIP) * OUTPUT_SCALE
    p = np.clip(1.0 / (1.0 + np.exp(-pred_np)), 1e-6, 1 - 1e-6)
    return CP_SCALE * np.log(p / (1.0 - p))


def evaluate(net, data, idxs, device, batch, mode='value', feat='pst'):
    """
    在验证集上算 loss 与三项指标。

    除了整体相关系数，这里特意**单独报「均势档」（|cp|<100）的相关系数**。
    整体相关系数会被少量一边倒的局面撑得很高 —— v1 报 0.9797，看起来很漂亮，
    但均势档只有 0.62。而均势局面占了样本的 57%，恰恰是排序最需要分辨力的
    地方。只看整体相关系数会得出「学得很好」的错误结论。
    """
    net.eval()
    tot, cnt = 0.0, 0
    preds, tgts, cps = [], [], []
    with torch.no_grad():
        for s in range(0, len(idxs), batch):
            sub = idxs[s:s + batch]
            i, sd, t = make_batch(data, sub, device, mode, feat)
            out = net(i, sd)
            tot += batch_loss(out, t, mode).item() * len(sub)
            cnt += len(sub)
            preds.append(to_display(out, mode).cpu().numpy())
            tgts.append(t.cpu().numpy())
            cps.append(data['cp'][sub].astype(np.int32))
    net.train()

    p = np.concatenate(preds).astype(np.float64)
    t = np.concatenate(tgts).astype(np.float64)
    c = np.concatenate(cps).astype(np.float64)

    def corr(a, b):
        if len(a) < 10 or a.std() == 0 or b.std() == 0:
            return float('nan')
        return float(np.corrcoef(a, b)[0, 1])

    m_bal = np.abs(c) < 100
    pred_cp = pred_to_cp(p, mode)
    cap = np.abs(c) < 2000

    stats = {
        'loss': tot / max(cnt, 1),
        'corr': corr(p, t),
        'corr_bal': corr(p[m_bal], t[m_bal]) if m_bal.sum() > 10 else float('nan'),
        'n_bal': int(m_bal.sum()),
        'mae_cp': float(np.mean(np.abs(pred_cp[cap] - c[cap]))) if cap.sum() else float('nan'),
        'mae_cp_bal': (float(np.mean(np.abs(pred_cp[m_bal] - c[m_bal])))
                       if m_bal.sum() else float('nan')),
    }
    return stats


def pick_device(forced=None):
    """
    选训练设备。**Apple Silicon 上刻意不用 MPS**，这是实测结论不是猜的。

    瓶颈在第一层的稀疏 gather/scatter（EmbeddingBag 的反向）：
        MPS：每条样本固定 20.4 us，与批大小完全无关（B=256 到 8192 都是这个数）
        CPU：每条样本 4.1 us
    整步吞吐因此是 MPS 4.9 万局面/秒 vs CPU 24.5 万局面/秒，差 5 倍。
    单看矩阵乘 MPS 反而更快（1.75ms vs 2.43ms），但这里矩阵乘根本不是瓶颈。

    网络总共才 68 万参数，CPU 完全喂得动，所以直接选 CPU。
    想自己量一遍：--device mps，对照 --device cpu。
    """
    if forced:
        return torch.device(forced)
    if torch.cuda.is_available():
        return torch.device('cuda')
    return torch.device('cpu')


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='训练象棋 NNUE 评估网络')
    ap.add_argument('--data', default='../data', help='数据目录')
    ap.add_argument('--out', default='../logs', help='输出目录（checkpoint 与日志）')
    ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--batch', type=int, default=8192)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--l1', type=int, default=512, help='第一层宽度')
    ap.add_argument('--l2', type=int, default=64, help='第二层宽度')
    ap.add_argument('--feat', choices=features.MODES, default='pst',
                    help='特征编码：pst=1260 维（默认，v1/v2 一直用的）；'
                         'halfka=11340 维，额外带上「己方将/帅所在宫格」的 9 个桶；'
                         'halfka_rand=同维度但桶里装随机分组，用来区分'
                         '「将位这个信息有用」和「单纯多了 9 倍容量」')
    ap.add_argument('--val-frac', type=float, default=0.05, help='验证集比例')
    ap.add_argument('--target-mode', choices=['value', 'winrate'], default='value',
                    help='value=线性回归引擎分（默认）；winrate=v1 的压缩胜率，仅供复现旧结果')
    ap.add_argument('--no-dedup', action='store_true',
                    help='不按局面去重（复现 v1 的旧行为，验证集会有泄漏）')
    ap.add_argument('--max-minutes', type=float, default=0,
                    help='训练时长上限（分钟），0 表示不限')
    ap.add_argument('--limit', type=int, default=0,
                    help='只用前 N 条数据（调试用），0 表示全部')
    ap.add_argument('--device', default=None, help='cpu / cuda / mps，默认自动')
    ap.add_argument('--seed', type=int, default=20260921)
    ap.add_argument('--log-every', type=int, default=200, help='每多少步打印一次')
    ap.add_argument('--fresh', action='store_true',
                    help='忽略已有 checkpoint 从头训练（默认是：发现 ckpt 就接着上次的轮次继续）')
    return ap.parse_args(argv)


def main():
    args = parse_args()
    rng = np.random.default_rng(args.seed)
    torch.manual_seed(args.seed)

    device = pick_device(args.device)
    print('=' * 64)
    print('训练象棋 NNUE 评估网络')
    print('  设备    : %s' % device)
    print('  数据目录: %s' % os.path.abspath(args.data))
    print('  输出目录: %s' % os.path.abspath(args.out))
    print('  训练目标: %s' % ('线性分值（单位兵）' if args.target_mode == 'value'
                              else '压缩胜率 sigmoid(cp/400)（旧行为）'))
    print('  特征编码: %s（%d 维）' % (args.feat, features.feature_dim(args.feat)))
    print('=' * 64)

    print('读取数据…')
    data = load_dataset(args.data)
    if args.limit and args.limit < len(data):
        data = data[:args.limit]
        print('按 --limit 截断到 %d 条' % len(data))

    if args.no_dedup:
        print('  按记录随机划分（--no-dedup：同一局面会横跨训练/验证集）')
        perm = rng.permutation(len(data))
        n_val = max(1, int(len(data) * args.val_frac))
        val_idx = np.sort(perm[:n_val])
        tr_idx = np.sort(perm[n_val:])
        print('  划分：训练 %d 条 / 验证 %d 条' % (len(tr_idx), len(val_idx)))
    else:
        data, tr_idx, val_idx = dedup_positions(data, args.val_frac)

    os.makedirs(args.out, exist_ok=True)
    feat_dim = features.feature_dim(args.feat)
    net = XQNet(l1=args.l1, l2=args.l2, feature_dim=feat_dim).to(device)
    n_param = sum(p.numel() for p in net.parameters())
    print('网络参数：%d 个（第一层 %d x %d = %d，占大头）'
          % (n_param, feat_dim, args.l1, feat_dim * args.l1))

    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    steps_per_epoch = max(1, len(tr_idx) // args.batch)
    total_steps = steps_per_epoch * args.epochs
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(
        opt, T_max=max(total_steps, 1), eta_min=args.lr * 0.01)

    log_path = os.path.join(args.out, 'train.log')
    log_f = open(log_path, 'a', encoding='utf-8')

    def log(msg):
        print(msg, flush=True)
        log_f.write(msg + '\n')
        log_f.flush()

    t0 = time.time()
    deadline = t0 + args.max_minutes * 60 if args.max_minutes > 0 else None
    step = 0
    stopped = False

    # ---- 断点恢复 ----
    # 默认行为：发现 ckpt.pt 就接着上次的轮次继续（默认才叫"断点恢复"，
    # 否则用户还得记得加参数）。想从头训加 --fresh。
    ckpt_path = os.path.join(args.out, 'ckpt.pt')
    start_epoch = 1
    fp = resume.data_fingerprint(args.data, REC_SIZE)
    if args.fresh and os.path.isfile(ckpt_path):
        os.remove(ckpt_path)
        log('--fresh：已丢弃旧 checkpoint，从头训练')
    if (not args.fresh) and os.path.isfile(ckpt_path):
        ck = None
        try:
            # weights_only=False 是必需的：checkpoint 里存了优化器状态、
            # numpy 的随机数状态这些非张量对象（文件是本机自己写的）
            ck = torch.load(ckpt_path, map_location=device, weights_only=False)
        except Exception as e:
            log('[警告] checkpoint 读不出来（%s），改为从头训练' % e)
        if ck is not None:
            # 形状相关的参数必须一致，否则权重根本接不上
            shape_keys = ('l1', 'l2', 'target_mode', 'feat')
            bad = [k for k in shape_keys if ck.get(k) != getattr(args, k)]
            if bad:
                log('[拒绝续训] checkpoint 的 %s 与当前参数不一致：'
                    % '、'.join(bad))
                for k in bad:
                    log('           %-12s checkpoint=%s  当前=%s'
                        % (k, ck.get(k), getattr(args, k)))
                log('           要么用原参数重跑，要么加 --fresh 从头训。')
                log_f.close()
                return 2
            old_fp = ck.get('data_fingerprint') or {}
            if old_fp and old_fp.get('digest') != fp.get('digest'):
                log('[注意] 数据变了，仍按断点继续，但验证集指标与之前几轮不可比：')
                log('       之前 %s 个分片 / %s 条，现在 %s 个分片 / %s 条'
                    % (old_fp.get('files'), old_fp.get('records'),
                       fp.get('files'), fp.get('records')))
            net.load_state_dict(ck['model'])
            if ck.get('optimizer'):
                opt.load_state_dict(ck['optimizer'])
            if ck.get('scheduler'):
                sched.load_state_dict(ck['scheduler'])
            if ck.get('rng'):
                # 恢复随机数状态，让每个 epoch 的取样顺序可复现
                try:
                    rng.bit_generator.state = ck['rng']
                except Exception:
                    pass
            step = int(ck.get('step', 0))
            start_epoch = int(ck.get('epoch', 0)) + 1
            log('')
            log('=== 从断点继续：已完成 %d 轮，从第 %d 轮开始（累计 %d 步）==='
                % (start_epoch - 1, start_epoch, step))
            log('    上次验证 loss=%.5f（均势档相关系数 %.4f）'
                % (ck.get('val_loss', 0.0), ck.get('val_corr_balanced', 0.0)))
    if start_epoch > args.epochs:
        log('已训到第 %d 轮，达到 --epochs=%d，无需继续，直接导出权重。'
            % (start_epoch - 1, args.epochs))
        torch.save(net.state_dict(), os.path.join(args.out, 'weights.pt'))
        log_f.close()
        return 0

    for epoch in range(start_epoch, args.epochs + 1):
        if stopped:
            break
        order = rng.permutation(len(tr_idx))
        run_loss, run_cnt = 0.0, 0
        ep_t0 = time.time()

        for s in range(0, len(tr_idx) - args.batch + 1, args.batch):
            if deadline and time.time() > deadline:
                log('达到训练时长上限，提前结束')
                stopped = True
                break

            sub = tr_idx[order[s:s + args.batch]]
            idx_t, side_t, tgt_t = make_batch(data, sub, device,
                                              args.target_mode, args.feat)

            out = net(idx_t, side_t)
            loss = batch_loss(out, tgt_t, args.target_mode)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            net.zero_pad_row()      # 补齐位的权重必须是 0，否则等于加常噪声
            sched.step()

            run_loss += loss.item() * len(sub)
            run_cnt += len(sub)
            step += 1

            if step % args.log_every == 0:
                el = time.time() - t0
                avg = run_loss / max(run_cnt, 1)
                ips = run_cnt / max(time.time() - ep_t0, 1e-9)
                log('  轮次 %d  步 %d/%d  loss=%.5f  学习率=%.2e  %d 局面每秒  已用 %.0f 分钟'
                    % (epoch, step, total_steps, avg, sched.get_last_lr()[0], ips, el / 60))

        if run_cnt:
            log('轮次 %d 完成：平均 loss=%.5f，用时 %.1f 分钟'
                % (epoch, run_loss / run_cnt, (time.time() - ep_t0) / 60))

        st = evaluate(net, data, val_idx, device, args.batch,
                      args.target_mode, args.feat)
        log('  验证：loss=%.5f  相关系数=%.4f（均势档 %.4f，%d 个局面）'
            % (st['loss'], st['corr'], st['corr_bal'], st['n_bal']))
        log('        换算成引擎分值：平均偏差 %.1f 分（均势档 %.1f 分）'
            % (st['mae_cp'], st['mae_cp_bal']))

        # checkpoint 原子写：先写 .tmp 再 replace。
        # 直接覆写的话，正卡在写盘时断电（Windows 自动更新重启就属于这种）
        # 会留下一个半损坏的 ckpt —— torch.load 对截断文件未必报错，
        # 可能安静地读进一堆坏权重。
        ckpt = os.path.join(args.out, 'ckpt.pt')
        tmp = ckpt + '.tmp'
        torch.save({
            'model': net.state_dict(),
            'optimizer': opt.state_dict(),
            'scheduler': sched.state_dict(),
            'rng': rng.bit_generator.state,
            'l1': args.l1, 'l2': args.l2,
            'target_mode': args.target_mode, 'feat': args.feat,
            'epochs': args.epochs, 'batch': args.batch, 'lr': args.lr,
            'epoch': epoch, 'step': step,
            'data_fingerprint': fp,
            'val_loss': st['loss'], 'val_corr': st['corr'],
            'val_corr_balanced': st['corr_bal'],
            'val_mae_cp': st['mae_cp'],
        }, tmp)
        with open(tmp, 'rb+') as f:
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, ckpt)
        log('  已保存 checkpoint: %s（第 %d 轮完成，随时中断都能续训）' % (ckpt, epoch))

    # 另外导出一份纯权重，便于 export.py 直接使用
    torch.save(net.state_dict(), os.path.join(args.out, 'weights.pt'))
    log('')
    log('训练结束，总用时 %.1f 分钟' % ((time.time() - t0) / 60))
    log('权重文件: %s' % os.path.join(args.out, 'weights.pt'))
    log_f.close()


if __name__ == '__main__':
    # 让 exit code 反映成功与否：拒绝续训会返回 2，上层（pipeline / bat）
    # 靠它决定是停下来还是继续往后走。之前这里只是 main()，
    # 返回值被丢掉，拒绝续训也报成功。
    sys.exit(main() or 0)
