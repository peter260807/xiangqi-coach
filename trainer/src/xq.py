"""
中国象棋棋盘表示与 NNUE 风格的特征编码。

设计取舍：这里的棋盘只负责「记录状态」和「应用着法」，**不做合法性判断**。
因为所有着法都来自 Pikafish，天然合法。所以不需要实现马腿、象眼、白脸将、
过河兵这些规则，代码量很小，也不会有规则实现出 bug 的风险。

棋盘索引：r * 9 + c，r=0 是黑方底线（对应 UCI 的行 9），r=9 是红方底线（UCI 行 0）。
UCI 坐标：列 a-i 从左到右，行 0-9 从红方底线往上数。
"""

START_FEN = 'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR'

EMPTY = '.'

RED_PIECES = 'KABNRCP'
BLACK_PIECES = 'kabnrcp'
RED_PIECES_SET = frozenset(RED_PIECES)

# 棋子类型编号：视角相关。0-6 是「己方」，7-13 是「对方」。
TYPE_OF = {
    'K': 0, 'A': 1, 'B': 2, 'N': 3, 'R': 4, 'C': 5, 'P': 6,
    'k': 0, 'a': 1, 'b': 2, 'n': 3, 'r': 4, 'c': 5, 'p': 6,
}

NUM_SQUARES = 90
NUM_TYPES = 14                 # 己方 7 种 + 对方 7 种
FEATURE_DIM = NUM_SQUARES * NUM_TYPES   # 1260

MAX_PIECES = 32                # 单方最多 16 个，双方最多 32 个，用来给索引数组定长


def parse_fen(fen):
    """把 FEN 转成 90 字符的列表，每格一个字符。"""
    board = []
    for row in fen.split('/'):
        if len(row) != 9:
            raise ValueError('FEN 每段必须是 9 个字符，收到: %r' % row)
        board.extend(row)
    if len(board) != NUM_SQUARES:
        raise ValueError('FEN 必须共 90 格，收到 %d 格' % len(board))
    return board


def board_to_fen(board):
    return '/'.join(''.join(board[i * 9:(i + 1) * 9]) for i in range(10))


def board_to_std_fen(board):
    """转成标准 FEN 的棋盘部分：连续空格写成数字。

    我们内部用 '.' 表示空格，但引擎只认标准 FEN ——
    直接传 '.' 记法会被 Pikafish 判成
        Invalid FEN. Invalid piece: .
    所以给引擎的局面必须先过这一道转换。
    """
    rows = []
    for row in board_to_fen(board).split('/'):
        buf = []
        empty = 0
        for ch in row:
            if ch == EMPTY:
                empty += 1
                continue
            if empty:
                buf.append(str(empty))
                empty = 0
            buf.append(ch)
        if empty:
            buf.append(str(empty))
        rows.append(''.join(buf))
    return '/'.join(rows)


def to_engine_fen(board, side):
    """拼出引擎可直接使用的完整 FEN。

    两个容易踩的点：
      1. 空格用数字表示（见 board_to_std_fen）
      2. 走子方是 w / b，不是 r / b
    """
    return '%s %s - - 0 1' % (board_to_std_fen(board),
                              'w' if side == 'r' else 'b')


def uci_to_idx(sq):
    """'e0' -> 85（红方底线中路）"""
    c = ord(sq[0]) - 97
    r = 9 - int(sq[1])
    if not (0 <= c < 9 and 0 <= r < 10):
        raise ValueError('坐标越界: %r' % sq)
    return r * 9 + c


def idx_to_uci(i):
    return chr(97 + i % 9) + str(9 - i // 9)


def apply_move(board, uci):
    """应用一步着法（就地修改），返回被吃掉的子（可能是 '.'），便于撤销。"""
    f = uci_to_idx(uci[0:2])
    t = uci_to_idx(uci[2:4])
    captured = board[t]
    board[t] = board[f]
    board[f] = EMPTY
    return captured


def undo_move(board, uci, captured):
    f = uci_to_idx(uci[0:2])
    t = uci_to_idx(uci[2:4])
    board[f] = board[t]
    board[t] = captured


def feature_indices(board, side):
    """
    返回这个局面在「走子方视角」下的激活特征索引列表。

    视角归一化：轮到红方走时，红子映射到类型 0-6、黑子映射到 7-13；
    轮到黑方走时反过来。这样网络只需学一套「己方/对方」的概念，
    不必分别为红黑学两套，样本效率翻倍。
    """
    red_side = (side == 'r')
    out = []
    for i in range(NUM_SQUARES):
        p = board[i]
        if p == EMPTY:
            continue
        is_red = p in RED_PIECES_SET
        base = TYPE_OF[p]
        # 己方 -> 0-6，对方 -> 7-13
        t = base if (is_red == red_side) else base + 7
        out.append(i * NUM_TYPES + t)
    return out


def piece_count(board, side):
    """某一方还剩多少个子（用于判断是否进入残局，以及数据采样时的分段）。"""
    if side == 'r':
        return sum(1 for p in board if p in RED_PIECES_SET)
    return sum(1 for p in board if p != EMPTY and p not in RED_PIECES_SET)


def material(board, side):
    """子力总值，用常见估值：车 9、炮 4.5、马 4、仕相 2、兵 1。"""
    values = {'R': 9.0, 'C': 4.5, 'N': 4.0, 'B': 2.0, 'A': 2.0, 'P': 1.0}
    total = 0.0
    for p in board:
        if p == EMPTY:
            continue
        v = values.get(p.upper(), 0.0)
        if (p in RED_PIECES_SET) == (side == 'r'):
            total += v
    return total


def mirror_side(side):
    return 'b' if side == 'r' else 'r'
