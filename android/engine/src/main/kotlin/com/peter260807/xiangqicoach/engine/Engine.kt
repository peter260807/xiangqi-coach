package com.peter260807.xiangqicoach.engine

import kotlin.concurrent.withLock
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.pow

/** 搜索等级：深度越大、容错越小，越接近「不留情」。 */
class SearchLevel(
    val key: String,
    val label: String,
    val depth: Int,
    val timeMs: Int,
    /** 入门档会挑分数接近的着法，故意留破绽。 */
    val slack: Int,
) {
    companion object {
        /**
         * 档位只有四档。
         *
         * 曾经有第五档 `master`（大师，d12/6000ms）。2026-09-24 实测它与 `expert`
         * 的区别是 **−112 Elo、95% 区间 [−262, +37] 跨 0**，开局段两者都卡在第 8 层
         * —— 多给的 2.5 秒换不成棋力（docs/strength-levels.md §一、§二）。故删除。
         *
         * ⚠️ 本表改动必须同步 Swift 的 `SearchLevel.all`、`web/js/engine.js` 的 `LEVELS`
         * 与 `tools/level-match/gen-level-engines.js`（后者会反过来对账，防止走神）。
         */
        val all: List<SearchLevel> = listOf(
            SearchLevel("easy", "入门", 1, 600, 320),
            SearchLevel("normal", "初级", 3, 1200, 110),
            SearchLevel("hard", "中级", 5, 2200, 35),
            SearchLevel("expert", "高级", 8, 3500, 0),
        )

        /**
         * 已废弃的档位名 → 现在归到哪一档。
         *
         * 老存档的 `GameRecord.level` 里可能还写着 `"master"`。不做这层映射的话，
         * 它会掉进兜底（`hard`）→ 用户回看一盘「大师」难度的棋，难度显示成「中级」，
         * 静默降了两档。映射到 `expert` 才与实测结论一致。
         */
        val legacyAliases: Map<String, String> = mapOf("master" to "expert")

        fun named(key: String?): SearchLevel {
            val k = key ?: "hard"
            val resolved = legacyAliases[k] ?: k
            return all.firstOrNull { it.key == resolved }
                ?: all.firstOrNull { it.key == "hard" }
                ?: all[0]
        }
    }
}

/** 一次搜索的结果。 */
class SearchResult(
    val move: Move?,
    val score: Int = 0,
    val depth: Int = 0,
    val nodes: Int = 0,
    /**
     * 这次搜索里 SEE 被算过多少次。**自证用**：排序里那条路如果一次都没走到，
     * 说明它其实是死代码，而「没报错」看不出来这件事。
     */
    val seeCalls: Int = 0,
)

/** 多路分析的一个候选着法。 */
class CandidateMove(
    val move: Move,
    val score: Int,
    val depth: Int,
    val label: String,
)

// ---------- 排序分档（文件级常量，排序与搜索两处共用） ----------

private const val SCORE_TT = 100_000_000
private const val SCORE_GOOD_CAP = 20_000_000
private const val SCORE_KILLER_1 = 15_000_000
private const val SCORE_KILLER_2 = 14_000_000
private const val SCORE_QUIET = 10_000_000
private const val SCORE_BAD_CAP = 1_000_000

/**
 * 位置表增量的权重。实测 4 / 8 / 16 三档几乎并列（73.5% / 74.5% / 74.6% 的节点数），
 * 取中间的 8 —— 这个常数不值得再调（差别落在局面间的正常波动里）。
 */
private const val PST_WEIGHT = 8

/**
 * 历史分数的上限。历史表靠「同一着法反复造成截断」累积、随深度平方增长；
 * 完全不封顶会让它盖掉位置表增量（实测不封顶时节点数是 78.2% 对 74.4%）。
 * 注：在实测的深度范围内这个上限其实**基本不触发**，它是一条保险丝。
 */
private const val HIST_CAP = 4096

/**
 * SEE 只在 **ply ≤ 这个值** 的时候算（浅层）。
 *
 * 为什么不是整棵树都算 —— 实测（`tools/order-fuzz.js --mode time`，150 个随机局面）：
 * 整棵树都算 SEE 时，**开局**节点省 16%，但**中局**因为吃子多、SEE 的射线扫描贵，
 * 每千节点/秒从 2684 掉到 2177（慢 19%），而中局的节点只省下 5% ——
 * 一进一出，固定时间下反而比不改**更浅**（改动前多搜到一层的局面 14:3）。
 *
 * 放开到 internal（而不是 private）是为了让测试**贴着边界两侧**各断言一次：
 * ply = 本值要算 SEE、ply = 本值+1 不能算。测试里硬编码 4 的话，
 * 以后调这个值，那条断言就会变成在测别的东西、而且照样全绿。
 */
const val SEE_MAX_PLY = 4

/**
 * 搜索引擎：Alpha-Beta + 置换表 + 静态搜索 + 杀手着法 + LMR + 空着裁剪。
 *
 * 这是 `ios/XiangqiCoach/Engine/Search.swift` 的 Kotlin 移植，**行为对齐是硬要求**：
 * 验收靠 `tools/match.js` 把两个引擎摆在同一张对局台上量 Elo（docs/android-plan.md §5.3）。
 *
 * ## 与 Swift 版**有意**不同的三处
 *
 * 1. **没有串行队列。** Swift 侧所有入口都 `queue.sync`/`queue.async` 到一条私有队列上，
 *    一是防 UI 卡、二是防多个搜索同时改内部状态。Android 侧由调用方决定线程
 *    （界面走 `Dispatchers.Default`，见 §6.1），引擎自己只提供**同步**入口，
 *    并用一把锁挡住并发进入 —— 少一层队列语义，测试里也不用再等异步回调。
 * 2. **归因开关是实例属性而不是环境变量。** `XQ_NO_LMR` / `XQ_NO_NULL` 在 Android 上
 *    根本读不到；测试台要能「同一个二进制、只差一个开关」地跑 A/B，
 *    所以 `lmrEnabled` / `nullMoveEnabled` / `perpetualEnabled` 必须是可写属性。
 * 3. **置换表容量可配**（`ttBits`），理由是安卓低端机的内存。
 *    默认 18 位 = 262 144 槽 ≈ 8 MB，与 Swift 的 `option Hash default 8` 对齐。
 *
 * ## 工作集与分配
 *
 * 棋盘、着法列表这些**每个节点都会产生**的东西一律复用实例上的可变数组
 * （`work` / `pseudoBuf` / `moveBuf`），搜索过程中不再新建 ——
 * JVM 上分配本身不算贵，但把 90 字节的数组在几十万节点上反复分配，
 * 光 GC 压力就足以把「原生比 JS 快多少」这个结论吃掉。
 *
 * ⚠️ 因此这个类**不是线程安全的**（一把可重入锁只保证「串行进入」，
 * 不保证两次搜索能交错）。每个线程要用各自的实例。
 */
class Engine(
    ttBits: Int = 18,
    /** LMR（后期着法缩减）。默认开。关掉它只为了归因 A/B 与测试。 */
    var lmrEnabled: Boolean = true,
    /** 空着裁剪。默认开，理由同上。 */
    var nullMoveEnabled: Boolean = true,
    /** 搜索层的长将意识。默认开。 */
    var perpetualEnabled: Boolean = true,
) {

    companion object {
        /** 进程内共享实例：界面与 UCI 前端都用它，与 Swift 的 `Engine.shared` 对应。 */
        val shared: Engine by lazy { Engine() }

        const val MATE: Int = 200_000
        const val INFINITE: Int = 100_000_000

        /** 空着之后缩减几层。用固定值而不是自适应，是为了**便于归因**。 */
        const val NULL_MOVE_MIN_DEPTH = 3
        const val NULL_MOVE_R = 2

        /** 排在前面的这几个着法不缩减：它们已经是有希望的那些。 */
        const val LMR_MIN_DEPTH = 3
        const val LMR_FULL_MOVES = 3

        /**
         * 缩减量表：行 = 深度，列 = 着法序号（从 1 起）。
         *
         * `r = 0.75 + ln(d)·ln(m) / 2.25`（与主流引擎同一量级），取整后夹在 0…4。
         * 预计算成表是为了不在热点循环里调 `ln`。
         */
        val lmrTable: Array<IntArray> = Array(64) { d ->
            IntArray(64) { m ->
                if (d == 0 || m == 0) 0
                else {
                    val v = 0.75 + ln(d.toDouble()) * ln(m.toDouble()) / 2.25
                    v.toInt().coerceIn(0, 4)
                }
            }
        }

        /** 评分 → 红方胜率。 */
        fun winRate(redScore: Int): Double {
            if (redScore > MATE - 1000) return 1.0
            if (redScore < -MATE + 1000) return 0.0
            val k = 1.0 / (1.0 + 10.0.pow(-redScore / 400.0))
            return k.coerceIn(0.02, 0.98)
        }

        /** 评分 → 中文描述。 */
        fun scoreText(v: Int): String = when {
            v > MATE - 1000 -> "红方已成杀"
            v < -MATE + 1000 -> "黑方已成杀"
            v > 150 -> "红方明显占优"
            v > 50 -> "红方稍优"
            v < -150 -> "黑方明显占优"
            v < -50 -> "黑方稍优"
            else -> "均势"
        }
    }

    // ---------- 局面评估 ----------

    private val pieceValue = intArrayOf(60000, 200, 200, 400, 900, 450, 100)

    private val pstPawn = arrayOf(
        intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0),
        intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0),
        intArrayOf(35, 45, 55, 70, 80, 70, 55, 45, 35),
        intArrayOf(25, 35, 45, 60, 70, 60, 45, 35, 25),
        intArrayOf(15, 20, 28, 40, 48, 40, 28, 20, 15),
        intArrayOf(6, 8, 10, 14, 18, 14, 10, 8, 6),
        intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0),
        intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0),
        intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0),
        intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0),
    )

    private val pstHorse = arrayOf(
        intArrayOf(0, -4, 0, 0, 0, 0, 0, -4, 0),
        intArrayOf(0, 2, 4, 6, 6, 6, 4, 2, 0),
        intArrayOf(2, 6, 10, 12, 14, 12, 10, 6, 2),
        intArrayOf(4, 8, 14, 18, 20, 18, 14, 8, 4),
        intArrayOf(4, 10, 16, 22, 24, 22, 16, 10, 4),
        intArrayOf(2, 8, 14, 20, 22, 20, 14, 8, 2),
        intArrayOf(0, 6, 12, 16, 18, 16, 12, 6, 0),
        intArrayOf(0, 4, 8, 10, 10, 10, 8, 4, 0),
        intArrayOf(0, 0, 2, 4, 4, 4, 2, 0, 0),
        intArrayOf(-6, -4, 0, 2, 2, 2, 0, -4, -6),
    )

    private val pstCannon = arrayOf(
        intArrayOf(6, 4, 0, -6, -8, -6, 0, 4, 6),
        intArrayOf(6, 6, 2, 2, 2, 2, 2, 6, 6),
        intArrayOf(4, 6, 8, 10, 12, 10, 8, 6, 4),
        intArrayOf(2, 4, 6, 8, 10, 8, 6, 4, 2),
        intArrayOf(2, 4, 6, 8, 8, 8, 6, 4, 2),
        intArrayOf(2, 4, 6, 8, 8, 8, 6, 4, 2),
        intArrayOf(2, 4, 6, 8, 10, 8, 6, 4, 2),
        intArrayOf(0, 2, 4, 6, 8, 6, 4, 2, 0),
        intArrayOf(0, 0, 2, 4, 4, 4, 2, 0, 0),
        intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0),
    )

    private val pstRook = arrayOf(
        intArrayOf(8, 10, 10, 12, 12, 12, 10, 10, 8),
        intArrayOf(10, 12, 12, 14, 14, 14, 12, 12, 10),
        intArrayOf(6, 8, 10, 12, 14, 12, 10, 8, 6),
        intArrayOf(6, 8, 10, 12, 14, 12, 10, 8, 6),
        intArrayOf(4, 6, 10, 12, 14, 12, 10, 6, 4),
        intArrayOf(4, 6, 10, 12, 14, 12, 10, 6, 4),
        intArrayOf(2, 6, 8, 10, 12, 10, 8, 6, 2),
        intArrayOf(2, 4, 6, 8, 10, 8, 6, 4, 2),
        intArrayOf(0, 2, 4, 6, 8, 6, 4, 2, 0),
        intArrayOf(0, 0, 2, 4, 4, 4, 2, 0, 0),
    )

    /** 红方视角的静态评估。 */
    fun evaluate(b: ByteArray): Int {
        var s = 0
        for (i in 0 until Rules.SQUARES) {
            val p = b[i].toInt()
            if (p == 0) continue
            val red = Piece.isRed(p)
            val t = Piece.type(p)
            var v = pieceValue[t]
            val r = i / 9
            val c = i % 9
            val row = if (red) r else 9 - r
            when (t) {
                Piece.TYPE_PAWN -> v += pstPawn[row][c]
                Piece.TYPE_HORSE -> v += pstHorse[row][c]
                Piece.TYPE_CANNON -> v += pstCannon[row][c]
                Piece.TYPE_ROOK -> v += pstRook[row][c]
            }
            s += if (red) v else -v
        }
        return s
    }

    // ---------- 位置表：取值与增量 ----------

    /**
     * 位置价值表的取值（红方视角、黑方按行镜像）—— 与 [evaluate] 里的取法必须一致。
     *
     * 公开出来是为了让测试能直接断言 —— SEE 是「就地改棋盘再还原」的写法，
     * 出问题不抛异常、只是悄悄算错，没有独立断言看着不行。
     */
    fun pstValue(type: Int, red: Boolean, r: Int, c: Int): Int {
        val row = if (red) r else 9 - r
        return when (type) {
            Piece.TYPE_PAWN -> pstPawn[row][c]
            Piece.TYPE_HORSE -> pstHorse[row][c]
            Piece.TYPE_CANNON -> pstCannon[row][c]
            Piece.TYPE_ROOK -> pstRook[row][c]
            else -> 0
        }
    }

    /**
     * 位置价值表的**增量**：走完之后这颗子在位置表上值多少、减掉原来值多少。
     *
     * 别小看它 —— 位置表本身已经把「过河兵推进」「马往前跳」「车占好线」都编码进去了，
     * 所以这一个差值就同时覆盖了这几条，成本只有两次查表。
     */
    fun pstDelta(b: ByteArray, from: Int, to: Int): Int {
        val p = b[from].toInt()
        if (p == 0) return 0
        val red = Piece.isRed(p)
        val t = Piece.type(p)
        val before = pstValue(t, red, from / 9, from % 9)
        val after = pstValue(t, red, to / 9, to % 9)
        return (after - before) * PST_WEIGHT
    }

    // ---------- SEE ----------

    /**
     * `side` 方攻击 `sq` 上那颗子的**最便宜**的子。
     *
     * 必须是「找最小」而不是「列全部」—— SEE 交换序列的每一步都要调一次，
     * 列全部再排序会把成本放大好几倍。按价值从低到高依次试：
     * 兵 100 → 士/象 200 → 马 400 → 炮 450 → 车 900。
     *
     * ⚠️ **故意不算将/帅。** 它的「吃回」在象棋里经常是非法的（那个格子被自己人挡着时
     * 将在原地就违规，或者格子另外被别的子守住），SEE 不知道这些，会把正常吃子算成
     * -60000 级的巨亏再打到安静着法后面去。实测不排除将/帅时 SEE 反而让搜索变慢。
     */
    fun leastAttacker(b: ByteArray, sq: Int, side: Side): IntArray? {
        val r = sq / 9
        val c = sq % 9
        val red = side == Side.RED

        // 兵 / 卒（100）
        val pawn = Piece.code(Piece.TYPE_PAWN, side).toInt()
        val fwd = if (red) r + 1 else r - 1
        if (Rules.inBoard(fwd, c) && b[fwd * 9 + c].toInt() == pawn) {
            return intArrayOf(fwd * 9 + c, 100)
        }
        // 横着吃的兵必须已过河：红兵过河 = 行 ≤ 4，黑卒过河 = 行 ≥ 5
        if (if (red) r <= 4 else r >= 5) {
            if (c > 0 && b[r * 9 + c - 1].toInt() == pawn) return intArrayOf(r * 9 + c - 1, 100)
            if (c < 8 && b[r * 9 + c + 1].toInt() == pawn) return intArrayOf(r * 9 + c + 1, 100)
        }

        // 士（200）：斜一步，且必须在本方九宫内
        val advisor = Piece.code(Piece.TYPE_ADVISOR, side).toInt()
        for (d in Rules.diag) {
            val ar = r + d[0]
            val ac = c + d[1]
            if (ac < 3 || ac > 5) continue
            if (if (red) (ar < 7 || ar > 9) else (ar < 0 || ar > 2)) continue
            if (b[ar * 9 + ac].toInt() == advisor) return intArrayOf(ar * 9 + ac, 200)
        }

        // 象（200）：斜两步，象眼要空，且不过河（红象只在行 5~9，黑象只在行 0~4）
        val elephant = Piece.code(Piece.TYPE_ELEPHANT, side).toInt()
        for (d in Rules.diag) {
            val br = r + 2 * d[0]
            val bc = c + 2 * d[1]
            if (!Rules.inBoard(br, bc)) continue
            if (if (red) br < 5 else br > 4) continue
            if (b[br * 9 + bc].toInt() != elephant) continue
            if (b[(r + d[0]) * 9 + (c + d[1])].toInt() != Piece.EMPTY) continue
            return intArrayOf(br * 9 + bc, 200)
        }

        // 马（400）：Rules.horse 是「从马出发」的偏移，攻击 sq 的马在 (r-dr, c-dc)，腿相对马算
        val horse = Piece.code(Piece.TYPE_HORSE, side).toInt()
        for (h in Rules.horse) {
            val hr = r - h[0]
            val hc = c - h[1]
            if (!Rules.inBoard(hr, hc)) continue
            if (b[hr * 9 + hc].toInt() != horse) continue
            val lr = hr + h[2]
            val lc = hc + h[3]
            if (!Rules.inBoard(lr, lc)) continue
            if (b[lr * 9 + lc].toInt() != Piece.EMPTY) continue
            return intArrayOf(hr * 9 + hc, 400)
        }

        // 炮（450）：必须正好隔一个炮架（第一个碰到的子当架，再碰到的才是炮）
        val cannon = Piece.code(Piece.TYPE_CANNON, side).toInt()
        for (d in Rules.dir4) {
            var tr = r + d[0]
            var tc = c + d[1]
            var screen = false
            while (Rules.inBoard(tr, tc)) {
                val t = b[tr * 9 + tc].toInt()
                if (!screen) {
                    if (t != Piece.EMPTY) screen = true
                } else if (t != Piece.EMPTY) {
                    if (t == cannon) return intArrayOf(tr * 9 + tc, 450)
                    break
                }
                tr += d[0]
                tc += d[1]
            }
        }

        // 车（900）：四个方向碰到的第一个子
        val rook = Piece.code(Piece.TYPE_ROOK, side).toInt()
        for (d in Rules.dir4) {
            var ur = r + d[0]
            var uc = c + d[1]
            while (Rules.inBoard(ur, uc)) {
                val u = b[ur * 9 + uc].toInt()
                if (u != Piece.EMPTY) {
                    if (u == rook) return intArrayOf(ur * 9 + uc, 900)
                    break
                }
                ur += d[0]
                uc += d[1]
            }
        }

        return null
    }

    /**
     * 走 `from → to` 这一手吃子的 SEE 净收益。正数 = 赚，0 = 平换，负数 = 亏本吃。
     *
     * 算法（自己推的，查到的几个版本索引记不牢、容易写错）：
     *   设 u = [u1, u2, …] 为每一步「进攻方用的那颗子」的价值（u1 = 走子方的子）。
     *   第 k 步**吃到**的东西价值 G[k]：G[1] = 被吃子的价值，G[k] = u[k-1]。
     *   记 f(k) = 第 k 步进攻方的净收益，则 f(n) = G[n]、f(k) = G[k] - max(0, f(k+1))，
     *   答案就是 f(1)。
     *
     * 例（JS 侧有对应的单元测试，两边必须同答案）：
     *   车(900)吃兵(100)、被兵吃回来 → u=[900,100]，G=[100,900] → f(1)=100-900 = **-800**
     *   兵(100)吃车(900)、没人吃回来 → u=[100]，G=[900] → f(1) = 900
     *   车(900)吃车(900)、被兵吃回来 → u=[900,100]，G=[900,900] → f(1)=900-900 = **0**
     *
     * ⚠️ 与 Swift 版的差别：Swift 靠数组的写时复制（进函数时不复制、真改才复制）
     * 拿到一份可以随便改的副本；Kotlin 的 `ByteArray` 是引用语义，**必须显式 `copyOf()`**，
     * 否则会把调用方的棋盘改坏 —— 而且不会报错，只会算出一盘不存在的棋。
     */
    fun seeCapture(boardIn: ByteArray, from: Int, to: Int, side: Side): Int {
        val victim = boardIn[to].toInt()
        if (victim == Piece.EMPTY) return 0

        val b = boardIn.copyOf()
        val u = ArrayList<Int>(8)
        u.add(pieceValue[Piece.type(b[from].toInt())])
        b[to] = b[from]
        b[from] = 0

        var cur = side.other
        var guardCount = 0
        while (guardCount < 24) {
            guardCount++
            val att = leastAttacker(b, to, cur) ?: break
            u.add(att[1])
            b[to] = b[att[0]]
            b[att[0]] = 0
            cur = cur.other
        }

        // G = [被吃子的价值, u1, …, u(n-1)]，从尾部往前取 max(0, ·)
        var value = 0
        if (u.size >= 2) {
            for (k in u.size - 2 downTo 0) {
                value = u[k] - maxOf(0, value)
            }
        }
        return pieceValue[Piece.type(victim)] - maxOf(0, value)
    }

    // ---------- 着法排序 ----------

    /**
     * 着法排序：
     * ```
     *   TT 着法                                 100,000,000
     *   好/等吃子（SEE ≥ 0）                     20,000,000 + MVV-LVA
     *   杀手着法 1 / 2                          15,000,000 / 14,000,000
     *   安静着法                                10,000,000 + 位置表增量 + 历史
     *   亏本吃（SEE < 0）                        1,000,000 + SEE
     * ```
     * 两条纪律：
     *   1. **亏本吃必须降到安静着法之后。** 它的价值是负的，排在前面只会让每个节点都白
     *      展开一整棵子树去证明「果然亏了」。
     *   2. **SEE 只在「可能亏」的时候算。** 被吃子比吃子方的子更值钱时（吃大子 / 平换），
     *      即使被吃回来也不亏，MVV-LVA 就够了 —— 这一条把 SEE 的调用次数砍掉大半。
     *
     * ⚠️ **排序必须稳定**（同分按原下标）。Swift 的 `sort` 不保证稳定、JS 的稳定，
     * 不显式钉住的话，同一个局面在两端的着法顺序会不一样，
     * 「两端是同一套算法」这条就名存实亡了。
     */
    fun orderMoves(b: ByteArray, moves: List<Move>, ply: Int, ttMove: Move?): List<Move> {
        val k0 = killers[if (ply < 63) ply else 63][0]
        val k1 = killers[if (ply < 63) ply else 63][1]
        val n = moves.size
        val scores = IntArray(n)
        val idx = IntArray(n) { it }

        for (i in 0 until n) {
            val m = moves[i]
            var s = 0
            val cap = b[m.to].toInt()
            if (ttMove != null && ttMove == m) {
                s = SCORE_TT
            } else if (cap != Piece.EMPTY) {
                val capVal = pieceValue[Piece.type(cap)]
                val attVal = pieceValue[Piece.type(b[m.from].toInt())]
                val mvv = capVal * 16 - attVal
                if (capVal >= attVal || ply > SEE_MAX_PLY) {
                    // 吃大子 / 平换：再差也不会亏，不必花 SEE。
                    // 深于 SEE_MAX_PLY 的节点也走这一支：那里节点数占绝大多数，
                    // 而 SEE 的射线扫描在最贵的节点上最不划算。
                    s = SCORE_GOOD_CAP + mvv
                } else {
                    seeCallCount++
                    val see = seeCapture(b, m.from, m.to, Piece.side(b[m.from].toInt()))
                    s = if (see >= 0) SCORE_GOOD_CAP + mvv else SCORE_BAD_CAP + see
                }
            } else if (k0 != null && k0 == m) {
                s = SCORE_KILLER_1
            } else if (k1 != null && k1 == m) {
                s = SCORE_KILLER_2
            } else {
                val hv = history[m.from * 90 + m.to]
                s = SCORE_QUIET + pstDelta(b, m.from, m.to) + (if (hv > HIST_CAP) HIST_CAP else hv)
            }
            scores[i] = s
        }

        // 稳定排序：先按下标、再按分数（分数相同的保持原顺序）
        val order = Array(n) { it }
        order.sortWith(compareByDescending<Int> { scores[it] }.thenBy { it })
        return order.map { moves[it] }
    }

    // ---------- Zobrist ----------

    private val zobrist = Array(15) { LongArray(Rules.SQUARES) }
    private var zSide: Long = 0
    private var hash: Long = 0

    init {
        var seed = 0x9E3779B97F4A7C15UL.toLong()
        fun next(): Long {
            seed = seed xor (seed shl 13)
            seed = seed xor (seed ushr 7)
            seed = seed xor (seed shl 17)
            return seed
        }
        for (p in 0 until 15) for (i in 0 until Rules.SQUARES) zobrist[p][i] = next()
        zSide = next()
    }

    private fun computeHash(b: ByteArray, side: Side): Long {
        var h = 0L
        for (i in 0 until Rules.SQUARES) {
            val p = b[i].toInt()
            if (p != 0) h = h xor zobrist[p][i]
        }
        if (side == Side.BLACK) h = h xor zSide
        return h
    }

    /** 外部（界面）在别处改过棋盘后，用它对齐哈希。 */
    fun syncHash(b: ByteArray, side: Side) = lock.withLock { hash = computeHash(b, side) }

    private fun doMove(b: ByteArray, m: Move): Byte {
        val p = b[m.from]
        val cap = b[m.to]
        val pi = p.toInt()
        if (cap.toInt() != 0) hash = hash xor zobrist[cap.toInt()][m.to]
        hash = hash xor zobrist[pi][m.from] xor zobrist[pi][m.to]
        hash = hash xor zSide
        b[m.to] = p
        b[m.from] = 0
        return cap
    }

    private fun undo(b: ByteArray, m: Move, cap: Byte) {
        val p = b[m.to]
        val pi = p.toInt()
        b[m.from] = p
        b[m.to] = cap
        hash = hash xor zSide
        hash = hash xor zobrist[pi][m.from] xor zobrist[pi][m.to]
        if (cap.toInt() != 0) hash = hash xor zobrist[cap.toInt()][m.to]
    }

    // ---------- 置换表 ----------

    private class TTEntry {
        var key: Long = 0
        var score: Int = 0
        var depth: Int = -1
        var flag: Int = 0
        var from: Int = -1
        var to: Int = -1
        fun clear() {
            key = 0; score = 0; depth = -1; flag = 0; from = -1; to = -1
        }
    }

    private val tt: Array<TTEntry>
    private val ttMask: Int

    init {
        require(ttBits in 10..24) { "ttBits 应在 10..24（4 KB ~ 256 MB），收到 $ttBits" }
        tt = Array(1 shl ttBits) { TTEntry() }
        ttMask = (1 shl ttBits) - 1
    }

    private val flagExact = 0
    private val flagLower = 1
    private val flagUpper = 2

    // ---------- 启发信息 ----------

    private val killers = Array(64) { arrayOfNulls<Move>(2) }
    private val history = IntArray(90 * 90)

    /**
     * 上一次搜索是不是「空着」。**连续两次空着没有意义**（等于双方各放弃一手、
     * 局面回到原样），而且会一直递归下去 —— 所以空着之后必须禁用一次。
     */
    private var nullMoveOk = true

    /** 这次搜索算了多少次 SEE（自证用）。 */
    var seeCallCount: Int = 0
        private set

    // ---------- 工作集（全部复用，避免在每个节点上分配） ----------

    private val work = ByteArray(Rules.SQUARES)
    private val genBuf = ArrayList<Move>(64)
    private val moveBuf = ArrayList<Move>(64)

    // ---------- 时间与节点 ----------

    private var nodes = 0
    private var deadline: Long = 0
    private var aborted = false

    private val lock = java.util.concurrent.locks.ReentrantLock()

    private fun nowMs(): Long = System.nanoTime() / 1_000_000

    private fun checkTime() {
        if ((nodes and 511) == 0 && nowMs() > deadline) aborted = true
    }

    // ---------- 静态搜索 ----------

    private fun quiesce(b: ByteArray, side: Side, alphaIn: Int, beta: Int, ply: Int, qd: Int): Int {
        checkTime()
        if (aborted) return 0
        nodes++

        val sign = if (side == Side.RED) 1 else -1
        val stand = sign * evaluate(b)
        var alpha = alphaIn
        if (stand >= beta) return beta
        if (stand > alpha) alpha = stand
        if (qd <= 0) return alpha

        val all = Rules.genMoves(b, side)
        val caps = ArrayList<Move>(all.size / 2 + 4)
        for (m in all) if (b[m.to].toInt() != 0) caps.add(m)
        val ordered = orderMoves(b, caps, if (ply < 63) ply else 63, null)

        var best = stand
        for (m in ordered) {
            val cap = doMove(b, m)
            if (Rules.inCheck(b, side) || Rules.kingsFacing(b)) {
                undo(b, m, cap)
                continue
            }
            val sc = -quiesce(b, side.other, -beta, -alpha, ply + 1, qd - 1)
            undo(b, m, cap)
            if (aborted) return 0
            if (sc > best) best = sc
            if (best > alpha) alpha = best
            if (alpha >= beta) break
        }
        return best
    }

    // ---------- 重复局面（搜索里的「和棋意识」） ----------

    /**
     * 走到搜索根**之前**的棋局历史。
     *
     * 有了它，引擎才知道哪些局面「已经出现过」—— 走回去按和棋算（0 分）。
     * 没有它的时候：引擎不知道自己在绕圈，一盘赢棋会被自己走成三次重复，
     * 只能靠对局层兜住判和，等于白送一局。
     */
    class SearchHistory(
        /** 棋局起始局面（与 `Rules.START_FEN` 同格式的棋盘串）。 */
        val startFen: String,
        /** 从起始局面到搜索根的着法。 */
        val moves: List<Move>,
        val startSide: Side,
    ) {
        companion object {
            /** 从标准开局开始的整局棋（界面里的对局走这条）。 */
            fun fromStart(moves: List<Move>) = SearchHistory(Rules.START_FEN, moves, Side.RED)
        }
    }

    private class RepNode(
        val h: Long,
        var fresh: Boolean,
        val mover: Side,
        val check: Boolean,
    )

    /**
     * 当前「不可逆段」上的局面。
     *
     * 除了哈希，还带着「走到这个局面的那一手」的信息：`mover` 是走子方、
     * `check` 是这一手有没有将军。带这两个字段是为了在重复发生时能构造出
     * 循环体交给 `Rules.perpetualChecker`，把**长将判负**也搬进搜索 ——
     * 否则搜索只知道「重复 = 和棋」，会主动走进长将循环捞半分，到对局层却被判负。
     */
    private var repStack = ArrayList<RepNode>(128)
    private var repCount = HashMap<Long, Int>()
    private var repSaved = ArrayList<HashMap<Long, Int>>()

    /** 这一手之后，之前的局面还有可能重现吗？吃子 / 走兵 → 不可能（兵只进不退）。 */
    private fun isIrreversible(piece: Byte, cap: Byte): Boolean =
        cap.toInt() != 0 || Piece.type(piece.toInt()) == Piece.TYPE_PAWN

    /**
     * 这个局面「子力够不够做空着裁剪」。
     *
     * **残局必须禁用**：象棋残局里「放弃一手」常常反而变好（zugzwang，
     * 车兵 / 马兵残局尤其明显），拿它去剪枝会把赢棋判成输棋。
     *
     * 判据刻意收得保守：只有本方**还有车 / 炮 / 马**才算子力足够。士象不参与进攻。
     */
    private fun hasNonPawnMaterial(b: ByteArray, side: Side): Boolean {
        val wantRed = side == Side.RED
        for (i in 0 until Rules.SQUARES) {
            val p = b[i].toInt()
            if (p == 0) continue
            if (Piece.isRed(p) != wantRed) continue
            val t = Piece.type(p)
            if (t == Piece.TYPE_ROOK || t == Piece.TYPE_CANNON || t == Piece.TYPE_HORSE) return true
        }
        return false
    }

    /** 把「根节点 + 它之前的棋局历史」装进路径栈。 */
    private fun repInit(history: SearchHistory?) {
        repStack = ArrayList(128)
        repCount = HashMap()
        repSaved = ArrayList()

        if (history == null || history.moves.isEmpty()) {
            repStack.add(RepNode(hash, false, Side.RED, false))
            repCount[hash] = 1
            return
        }

        val b = Rules.parse(history.startFen)
        var side = history.startSide
        val keys = ArrayList<Long>(history.moves.size + 1)
        val segs = ArrayList<Int>(history.moves.size + 1)
        val infos = ArrayList<RepNode>(history.moves.size + 1)
        keys.add(computeHash(b, side))
        segs.add(0)
        // 与 keys 同下标：走到 keys[i] 的那一手的（走子方, 是否将军）。
        // 下标 0 是起始局面，没有「走到它的那一手」，填占位值（不会被读）。
        infos.add(RepNode(0, false, Side.RED, false))
        var segStart = 0
        for (m in history.moves) {
            val irrev = isIrreversible(b[m.from], b[m.to])
            val mover = side
            Rules.makeMove(b, m)
            side = side.other
            if (irrev) segStart = keys.size
            keys.add(computeHash(b, side))
            // 走完这一手后 side 已经是对方，「对方被将」就等于「这一手是将军」
            infos.add(RepNode(0, false, mover, Rules.inCheck(b, side)))
            segs.add(segStart)
        }
        // 以真实棋盘为准：万一调用方给的历史和棋盘不是同一路棋，也不至于引入假重复
        keys[keys.size - 1] = hash
        // 只装「最后一个不可逆段」—— 更早的局面不可能重现了
        val from = segs[segs.size - 1]
        for (i in from until keys.size) {
            repStack.add(RepNode(keys[i], i == from, infos[i].mover, infos[i].check))
            repCount[keys[i]] = (repCount[keys[i]] ?: 0) + 1
        }
        // 根节点不是 repPush 压进去的，它不需要在下一次 repPop 时还原计数表
        if (repStack.isNotEmpty()) repStack[0].fresh = false
    }

    /**
     * 走子之后把新局面压进路径栈 —— 必须在 [doMove] **之后**调用（要读新局面）。
     *
     * @return **这一手是否将军** —— LMR 要用它决定该不该缩减；顺手返回，
     *   省得再算一次 `inCheck`（它每个节点都要跑，不能重复付钱）。
     */
    private fun repPush(b: ByteArray, m: Move, cap: Byte, mover: Side): Boolean {
        val fresh = isIrreversible(b[m.to], cap)
        if (fresh) {
            repSaved.add(repCount)
            repCount = HashMap()
        }
        // 走完后轮到对手 —— 对手被将，就等于这一手是将军
        val givesCheck = Rules.inCheck(b, mover.other)
        repStack.add(RepNode(hash, fresh, mover, givesCheck))
        repCount[hash] = (repCount[hash] ?: 0) + 1
        return givesCheck
    }

    private fun repPop() {
        if (repStack.isEmpty()) return
        val e = repStack.removeAt(repStack.size - 1)
        val c = (repCount[e.h] ?: 0) - 1
        if (c <= 0) repCount.remove(e.h) else repCount[e.h] = c
        if (e.fresh && repSaved.isNotEmpty()) repCount = repSaved.removeAt(repSaved.size - 1)
    }

    /**
     * 当前局面在本段路径上出现过 → 按和棋算（0 分）。
     *
     * 这里是**两次重复**就判和，比正式的「三次重复」保守一层。搜索里要防的是
     * 「双方都愿意重复」导致的无限循环，宁可早判：判早了只会让优势方更主动地躲开
     * 循环，不会把赢棋判成和棋。对局层仍然是三次重复才判（[Rules.adjudicate]），
     * **两处不一致是刻意的**。
     */
    private fun repIsDraw(): Boolean =
        repStack.size > 1 && (repCount[hash] ?: 0) > 1

    /**
     * 当前局面重复了 —— 那这是「长将循环」吗？
     *
     * @return 长将的一方（**该方判负**）；null 表示普通重复，按和棋算。
     *
     * 判据与对局层的 [Rules.adjudicate] 用的是**同一个** [Rules.perpetualChecker]：
     * 只取出「上次出现当前局面 → 现在」这一段的着法（走子方 + 是否将军）交给它，
     * 由它去认谁在长将。这样搜索和裁判对长将的看法终于一致 ——
     * 从前搜索只认「重复 = 0 分」，于是优势方会主动走进长将循环捞半分，
     * 到对局层却被判负（两批 A/B 各有 2 局栽在这上面，是结构性的）。
     */
    private fun repPerpetualLoser(): Side? {
        if (repStack.size <= 1) return null
        // 栈顶（下标 size-1）就是当前局面，从它下面一个位置往前找「上一次出现」
        var prev = -1
        var i = repStack.size - 2
        while (i >= 0) {
            if (repStack[i].h == hash) {
                prev = i
                break
            }
            i--
        }
        if (prev < 0 || prev + 1 >= repStack.size) return null

        val cycle = ArrayList<Rules.CycleMove>(repStack.size - prev - 1)
        for (k in (prev + 1) until repStack.size) {
            cycle.add(Rules.CycleMove(repStack[k].mover, repStack[k].check))
        }
        if (cycle.isEmpty()) return null
        return Rules.perpetualChecker(cycle)
    }

    // ---------- 主搜索 ----------

    private fun negamax(b: ByteArray, side: Side, depth: Int, alphaIn: Int, beta: Int, ply: Int): Int {
        checkTime()
        if (aborted) return 0

        // 重复局面必须在置换表**之前**判。0 分是「相对路径」的结论 —— 同一个局面
        // 从别的路径搜过来并不等于和棋，把它当普通评分存进置换表会污染后续搜索。
        if (ply > 0 && repIsDraw()) {
            if (perpetualEnabled) {
                val loser = repPerpetualLoser()
                if (loser != null) {
                    // 先问一句「这是不是长将循环」：是的话长将方判负（给绝杀分，按 ply 递减，
                    // 与「无合法着法」同一套表示），而不是判和。
                    return if (loser == side) -MATE + ply else MATE - ply
                }
            }
            return 0
        }

        nodes++

        val alphaOrig = alphaIn
        var alpha = alphaIn
        val plyKey = if (ply < 63) ply else 63
        val h = hash
        val slot = h.toInt() and ttMask

        var ttMove: Move? = null
        val entry = tt[slot]
        if (entry.key == h) {
            if (entry.from >= 0) ttMove = Move(entry.from, entry.to)
            if (entry.depth >= depth && ply > 0) {
                var hs = entry.score
                if (hs > MATE - 1000) hs -= ply
                else if (hs < -MATE + 1000) hs += ply
                if (entry.flag == flagExact) return hs
                if (entry.flag == flagLower && hs >= beta) return hs
                if (entry.flag == flagUpper && hs <= alpha) return hs
            }
        }

        if (depth <= 0) return quiesce(b, side, alpha, beta, ply, 8)

        // 空着裁剪和 LMR 都要知道「当前节点是否被将军」，合起来只算一次。
        // 只在深度够时才付这笔钱 —— `inCheck` 要扫全盘找将。
        val needInCheck = depth >= minOf(NULL_MOVE_MIN_DEPTH, LMR_MIN_DEPTH)
        val inCheckNow = needInCheck && Rules.inCheck(b, side)

        // 空着裁剪：先「放弃一手」试探。如果对手**多走一步**仍然够不到 beta，
        // 说明这个局面已经好到不必细算 —— 直接按 beta 剪枝。
        // 放在着法生成**之前**：剪枝成功连着法都不用生成。
        //
        // 三个前提缺一不可：① 不被将军（被将时每一步都可能是唯一的解）
        // ② 上一次不是空着（连续空着等于双方都放弃一手，会无限递归）
        // ③ 子力足够（残局的 zugzwang 会让「放弃一手」反而变好）
        if (nullMoveEnabled && depth >= NULL_MOVE_MIN_DEPTH && nullMoveOk && !inCheckNow &&
            hasNonPawnMaterial(b, side)
        ) {
            val nmDepth = maxOf(1, depth - 1 - NULL_MOVE_R)
            // 空着：棋盘不动，只把走子权交给对方 —— 哈希里的走子方项要跟着翻
            hash = hash xor zSide
            nullMoveOk = false
            val sc = -negamax(b, side.other, nmDepth, -beta, -beta + 1, ply + 1)
            nullMoveOk = true
            hash = hash xor zSide
            if (aborted) return 0
            if (sc >= beta) {
                // 不写置换表：这是「少算了一层」的结论，当普通评分存进去会污染搜索
                return beta
            }
        }

        val raw = Rules.genMoves(b, side)
        val moves = orderMoves(b, raw, plyKey, ttMove)

        var best = -INFINITE
        var bestMove: Move? = null
        var anyLegal = false
        var searchedOne = false
        // 已经搜索过的合法着法数（不是循环下标 —— 非法着法被 continue 跳过，
        // 用下标会让缩减判断偏早）
        var moveIdx = 0

        // LMR 的两个前提：深度够、着法够多（浅节点上不值得这么做）
        val lmrPossible = lmrEnabled && depth >= LMR_MIN_DEPTH && moves.size > LMR_FULL_MOVES

        for (m in moves) {
            val cap = doMove(b, m)
            if (Rules.inCheck(b, side) || Rules.kingsFacing(b)) {
                undo(b, m, cap)
                continue
            }
            anyLegal = true
            val givesCheck = repPush(b, m, cap, side)

            // LMR：只缩减「排序靠后的安静着法」。吃子、将军、被将军三类都不缩减 ——
            // 它们往往是唯一的解，缩减会把正确着法漏掉（宁可少省一点时间）。
            var reduced = 0
            if (lmrPossible && moveIdx >= LMR_FULL_MOVES && cap.toInt() == 0 && !inCheckNow && !givesCheck) {
                reduced = lmrTable[minOf(depth, 63)][minOf(moveIdx + 1, 63)]
                // 缩减后至少要留 1 层可搜，否则等于不搜
                reduced = minOf(reduced, maxOf(0, depth - 2))
            }

            var sc: Int
            if (!searchedOne) {
                // 首着必须用全窗口：此时 alpha 可能仍是 -INFINITE
                sc = -negamax(b, side.other, depth - 1, -beta, -alpha, ply + 1)
            } else if (reduced > 0) {
                // 先用缩减深度 + 零窗口试探，够好再按全深度重搜。
                //
                // ⚠️ 重搜是**两步**，和下面 PVS 分支保持一致：先零窗口确认它确实超过
                // alpha，再开全窗口取精确值。只做第一步会漏掉落在 (alpha, beta) 区间里的
                // 精确值 —— 那个值要写进置换表、也会成为 PV，不精确会顺着树往上放大。
                // （2026-09-23 这里用零窗口当精确分，40 局 A/B 从 71.3% 掉到 47.5%。）
                sc = -negamax(b, side.other, depth - 1 - reduced, -alpha - 1, -alpha, ply + 1)
                if (sc > alpha) {
                    sc = -negamax(b, side.other, depth - 1, -alpha - 1, -alpha, ply + 1)
                    if (sc > alpha && sc < beta) {
                        sc = -negamax(b, side.other, depth - 1, -beta, -alpha, ply + 1)
                    }
                }
            } else {
                sc = -negamax(b, side.other, depth - 1, -alpha - 1, -alpha, ply + 1)
                if (sc > alpha && sc < beta) {
                    sc = -negamax(b, side.other, depth - 1, -beta, -alpha, ply + 1)
                }
            }
            searchedOne = true
            moveIdx++
            repPop()
            undo(b, m, cap)
            if (aborted) return 0

            if (sc > best) {
                best = sc
                bestMove = m
            }
            if (best > alpha) alpha = best
            if (alpha >= beta) {
                if (cap.toInt() == 0) {
                    val kk = killers[plyKey]
                    if (kk[0] != m) {
                        kk[1] = kk[0]
                        kk[0] = m
                    }
                    history[m.from * 90 + m.to] += depth * depth
                }
                break
            }
        }

        if (!anyLegal) return -MATE + ply

        var store = best
        if (store > MATE - 1000) store += ply
        else if (store < -MATE + 1000) store -= ply
        val flag = when {
            best <= alphaOrig -> flagUpper
            best >= beta -> flagLower
            else -> flagExact
        }
        val te = tt[slot]
        te.key = h
        te.score = store
        te.depth = depth.coerceIn(-128, 127)
        te.flag = flag
        te.from = bestMove?.from ?: -1
        te.to = bestMove?.to ?: -1

        return best
    }

    // ---------- 根节点 ----------

    private fun prepare() {
        for (k in killers) {
            k[0] = null
            k[1] = null
        }
        java.util.Arrays.fill(history, 0)
        nodes = 0
        seeCallCount = 0
        aborted = false
        nullMoveOk = true
        // 重复局面路径栈每次都从 rootSearch 的 repInit 重建；这里清掉是为了
        // 「搜完之后不留状态」—— 上一次搜索的路径不该影响下一次。
        repStack = ArrayList(128)
        repCount = HashMap()
        repSaved = ArrayList()
        // 置换表按槽位残留，键不匹配会被忽略，不清空也安全（跨局累积是引擎本来的行为）。
    }

    private fun rootMoves(b: ByteArray, side: Side, excluded: List<Move>): MutableList<Move> {
        val all = Rules.genMoves(b, side)
        val w = b.copyOf()
        val res = ArrayList<Move>(all.size)
        for (m in all) {
            if (excluded.contains(m)) continue
            val cap = Rules.makeMove(w, m)
            val ok = !Rules.inCheckByGeneration(w, side) && !Rules.kingsFacing(w)
            Rules.undoMove(w, m, cap)
            if (ok) res.add(m)
        }
        return res
    }

    private fun rootSearch(
        board: ByteArray,
        side: Side,
        maxDepth: Int,
        timeMs: Int,
        excluded: List<Move>,
        history: SearchHistory?,
    ): SearchResult {
        System.arraycopy(board, 0, work, 0, Rules.SQUARES)
        val b = work
        hash = computeHash(b, side)
        deadline = nowMs() + maxOf(80, timeMs).toLong()
        repInit(history)

        var moves = rootMoves(b, side, excluded)
        if (moves.isEmpty()) {
            repInit(null)
            return SearchResult(null, -MATE, 0, 0, 0)
        }

        moves = orderMoves(b, moves, 0, null).toMutableList()

        val sign = if (side == Side.RED) 1 else -1
        var bestMove: Move? = moves[0]
        var bestScore = sign * evaluate(b)
        var reached = 0

        for (d in 1..maxOf(1, maxDepth)) {
            var alpha = -INFINITE
            var localBest: Move? = null
            var localScore = -INFINITE
            var completed = true

            for (m in moves) {
                val cap = doMove(b, m)
                repPush(b, m, cap, side)
                val sc = -negamax(b, side.other, d - 1, -INFINITE, -alpha, 1)
                repPop()
                undo(b, m, cap)
                if (aborted) {
                    completed = false
                    break
                }
                if (sc > localScore) {
                    localScore = sc
                    localBest = m
                }
                if (sc > alpha) alpha = sc
            }

            if (!completed) break
            if (localBest != null) {
                bestMove = localBest
                bestScore = localScore
                reached = d
                // 把上一轮的最佳着法提到最前面：下一轮先搜它，剪枝更早发生
                val idx = moves.indexOf(localBest)
                if (idx > 0) {
                    moves.removeAt(idx)
                    moves.add(0, localBest)
                }
            }
            if (abs(bestScore) > MATE - 1000) break
        }

        return SearchResult(bestMove, bestScore, reached, nodes, seeCallCount)
    }

    // ---------- 对外接口（同步；并发由锁挡住） ----------

    /**
     * 同步搜索。
     *
     * @param excluded 排除掉的着法。多路分析（[topMoves]）靠它逐个换着法，
     *   测试靠它把「某一手值多少分」单独问出来 —— 只看最佳着法是分不出
     *   「这手被判成和棋」和「这手本来就烂」的。
     */
    fun search(
        board: ByteArray,
        side: Side,
        maxDepth: Int,
        timeMs: Int,
        excluded: List<Move> = emptyList(),
        history: SearchHistory? = null,
    ): SearchResult = lock.withLock {
        prepare()
        rootSearch(board, side, maxDepth, timeMs, excluded, history)
    }

    /**
     * 多路分析：给出前 n 个候选着法，供教练点评与「让模型选一个」使用。
     *
     * 时间预算按候选数切片（第 2、3 个候选会搜得更浅）—— 这是**界面提示**要的口径。
     * 要「同深度的前 N 个候选」（离线预计算那种），请用 [Engine.search] 加 `excluded` 自己循环。
     */
    fun topMoves(
        board: ByteArray,
        side: Side,
        count: Int,
        maxDepth: Int,
        timeMs: Int,
        history: SearchHistory? = null,
    ): List<CandidateMove> = lock.withLock {
        prepare()
        val excluded = ArrayList<Move>()
        val out = ArrayList<CandidateMove>(count)
        val budget = maxOf(400, timeMs)
        for (i in 0 until count) {
            val slice = maxOf(300, budget / (count - i))
            val r = rootSearch(board, side, maxDepth, slice, excluded, history)
            val mv = r.move ?: break
            out.add(CandidateMove(mv, r.score, r.depth, Notation.label(board, mv)))
            excluded.add(mv)
            if (abs(r.score) > MATE - 1000) break
        }
        out
    }

    /** 重置内部状态（测试用，避免用例之间通过置换表互相影响）。 */
    fun resetForTesting() = lock.withLock {
        prepare()
        for (e in tt) e.clear()
    }

    /**
     * 按难度档挑一手。
     *
     * 入门档（`slack > 0`）**故意**在接近最优的着法里随机挑，让新手有得下。
     *
     * @param random 注入随机源是为了让测试台能钉住它（默认 `Random.Default`）。
     */
    fun pickMove(
        board: ByteArray,
        side: Side,
        level: SearchLevel,
        history: SearchHistory? = null,
        random: kotlin.random.Random = kotlin.random.Random.Default,
    ): SearchResult = lock.withLock {
        prepare()
        val res = rootSearch(board, side, level.depth, level.timeMs, emptyList(), history)

        if (res.move == null || level.slack <= 0) return@withLock res

        // 入门档故意在接近最优的着法里随机挑，让新手有得下
        val legal = Rules.legalMoves(board, side)
        val candidates = ArrayList<Move>()
        for (m in legal) {
            System.arraycopy(board, 0, work, 0, Rules.SQUARES)
            val cap = Rules.makeMove(work, m)
            // 这一层是「1 步之后的静态分」，只是给入门档挑个不离开最优太远的着法。
            // 故意不传 history：这里的棋盘是 board + m，而 history 只到 board，
            // 硬塞进去会把 board 从路径上顶掉，反而可能造出假重复。
            val sub = rootSearch(work, side.other, 1, 120, emptyList(), null)
            Rules.undoMove(work, m, cap)
            if (res.score - (-sub.score) <= level.slack) candidates.add(m)
        }
        if (candidates.isEmpty()) return@withLock res

        val chosen = candidates[random.nextInt(candidates.size)]
        SearchResult(chosen, res.score, res.depth, res.nodes, res.seeCalls)
    }
}
