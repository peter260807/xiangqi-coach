"""
NNUE 风格的评估网络。

结构（刻意做得简单、量化友好、便于 C++ 侧重新实现）：

    稀疏特征索引（最多 32 个）
        │
        ▼  EmbeddingBag 求和（等价于 稀疏一热向量 × 权重）
    l1 维累加器  +  先后手偏置
        │
        ▼  ClippedReLU：clamp(x, 0, 1)
    l2 维
        │
        ▼  ClippedReLU
    1 维  →  走子方分差（单位：兵，即 100 分）

为什么第一层用 EmbeddingBag 而不是普通 Linear：
一张 one-hot 的 1260 维向量 99% 是 0，走普通矩阵乘是纯浪费。
EmbeddingBag 直接按索引把对应行加起来，等价于矩阵乘但只算非零项 ——
这正是 NNUE「累加器」的本质。

--------------------------------------------------------------------------
训练目标：直接回归引擎分值（v2 改动）

v1 把标签做成 sigmoid(cp / 400) 的胜率，用 BCE 训练。这个做法有一个
致命后果：**把要分辨的信号压到了噪声以下**。

实测过：同一局面下的候选着法之间，引擎分差距中位数只有 3 分。经
sigmoid(·/400) 压缩后，3 分只对应 0.0019 的胜率差；而网络的输出误差是
0.0121。信噪比 0.16 —— 信号比噪声还小，网络根本没有能力把候选排出正确
顺序。实测排序名次 2.81 vs 手写评估 2.44，配对 t 检验 p=0.146，完全不显著。

而且 sigmoid 两端会饱和：+800 分和 +1200 分都变成 0.98、0.99，梯度接近 0，
这两类局面在网络眼里没有区别。训练日志里 loss 从 0.6557 只降到 0.6532，
而「永远输出 0.5」的基准是 0.6931 —— 8 轮训练只解释掉 6% 的信息量。

所以 v2 去掉压缩：标签就是 cp 本身（换算成「兵」，除以 100），
损失用 Huber。这样：
  - 排序分辨率是线性的，不存在饱和区；
  - 损失的梯度封顶在一个兵以内，一万三千分之一的杀棋局面不会靠
    「误差大」把梯度全抢走。

注意这里不再有 sigmoid，输出就是分值本身。要让引擎侧显示胜率，
在展示层再套一次 sigmoid(cp / 400) 即可（见 cp_to_prob）。
"""

import math

import torch
import torch.nn as nn

FEATURE_DIM = 1260               # 90 格 × (7 种己方子 + 7 种对方子)
PAD_INDEX = FEATURE_DIM          # 哨兵：补齐位用这个索引，其权重恒为 0
MAX_FEATURES = 32                # 单局面最多 32 个棋子

OUTPUT_SCALE = 100.0             # 网络输出 1.0 对应 100 分（一个兵的量级）
VALUE_CLIP = 30.0                # 标签裁剪到 ±30 兵 = ±3000 分，与 mate 分一致

# Huber 的转折点（单位同上：兵）。小于它按平方损失，大于它按线性损失。
#
# 取 0.5 兵 = 50 分是权衡后的结果：96.5% 的样本 |cp| 落在 800 分以内，
# 但其中 1.13% 是 ±3000 的杀棋局面。纯平方损失下，这些杀棋局面的梯度会
# 是均势局面的上千倍，把网络全部拉去拟合「有没有绝杀」，而排序真正需要
# 的均势局面分辨率反而没人管。转折点设在 50 分，等于把单个样本的梯度
# 封顶在 1.0，杀棋局面最多只能拿到均势局面 3 倍的权重。
HUBER_BETA = 0.5

# 仅用于把分值换算成胜率展示，**不参与训练**。保留这个名字是因为
# 400 分对应约 90% 胜率是国际通用的刻度，展示时用它能让人一眼看懂。
CP_SCALE = 400.0

# 导出文件的魔数与版本。
# v1 -> v2：输出语义从「走子方胜率」变成「走子方分差（单位兵）」，
# 头部新增 output_scale 字段，加载方必须按版本号分支，不能混用。
MAGIC = b'XQNN'
FORMAT_VERSION = 2


def cp_to_value(cp):
    """引擎 cp 分 -> 训练标签（单位：兵，裁剪到 ±VALUE_CLIP）。"""
    return max(-VALUE_CLIP, min(VALUE_CLIP, cp / OUTPUT_SCALE))


def value_to_cp(v):
    """网络输出（单位：兵）-> cp 分。"""
    return v * OUTPUT_SCALE


def cp_to_prob(cp):
    """cp 分 -> 胜率（0~1）。只用于展示，不参与训练。"""
    return 1.0 / (1.0 + math.exp(-cp / CP_SCALE))


def prob_to_cp(p):
    """胜率 -> cp 分。只用于展示。p 需夹在开区间内避免除零。"""
    p = min(max(p, 1e-6), 1 - 1e-6)
    return CP_SCALE * math.log(p / (1.0 - p))


def huber_loss(pred, target, beta=HUBER_BETA):
    """
    Huber（平滑 L1）损失，手写而不用 F.smooth_l1_loss。

    一是为了不受 torch 版本对 beta 参数的支持差异影响，二是这里的语义
    值得写清楚：|误差| < beta 时梯度是误差本身（细粒度收敛），
    超出 beta 后梯度恒为 1（异常值不再抢梯度）。
    """
    diff = pred - target
    absd = diff.abs()
    quad = 0.5 * diff * diff / beta
    lin = absd - 0.5 * beta
    return torch.where(absd < beta, quad, lin).mean()


class XQNet(nn.Module):
    def __init__(self, l1=512, l2=64):
        super().__init__()
        self.l1 = l1
        self.l2 = l2
        self.feat = nn.EmbeddingBag(FEATURE_DIM + 1, l1, mode='sum')
        self.side_bias = nn.Parameter(torch.zeros(2, l1))
        self.fc2 = nn.Linear(l1, l2)
        self.fc3 = nn.Linear(l2, 1)
        self._init_weights()

    def _init_weights(self):
        # 第一层用很小的初始化：它是个"累加器"，初始值大一点就会在
        # 32 个特征累加后爆掉，把 ClippedReLU 全部推入饱和区
        nn.init.normal_(self.feat.weight, std=0.05)
        nn.init.normal_(self.fc2.weight, std=0.05)
        nn.init.zeros_(self.fc2.bias)
        # 第三层输出的是分值（±30 兵），比原来的 logit（±5）大一个量级。
        # 由于 h2 被 ClippedReLU 夹在 [0,1]，输出上限是 Σ|w| + |b|，
        # 初始化太小的话网络要先花很久把权重「长」到能表达大优势的局面。
        nn.init.normal_(self.fc3.weight, std=0.2)
        nn.init.zeros_(self.fc3.bias)

    def forward(self, idx, side):
        """
        idx:  [B, MAX_FEATURES] int64，不足处填 PAD_INDEX
        side: [B] int64，0=红方走，1=黑方走
        返回: [B] 走子方分差（单位：兵）。正数表示走子方占优。
        """
        b = idx.shape[0]
        offsets = torch.arange(b, device=idx.device) * idx.shape[1]
        acc = self.feat(idx.reshape(-1), offsets)      # [B, l1]
        acc = acc + self.side_bias[side]
        h1 = torch.clamp(acc, 0.0, 1.0)                # ClippedReLU
        h2 = torch.clamp(self.fc2(h1), 0.0, 1.0)       # ClippedReLU
        return self.fc3(h2).squeeze(-1)

    def zero_pad_row(self):
        """
        把哨兵行的权重清零。补齐位参与求和但不能贡献任何值，
        否则等于给每个局面加了个固定噪声。
        """
        with torch.no_grad():
            self.feat.weight[PAD_INDEX].zero_()

    @torch.no_grad()
    def predict_cp(self, idx, side):
        """直接给出 cp 分，并裁剪到训练标签的值域内。"""
        v = self.forward(idx, side)
        return torch.clamp(v, -VALUE_CLIP, VALUE_CLIP) * OUTPUT_SCALE


def collate(records, device):
    """
    records: [(feature_idx_list, side_int, target_value), ...]
    返回已经 padding 好的张量。
    """
    b = len(records)
    idx = torch.full((b, MAX_FEATURES), PAD_INDEX, dtype=torch.long)
    side = torch.empty(b, dtype=torch.long)
    target = torch.empty(b, dtype=torch.float32)
    for i, (feats, s, t) in enumerate(records):
        n = min(len(feats), MAX_FEATURES)
        idx[i, :n] = torch.tensor(feats[:n], dtype=torch.long)
        side[i] = s
        target[i] = t
    return idx.to(device), side.to(device), target.to(device)
