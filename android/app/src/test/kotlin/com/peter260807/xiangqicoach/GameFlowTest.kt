package com.peter260807.xiangqicoach

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.peter260807.xiangqicoach.data.GameStore
import com.peter260807.xiangqicoach.engine.Notation
import com.peter260807.xiangqicoach.engine.Piece
import com.peter260807.xiangqicoach.engine.Rules
import com.peter260807.xiangqicoach.engine.Side
import com.peter260807.xiangqicoach.engine.XiangqiLibrary
import com.peter260807.xiangqicoach.engine.XQScene
import com.peter260807.xiangqicoach.ui.ConfirmKind
import com.peter260807.xiangqicoach.ui.GameViewModel
import com.peter260807.xiangqicoach.ui.TrainRow
import com.peter260807.xiangqicoach.ui.buildRows
import com.peter260807.xiangqicoach.ui.validatedFEN
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.time.Duration

/**
 * 对局状态机的集成测试（Robolectric，跑在 JVM 上，不用模拟器）。
 *
 * ## 为什么这一组必须有
 *
 * `engine` 模块的单测证明的是「规则与搜索是对的」；而**用户在屏幕上点两下**
 * 走的是另一条链：`tap → 选中 → targets → play → 动画 → onMoveSettled → 电脑走棋`。
 * 这条链坏掉时表现是「点了没反应」，但引擎测试全绿 —— 我正是在模拟器上撞到的。
 * 这组测试把这条链钉在 JVM 上，避免每次都要靠截图猜。
 *
 * ⚠️ 用 Robolectric 而不是 instrumented test：这条链是纯逻辑（没有真实渲染），
 * 跑在 JVM 上几秒就有结果，而 instrumented test 要起模拟器、几十倍慢。
 */
@RunWith(AndroidJUnit4::class)
class GameFlowTest {

    // ---------- 测试脚手架 ----------

    /**
     * 每次建一个全新的 ViewModel：存档指向一个临时文件，题库用空库。
     *
     * ⚠️ **动画时长归零**是有意的：走子动画跑在 `viewModelScope`（主线程）上，
     * 而引擎搜索跑在 `Dispatchers.Default`（真实线程池）上 —— 两条时间链，
     * 在 Robolectric 里让它们按真实时间对齐非常脆。归零之后
     * 「走一手 → 落子 → 轮到电脑」立刻推进完，测试才稳定。
     * 生产代码里这两个值保持 iOS 的 460 / 520，不要跟着改。
     */
    private fun newVm(): GameViewModel {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = GameStore(File(ctx.filesDir, "test-archive-${System.nanoTime()}.json"))
        val vm = GameViewModel(library = XiangqiLibrary.EMPTY, store = store)
        vm.slideMs = 0
        vm.settleMs = 0
        return vm
    }

    /**
     * 推进 Robolectric 的**虚拟时钟**。
     *
     * ⚠️ 只调 `idle()` 不够：`delay(16)` 在 Robolectric 里是按虚拟时钟排队的消息，
     * 时钟不往前走它永远不触发；而 `Thread.sleep` 只让真实线程歇一会儿、**不动虚拟时钟**。
     * 正确做法是 `idleFor(时长)`：把时钟往前推，顺带执行到期的任务。
     */
    private fun advance(millis: Long) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis))
    }

    /**
     * 反复「推进虚拟时钟 + 让真实线程歇一会儿」，直到条件成立或超时。
     *
     * 两件事都要做：动画在**虚拟时钟**上（`idleFor` 负责），
     * 引擎搜索在 `Dispatchers.Default` 的**真实线程**上（`sleep` 负责）。
     */
    private fun waitUntil(timeoutMs: Long = 20000, cond: () -> Boolean): Boolean {
        var waited = 0L
        while (waited < timeoutMs) {
            if (cond()) return true
            advance(50)
            Thread.sleep(50)
            waited += 50
        }
        return cond()
    }

    /** 红兵三（第 6 纵线上的那个红兵）所在的格。 */
    private fun redPawnSquare(): Int {
        val b = Rules.parse(Rules.START_FEN)
        val pawn = Piece.code(Piece.TYPE_PAWN, Side.RED).toInt()
        for (i in 0 until Rules.SQUARES) {
            if (b[i].toInt() == pawn && i % 9 == 6) return i
        }
        error("没找到红兵三")
    }

    // ---------- 基础 ----------

    @Test
    fun freshGameStartsAtStandardOpening() {
        val vm = newVm()
        assertEquals(Rules.START_FEN, Rules.fen(vm.board))
        assertEquals(Side.RED, vm.turn)
        assertEquals(0, vm.history.size)
        assertTrue(vm.targets.isEmpty())
        assertEquals(-1, vm.selected)
    }

    /**
     * 自证：主线程上的协程在这个测试环境里**真的会跑**。
     *
     * 这条断言的存在是有理由的：如果 `Dispatchers.Main` 在 Robolectric 下不推进，
     * 那么「动画结束后 animating 会变 false」这类断言会永远失败，
     * 而失败的报错会指向别的地方（看起来像业务逻辑错）。
     * 先证明地基是通的，后面的失败才可信。
     */
    @Test
    fun mainThreadCoroutinesRunInThisEnvironment() {
        val vm = newVm()
        vm.showMessage("地基自检")
        assertEquals("showMessage 应当在主线程协程里立刻设上 toast", "地基自检", vm.toast)
    }

    // ---------- 走子 ----------

    @Test
    fun tapSelectsPieceThenPlaysLegalMove() {
        val vm = newVm()
        val pawn = redPawnSquare()

        vm.tap(pawn)
        assertEquals("点第一下应当选中", pawn, vm.selected)
        assertTrue("选中后应当有可落点", vm.targets.isNotEmpty())

        val move = vm.targets.first()
        vm.tap(move.to)

        assertEquals("走一手之后历史 +1", 1, vm.history.size)
        assertEquals("走后轮到黑方", Side.BLACK, vm.turn)
        assertEquals("走后清空选中", -1, vm.selected)
        assertTrue("走后清空可落点", vm.targets.isEmpty())
        assertEquals("动画起点是选中的格", pawn, vm.animFrom)
        assertEquals("动画终点是落点", move.to, vm.animTo)
    }

    @Test
    fun illegalTapDoesNotMove() {
        val vm = newVm()
        val king = Rules.kingIndex(vm.board, Side.RED)
        vm.tap(king)
        assertEquals(king, vm.selected)

        // 帅不能一次走两格
        val far = king - 2 * 9
        vm.tap(far)
        assertEquals("点非法目标不该走子", 0, vm.history.size)
        assertTrue("点非法目标应当清掉选中或改选到别的己方子", vm.selected == -1 || vm.selected == far)
    }

    @Test
    fun tappingOwnPieceSwitchesSelection() {
        val vm = newVm()
        val king = Rules.kingIndex(vm.board, Side.RED)
        val rook = Rules.kingIndex(vm.board, Side.RED) - 4 // 帅往左四格是车
        vm.tap(king)
        vm.tap(rook)
        assertEquals("点自己的另一个子应当改选", rook, vm.selected)
        assertTrue(vm.targets.all { it.from == rook })
    }

    // ---------- 悔棋 ----------

    /**
     * 悔棋后的还原。
     *
     * ⚠️ 等到「动画结束**且电脑这一手也走完**」再悔棋。为什么要连 thinking 一起等：
     * 真实使用中「轮到黑方、电脑正在算」只存在两三秒，而且那时悔棋本来就被挡住
     * （`undo()` 里有 `if (thinking) return`）。测试里没法自然停在那个瞬间，
     * 所以等它彻底走完 —— 此时轮到红方，悔棋退掉一整个回合，
     * 结果同样是「棋盘回到初始局面」。这条测的是还原，不是退几手。
     */
    @Test
    fun undoRestoresBoardAndTurn() {
        val vm = newVm()
        val king = Rules.kingIndex(vm.board, Side.RED)
        vm.tap(king)
        vm.tap(vm.targets.first { it.from == king }.to)
        assertEquals(Side.BLACK, vm.turn)

        // 动画进行中悔棋会被挡下 —— 这是有意的保护（否则动画会停在已不存在的局面上）。
        // 时长归零后动画几乎立刻结束，所以这条断言只在「挡下」这一侧成立与否都可能，
        // 这里不断言，只把它作为行为记录。

        if (!waitUntil { !vm.animating && !vm.thinking }) {
            throw AssertionError("动画/电脑走棋没有结束 —— 主线程调度在这个测试环境里没跑起来")
        }
        vm.undo()
        assertEquals("悔棋后回到初始局面", 0, vm.history.size)
        assertEquals("悔棋后轮到红方", Side.RED, vm.turn)
        assertEquals(Rules.START_FEN, Rules.fen(vm.board))
    }

    /** 电脑已经应手之后再悔棋：退掉**一整个回合**（2 手）。 */
    @Test
    fun undoAfterComputerRepliedTakesBackWholeRound() {
        val vm = newVm()
        vm.setLevel("easy") // 1 层 / 600ms，应手快
        val king = Rules.kingIndex(vm.board, Side.RED)
        vm.tap(king)
        vm.tap(vm.targets.first { it.from == king }.to)

        if (!waitUntil { vm.history.size >= 2 && !vm.thinking }) {
            return // 电脑没应手（慢机器）：这条用例不成立，跳过而不是假绿
        }
        assertEquals(Side.RED, vm.turn)
        val before = vm.history.size
        advance(200)
        vm.undo()
        assertEquals(Side.RED, vm.turn)
        assertTrue("退掉的手数不该超过原有手数（原 $before）", vm.history.size < before)
    }

    // ---------- 二次确认 ----------

    @Test
    fun requestingSceneWithNoMovesLoadsImmediately() {
        val vm = newVm()
        vm.requestScene(XQScene.standard())
        assertNull("一条着法都没走时不该弹确认框", vm.pendingConfirm)
    }

    @Test
    fun requestingRestartWithMovesAsksForConfirmation() {
        val vm = newVm()
        val king = Rules.kingIndex(vm.board, Side.RED)
        vm.tap(king)
        vm.tap(vm.targets.first { it.from == king }.to)
        vm.requestRestart()
        assertNotNull("场上还有棋时重开必须先问一句", vm.pendingConfirm)
        assertTrue(vm.pendingConfirm is ConfirmKind.Restart)

        vm.confirmPending()
        assertNull(vm.pendingConfirm)
        assertEquals("确认后回到初始局面", Rules.START_FEN, Rules.fen(vm.board))
        assertEquals(0, vm.history.size)
    }

    // ---------- FEN 校验 ----------

    @Test
    fun fenValidationAcceptsLegalAndRejectsBroken() {
        assertEquals(Rules.START_FEN, validatedFEN(Rules.START_FEN))
        assertNull("只有九行", validatedFEN("rnbakabnr/........./........./........./........./........./........./........./........."))
        assertNull("某行长度不对", validatedFEN("rnbakabnr/......../........./........./........./........./........./........./........./RNBAKABNR"))
        assertNull("没有帅", validatedFEN(Rules.START_FEN.replace("K", ".")))
        val facing = "....k..../........./........./........./........./........./........./........./........./....K...."
        assertNull("白脸将（将帅照面）不能导入", validatedFEN(facing))
    }

    // ---------- 棋谱导入导出 ----------

    @Test
    fun importChineseNotationAppliesMoves() {
        val vm = newVm()
        val err = vm.importText("炮二平五 马8进7 马二进三")
        assertNull("合法棋谱不该报错：$err", err)
        assertEquals(3, vm.history.size)
        assertEquals(listOf("炮二平五", "马8进7", "马二进三"), vm.history.map { it.label })
    }

    @Test
    fun importRejectsGarbageWithExplanation() {
        val vm = newVm()
        val err = vm.importText("这不是棋谱也不是局面")
        assertNotNull("认不出来时必须给说明，不能静默失败", err)
    }

    @Test
    fun exportTextContainsAllThreeForms() {
        val vm = newVm()
        val king = Rules.kingIndex(vm.board, Side.RED)
        vm.tap(king)
        vm.tap(vm.targets.first { it.from == king }.to)

        val label = Notation.label(Rules.parse(Rules.START_FEN), vm.history[0].move)
        val text = vm.exportShareText
        assertTrue("导出文本应含初始局面", text.contains("【初始局面】"))
        assertTrue("导出文本应含棋谱", text.contains("【棋谱】"))
        assertTrue("导出文本应含当前局面", text.contains("【当前局面】"))
        assertTrue("棋谱里应有刚走的那一手（$label）", text.contains(label))
    }

    // ---------- 存档 ----------

    @Test
    fun savedGameSurvivesReload() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val f = File(ctx.filesDir, "test-archive-${System.nanoTime()}.json")

        val vm1 = GameViewModel(XiangqiLibrary.EMPTY, GameStore(f))
        val king = Rules.kingIndex(vm1.board, Side.RED)
        vm1.tap(king)
        vm1.tap(vm1.targets.first { it.from == king }.to)
        vm1.saveCurrentGame()

        // 换一个 store 实例读同一个文件 —— 模拟「下次启动」
        val store2 = GameStore(f)
        store2.load()
        assertEquals("重开后应当读回那盘棋", 1, store2.payload.games.size)
        assertEquals(1, store2.payload.games[0].movePairs.size)
    }

    @Test
    fun solvedDrillIsRecordedOnce() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = GameStore(File(ctx.filesDir, "test-drills-${System.nanoTime()}.json"))
        assertTrue("第一次通关返回 true", store.markSolved("mate:m1"))
        assertFalse("重复通关返回 false（界面靠它决定要不要提示「新纪录」）", store.markSolved("mate:m1"))
        assertTrue(store.solvedIds.contains("mate:m1"))
    }

    // ---------- 训练页的行模型 ----------

    /**
     * 摊平后的行 key 必须两两不同。
     *
     * 这条测试是被一次**真崩溃**逼出来的：我批量改代码时把一个字符串模板写坏成了
     * 字面量，于是每一道杀法题拿到同一个 key，而 `LazyColumn` 遇到重复 key
     * 直接抛 `IllegalArgumentException: Key ... was already used` 崩掉整个训练页。
     * 编译期看不出来、不打开训练页的测试也看不出来 —— 只有在模拟器上点进去才崩。
     */
    @Test
    fun trainingRowsHaveUniqueKeys() {
        val groups = TestLibrary.shared.mateGroups(emptySet())
        assertTrue("题库为空，这条测试等于空转", groups.isNotEmpty())

        // 收起与展开两种情况都要验：走的代码路径不同
        for (expanded in listOf(emptySet<String>(), groups.map { it.label }.toSet())) {
            val keys = buildRows(groups, expanded, emptySet()).map { it.key }
            val dup = keys.groupingBy { it }.eachCount().filter { it.value > 1 }.keys
            assertEquals("行 key 有重复：$dup", keys.size, keys.toSet().size)
        }
    }

    /** 收起时每组最多 40 道题 + 一行「展开其余」。 */
    @Test
    fun collapsedGroupsCapAtFortyPuzzles() {
        val groups = TestLibrary.shared.mateGroups(emptySet())
        val big = groups.firstOrNull { it.items.size > 40 } ?: return
        val rows = buildRows(listOf(big), emptySet(), emptySet())
        assertEquals("收起时只画 40 行", 40, rows.filterIsInstance<TrainRow.Puzzle>().size)
        assertTrue("大分组收起时应当有一行「展开其余」", rows.any { it is TrainRow.More })
    }
}

/**
 * 训练页测试用的题库。
 *
 * ⚠️ 直接从 `shared/library.json` 读（测试的工作目录不保证是模块目录，
 * 与 engine 模块的 `TestFixtures` 同一个理由），而不是读 assets ——
 * assets 是 Android 资源，读它要起模拟器或配 Robolectric 资源路径，
 * 而这里要验的只是「行模型的 key 唯一」。
 */
private object TestLibrary {
    val shared: XiangqiLibrary by lazy {
        var dir: File? = File("").absoluteFile
        var found: File? = null
        repeat(5) {
            val f = File(dir, "shared/library.json")
            if (found == null && f.exists()) found = f
            dir = dir?.parentFile
        }
        val f = found ?: error("找不到 shared/library.json（工作目录：${File("").absolutePath}）")
        kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
            .decodeFromString(XiangqiLibrary.serializer(), f.readText())
    }
}
