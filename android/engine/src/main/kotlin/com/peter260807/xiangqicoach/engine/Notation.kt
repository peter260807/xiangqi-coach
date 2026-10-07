package com.peter260807.xiangqicoach.engine

/**
 * 标准中文棋谱记法。
 *
 * 红方用汉字一~九（自右向左数），黑方用数字 1~9（自左向右数）——
 * 和棋谱里的「炮二平五」「将5平6」是同一套编号。
 *
 * 对应 `ios/XiangqiCoach/Engine/Notation.swift`，逐函数对齐。
 */
object Notation {

    private val cnNum = arrayOf("一", "二", "三", "四", "五", "六", "七", "八", "九")

    /** 纵线编号：红方从右往左为一~九，黑方从左往右为 1~9。 */
    private fun fileNumber(col: Int, red: Boolean): Int = if (red) 9 - col else col + 1

    private fun numLabel(n: Int, red: Boolean): String {
        if (!red) return n.toString()
        if (n < 1 || n > 9) return n.toString()
        return cnNum[n - 1]
    }

    /** 同一纵线上有多个同类子时用「前/中/后」区分。 */
    private fun ordinal(idx: Int, count: Int): String {
        if (count == 2) return if (idx == 0) "前" else "后"
        if (count == 3) return arrayOf("前", "中", "后")[idx]
        val table = arrayOf("前", "二", "三", "四", "五")
        return if (idx < table.size) table[idx] else ""
    }

    /** 把一步棋写成中文记谱，如「炮二平五」「马八进七」。 */
    fun label(board: ByteArray, move: Move): String {
        val p = board[move.from].toInt()
        if (p == 0) return "?"
        val red = Piece.isRed(p)
        val name = Piece.name(p)
        val r1 = move.from / 9
        val c1 = move.from % 9
        val r2 = move.to / 9
        val c2 = move.to % 9

        // 同纵线同类子 → 用前/后代替起始纵线
        val sameCol = ArrayList<Int>(3)
        for (i in 0 until Rules.SQUARES) {
            if (board[i].toInt() == p && i % 9 == c1) sameCol.add(i)
        }

        val lead: String
        if (sameCol.size > 1) {
            sameCol.sortWith { a, b ->
                if (red) (a / 9).compareTo(b / 9) else (b / 9).compareTo(a / 9)
            }
            val idx = sameCol.indexOf(move.from).let { if (it < 0) 0 else it }
            lead = ordinal(idx, sameCol.size) + name
        } else {
            lead = name + numLabel(fileNumber(c1, red), red)
        }

        if (r2 == r1) return lead + "平" + numLabel(fileNumber(c2, red), red)

        val forward = if (red) r2 < r1 else r2 > r1
        val t = Piece.type(p)
        // 马、象、士走斜线，进退后面跟目标纵线；其余跟步数
        val diagonal = (t == Piece.TYPE_HORSE || t == Piece.TYPE_ELEPHANT || t == Piece.TYPE_ADVISOR)
        val step = if (diagonal) numLabel(fileNumber(c2, red), red)
        else numLabel(Math.abs(r2 - r1), red)
        return lead + (if (forward) "进" else "退") + step
    }

    /** 一串着法转成棋谱文本。 */
    fun movesToText(startFen: String, moves: List<Move>): String {
        val b = Rules.parse(startFen)
        val parts = ArrayList<String>(moves.size)
        var turn = Side.RED
        for ((i, m) in moves.withIndex()) {
            val lab = label(b, m)
            if (turn == Side.RED) parts.add("${i / 2 + 1}. $lab") else parts.add(lab)
            Rules.makeMove(b, m)
            turn = turn.other
        }
        return parts.joinToString("  ")
    }

    /**
     * 按棋谱文本反查着法，用于校验大模型给的着法是否合法。
     *
     * 容忍空格与首尾空白；找不到就返回 null（**外层必须当非法着法处理**，
     * 混合对弈靠它回退到引擎首选）。
     */
    fun findMove(board: ByteArray, side: Side, text: String): Move? {
        val clean = text.trim().replace(" ", "").replace("\n", "").replace("\t", "")
        if (clean.isEmpty()) return null
        for (m in Rules.legalMoves(board, side)) {
            if (label(board, m) == clean) return m
        }
        return null
    }
}
