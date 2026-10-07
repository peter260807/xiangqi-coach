package com.peter260807.xiangqicoach.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * 棋谱库校验（对应 iOS 的 `LibraryTests`）。
 *
 * 库里的局面全是手工编排或从公开题库导入的，最容易出的问题不是「引擎算不出杀」，
 * 而是「局面本身摆错了」—— 比如黑方开局就已经无子可动（等于随便走一步就赢），
 * 或者压根没在将军却被当成杀局。这类错误光看棋谱看不出来，必须逐条走一遍。
 *
 * ⚠️ **测的是哪一份数据**：这里是 `shared/library.json`（唯一数据源），
 * 不是 APK 里那份 assets 副本。副本是否同步由两条断言守着
 * （条数 ≥ 900 + 抽查跨批次 id），对应 iOS 那次「停在 11 道题上、测试全绿」的事故。
 *
 * ⚠️ 这一条**刻意不去读 assets**：assets 是 Android 的资源，
 * 读它就得起模拟器或引 Robolectric，而这份测试要在纯 JVM 上秒级跑完。
 * 「assets 是同步出来的」这件事由 `tools/sync-library.js` 与
 * `LibraryAssetsTest`（app 模块）分别守着。
 */
class LibraryTests {

    private val lib: XiangqiLibrary get() = TestFixtures.sharedLibrary

    @Test
    fun libraryIsNonEmpty() {
        assertTrue(lib.mates.isNotEmpty(), "杀法库为空")
        assertTrue(lib.openings.isNotEmpty(), "开局库为空")
        assertTrue(lib.studies.isNotEmpty(), "残局库为空")
        assertEquals(1, lib.version)
    }

    /**
     * 抽取的必须是**完整**题库，不能停在导入公考题库之前那份 11 道的旧副本。
     *
     * 起因：iOS 的 `Resources/library.json` 曾经是**独立副本**，同步脚本只生成网页端那份。
     * 于是导入 445 道 + 用 Pikafish 又解出 525 道（共 981 道）之后，
     * 网页端有 981 道、iOS 端还是 11 道，而**所有单测照样全绿** ——
     * 因为它们统统只断言「非空」，恰好那 11 道也非空。
     */
    @Test
    fun isNotTheStaleCopy() {
        assertTrue(
            lib.mates.size >= 900,
            "杀法库只有 ${lib.mates.size} 道 —— 大概率还是导入之前的旧副本。" +
                "同步办法：node tools/sync-library.js",
        )
        val ids = lib.mates.map { it.id }.toSet()
        for (id in listOf("m1", "x0010", "x0446", "x0970")) {
            assertTrue(ids.contains(id), "库里缺 $id —— 旧副本里不会有的条目")
        }
        assertTrue(
            (lib.mates.mapNotNull { it.mateIn }.maxOrNull() ?: 0) >= 20,
            "最深一题不到 20 手 —— 深杀（Pikafish 求解那批）没进库",
        )
    }

    /**
     * 每道杀法题：① 局面不能是退化的；② **库里的那条解法路线必须真的把对方将死**。
     *
     * 判据与网页端 `XQLIB.validateLibrary` 完全一致（那是唯一的数据源口径）：
     *   ① 双方都有子可动、黑方开局没被将军、红方一上来没被将、没摆白脸将；
     *   ② 沿存下来的解法路线逐步走，每一步都能识别且合法；
     *   ③ 走完最后一步轮到黑方、且黑方无子可动 —— 这才是红方成杀；
     *   ④ 线路长度 == 2·mateIn − 1。
     *
     * ⚠️ 这里**不能**用「引擎搜不搜得到杀棋分」当判据。那条判据只对 mateIn ≤ 2 成立，
     * 一直只是靠「库里恰好只有 11 道浅题」才绿的。搜索验证的是「引擎能不能看到杀」，
     * 而我们要保证的是「**库里存的那条路线是对的**」—— 那才是给学生看的东西。
     * 引擎断言只留给浅题（见 [shallowPuzzlesAreFoundByEngine]）。
     */
    @Test
    fun everyMatePuzzleIsPlayableAndActuallyWins() {
        val failures = ArrayList<String>(16)
        for (m in lib.mates) {
            val b = Rules.parse(m.fen)
            assertEquals(Rules.SQUARES, b.size, "${m.name}：FEN 解析出的盘面长度不对")

            if (Rules.legalMoves(b, Side.RED).isEmpty()) failures.add("${m.name}：红方无子可动")
            if (!Rules.hasLegalMove(b, Side.BLACK)) failures.add("${m.name}：黑方开局就无子可动 —— 退化局面")
            if (Rules.inCheck(b, Side.BLACK)) failures.add("${m.name}：黑方开局不应已被将军")
            if (Rules.inCheck(b, Side.RED)) failures.add("${m.name}：红方一上来就处于被将状态")
            if (Rules.kingsFacing(b)) failures.add("${m.name}：摆出了白脸将")

            val line = m.line
            if (line.isNullOrEmpty()) {
                failures.add("${m.name}：没有解法路线 —— 导入题库的题都必须带 line")
                continue
            }

            var bb = Rules.parse(m.fen)
            var side = Side.RED
            var bad: String? = null
            for ((i, token) in line.withIndex()) {
                val mv = Notation.findMove(bb, side, token)
                if (mv == null) {
                    bad = "第 ${i + 1} 着「$token」在本局面无法识别或不合法"
                    break
                }
                Rules.makeMove(bb, mv)
                side = side.other
            }
            if (bad != null) {
                failures.add("${m.name}：$bad")
                continue
            }
            if (Rules.hasLegalMove(bb, side)) failures.add("${m.name}：走完解法路线对方仍有子可动")
            if (side != Side.BLACK) failures.add("${m.name}：走完解法路线轮到红方 —— 线路长度是偶数")
            m.mateIn?.let {
                if (line.size != 2 * it - 1) {
                    failures.add("${m.name}：线路 ${line.size} 步与标注的 $it 手杀对不上")
                }
            }
        }
        assertTrue(failures.isEmpty(), "共 ${failures.size} 条不合格：\n  " + failures.take(12).joinToString("\n  "))
    }

    /**
     * 浅题（mateIn ≤ 2）另外还要过**引擎**：它得在 6 层内看得到杀棋分。
     *
     * 上面那条规则层判据证明的是「存下来的路线对」，证明不了「引擎自己找得到」；
     * 而 App 的「提示」按钮走的就是引擎。浅题上这条必须成立，深题上它必然不成立，
     * 所以分开写。
     */
    @Test
    fun shallowPuzzlesAreFoundByEngine() {
        val engine = Engine()
        val shallow = lib.mates.filter { (it.mateIn ?: 99) <= 2 }
        assertTrue(shallow.size >= 20, "浅题太少（${shallow.size} 道），这条断言覆盖不到什么")
        val failures = ArrayList<String>(8)
        for (m in shallow) {
            val b = Rules.parse(m.fen)
            engine.resetForTesting()
            val r = engine.search(b, Side.RED, maxDepth = 6, timeMs = 8000)
            if (r.score <= Engine.MATE - 1000) {
                failures.add("${m.name}：引擎在 6 层内没找到成杀（实际评估 ${r.score}）")
                continue
            }
            val mv = r.move
            if (mv == null || !Rules.isLegal(b, Side.RED, mv)) {
                failures.add("${m.name}：引擎返回的着法本身不合法")
                continue
            }
            val probe = b.copyOf()
            Rules.makeMove(probe, mv)
            if (Rules.hasLegalMove(probe, Side.BLACK) && !Rules.inCheck(probe, Side.BLACK)) {
                failures.add("${m.name}：推荐的着法把黑方逼成困毙而非将死")
            }
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n  "))
    }

    @Test
    fun everyOpeningLineIsLegalMoveByMove() {
        assertTrue(lib.openings.isNotEmpty())
        val failures = ArrayList<String>(4)
        for (o in lib.openings) {
            val b = Rules.parse(Rules.START_FEN)
            var side = Side.RED
            var ply = 0
            for (token in o.line.split(' ').filter { it.isNotEmpty() }) {
                ply++
                val m = Notation.findMove(b, side, token)
                if (m == null) {
                    failures.add("${o.name}：第 $ply 手「$token」在盘面上不合法")
                    break
                }
                Rules.makeMove(b, m)
                side = side.other
            }
            if (ply < 4) failures.add("${o.name}：开局谱太短，起不到演示作用")
            if (Rules.inCheck(b, Side.RED)) failures.add("${o.name}：走完开局谱后红方被将")
            if (Rules.inCheck(b, Side.BLACK)) failures.add("${o.name}：走完开局谱后黑方被将")
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n  "))
    }

    @Test
    fun everyStudyPositionIsWellFormed() {
        assertTrue(lib.studies.isNotEmpty())
        val failures = ArrayList<String>(4)
        for (s in lib.studies) {
            val b = Rules.parse(s.fen)
            if (Rules.legalMoves(b, Side.RED).isEmpty()) failures.add("${s.name}：红方无子可动")
            if (!Rules.hasLegalMove(b, Side.BLACK)) failures.add("${s.name}：黑方无子可动")
            if (Rules.inCheck(b, Side.RED)) failures.add("${s.name}：红方一上来就处于被将状态")
            if (Rules.kingsFacing(b)) failures.add("${s.name}：摆出了白脸将")
            if (Rules.material(b) >= 60) failures.add("${s.name}：名为残局，子力却还很多")
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n  "))
    }

    /**
     * 难度文案必须说得出**手数**，不能一律「多步杀」。
     *
     * 起因：`difficultyText` 原来是一个写死到「十」的数组，11 手以上全部掉进 tier 兜底。
     * 用 Pikafish 求解深杀之后库里有 30 手杀，这个洞就露出来了。
     */
    @Test
    fun difficultyTextReportsMoveCount() {
        fun text(mateIn: Int?) = MatePuzzle(
            id = "t", name = "n", tier = 3, fen = Rules.START_FEN, set = "s", mateIn = mateIn,
        ).difficultyText

        assertEquals("一步杀", text(1))
        // ⚠️ 2 手刻意是「二」不是「两」：既有文案与网页端筛选徽标都用「二」
        assertEquals("二步杀", text(2))
        assertEquals("十步杀", text(10))
        assertEquals("十一步杀", text(11))
        assertEquals("二十步杀", text(20))
        assertEquals("二十八步杀", text(28))
        assertEquals("三十步杀", text(30))

        assertEquals(null, MatePuzzle.cnNum(0), "0 手没有中文写法")
        assertEquals(null, MatePuzzle.cnNum(100), "超过 99 手不编造")
        assertEquals("多步杀", text(null), "没有 mateIn 的老条目退回 tier 文案，不能变空串")

        val deepest = lib.mates.maxByOrNull { it.mateIn ?: 0 }
        assertNotNull(deepest)
        assertNotEquals("多步杀", deepest.difficultyText, "库里最深一题「${deepest.name}」应当报出手数")
    }

    @Test
    fun sceneCatalogCoversWholeLibrary() {
        val scenes = SceneCatalog.all(lib)
        assertEquals(
            1 + lib.allClassics.size + lib.mates.size + lib.openings.size + lib.studies.size,
            scenes.size,
        )
        assertEquals("start", scenes.first().id)
        for (s in scenes) {
            val (board, moves) = SceneCatalog.resolve(s)
            assertEquals(Rules.SQUARES, board.size)
            // 开局库预摆的着法必须全部落地，否则场景显示的局面与描述不符
            if (s.kind == SceneKind.OPENING) {
                assertEquals(
                    s.preloadLabels.size, moves.size,
                    "${s.title}：有 ${s.preloadLabels.size - moves.size} 手开局谱没能摆上去",
                )
            }
        }
    }

    /** 导入的题没有手写讲解（`idea`），提示里不能露出 "null" 或空行。 */
    @Test
    fun importedPuzzlesHaveUsableHintText() {
        assertTrue(lib.mates.any { it.set != null }, "没有导入的题 —— 库可能还是旧副本")
        for (s in SceneCatalog.all(lib)) {
            if (!s.id.startsWith("mate:")) continue
            assertTrue(s.note.isNotEmpty(), "${s.title}：提示文案为空")
            assertFalse(s.note.contains("null"), "${s.title}：提示文案里露出了 null")
        }
    }
}
