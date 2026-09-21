"""
NNUE 风格的评估网络。

结构（刻意做得简单、量化友好、便于 C++ 侧重新实现）：

    稀疏特征索引（最多 32 个）
        │
        ▼  EmbeddingBag 求和（等价于 稀疏一热向量 × 权重）
    256 维累加器  +  先后手偏置
        │
        ▼  ClippedReLU：clamp(x, 0, 1)
    32 维
        │
        ▼  ClippedReLU
    1 维  →  sigmoid  →  走子方胜率

为什么第一层用 EmbeddingBag 而不是普通 Linear：
一张 one-hot 的 1260 维向量 99% 是 0，走普通矩阵乘是纯浪费。
EmbeddingBag 直接按索引把对应行加起来，等价于矩阵乘但只算非零项 ——
这正是 NNUE「累加器」的本质。

训练目标：让网络输出的胜率去拟合 Pikafish 自己判断的胜率
（把它的 cp 分按 sigmoid(cp / 400) 转过来）。也就是在**蒸馏**它的评估函数。
"""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

FEATURE_DIM = 1260
PAD_INDEX = FEATURE_DIM          # 哨兵：补齐位用这个索引，其权重恒为 0
MAX_FEATURES = 32                # 单局面最多 32 个棋子
CP_SCALE = 400.0                 # cp 转胜率的尺度，沿用国际通用的 400

# 导出文件的魔数与版本
MAGIC = b'XQNN'
FORMAT_VERSION = 1


def cp_to_prob(cp):
    """Pikafish 的 cp 分 -> 胜率（0~1）。这是训练标签的来源。"""
    return 1.0 / (1.0 + math.exp(-cp / CP_SCALE))


def prob_to_cp(p):
    """胜率 -> cp 分，供引擎评分使用。p 需要夹在开区间内避免除零。"""
    p = min(max(p, 1e-6), 1 - 1e-6)
    return CP_SCALE * math.log(p / (1.0 - p))


class XQNet(nn.Module):
    def __init__(self, l1=256, l2=32):
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
        nn.init.normal_(self.fc3.weight, std=0.05)
        nn.init.zeros_(self.fc3.bias)

    def forward(self, idx, side):
        """
        idx:  [B, MAX_FEATURES] int64，不足处填 PAD_INDEX
        side: [B] int64，0=红方走，1=黑方走
        返回: [B] logits（未过 sigmoid）
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
    def predict_prob(self, idx, side):
        return torch.sigmoid(self.forward(idx, side))


def collate(records, device):
    """
    records: [(feature_idx_list, side_int, target_prob), ...]
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
