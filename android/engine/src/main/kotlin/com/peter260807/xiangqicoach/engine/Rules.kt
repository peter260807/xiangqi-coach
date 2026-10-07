package com.peter260807.xiangqicoach.engine

/**
 * 中国象棋规则引擎：只负责「什么能走、什么算合法、什么算终局」，不做搜索。
 *
 * 这是 `ios/XiangqiCoach/Engine/Rules.swift` 的 Kotlin 移植。
 * **逐函数对齐**是硬要求 —— 两端共用同一套局面表示（FEN）与同一套终局判据，
 * `web/js/engine.js` 里还有第三份实现；三份行为不一致的话，
 * 「改了搜索有没有变强」这类测量就没有意义了。
 *
 * 验收方式（docs/android-plan.md §5.3 第一关）：
 *   perft(1..4) = 44 / 1920 / 79666 / 3290240，
 *   并与 Swift 引擎（tools/uci/build/xq-uci）在 981 个局面逐一对数。
 */
object Rules {

    // ---------- 索引与坐标 ----------

    const val SQUARES = 90
    const val COLS = 9
    const val ROWS = 10

    /** 棋盘 9 列 × 10 行。索引 = row * 9 + col，与 iOS / JS 一致。 */
    inline fun row(i: Int): Int = i / 9
    inline fun col(i: Int): Int = i % 9
    inline fun index(r: Int, c: Int): Int = r * 9 + c
    inline fun inBoard(r: Int, c: Int): Boolean = r in 0..9 && c in 0..8

    /** 起始局面 FEN（红方先行）。 */
    const val START_FEN =
        "rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR"

    /** 四个正交方向：上 下 左 右。 */
    val dir4: Array<IntArray> = arrayOf(
        intArrayOf(-1, 0), intArrayOf(1, 0), intArrayOf(0, -1), intArrayOf(0, 1),
    )

    /** 四个斜向。 */
    val diag: Array<IntArray> = arrayOf(
        intArrayOf(-1, -1), intArrayOf(-1, 1), intArrayOf(1, -1), intArrayOf(1, 1),
    )

    /** 马：前两项是落点偏移，后两项是马腿偏移。 */
    val horse: Array<IntArray> = arrayOf(
        intArrayOf(-2, -1, -1, 0), intArrayOf(-2, 1, -1, 0),
        intArrayOf(2, -1, 1, 0), intArrayOf(2, 1, 1, 0),
        intArrayOf(-1, -2, 0, -1), intArrayOf(1, -2, 0, -1),
        intArrayOf(-1, 2, 0, 1), intArrayOf(1, 2, 0, 1),
    )

    // ---------- 棋盘读写 ----------

    /**
     * FEN → 棋盘。
     *
     * ⚠️ 缺行/缺列时按 0（空格）补齐，不抛异常：`library.json` 里的排局有
     * 写成 9 行的情况（省略了空行），iOS 侧同样是宽松解析。
     */
    fun parse(fen: String): ByteArray {
        val b = ByteArray(SQUARES)
        val rows = fen.split('/')
        for (r in 0 until minOf(ROWS, rows.size)) {
            val line = rows[r]
            for (c in 0 until minOf(COLS, line.length)) {
                val ch = line[c]
                if (ch == '.') continue
                b[r * 9 + c] = Piece.fromChar[ch] ?: 0
            }
        }
        return b
    }

    /** 棋盘 → FEN。与 `parse` 往返一致。 */
    fun fen(b: ByteArray): String {
        val sb = StringBuilder(90 + 9)
        for (r in 0 until ROWS) {
            if (r > 0) sb.append('/')
            for (c in 0 until COLS) {
                val p = b[r * 9 + c]
                sb.append(if (p.toInt() == 0) '.' else Piece.charOf(p))
            }
        }
        return sb.toString()
    }

    // ---------- 着法生成 ----------

    /**
     * 生成伪合法着法（**不检查**走后是否被将）。
     *
     * 需要「真正能走的着法」请用 [legalMoves]。
     */
    fun genMoves(b: ByteArray, side: Side): MutableList<Move> {
        val out = ArrayList<Move>(48)
        val red = side == Side.RED

        for (i in 0 until SQUARES) {
            val p = b[i].toInt()
            if (p == 0) continue
            if (Piece.isRed(p) != red) continue

            val r = i / 9
            val c = i % 9
            when (Piece.type(p)) {
                Piece.TYPE_KING -> {
                    val rMin = if (red) 7 else 0
                    val rMax = if (red) 9 else 2
                    for (d in dir4) {
                        val nr = r + d[0]
                        val nc = c + d[1]
                        if (nr < rMin || nr > rMax || nc < 3 || nc > 5) continue
                        val q = b[nr * 9 + nc].toInt()
                        if (q != 0 && Piece.isRed(q) == red) continue
                        out.add(Move(i, nr * 9 + nc))
                    }
                }

                Piece.TYPE_ADVISOR -> {
                    val rMin = if (red) 7 else 0
                    val rMax = if (red) 9 else 2
                    for (d in diag) {
                        val nr = r + d[0]
                        val nc = c + d[1]
                        if (nr < rMin || nr > rMax || nc < 3 || nc > 5) continue
                        val q = b[nr * 9 + nc].toInt()
                        if (q != 0 && Piece.isRed(q) == red) continue
                        out.add(Move(i, nr * 9 + nc))
                    }
                }

                Piece.TYPE_ELEPHANT -> {
                    val rMin = if (red) 5 else 0
                    val rMax = if (red) 9 else 4
                    for (d in diag) {
                        val nr = r + 2 * d[0]
                        val nc = c + 2 * d[1]
                        if (nr < rMin || nr > rMax || nc < 0 || nc > 8) continue
                        if (b[(r + d[0]) * 9 + (c + d[1])].toInt() != 0) continue // 塞象眼
                        val q = b[nr * 9 + nc].toInt()
                        if (q != 0 && Piece.isRed(q) == red) continue
                        out.add(Move(i, nr * 9 + nc))
                    }
                }

                Piece.TYPE_HORSE -> {
                    for (h in horse) {
                        val nr = r + h[0]
                        val nc = c + h[1]
                        if (!inBoard(nr, nc)) continue
                        if (b[(r + h[2]) * 9 + (c + h[3])].toInt() != 0) continue // 蹩马腿
                        val q = b[nr * 9 + nc].toInt()
                        if (q != 0 && Piece.isRed(q) == red) continue
                        out.add(Move(i, nr * 9 + nc))
                    }
                }

                Piece.TYPE_ROOK -> {
                    for (d in dir4) {
                        var nr = r + d[0]
                        var nc = c + d[1]
                        while (inBoard(nr, nc)) {
                            val q = b[nr * 9 + nc].toInt()
                            if (q == 0) {
                                out.add(Move(i, nr * 9 + nc))
                            } else {
                                if (Piece.isRed(q) != red) out.add(Move(i, nr * 9 + nc))
                                break
                            }
                            nr += d[0]
                            nc += d[1]
                        }
                    }
                }

                Piece.TYPE_CANNON -> {
                    for (d in dir4) {
                        var nr = r + d[0]
                        var nc = c + d[1]
                        var jumped = false
                        while (inBoard(nr, nc)) {
                            val q = b[nr * 9 + nc].toInt()
                            if (!jumped) {
                                if (q == 0) {
                                    out.add(Move(i, nr * 9 + nc))
                                } else {
                                    jumped = true // 找到炮架
                                }
                            } else if (q != 0) {
                                if (Piece.isRed(q) != red) out.add(Move(i, nr * 9 + nc))
                                break
                            }
                            nr += d[0]
                            nc += d[1]
                        }
                    }
                }

                Piece.TYPE_PAWN -> {
                    val fwd = if (red) -1 else 1
                    val pr = r + fwd
                    if (inBoard(pr, c)) {
                        val q = b[pr * 9 + c].toInt()
                        if (q == 0 || Piece.isRed(q) != red) out.add(Move(i, pr * 9 + c))
                    }
                    val crossed = if (red) r <= 4 else r >= 5
                    if (crossed) {
                        for (dc in intArrayOf(-1, 1)) {
                            val nc = c + dc
                            if (!inBoard(r, nc)) continue
                            val q = b[r * 9 + nc].toInt()
                            if (q == 0 || Piece.isRed(q) != red) out.add(Move(i, r * 9 + nc))
                        }
                    }
                }
            }
        }
        return out
    }

    // ---------- 局面判定 ----------

    /** 将/帅所在格；不在盘上返回 -1。 */
    fun kingIndex(b: ByteArray, side: Side): Int {
        val target = Piece.code(Piece.TYPE_KING, side).toInt()
        for (i in 0 until SQUARES) if (b[i].toInt() == target) return i
        return -1
    }

    /** 将帅照面（白脸将）—— 这种局面下「谁走谁输」，属于非法局面。 */
    fun kingsFacing(b: ByteArray): Boolean {
        val kr = kingIndex(b, Side.RED)
        val kb = kingIndex(b, Side.BLACK)
        if (kr < 0 || kb < 0) return false
        val c = kr % 9
        if (c != kb % 9) return false
        val r1 = minOf(kr / 9, kb / 9)
        val r2 = maxOf(kr / 9, kb / 9)
        if (r2 - r1 < 2) return true
        for (r in (r1 + 1) until r2) {
            if (b[r * 9 + c].toInt() != 0) return false
        }
        return true
    }

    /**
     * 某方是否正被将军。
     *
     * 搜索里这个函数会被调用几十万次，所以从将/帅所在格直接反查攻击者，
     * 而不是生成对方全部着法再比对 —— iOS 侧实测快一个数量级。
     * [inCheckByGeneration] 保留为参考实现，测试里两者必须完全一致。
     */
    fun inCheck(b: ByteArray, side: Side): Boolean {
        val ki = kingIndex(b, side)
        if (ki < 0) return true
        val r = ki / 9
        val c = ki % 9
        val oppRed = side.other == Side.RED

        // 1) 车 / 炮 / 将：沿四条直线
        for (d in dir4) {
            var nr = r + d[0]
            var nc = c + d[1]
            var screens = 0
            while (inBoard(nr, nc)) {
                val q = b[nr * 9 + nc].toInt()
                if (q != 0) {
                    if (Piece.isRed(q) == oppRed) {
                        val t = Piece.type(q)
                        if (screens == 0) {
                            if (t == Piece.TYPE_ROOK) return true
                            if (t == Piece.TYPE_KING && Math.abs(nr - r) + Math.abs(nc - c) == 1) return true
                        } else {
                            if (t == Piece.TYPE_CANNON) return true
                            break
                        }
                    }
                    screens++
                    if (screens > 1) break
                }
                nr += d[0]
                nc += d[1]
            }
        }

        // 2) 马：看八个马位，并检查它蹩不蹩腿
        for (h in horse) {
            val hr = r + h[0]
            val hc = c + h[1]
            if (!inBoard(hr, hc)) continue
            val q = b[hr * 9 + hc].toInt()
            if (q == 0 || Piece.isRed(q) != oppRed) continue
            if (Piece.type(q) != Piece.TYPE_HORSE) continue
            // 马从 (hr,hc) 走到 (r,c) 时的马腿位置
            val legR: Int
            val legC: Int
            if (Math.abs(h[0]) == 2) {
                legR = r + h[0] / 2
                legC = hc
            } else {
                legR = hr
                legC = c + h[1] / 2
            }
            if (inBoard(legR, legC) && b[legR * 9 + legC].toInt() == 0) return true
        }

        // 3) 兵 / 卒：正面一格 + 过河后的左右
        val pawn = Piece.code(Piece.TYPE_PAWN, side.other).toInt()
        val fwd = if (oppRed) -1 else 1 // 对方兵推进的方向
        // 对方兵在 (r - fwd, c) 时正好攻击到 (r, c)
        val ar = r - fwd
        if (inBoard(ar, c) && b[ar * 9 + c].toInt() == pawn) return true
        for (dc in intArrayOf(-1, 1)) {
            val ac = c + dc
            if (!inBoard(r, ac)) continue
            if (b[r * 9 + ac].toInt() != pawn) continue
            // 只有过河后的兵才能横着吃
            val crossed = if (oppRed) r <= 4 else r >= 5
            if (crossed) return true
        }

        return false
    }

    /** 参考实现：生成对方全部着法再比对。仅用于测试交叉验证。 */
    fun inCheckByGeneration(b: ByteArray, side: Side): Boolean {
        val ki = kingIndex(b, side)
        if (ki < 0) return true
        for (m in genMoves(b, side.other)) {
            if (m.to == ki) return true
        }
        return false
    }

    /**
     * 落子。返回被吃的子（0 = 空格），需要交给 [undoMove] 还原。
     *
     * ⚠️ 只动盘面，**不碰任何全局状态**（Zobrist 哈希在引擎那一层自己同步）。
     * 这条约束是 `adjudicate` 能安全试走的前提。
     */
    fun makeMove(b: ByteArray, m: Move): Byte {
        val cap = b[m.to]
        b[m.to] = b[m.from]
        b[m.from] = 0
        return cap
    }

    fun undoMove(b: ByteArray, m: Move, cap: Byte) {
        b[m.from] = b[m.to]
        b[m.to] = cap
    }

    /**
     * 完全合法着法（走后不能自己被将，也不能形成白脸将）。
     *
     * ⚠️ 只过滤「**自己**的帅被将」，不过滤「对方被将军」——
     * 后者是把 perft 算成 79 258 而不是 79 666 的那个坑（见 docs/android-plan.md §5.3）。
     */
    fun legalMoves(b: ByteArray, side: Side): List<Move> {
        val pseudo = genMoves(b, side)
        val out = ArrayList<Move>(pseudo.size)
        val work = b.copyOf()
        for (m in pseudo) {
            val cap = makeMove(work, m)
            if (!inCheck(work, side) && !kingsFacing(work)) out.add(m)
            undoMove(work, m, cap)
        }
        return out
    }

    fun hasLegalMove(b: ByteArray, side: Side): Boolean {
        val pseudo = genMoves(b, side)
        val work = b.copyOf()
        for (m in pseudo) {
            val cap = makeMove(work, m)
            val ok = !inCheck(work, side) && !kingsFacing(work)
            undoMove(work, m, cap)
            if (ok) return true
        }
        return false
    }

    /** 某一手是否合法（不要求它一定出现在 [genMoves] 里）。 */
    fun isLegal(b: ByteArray, side: Side, m: Move): Boolean {
        val work = b.copyOf()
        val cap = makeMove(work, m)
        val ok = !inCheck(work, side) && !kingsFacing(work)
        undoMove(work, m, cap)
        return ok
    }

    // ---------- 子力统计 ----------

    /**
     * 子力价值（按类型索引：将 士 象 马 车 炮 兵）。
     *
     * ⚠️ 这张表**必须正好 7 个元素**。iOS 侧曾经多写一个元素导致整体错位一格 ——
     * 马被算成 2 分、车算成 4 分、炮算成 9 分，进而让「是否进入残局」的判定整个偏掉，
     * 而表面上看不出任何异常。测试里有一条专门钉住它。
     */
    val worth: DoubleArray = doubleArrayOf(0.0, 2.0, 2.0, 4.0, 9.0, 4.5, 1.0)

    /** 场上剩余子力（不含将帅），用于判断是否进入残局。 */
    fun material(b: ByteArray): Double {
        var total = 0.0
        for (i in 0 until SQUARES) {
            val p = b[i].toInt()
            if (p == 0) continue
            val t = Piece.type(p)
            if (t == Piece.TYPE_KING) continue
            total += worth[t]
        }
        return total
    }

    // ---------- 对局层终局判定（判和 / 长将判负） ----------

    /** 60 回合无吃子判和 —— 一回合 = 双方各一手，所以按半回合数是 120。 */
    const val NO_CAPTURE_PLIES = 120

    /** 重复循环里的一手：谁走的、这一手是否将军。 */
    class CycleMove(val side: Side, val check: Boolean)

    /**
     * 一次重复循环里谁在长将。
     *
     * 抽成纯函数是为了能直接测「双方都长将」这种实战里极难摆出来的局面 ——
     * 用合成数据测判定逻辑，比硬凑一个棋例可靠得多。
     *
     * @return 长将的一方；null = 双方都长将 或 双方都不是（按规则判和）
     */
    fun perpetualChecker(cycle: List<CycleMove>): Side? {
        var redChecks = true
        var blackChecks = true
        var redMoves = 0
        var blackMoves = 0
        for (m in cycle) {
            if (m.side == Side.RED) {
                redMoves++
                if (!m.check) redChecks = false
            } else {
                blackMoves++
                if (!m.check) blackChecks = false
            }
        }
        // 循环里没出过手的一方不算长将（别让空集的真值混进来）
        if (redMoves == 0) redChecks = false
        if (blackMoves == 0) blackChecks = false
        // 都长将 / 都不长将 → 不认定某一方长将
        if (redChecks == blackChecks) return null
        return if (redChecks) Side.RED else Side.BLACK
    }

    /**
     * 判定当前局面是否已经终局。
     *
     * 只认规则、不做搜索 —— 与 `Rules.adjudicate`（Swift）、`web/js/engine.js` 的
     * `adjudicate` 是同一套判据，改一边必须改另外两边。
     *
     * @return null 表示还没终局；`Adjudication.winner` 为 null 表示判和
     */
    fun adjudicate(
        startFen: String,
        moves: List<Move>,
        startSide: Side = Side.RED,
    ): Adjudication? {
        if (moves.isEmpty()) return null

        val b = parse(startFen)
        var side = startSide
        // 每手走完后的局面键（含走子方），下标 0 = 起始局面。
        // 用完整盘面而不是哈希：哈希碰撞会把「像重复」当成「真重复」而误判长将。
        fun key(s: Side) = fen(b) + "|" + if (s == Side.RED) "r" else "b"

        val keys = ArrayList<String>(moves.size + 1)
        keys.add(key(side))
        val movers = ArrayList<Side>(moves.size)
        val gaveCheck = ArrayList<Boolean>(moves.size)
        var lastCapturePly = 0

        for ((j, m) in moves.withIndex()) {
            movers.add(side)
            val cap = makeMove(b, m) // 只动盘面，不碰任何全局状态
            side = side.other
            if (cap.toInt() != 0) lastCapturePly = j + 1
            keys.add(key(side))
            gaveCheck.add(inCheck(b, side))
        }
        val n = moves.size

        // 1) 60 回合无吃子 → 和
        if (n - lastCapturePly >= NO_CAPTURE_PLIES) {
            return Adjudication(null, "60 回合无吃子")
        }

        // 2) 三次重复局面：拿「倒数第三次出现 → 现在」这一段当循环体
        val cur = keys[n]
        val occ = keys.indices.filter { keys[it] == cur }
        if (occ.size < 3) return null
        val from = occ[occ.size - 3]

        val cycle = ArrayList<CycleMove>(n - from)
        for (k in from until n) cycle.add(CycleMove(movers[k], gaveCheck[k]))

        // 一方长将、另一方不将 → 长将方判负；双方都长将 → 和（中国象棋规则）
        val checker = perpetualChecker(cycle)
        if (checker != null) {
            return Adjudication(checker.other, "长将（${checker.label}长将判负）")
        }
        return Adjudication(null, "三次重复局面（双方均非长将）")
    }
}
