package com.peter260807.xiangqicoach.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 规则层的**第一关验收**：perft 对数。
 *
 * perft = 从某局面出发，数「深度 d 内的合法着法序列」有多少条。
 * 它是规则实现的黄金标准：**只要有一条走子规则写错，这个数字就对不上**，
 * 而且不像「AI 下棋看起来还行」那样可以被蒙混过去。
 *
 * 标准值（起始局面，出处见 docs/android-plan.md §3.1）：
 *
 * | 深度 | 节点数 |
 * |---|---|
 * | 1 | 44 |
 * | 2 | 1 920 |
 * | 3 | 79 666 |
 * | 4 | 3 290 240 |
 *
 * ⚠️ **计数口径**（这个坑踩过，别再踩）：
 * 1. perft **只过滤「自己的帅被将」**，不过滤「对方被将军」——
 *    把「给对方将军」的局面也剔掉的话，79 666 会变成 79 258，
 *    而两个数字看起来都「挺像那么回事」。
 * 2. 递归到 `depth == 1` 时返回的是 `legalMoves(b, side).size`，
 *    也就是**叶子层的合法着法数之和**；本项目里它恰好等于「子节点数之和」，
 *    但两者不是同一个定义，改代码时不要混用。
 */
class PerftTest {

    private fun perft(board: ByteArray, side: Side, depth: Int): Long {
        if (depth == 0) return 1
        val moves = Rules.legalMoves(board, side)
        if (depth == 1) return moves.size.toLong()
        var total = 0L
        val work = board.copyOf()
        for (m in moves) {
            val cap = Rules.makeMove(work, m)
            total += perft(work, side.other, depth - 1)
            Rules.undoMove(work, m, cap)
        }
        return total
    }

    @Test
    fun startPositionPerft() {
        val b = Rules.parse(Rules.START_FEN)
        assertEquals(44L, perft(b, Side.RED, 1), "perft(1) 起始局面")
        assertEquals(1_920L, perft(b, Side.RED, 2), "perft(2) 起始局面")
        assertEquals(79_666L, perft(b, Side.RED, 3), "perft(3) 起始局面")
    }

    /**
     * perft(4) 单独一条，且**不打 @Ignore**：
     * 它要几秒，但那几秒买到的是「前 329 万个节点里没有隐藏的规则错误」。
     * 如果哪天它变成瓶颈，应该把深度降到 3 并**在文档里写明降级**，而不是悄悄删掉。
     */
    @Test
    fun startPositionPerft4() {
        val b = Rules.parse(Rules.START_FEN)
        assertEquals(3_290_240L, perft(b, Side.RED, 4), "perft(4) 起始局面")
    }

    /** 棋子编码表自身的形状：少一个元素就会让整套价值表错位（iOS 上真出过）。 */
    @Test
    fun pieceTablesAreWellFormed() {
        assertEquals(15, Piece.chars.size, "chars 表长度必须等于编码上限 + 1")
        assertEquals(15, Piece.toChar.size, "toChar 表长度必须等于编码上限 + 1")
        assertEquals(7, Rules.worth.size, "worth 表必须正好 7 个元素（将 士 象 马 车 炮 兵）")

        // 编码 ↔ 字符 往返
        for (c in 1..14) {
            val ch = Piece.charOf(c.toByte())
            assertEquals(c, Piece.fromChar[ch]?.toInt(), "编码 $c 的字符 $ch 反查不回来")
        }
        // 类型/阵营与编码一致
        for (t in 0 until Piece.TYPE_COUNT) {
            for (s in listOf(Side.RED, Side.BLACK)) {
                val code = Piece.code(t, s).toInt()
                assertEquals(t, Piece.type(code), "type(code($t, $s))")
                assertEquals(s, Piece.side(code), "side(code($t, $s))")
            }
        }
    }

    /** FEN 往返：`parse` → `fen` 必须还原成同一个串。 */
    @Test
    fun fenRoundTrip() {
        assertEquals(Rules.START_FEN, Rules.fen(Rules.parse(Rules.START_FEN)))
        val puzzles = listOf(
            "....k..../........./........./....C..../.....N.../........./........./........./........./...K.....",
            "........./......R../....k...b/........./C...P..../.......N./.....p.../........./....p..../.....K...",
        )
        for (p in puzzles) assertEquals(p, Rules.fen(Rules.parse(p)), "排局 FEN 往返：$p")
    }

    /** 快版与慢版的将军判定必须永远一致 —— 这是规则层最容易悄悄坏掉的地方。 */
    @Test
    fun inCheckFastMatchesGeneration() {
        val b = Rules.parse(Rules.START_FEN)
        var board = b.copyOf()
        var side = Side.RED
        var compared = 0
        val rnd = java.util.Random(20260924)

        repeat(200) {
            val moves = Rules.legalMoves(board, side)
            if (moves.isEmpty()) return@repeat
            for (s in listOf(Side.RED, Side.BLACK)) {
                assertEquals(
                    Rules.inCheckByGeneration(board, s),
                    Rules.inCheck(board, s),
                    "快版/慢版将军判定不一致，局面 ${Rules.fen(board)}",
                )
                compared++
            }
            val m = moves[rnd.nextInt(moves.size)]
            Rules.makeMove(board, m)
            side = side.other
        }
        assertTrue(compared > 300, "对比次数太少（$compared），这条测试等于没测")
    }
}
