"""
特征编码：可切换的几种「视角归一化」编码。

所有编码共享同一个骨架：

    特征索引 = <视角相关的桶> * (90 * 14) + square * 14 + type

其中 type 是 0-13（己方 0-6 / 对方 7-13，随走子方翻转），
<桶> 决定这个编码叫什么名字。

    pst         桶恒为 0（无桶）              → 1260 维
    halfka      桶 = 己方将/帅所在宫格 0-8     → 11340 维
    halfka_rand 桶 = 局面的伪随机值 0-8        → 11340 维（对照组）
    fullka      桶 = 己方将位 x 对方将位 0-80  → 102060 维

为什么要造 halfka_rand 这个「没意义」的对照组：它和 halfka **维度完全相同、
参数量完全相同**，唯一的区别是桶里装的是随机分组而不是将位。
如果 halfka 比 pst 好、而 halfka_rand 并不比 pst 好，说明提升来自
「将位」这个信息本身；如果 halfka_rand 和 halfka 打平，那提升只是
「多了 9 倍的容量在过拟合」，说明这套改动不值得做。

--------------------------------------------------------------------------
为什么用「宫格桶」而不是 Stockfish 那样 64 个将位桶

国际象棋的将可以在 64 格里到处跑，所以 HalfKA 用 64 个桶。
中国象棋的将/帅**只能在九宫里活动**，一共就 9 格 —— 天然只需要 9 个桶。
这是象棋特有的便宜，别照搬 Stockfish 的 64。

宫格编码成 0-8：按「己方底线方向」归一化，让红黑共用一套编号。

    own_row = 9 - r  （红方走时）    红方底线 r=9 → own_row=0
    own_row = r      （黑方走时）    黑方底线 r=0 → own_row=0
    bucket  = own_row * 3 + (c - 3)

红方底线中路（r=9, c=4）和黑方底线中路（r=0, c=4）都映射到 bucket=1，
含义一致（「将还在原位」），样本效率因此翻倍。

注意列方向**不镜像**：和既有的 pst 编码保持一致（pst 用的是绝对格号，
只把棋子颜色做了归一化，没做左右镜像）。保持一致才能保证两边的
不对称性来源相同，比较才有意义。
"""
import numpy as np

NUM_SQUARES = 90
NUM_TYPES = 14                 # 己方 7 种 + 对方 7 种
NUM_KING_BUCKETS = 9           # 九宫 3x3

# 桶内维度，也是历史格式（无桶）的维度。
# 各编码的总维度 = 桶数 x 1260，见 num_buckets / feature_dim。
PST_FEATURE_DIM = NUM_SQUARES * NUM_TYPES          # 1260

MAX_FEATURES = 32              # 单局面最多 32 个棋子

MODES = ('pst', 'halfka', 'halfka_rand', 'fullka')

# 各编码的桶数（每桶内部的特征空间都是 90 格 x 14 类 = 1260 维）
NUM_BUCKETS_OF = {
    'pst': 1,
    'halfka': NUM_KING_BUCKETS,                        # 己方将位 9
    'halfka_rand': NUM_KING_BUCKETS,
    'fullka': NUM_KING_BUCKETS * NUM_KING_BUCKETS,     # 双方将位 9 x 9 = 81
}

RED_KING = ord('K')
BLACK_KING = ord('k')


def num_buckets(mode):
    return NUM_BUCKETS_OF[mode]


def feature_dim(mode):
    return num_buckets(mode) * PST_FEATURE_DIM


def pad_index(mode):
    """哨兵索引：补齐位用它，其权重恒为 0。"""
    return feature_dim(mode)


# ---- 查表：ASCII 字符 -> 棋子种类（0-6）/ 是否红方 ----
BASE = np.full(256, -1, dtype=np.int16)
IS_RED = np.zeros(256, dtype=bool)
for _i, _ch in enumerate('KABNRCP'):
    BASE[ord(_ch)] = _i
    IS_RED[ord(_ch)] = True
for _i, _ch in enumerate('kabnrcp'):
    BASE[ord(_ch)] = _i
    IS_RED[ord(_ch)] = False

_SQ = np.arange(NUM_SQUARES, dtype=np.int64)[None, :]


def row_hash(boards, sides):
    """
    给每行算一个只依赖 (棋盘, 走子方) 的 64 位哈希。

    算法与 gen_data.position_hashes 一致（同样的多项式折叠），
    保证同一局面在两边算出的值相同。这里不直接调它是因为它的入参是
    结构化记录数组，而这里手上只有拆出来的 board / side 两块。
    """
    n = len(boards)
    b = np.ascontiguousarray(boards).view(np.uint8).reshape(n, NUM_SQUARES)
    buf = np.zeros((n, 96), dtype=np.uint8)
    buf[:, :NUM_SQUARES] = b
    buf[:, NUM_SQUARES] = sides
    u = buf.view(np.uint64).reshape(n, 12)
    h = u[:, 0].copy()
    for k in range(1, 12):
        h = h * np.uint64(1000003) + u[:, k]
    return h


def palace_bucket(boards, want_char, home_is_black_side):
    """
    找出 want_char 这个将/帅所在宫格的桶号 0-8。

    按「该方自己底线方向」归一化：own_row = r（底线在第 0 行，黑方）
    或 9 - r（底线在第 9 行，红方），bucket = own_row * 3 + (c - 3)。
    这样红黑两方的「将还在底线中路」都映射到同一个桶，含义一致。

    顺手校验桶号落在 0-8：将/帅跑到九宫外面说明棋盘或字节解析错了，
    这种错误必须立刻炸出来，不能带着它去训网络。
    """
    hit = (boards == want_char[:, None])                   # (N, 90)
    sq = hit.argmax(axis=1).astype(np.int64)               # (N,)
    if not hit.any(axis=1).all():
        raise ValueError('有局面找不到指定的将/帅，棋盘或走子方标错了')
    r = sq // 9
    c = sq % 9
    own_row = np.where(home_is_black_side, r, 9 - r)
    b = own_row * 3 + (c - 3)
    if ((b < 0) | (b > NUM_KING_BUCKETS - 1)).any():
        raise ValueError('将/帅不在九宫内，棋盘有误')
    return b


def king_buckets(boards, sides, mode):
    """
    算每行的「视角桶」。boards: (N,90) uint8；sides: (N,) 0=红方走 / 1=黑方走。

    pst         恒为 0（无桶）
    halfka      己方将位，0-8
    halfka_rand 局面的伪随机值，0-8（同维度对照）
    fullka      己方将位 x 对方将位，0-80
    """
    n = len(boards)
    if mode == 'pst':
        return np.zeros(n, dtype=np.int64)
    if mode == 'halfka_rand':
        return (row_hash(boards, sides) % np.uint64(NUM_KING_BUCKETS)).astype(np.int64)

    red_to_move = (sides == 0)
    own_char = np.where(red_to_move, RED_KING, BLACK_KING).astype(np.uint8)
    # 红方走时己方是红（底线在第 9 行）→ home_is_black_side=False
    own = palace_bucket(boards, own_char, ~red_to_move)
    if mode == 'halfka':
        return own

    # fullka：再带上对方将位。对方是黑时底线在第 0 行 → home_is_black_side=True
    opp_char = np.where(red_to_move, BLACK_KING, RED_KING).astype(np.uint8)
    opp = palace_bucket(boards, opp_char, red_to_move)
    return own * NUM_KING_BUCKETS + opp


def compute_features(boards, sides, mode='pst'):
    """
    boards: (B, 90) uint8；sides: (B,) uint8（0=红方走，1=黑方走）
    返回:  (B, 32) int64 特征索引，不足处填 PAD_INDEX

    视角归一化在这里完成：轮到谁走，谁的子就映射到类型 0-6，
    对方映射到 7-13。这样网络只需学一套「己方 / 对方」的概念，
    不必分别为红黑各学一套，样本效率翻倍。
    """
    base = BASE[boards]                                  # (B,90)
    occupied = base >= 0
    is_red = IS_RED[boards]
    red_to_move = (sides == 0)[:, None]
    own = (is_red == red_to_move)
    final_type = base + np.where(own, 0, 7).astype(np.int16)

    bucket = king_buckets(boards, sides, mode)[:, None]
    feat_all = (bucket * NUM_SQUARES + _SQ) * NUM_TYPES + final_type

    # 把有子的格子稳定地排到前面，取前 32 个
    order = np.argsort(~occupied, axis=1, kind='stable')
    take = order[:, :MAX_FEATURES]
    cols = np.take_along_axis(feat_all, take, axis=1)
    valid = np.take_along_axis(occupied, take, axis=1)
    return np.where(valid, cols, pad_index(mode)).astype(np.int64)


# ---------------- 单局面参考实现（供测试与引擎侧移植对照） ----------------

def feature_indices(board, side, mode='pst'):
    """
    返回**单个局面**在走子方视角下的激活特征索引列表（不含补齐位）。

    board 是 90 个字符的列表（见 xq.parse_fen），side 是 'r' / 'b'。
    这个函数刻意写得直白，作为向量化实现的对照基准：
    两边结果必须逐个相等，否则向量化那版就是在悄悄算别的东西。
    """
    from xq import TYPE_OF, RED_PIECES_SET, EMPTY          # 局部导入避免循环依赖

    if mode == 'halfka_rand':
        raise ValueError('halfka_rand 是向量化对照组，不提供单局面参考实现')

    red_side = (side == 'r')

    def bucket_of(ch, home_is_black):
        try:
            sq = board.index(ch)
        except ValueError:
            raise ValueError('棋盘上找不到将/帅: %r' % ch)
        r, c = divmod(sq, 9)
        own_row = r if home_is_black else 9 - r
        b = own_row * 3 + (c - 3)
        if not 0 <= b <= NUM_KING_BUCKETS - 1:
            raise ValueError('将/帅不在九宫内: %r' % ch)
        return b

    bucket = 0
    if mode == 'halfka':
        bucket = bucket_of('K' if red_side else 'k', not red_side)
    elif mode == 'fullka':
        own = bucket_of('K' if red_side else 'k', not red_side)
        opp = bucket_of('k' if red_side else 'K', red_side)
        bucket = own * NUM_KING_BUCKETS + opp

    out = []
    for i in range(NUM_SQUARES):
        p = board[i]
        if p == EMPTY:
            continue
        t = TYPE_OF[p]
        if (p in RED_PIECES_SET) != red_side:
            t += 7
        out.append((bucket * NUM_SQUARES + i) * NUM_TYPES + t)
    return out
