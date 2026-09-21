"""
NNUE 训练器。

    python train.py --data ../data --epochs 6 --batch 8192 --out ../logs

训练目标是「蒸馏」Pikafish 的评估：让它输出的胜率去拟合
sigmoid(引擎 cp 分 / 400)。也就是说，最终产物是一个**近似 Pikafish 判断**的轻量网络。

性能上的关键点：特征编码必须向量化。一个 batch 8192 条、每条 90 格，
如果用 Python 循环逐格处理，每秒只能跑几百条，GPU 会一直饿着。
这里全部用 numpy 一次性算完。
"""

import argparse
import glob
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_data import REC_DTYPE, REC_SIZE          # noqa: E402
from model import (CP_SCALE, FEATURE_DIM, MAX_FEATURES, PAD_INDEX,  # noqa: E402
                   XQNet, collate)

# ---- 查表：ASCII 字符 -> 棋子种类（0-6）/ 是否红方 ----
_BASE = np.full(256, -1, dtype=np.int16)
_IS_RED = np.zeros(256, dtype=bool)
for _i, _ch in enumerate('KABNRCP'):
    _BASE[ord(_ch)] = _i
    _IS_RED[ord(_ch)] = True
for _i, _ch in enumerate('kabnrcp'):
    _BASE[ord(_ch)] = _i
    _IS_RED[ord(_ch)] = False

_SQ = np.arange(90, dtype=np.int16)[None, :]


def compute_features(boards, sides):
    """
    boards: (B, 90) uint8；sides: (B,) uint8（0=红方走，1=黑方走）
    返回:  (B, 32) int64 特征索引，不足处填 PAD_INDEX

    视角归一化在这里完成：轮到谁走，谁的子就映射到类型 0-6，
    对方映射到 7-13。这样网络只需学一套「己方 / 对方」的概念，
    不必分别为红黑各学一套，样本效率翻倍。
    """
    base = _BASE[boards]                                 # (B,90)
    occupied = base >= 0
    is_red = _IS_RED[boards]
    red_to_move = (sides == 0)[:, None]
    own = (is_red == red_to_move)

    final_type = base + np.where(own, 0, 7)
    feat_all = _SQ * 14 + final_type                     # (B,90)

    # 把有子的格子稳定地排到前面，取前 32 个
    order = np.argsort(~occupied, axis=1, kind='stable')
    take = order[:, :MAX_FEATURES]
    cols = np.take_along_axis(feat_all, take, axis=1)
    valid = np.take_along_axis(occupied, take, axis=1)
    return np.where(valid, cols, PAD_INDEX).astype(np.int64)


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


def make_batch(data, idxs, device):
    boards = data['board'][idxs].view(np.uint8).reshape(len(idxs), 90)
    sides = data['side'][idxs].astype(np.uint8)
    cps = data['cp'][idxs].astype(np.float32)

    feats = compute_features(boards, sides)
    target = 1.0 / (1.0 + np.exp(-np.clip(cps, -30000, 30000) / CP_SCALE))

    idx_t = torch.from_numpy(feats).to(device)
    side_t = torch.from_numpy(sides.astype(np.int64)).to(device)
    tgt_t = torch.from_numpy(target.astype(np.float32)).to(device)
    return idx_t, side_t, tgt_t


def evaluate(net, data, idxs, device, batch):
    net.eval()
    tot, cnt = 0.0, 0
    preds, tgts = [], []
    with torch.no_grad():
        for s in range(0, len(idxs), batch):
            sub = idxs[s:s + batch]
            i, sd, t = make_batch(data, sub, device)
            logits = net(i, sd)
            loss = F.binary_cross_entropy_with_logits(logits, t, reduction='sum')
            tot += loss.item()
            cnt += len(sub)
            if len(preds) < 8:
                preds.append(torch.sigmoid(logits).cpu().numpy())
                tgts.append(t.cpu().numpy())
    if preds:
        p = np.concatenate(preds)
        t = np.concatenate(tgts)
        # 相关系数：衡量网络输出与引擎判断的一致程度，是比 loss 更直观的指标
        corr = float(np.corrcoef(p, t)[0, 1]) if p.std() > 0 and t.std() > 0 else float('nan')
        mae = float(np.mean(np.abs(p - t)))
    else:
        corr, mae = float('nan'), float('nan')
    net.train()
    return tot / max(cnt, 1), corr, mae


def pick_device(forced=None):
    if forced:
        return torch.device(forced)
    if torch.cuda.is_available():
        return torch.device('cuda')
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='训练象棋 NNUE 评估网络')
    ap.add_argument('--data', default='../data', help='数据目录')
    ap.add_argument('--out', default='../logs', help='输出目录（checkpoint 与日志）')
    ap.add_argument('--epochs', type=int, default=6)
    ap.add_argument('--batch', type=int, default=8192)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--l1', type=int, default=256, help='第一层宽度')
    ap.add_argument('--l2', type=int, default=32, help='第二层宽度')
    ap.add_argument('--val-frac', type=float, default=0.05, help='验证集比例')
    ap.add_argument('--max-minutes', type=float, default=0,
                    help='训练时长上限（分钟），0 表示不限')
    ap.add_argument('--limit', type=int, default=0,
                    help='只用前 N 条数据（调试用），0 表示全部')
    ap.add_argument('--device', default=None, help='cpu / cuda / mps，默认自动')
    ap.add_argument('--seed', type=int, default=20260921)
    ap.add_argument('--log-every', type=int, default=200, help='每多少步打印一次')
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
    print('=' * 64)

    print('读取数据…')
    data = load_dataset(args.data)
    total = len(data)
    if args.limit and args.limit < total:
        data = data[:args.limit]
        total = len(data)
        print('按 --limit 截断到 %d 条' % total)

    perm = rng.permutation(total)
    n_val = max(1, int(total * args.val_frac))
    val_idx = perm[:n_val]
    tr_idx = perm[n_val:]
    print('训练 %d 条 / 验证 %d 条' % (len(tr_idx), len(val_idx)))

    os.makedirs(args.out, exist_ok=True)
    net = XQNet(l1=args.l1, l2=args.l2).to(device)
    n_param = sum(p.numel() for p in net.parameters())
    print('网络参数：%d 个（第一层 %d x %d = %d，占大头）'
          % (n_param, FEATURE_DIM, args.l1, FEATURE_DIM * args.l1))

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

    for epoch in range(1, args.epochs + 1):
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
            idx_t, side_t, tgt_t = make_batch(data, sub, device)

            logits = net(idx_t, side_t)
            loss = F.binary_cross_entropy_with_logits(logits, tgt_t)
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

        vloss, corr, mae = evaluate(net, data, val_idx, device, args.batch)
        log('  验证：loss=%.5f  与引擎评分的相关系数=%.4f  平均绝对偏差=%.4f'
            % (vloss, corr, mae))

        ckpt = os.path.join(args.out, 'ckpt.pt')
        torch.save({
            'model': net.state_dict(),
            'l1': args.l1, 'l2': args.l2,
            'epoch': epoch, 'step': step,
            'val_loss': vloss, 'val_corr': corr,
        }, ckpt)
        log('  已保存 checkpoint: %s' % ckpt)

    # 另外导出一份纯权重，便于 export.py 直接使用
    torch.save(net.state_dict(), os.path.join(args.out, 'weights.pt'))
    log('')
    log('训练结束，总用时 %.1f 分钟' % ((time.time() - t0) / 60))
    log('权重文件: %s' % os.path.join(args.out, 'weights.pt'))
    log_f.close()


if __name__ == '__main__':
    main()
