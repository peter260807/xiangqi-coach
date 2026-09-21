"""
把训练好的网络导出成紧凑的二进制文件，供引擎侧（C++ / Rust / Swift / JS）加载。

    python export.py --weights ../logs/weights.pt --out ../logs/xq-v2.xqnn

文件格式（全部 little-endian）：

    偏移   类型          内容
    0      char[4]       魔数 "XQNN"
    4      uint32        格式版本（当前 2）
    8      uint32        特征维度 feat_dim
    12     uint32        第一层宽度 l1
    16     uint32        第二层宽度 l2
    20     uint32        output_scale：网络输出 1.0 对应多少分（当前 100）
    24     float32[l1][feat_dim]   第一层权重（行优先，注意是 [l1][feat_dim]）
    ...    float32[2][l1]          先后手偏置
    ...    float32[l2][l1]         第二层权重
    ...    float32[l2]             第二层偏置
    ...    float32[1][l2]          第三层权重
    ...    float32[1]              第三层偏置

⚠️ v1 -> v2 的破坏性变更：
v1 的网络输出经过 sigmoid，含义是「走子方胜率」，要拿 400*ln(p/(1-p)) 换回分值；
v2 去掉了 sigmoid，输出**直接就是分值**（单位由 output_scale 给出，即 100 分）。
加载方必须按版本号分支处理，混用会得到一个看上去正常、实际上毫无意义的数。
offset 20 这个字段在 v1 里是保留位（写 0），v2 才开始有含义。

推理（引擎侧照这个写就行）：

    acc[i] = Σ feat_weight[i][f]  +  side_bias[side][i]      // f 为该局面的激活特征
    h1[i]  = clamp(acc[i], 0, 1)                              // ClippedReLU
    h2[j]  = clamp(Σ fc2_weight[j][i] * h1[i] + fc2_bias[j], 0, 1)
    value  = Σ fc3_weight[0][j] * h2[j] + fc3_bias[0]
    cp     = value * output_scale                             // 走子方视角的分差

想显示胜率的话在展示层再套 sigmoid(cp / 400)，不要放进网络里 ——
那层压缩正是 v1 排序能力失效的原因。

导出后会立刻做一次**独立复现校验**：用纯 numpy 重新实现一遍前向，
和 PyTorch 的输出逐样本对比。两边对不上就说明导出有问题，会直接报错。
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
import struct
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import (CP_SCALE, FEATURE_DIM, FORMAT_VERSION, MAGIC,  # noqa: E402
                   OUTPUT_SCALE, VALUE_CLIP, XQNet)

HEADER_STRUCT = '<4sIIIII'


def export_network(state_dict, path):
    feat_w = state_dict['feat.weight'][:FEATURE_DIM].detach().cpu().numpy().astype(np.float32)
    side_b = state_dict['side_bias'].detach().cpu().numpy().astype(np.float32)
    fc2_w = state_dict['fc2.weight'].detach().cpu().numpy().astype(np.float32)
    fc2_b = state_dict['fc2.bias'].detach().cpu().numpy().astype(np.float32)
    fc3_w = state_dict['fc3.weight'].detach().cpu().numpy().astype(np.float32)
    fc3_b = state_dict['fc3.bias'].detach().cpu().numpy().astype(np.float32)

    l1 = feat_w.shape[1]
    l2 = fc2_w.shape[0]

    with open(path, 'wb') as f:
        f.write(struct.pack(HEADER_STRUCT, MAGIC, FORMAT_VERSION,
                            FEATURE_DIM, l1, l2, int(OUTPUT_SCALE)))
        # 转置成 [l1][feat_dim]，让引擎侧按行连续读取，缓存更友好
        f.write(np.ascontiguousarray(feat_w.T).tobytes())
        f.write(np.ascontiguousarray(side_b).tobytes())
        f.write(np.ascontiguousarray(fc2_w).tobytes())
        f.write(np.ascontiguousarray(fc2_b).tobytes())
        f.write(np.ascontiguousarray(fc3_w).tobytes())
        f.write(np.ascontiguousarray(fc3_b).tobytes())

    return {
        'l1': l1, 'l2': l2,
        'size': os.path.getsize(path),
        'feat_absmax': float(np.abs(feat_w).max()),
        'fc2_absmax': float(np.abs(fc2_w).max()),
        'fc3_absmax': float(np.abs(fc3_w).max()),
    }


# ---------------- 独立复现：完全不依赖 PyTorch，只读文件 ----------------

class NumpyNet:
    """照着文件格式重新实现一遍前向，用来验证导出是否正确。"""

    def __init__(self, path):
        with open(path, 'rb') as f:
            head = f.read(struct.calcsize(HEADER_STRUCT))
            magic, ver, feat_dim, l1, l2, output_scale = struct.unpack(HEADER_STRUCT, head)
            if magic != MAGIC:
                raise ValueError('魔数不对：%r' % magic)
            # v1 的文件仍然读得进来：它的输出是胜率 logit，换算方式不同。
            # 保留这条兼容路径是为了让旧模型还能参与同场对比评估，
            # 不必为了跑一次基准把老文件重新导一遍。
            if ver not in (1, FORMAT_VERSION):
                raise ValueError(
                    '不支持的格式版本：文件是 v%d，本代码支持 v1 与 v%d。'
                    % (ver, FORMAT_VERSION))
            self.legacy_winrate = (ver == 1)
            self.version = ver
            if self.legacy_winrate:
                print('  注意：这是 v1 格式，输出含义是「走子方胜率」，'
                      '分值按 %d*ln(p/(1-p)) 反算' % int(CP_SCALE))

            def take(shape):
                n = int(np.prod(shape))
                return np.frombuffer(f.read(n * 4), dtype='<f4').reshape(shape)

            self.feat_dim, self.l1, self.l2 = feat_dim, l1, l2
            self.output_scale = float(output_scale)
            # 文件里存的是 [l1][feat_dim]，转回 [feat_dim][l1] 方便按特征索引取行
            self.feat_w = take((l1, feat_dim)).T.copy()
            self.side_b = take((2, l1)).copy()
            self.fc2_w = take((l2, l1)).copy()
            self.fc2_b = take((l2,)).copy()
            self.fc3_w = take((1, l2)).copy()
            self.fc3_b = take((1,)).copy()

    def forward(self, feat_lists, sides):
        """返回网络原始输出（单位：由 output_scale 定义）。"""
        out = np.empty(len(feat_lists), dtype=np.float32)
        for i, (feats, side) in enumerate(zip(feat_lists, sides)):
            acc = self.feat_w[feats].sum(axis=0) + self.side_b[side]
            h1 = np.clip(acc, 0.0, 1.0)
            h2 = np.clip(self.fc2_w @ h1 + self.fc2_b, 0.0, 1.0)
            out[i] = float(self.fc3_w[0] @ h2 + self.fc3_b[0])
        return out

    def cp(self, feat_lists, sides):
        """走子方视角的分差，已裁剪到训练标签的值域内。"""
        v = self.forward(feat_lists, sides)
        if self.legacy_winrate:
            # v1：输出是 logit，胜率 = sigmoid(logit)，再按 400 分的刻度反算
            p = np.clip(1.0 / (1.0 + np.exp(-v)), 1e-6, 1 - 1e-6)
            return CP_SCALE * np.log(p / (1.0 - p))
        return np.clip(v, -VALUE_CLIP, VALUE_CLIP) * self.output_scale


def verify_roundtrip(state_dict, path, n=64, seed=0):
    """从训练集里随便造点特征，比对 PyTorch 和 numpy 两条路径的输出。"""
    from model import MAX_FEATURES, PAD_INDEX

    rng = np.random.default_rng(seed)
    feats, sides = [], []
    for _ in range(n):
        k = rng.integers(1, MAX_FEATURES + 1)
        feats.append(sorted(rng.choice(FEATURE_DIM, size=int(k), replace=False).tolist()))
        sides.append(int(rng.integers(0, 2)))

    net = XQNet(l1=state_dict['feat.weight'].shape[1],
                l2=state_dict['fc2.weight'].shape[0])
    net.load_state_dict(state_dict)
    net.eval()

    idx = torch.full((n, MAX_FEATURES), PAD_INDEX, dtype=torch.long)
    for i, fs in enumerate(feats):
        idx[i, :len(fs)] = torch.tensor(fs, dtype=torch.long)
    side_t = torch.tensor(sides, dtype=torch.long)
    with torch.no_grad():
        # 比的是网络原始输出，不做任何后处理 —— 后处理两边都可能有 bug
        ref = net(idx, side_t).numpy()

    npnet = NumpyNet(path)
    got = npnet.forward(feats, sides)

    diff = np.abs(ref - got)
    return float(diff.max()), float(diff.mean()), n


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='导出 NNUE 网络为引擎可加载的格式')
    ap.add_argument('--weights', default='../logs/weights.pt',
                    help='train.py 产出的权重文件，或 ckpt.pt')
    ap.add_argument('--out', default=None, help='输出文件路径')
    ap.add_argument('--l1', type=int, default=None, help='ckpt 未记录时手动指定')
    ap.add_argument('--l2', type=int, default=None)
    return ap.parse_args(argv)


def main():
    args = parse_args()
    if not os.path.isfile(args.weights):
        raise SystemExit('找不到权重文件: %s' % args.weights)

    blob = torch.load(args.weights, map_location='cpu', weights_only=False)
    if isinstance(blob, dict) and 'model' in blob:
        state = blob['model']
        l1 = blob.get('l1', args.l1)
        l2 = blob.get('l2', args.l2)
        print('从 checkpoint 读取：轮次 %s，验证相关系数 %s，目标模式 %s'
              % (blob.get('epoch'), blob.get('val_corr'), blob.get('target_mode')))
    else:
        state = blob
        l1 = args.l1
        l2 = args.l2

    if l1 is None:
        l1 = state['feat.weight'].shape[1]
    if l2 is None:
        l2 = state['fc2.weight'].shape[0]

    out = args.out or os.path.join(os.path.dirname(os.path.abspath(args.weights)),
                                   'xq-v2.xqnn')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    info = export_network(state, out)
    print('已导出: %s' % out)
    print('  维度    : 特征 %d -> %d -> %d -> 1' % (FEATURE_DIM, info['l1'], info['l2']))
    print('  输出    : 分值，1.0 对应 %d 分（v%d 格式）'
          % (int(OUTPUT_SCALE), FORMAT_VERSION))
    print('  体积    : %.2f MB' % (info['size'] / 1024 / 1024))
    print('  权重范围: 第一层 ±%.4f，第二层 ±%.4f，第三层 ±%.4f'
          % (info['feat_absmax'], info['fc2_absmax'], info['fc3_absmax']))

    print()
    print('做独立复现校验（纯 numpy 重新实现前向，与 PyTorch 比对）…')
    mx, mean, n = verify_roundtrip(state, out)
    print('  比对 %d 个随机样本：最大偏差 %.3e，平均偏差 %.3e' % (n, mx, mean))
    if mx > 1e-4:
        print('  !! 偏差过大，导出可能有误')
        return 1
    print('  导出文件可被独立复现，格式正确')
    return 0


if __name__ == '__main__':
    sys.exit(main())
