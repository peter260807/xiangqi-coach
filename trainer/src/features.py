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

MODES = ('pst', 'halfka', 'halfka_rand', 'fullka', 'mob', 'rel')

# 各编码的桶数（每桶内部的特征空间都是 90 格 x 14 类 = 1260 维）
NUM_BUCKETS_OF = {
    'pst': 1,
    'halfka': NUM_KING_BUCKETS,                        # 己方将位 9
    'halfka_rand': NUM_KING_BUCKETS,
    'fullka': NUM_KING_BUCKETS * NUM_KING_BUCKETS,     # 双方将位 9 x 9 = 81
    'mob': 1,                                          # 骨架同 pst + 机动性段
    'rel': 1,                                          # 骨架同 pst + 机动性 + 威胁
}

RED_KING = ord('K')
BLACK_KING = ord('k')


def num_buckets(mode):
    return NUM_BUCKETS_OF[mode]


def feature_dim(mode):
    """总维度 = 骨架（桶数 x 1260）+ 关系特征段（mob 只有机动性，rel 再加威胁）。"""
    d = num_buckets(mode) * PST_FEATURE_DIM
    if mode == 'mob':
        d += MOB_DIM
    elif mode == 'rel':
        d += REL_DIM
    return d


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
    mob / rel   恒为 0（骨架同 pst，关系特征另成一段，见文件后半）
    halfka      己方将位，0-8
    halfka_rand 局面的伪随机值，0-8（同维度对照）
    fullka      己方将位 x 对方将位，0-80
    """
    n = len(boards)
    if mode in ('pst', 'mob', 'rel'):
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


# ==================== 关系特征段（mob）：每方到底有多少棋可走 ====================
#
# 现有骨架「桶 x (格子 x 类型)」再求和，只能表达「某个子摆在某个格子上值多少分」
# 的**线性叠加**，表达不了子和子之间的关系。06 号报告把瓶颈定位在这里。
# 这一段补的是其中最经典的一条：**机动性** —— 每一方还剩多少着法可走。
#
# 索引安排在原有骨架之后：
#
#   [0, 1260)                     原有 PST 骨架
#   [1260, 1260 + 2*16)           机动性：己方 / 对方，各按 4 步一桶分 16 桶
#
# 视角沿用骨架那套（轮到谁走谁就是「己方」），但两侧的桶是分开的 ——
# 「该我走时我有 30 种走法」和「对手有 30 种走法」完全是两码事，不能共用一个桶。
#
# 这里算的是**伪合法**着法：不检查走完是否自己被将、不查蹩马腿 / 塞象眼。
# 特征只需要反映「活动空间有多大」，不需要严格性；而严格的走法生成在 numpy 里
# 既慢又容易写错。士 / 象的落点仍然限制在九宫 / 己方半场 —— 那不是严格性问题，
# 而是它们本来就到不了那里。

MOB_BUCKETS = 16        # 4 步一桶，最后一桶把更大的值收口
MOB_STEP = 4
MOB_DIM = 2 * MOB_BUCKETS       # 32
MOB_MAX = 2                     # 单局面固定追加 2 个槽位（己方一个、对方一个）

_T_K, _T_A, _T_B, _T_N, _T_R, _T_C, _T_P = range(7)

_SQ_R = (np.arange(NUM_SQUARES) // 9).astype(np.int16)
_SQ_C = (np.arange(NUM_SQUARES) % 9).astype(np.int16)

_HORSE_STEPS = ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1))
_ELEPHANT_STEPS = ((-2, -2), (-2, 2), (2, -2), (2, 2))
_ADVISOR_STEPS = ((-1, -1), (-1, 1), (1, -1), (1, 1))
_KING_STEPS = ((-1, 0), (1, 0), (0, -1), (0, 1))


def max_features(mode):
    """单个局面的特征槽位数（含补齐位）。"""
    if mode == 'mob':
        return MAX_FEATURES + MOB_MAX
    if mode == 'rel':
        return MAX_FEATURES + MOB_MAX + REL_MAX
    return MAX_FEATURES


NUM_ROWS = 10
NUM_COLS = 9
# 自证：棋盘就是 10x9。第一版把这里写成 9x9，reshape 当场炸了 —— 留个断言
# 比下次再靠报错反推强。（象棋是 10 行，不是国际象棋的 8。）
if NUM_ROWS * NUM_COLS != NUM_SQUARES:
    raise AssertionError('棋盘尺寸常量与 NUM_SQUARES 不一致')


def _step_empty(occ, dr, dc):
    """(B,90) 沿固定偏移走一步，落点是否**在盘内且为空**。越界一律 False。"""
    tr = _SQ_R + dr
    tc = _SQ_C + dc
    ok = (tr >= 0) & (tr < NUM_ROWS) & (tc >= 0) & (tc < NUM_COLS)
    idx = np.broadcast_to(np.where(ok, tr * NUM_COLS + tc, 0)[None, :], occ.shape)
    return np.broadcast_to(ok[None, :], occ.shape) & ~np.take_along_axis(occ, idx, axis=1)


def _first_blocker(occ):
    """
    (B,4,90) 每格沿 下/上/右/左 四个方向的第一个障碍格号，没有则 -1。

    沿每个方向做一次线性扫描、边走边记 —— 比「逐格射线」快一个量级。
    车和炮的移动能力直接由它得出。

    注意两个方向的中间量形状不一样：上下方向是「每列一个游标」(B,9)，
    左右方向是「每行一个游标」(B,10)。棋盘不是正方形，这里弄混会静默错位。
    """
    b = occ.shape[0]
    g = occ.reshape(b, NUM_ROWS, NUM_COLS)
    out = np.full((b, 4, NUM_SQUARES), -1, dtype=np.int16)
    col = np.arange(NUM_COLS, dtype=np.int16)
    row = np.arange(NUM_ROWS, dtype=np.int16) * NUM_COLS

    # 方向 0：向下（行号增大）。从最大行往上扫，cur 记「已经扫过的最近一个子」
    cur = np.full((b, NUM_COLS), -1, dtype=np.int16)
    for r in range(NUM_ROWS - 1, -1, -1):
        out[:, 0, r * NUM_COLS:(r + 1) * NUM_COLS] = cur
        cur = np.where(g[:, r, :], (r * NUM_COLS + col)[None, :], cur)
    # 方向 1：向上
    cur = np.full((b, NUM_COLS), -1, dtype=np.int16)
    for r in range(NUM_ROWS):
        out[:, 1, r * NUM_COLS:(r + 1) * NUM_COLS] = cur
        cur = np.where(g[:, r, :], (r * NUM_COLS + col)[None, :], cur)
    # 方向 2：向右（列号增大）—— 游标按行
    cur = np.full((b, NUM_ROWS), -1, dtype=np.int16)
    for c in range(NUM_COLS - 1, -1, -1):
        out[:, 2, c::NUM_COLS] = cur
        cur = np.where(g[:, :, c], (row + c)[None, :], cur)
    # 方向 3：向左
    cur = np.full((b, NUM_ROWS), -1, dtype=np.int16)
    for c in range(NUM_COLS):
        out[:, 3, c::NUM_COLS] = cur
        cur = np.where(g[:, :, c], (row + c)[None, :], cur)
    return out


def _slide_empty(first):
    """(B,4,90) 每格在 4 个直行方向上、到第一个障碍之间的空格数；无障碍算到边界。"""
    b = first.shape[0]
    edge = np.stack([NUM_ROWS - 1 - _SQ_R, _SQ_R,
                     NUM_COLS - 1 - _SQ_C, _SQ_C]).astype(np.int16)   # (4,90)
    out = np.empty((b, 4, NUM_SQUARES), dtype=np.int16)
    for k in range(4):
        blk = first[:, k, :]
        safe = np.clip(blk, 0, NUM_SQUARES - 1)
        d = np.abs(_SQ_R[safe] - _SQ_R[None, :]) + np.abs(_SQ_C[safe] - _SQ_C[None, :]) - 1
        out[:, k, :] = np.where(blk >= 0, d, edge[k][None, :])
    return out


def _in_own_palace(is_red, tr, tc):
    """落点是否在**走子方自己的**九宫里。"""
    inside_c = (tc >= 3) & (tc <= 5)
    return np.where(is_red, (tr >= 7) & (tr <= 9) & inside_c,
                           (tr >= 0) & (tr <= 2) & inside_c)


def mobility_per_side(boards):
    """
    每方的伪合法着法总数，(B,2) int32：[:,0] 红方、[:,1] 黑方。

      车 / 炮 —— 四个直行方向上、到第一个障碍之间的空格数之和
                 （炮的吃子要靠炮架，这里不计，理由见段首注释）
      马      —— 8 个跳格中为空格的个数（不查蹩腿）
      象 / 士 —— 4 个斜跳格中为空格的个数，落点限制在己方半场 / 九宫
      将 / 帅 —— 九宫内 4 个正交邻格中为空格的个数
      兵 / 卒 —— 前进一格；过河之后还能左右横走
    """
    b = boards.shape[0]
    base = BASE[boards]                       # (B,90)，-1 表示空格
    occ = base >= 0
    is_red = IS_RED[boards]
    slide = _slide_empty(_first_blocker(occ)).sum(axis=1)      # (B,90)

    tot = np.zeros((b, 2), dtype=np.int32)

    straight = (base == _T_R) | (base == _T_C)
    s = np.where(straight, slide, 0)
    tot[:, 0] += np.where(is_red, s, 0).sum(axis=1)
    tot[:, 1] += np.where(~is_red, s, 0).sum(axis=1)

    for steps, kinds, region in (
        (_HORSE_STEPS, (_T_N,), None),
        (_ELEPHANT_STEPS, (_T_B,), 'half'),
        (_ADVISOR_STEPS, (_T_A,), 'palace'),
        (_KING_STEPS, (_T_K,), 'palace'),
    ):
        for dr, dc in steps:
            ok = _step_empty(occ, dr, dc)                       # (B,90)
            if region == 'palace':
                ok = ok & _in_own_palace(is_red, _SQ_R + dr, _SQ_C + dc)
            elif region == 'half':
                tr = _SQ_R + dr
                ok = ok & np.where(is_red, tr >= 5, tr <= 4)
            for t in kinds:
                m = (base == t) & ok
                tot[:, 0] += (m & is_red).sum(axis=1)
                tot[:, 1] += (m & ~is_red).sum(axis=1)

    # 兵 / 卒：红方向上、黑方向下；过河之后能横走
    pawn = (base == _T_P)
    for side in (0, 1):
        sel = is_red if side == 0 else ~is_red
        tot[:, side] += (pawn & sel & _step_empty(occ, -1 if side == 0 else 1, 0)).sum(axis=1)
        crossed = (_SQ_R <= 4) if side == 0 else (_SQ_R >= 5)
        for dc in (-1, 1):
            tot[:, side] += (pawn & sel & crossed[None, :] & _step_empty(occ, 0, dc)).sum(axis=1)
    return tot


def _mob_bucket(count):
    """着法数 -> 桶号 0..MOB_BUCKETS-1，每 MOB_STEP 步一桶，尾部收口。"""
    return np.minimum(count // MOB_STEP, MOB_BUCKETS - 1)


def mobility_feature_indices(boards, sides):
    """
    (B, MOB_MAX) int64，机动性特征的**段内**索引（0..MOB_DIM-1）。
    第 0 列是「己方」（按走子方视角），第 1 列是对方。
    """
    moves = mobility_per_side(boards)
    red_to_move = (sides == 0)
    own = np.where(red_to_move, moves[:, 0], moves[:, 1])
    opp = np.where(red_to_move, moves[:, 1], moves[:, 0])
    return np.stack([_mob_bucket(own).astype(np.int64),
                     (MOB_BUCKETS + _mob_bucket(opp)).astype(np.int64)], axis=1)


# ---------------- 关系特征段（rel）：谁正挨打 ----------------
#
# 机动性回答「还有多少棋可走」，这一段回答「哪些子正被攻击」。两者合起来才是
# 06 号报告说的「子和子之间发生了什么」。
#
# 编码：每个**正被对方攻击**的棋子产生一个特征，取值是视角归一化后的棋子类型
# 0..13（0-6 己方 / 7-13 对方），所以这一段只有 14 维。
# EmbeddingBag 是求和，同一索引出现多次会自然累加 ——「两个马都被攻击」由
# 「马被攻击」这个索引出现两次表达，不必为「被攻击几个」再开维度。
#
# 只给「被攻击」的子建特征：没被攻击是常态，权重的正负号本身就能表达
# 「这类子挨打是坏事」，不需要额外的「未被攻击」标签。
#
# 攻击判定同样是伪合法的：不查蹩马腿 / 塞象眼。但**炮必须隔一个子才能吃到目标**
# 这一点不能省 —— 省了炮就成了无阻挡的车，特征会完全失真。

REL_THREAT_DIM = 14                     # 视角归一化后的类型 0..13
REL_DIM = MOB_DIM + REL_THREAT_DIM      # 32 + 14 = 46
REL_MAX = 16                            # 单局面最多追加这么多威胁特征


def _second_blocker(first):
    """
    越过第一个障碍之后遇到的第一个障碍 —— 也就是炮的吃子目标。

    不用再扫一遍：在「第一障碍」那个格子上再取一次第一障碍就是答案
    （两者必定在同一条射线上，所以直接按格子索引即可）。
    """
    second = np.full_like(first, -1)
    for k in range(4):
        blk = first[:, k, :]
        idx = np.clip(blk, 0, NUM_SQUARES - 1)
        second[:, k, :] = np.where(blk >= 0, np.take_along_axis(blk, idx, axis=1), -1)
    return second


def _mark(atk, side, hit, tgt):
    """把 hit 为真的那些格子的攻击目标 tgt 标记进 atk[:, side, :]。"""
    if not hit.any():
        return
    bi, _ = np.nonzero(hit)
    atk[bi, side, np.broadcast_to(tgt, hit.shape)[hit]] = True


def attack_mask(boards):
    """
    (B,2,90) bool：某格是否被 红方(0) / 黑方(1) 攻击。

    伪合法：不查蹩马腿 / 塞象眼；炮必须隔一个子才能落到目标。
    攻击只关心「能不能打到」，所以不分敌我 —— 打在自家子上也算攻击。
    """
    b = boards.shape[0]
    base = BASE[boards]
    occ = base >= 0
    is_red = IS_RED[boards]
    first = _first_blocker(occ)
    second = _second_blocker(first)
    atk = np.zeros((b, 2, NUM_SQUARES), dtype=bool)

    for side, sel in ((0, is_red), (1, ~is_red)):
        # 车 = 第一个障碍；炮 = 越过第一个障碍后的那个子
        for t, tbl in ((_T_R, first), (_T_C, second)):
            src = (base == t) & sel
            for k in range(4):
                tgt = tbl[:, k, :]
                _mark(atk, side, src & (tgt >= 0), tgt)
        # 跳格类（马 / 象 / 士 / 将）
        for steps, kinds in ((_HORSE_STEPS, (_T_N,)), (_ELEPHANT_STEPS, (_T_B,)),
                             (_ADVISOR_STEPS, (_T_A,)), (_KING_STEPS, (_T_K,))):
            for dr, dc in steps:
                tr = _SQ_R + dr
                tc = _SQ_C + dc
                ok = (tr >= 0) & (tr < NUM_ROWS) & (tc >= 0) & (tc < NUM_COLS)
                tgt = np.where(ok, tr * NUM_COLS + tc, 0)[None, :]
                for t in kinds:
                    _mark(atk, side, (base == t) & sel & ok[None, :], tgt)
        # 兵 / 卒：吃子方向与走法一致（中国象棋的兵不斜吃），过河后才能横吃
        pawn = (base == _T_P) & sel
        # 注意 is_red 是**逐格**的 (B,90)，所以这里不能加 [None, :] ——
        # 加了会把结果变成 (1,B,90)，_mark 里解包就炸。
        fwd = np.where(is_red, _SQ_R - 1, _SQ_R + 1)      # (B,90)
        okf = (fwd >= 0) & (fwd < NUM_ROWS)
        _mark(atk, side, pawn & okf, np.where(okf, fwd * NUM_COLS + _SQ_C, 0))
        crossed = np.where(is_red, _SQ_R <= 4, _SQ_R >= 5)     # (B,90)
        for dc in (-1, 1):
            tc = _SQ_C + dc
            okc = (tc >= 0) & (tc < NUM_COLS)
            _mark(atk, side, pawn & crossed & okc,
                  np.where(okc, _SQ_R * NUM_COLS + tc, 0)[None, :])
    return atk


def threat_feature_indices(boards, sides):
    """
    (B, REL_MAX) int64：正被对方攻击的棋子各占一个槽位，段内取值 0..13；
    空出来的位置填 -1（由调用方换成 pad）。
    """
    base = BASE[boards]
    occ = base >= 0
    red_to_move = (sides == 0)[:, None]
    own = (IS_RED[boards] == red_to_move)
    atk = attack_mask(boards)
    # 两个方向都要看：我的子被对方打（真威胁）、他的子被我打（我制造的压力）。
    # **不能只取「对方攻击格 ∩ 所有子」** —— 攻击判定本身不分敌我（打自家子也算
    # 打得到），那样会把「他打他自己的子」一并算进来，混一堆无关噪声。
    own_atk = np.where(red_to_move, atk[:, 0, :], atk[:, 1, :])
    enemy_atk = np.where(red_to_move, atk[:, 1, :], atk[:, 0, :])
    hit = occ & ((own & enemy_atk) | (~own & own_atk))

    kind = np.where(own, 0, 7) + base                 # 视角归一化后的类型 0..13
    val = np.where(hit, kind, -1).astype(np.int64)
    # 有效的排前面（stable 保证同一局面结果可复现），取前 REL_MAX 个
    order = np.argsort(val < 0, axis=1, kind='stable')[:, :REL_MAX]
    out = np.take_along_axis(val, order, axis=1)
    return np.where(out >= 0, out, -1)


def compute_features(boards, sides, mode='pst'):
    """
    boards: (B, 90) uint8；sides: (B,) uint8（0=红方走，1=黑方走）
    返回:  (B, max_features(mode)) int64 特征索引，不足处填 PAD_INDEX

    视角归一化在这里完成：轮到谁走，谁的子就映射到类型 0-6，
    对方映射到 7-13。这样网络只需学一套「己方 / 对方」的概念，
    不必分别为红黑各学一套，样本效率翻倍。

    mode='mob' 时在骨架之后追加机动性段，见上面那段注释。
    """
    base = BASE[boards]                                  # (B,90)
    occupied = base >= 0
    is_red = IS_RED[boards]
    red_to_move = (sides == 0)[:, None]
    own = (is_red == red_to_move)
    final_type = base + np.where(own, 0, 7).astype(np.int16)

    bucket = king_buckets(boards, sides, mode)[:, None]
    feat_all = (bucket * NUM_SQUARES + _SQ) * NUM_TYPES + final_type

    # 把有子的格子稳定地排到前面，取前 MAX_FEATURES 个
    order = np.argsort(~occupied, axis=1, kind='stable')
    take = order[:, :MAX_FEATURES]
    cols = np.take_along_axis(feat_all, take, axis=1)
    valid = np.take_along_axis(occupied, take, axis=1)
    out = np.where(valid, cols, pad_index(mode)).astype(np.int64)

    parts = [out]
    if mode == 'mob':
        parts.append(mobility_feature_indices(boards, sides) + PST_FEATURE_DIM)
    elif mode == 'rel':
        parts.append(mobility_feature_indices(boards, sides) + PST_FEATURE_DIM)
        th = threat_feature_indices(boards, sides)
        # 没有有效值的位置填 pad；有值的加偏移搬到 [1260+32, 1260+46)
        parts.append(np.where(th >= 0, th + PST_FEATURE_DIM + MOB_DIM, pad_index(mode)))
    if len(parts) > 1:
        out = np.concatenate(parts, axis=1)
    return out


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
