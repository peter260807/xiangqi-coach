#!/usr/bin/env python3
"""把 .xqnn 权重导出成 JSON，并算出 Python 侧的参考输出（供 JS 实现交叉验证）。

用 NumpyNet 读文件，是为了确保布局解析这一层不出错 —— 它本来就是
「照着文件格式重写一遍前向」用来校验导出的类。
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = '/Users/GoodHarvest/WorkBuddy/2026-09-21-00-07-27/xiangqi-coach/trainer'
sys.path.insert(0, os.path.join(ROOT, 'src'))

import xq                       # noqa: E402
from export import NumpyNet     # noqa: E402

NET = os.path.join(ROOT, 'logs', 'xq-d512.xqnn')
OUT = HERE

net = NumpyNet(NET)
print('网络：%s' % NET)
print('  版本 v%d  feat_dim=%d  l1=%d  l2=%d  output_scale=%.0f  legacy=%s'
      % (net.version, net.feat_dim, net.l1, net.l2, net.output_scale, net.legacy_winrate))

# 权重转成嵌套 list，交给 JS；反正是测试用，不追求文件体积
json.dump({
    'version': net.version,
    'feat_dim': int(net.feat_dim),
    'l1': int(net.l1),
    'l2': int(net.l2),
    'output_scale': float(net.output_scale),
    'legacy_winrate': bool(net.legacy_winrate),
    'side_b': net.side_b.astype(float).tolist(),
    'fc2_w': net.fc2_w.astype(float).tolist(),
    'fc2_b': net.fc2_b.astype(float).tolist(),
    'fc3_w': net.fc3_w.astype(float).tolist(),
    'fc3_b': net.fc3_b.astype(float).tolist(),
    'feat_w': net.feat_w.astype(float).tolist(),      # [feat_dim][l1]
}, open(os.path.join(OUT, 'net_d512.json'), 'w'))

print('  权重已导出 net_d512.json（%.1f MB）'
      % (os.path.getsize(os.path.join(OUT, 'net_d512.json')) / 1024 / 1024))

# 参考输出：对评估用的那 144 个局面
pos = json.load(open(os.path.join(ROOT, 'logs', 'pos-xq-d512.json')))
feats, sides, board_chars = [], [], []
for it in pos:
    b = xq.parse_fen(it['board'])
    s = it['side']
    feats.append(xq.feature_indices(b, s))
    sides.append(0 if s == 'r' else 1)
    board_chars.append(''.join(b))

cp = net.cp(feats, sides)
json.dump({'fens': [it['board'] for it in pos],
           'sides': [it['side'] for it in pos],
           'boards': board_chars,
           'ref_cp': [float(v) for v in cp],
           'n_activated': [len(f) for f in feats]},
          open(os.path.join(OUT, 'ref_cp.json'), 'w'))

print('  参考输出：%d 个局面  cp 范围 %.1f ~ %.1f  平均 %.2f'
      % (len(pos), cp.min(), cp.max(), cp.mean()))
print('  激活特征数：最少 %d 最多 %d'
      % (min(len(f) for f in feats), max(len(f) for f in feats)))
