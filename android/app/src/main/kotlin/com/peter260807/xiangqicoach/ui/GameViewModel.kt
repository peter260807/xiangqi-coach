package com.peter260807.xiangqicoach.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.peter260807.xiangqicoach.data.GameStore
import com.peter260807.xiangqicoach.engine.Ability
import com.peter260807.xiangqicoach.engine.Adjudication
import com.peter260807.xiangqicoach.engine.CandidateMove
import com.peter260807.xiangqicoach.engine.Engine
import com.peter260807.xiangqicoach.engine.GameFlags
import com.peter260807.xiangqicoach.engine.GameRecord
import com.peter260807.xiangqicoach.engine.Move
import com.peter260807.xiangqicoach.engine.MoveEval
import com.peter260807.xiangqicoach.engine.Notation
import com.peter260807.xiangqicoach.engine.Piece
import com.peter260807.xiangqicoach.engine.Rules
import com.peter260807.xiangqicoach.engine.SceneCatalog
import com.peter260807.xiangqicoach.engine.SceneKind
import com.peter260807.xiangqicoach.engine.SearchLevel
import com.peter260807.xiangqicoach.engine.Side
import com.peter260807.xiangqicoach.engine.ReviewDigest
import com.peter260807.xiangqicoach.engine.XQScene
import com.peter260807.xiangqicoach.engine.XiangqiLibrary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** 一步棋的历史记录（悔棋靠它还原）。 */
class HistoryItem(
    val move: Move,
    val captured: Byte,
    val label: String,
    val side: Side,
)

/**
 * 需要二次确认的破坏性操作。
 *
 * 「重开」按钮就挨着「悔棋」，误触一下整盘就没了；场景菜单里换一局、
 * 训练页点开一个练习，同样会把这盘棋清掉。三种入口共用这一个弹窗 ——
 * 文案和确认后的动作都在这里定义，免得各写一份还互相对不上。
 */
sealed class ConfirmKind {
    abstract val title: String
    abstract val confirmLabel: String
    abstract val message: String

    /** 重开本局：局面不变，只把着法清空。 */
    class Restart(val moves: Int, val sceneTitle: String) : ConfirmKind() {
        override val title = "重开本局？"
        override val confirmLabel = "重开"
        override val message get() = "已走的 $moves 手会全部清掉，回到「$sceneTitle」的初始局面。"
    }

    /** 换到另一个场景：局面整个换掉。 */
    class SwitchScene(val scene: XQScene, val moves: Int) : ConfirmKind() {
        override val title = "换一局？"
        override val confirmLabel = "换局"
        override val message get() = "当前这局的 $moves 手会被丢掉，改从「${scene.title}」重新开始。"
    }

    /** 载入存档：局面换成存档里的，进度也一起换成存档的。 */
    class LoadGame(val record: GameRecord, val moves: Int) : ConfirmKind() {
        override val title = "载入存档？"
        override val confirmLabel = "载入"
        override val message get() = "当前这局的 $moves 手会被丢掉，改成载入存档「${record.sceneName}」。"
    }
}

/**
 * 对局状态机。所有流程控制都走这里，视图只负责呈现。
 *
 * 走子刻意拆成两步：棋盘状态立即更新，视觉用约 0.46 秒滑过去，
 * 再停 0.52 秒 —— 合计约 1 秒，让人看清「谁走到了哪里、吃了什么」。
 * 这两个数字与 iOS `GameState.slideMs / settleMs` 一致，**不要各自调**：
 * 两端节奏不同的话，「吃子提示」出现的时机也会跟着不同。
 *
 * ## 与 iOS 的差别（有意）
 *
 * - **没有 `@MainActor` + 回调**：搜索跑在 [Dispatchers.Default] 上，
 *   结果回到 `viewModelScope` 更新 Compose 状态。用 [engineMutex] 而不是
 *   引擎内部的队列，是因为「等搜索结果」在 Kotlin 里是挂起而不是回调。
 * - **状态只在这里**：棋盘、历史、动画进度全部是 ViewModel 的属性，
 *   所以旋转屏幕 / 分屏不会像 iOS 那样重建视图 —— 但反过来说，
 *   任何 UI 局部状态都不能影响棋局，否则一旋转就丢。
 */
class GameViewModel(
    val library: XiangqiLibrary,
    val store: GameStore,
    private val engine: Engine = Engine.shared,
) : ViewModel() {

    companion object {
        /** 棋盘滑到位用时（毫秒）。与 iOS `GameState.slideMs` 一致。 */
        const val SLIDE_MS = 460L

        /** 滑到位之后再停多久才交给下一步。与 iOS `GameState.settleMs` 一致。 */
        const val SETTLE_MS = 520L

        const val TOTAL_ANIM_MS = SLIDE_MS + SETTLE_MS

        /** 滑动结束到报将军之间的那一点点停顿（iOS 是 60ms）。 */
        const val ANNOUNCE_DELAY_MS = 60L
    }

    /**
     * 动画时长，单位毫秒。
     *
     * ⚠️ **可注入不是为了"支持关闭动画"**，而是为了让测试能在确定的时间内跑完：
     * 走子动画与随后的电脑走棋是两条时间链（虚拟时钟 vs 真实线程），
     * 在 Robolectric 里让它们按真实时间对齐非常脆。测试里设成 0，
     * 「走一手 → 落子 → 轮到电脑」这条链就能同步推进完。
     *
     * 生产代码**不要改这两个值** —— 它们与 iOS 的 460/520 是同一个节奏，
     * 两端不一致会让「吃子提示」出现的时机跟着不同。
     */
    var slideMs: Long = SLIDE_MS
    var settleMs: Long = SETTLE_MS

    /** 引擎是单实例、内部状态可变；用互斥量保证「一次只跑一个搜索」。 */
    private val engineMutex = Mutex()

    // ---------- 破坏性操作的二次确认 ----------

    var pendingConfirm: ConfirmKind? by mutableStateOf(null)
        private set

    /** 「重开」：场上还有棋就先问一句。空盘重开等于什么都没发生，不打扰。 */
    fun requestRestart() {
        if (history.isEmpty()) load(scene, silent = true) else {
            pendingConfirm = ConfirmKind.Restart(history.size, scene.title)
        }
    }

    /** 换场景（场景菜单与训练页都走它）：和「重开」一样会丢掉当前这盘棋。 */
    fun requestScene(target: XQScene) {
        if (history.isEmpty()) load(target, silent = true) else {
            pendingConfirm = ConfirmKind.SwitchScene(target, history.size)
        }
    }

    /** 载入存档（战绩页的「载入」）：同样会丢掉当前这盘棋。 */
    fun requestLoadGame(record: GameRecord) {
        if (history.isEmpty()) loadGame(record) else {
            pendingConfirm = ConfirmKind.LoadGame(record, history.size)
        }
    }

    fun confirmPending() {
        val kind = pendingConfirm ?: return
        pendingConfirm = null
        when (kind) {
            is ConfirmKind.Restart -> load(scene, silent = true)
            is ConfirmKind.SwitchScene -> load(kind.scene, silent = true)
            is ConfirmKind.LoadGame -> loadGame(kind.record)
        }
    }

    fun dismissPending() {
        pendingConfirm = null
    }

    // ---------- 棋盘与流程 ----------

    var board: ByteArray by mutableStateOf(Rules.parse(Rules.START_FEN))
        private set
    var turn: Side by mutableStateOf(Side.RED)
        private set
    var selected: Int by mutableStateOf(-1)
        private set
    var targets: List<Move> by mutableStateOf(emptyList())
        private set
    var lastMove: Move? by mutableStateOf(null)
        private set
    var hintMove: Move? by mutableStateOf(null)
        private set
    var checkSide: Side? by mutableStateOf(null)
        private set
    var gameOver: Boolean by mutableStateOf(false)
        private set
    var thinking: Boolean by mutableStateOf(false)
        private set

    // 动画
    var animating: Boolean by mutableStateOf(false)
        private set
    var animFrom: Int by mutableStateOf(0)
        private set
    var animTo: Int by mutableStateOf(0)
        private set
    var animPiece: Byte by mutableStateOf(0)
        private set
    var animProgress: Float by mutableStateOf(1f)
        private set
    var animCaptured: Byte by mutableStateOf(0)
        private set

    // 展示
    var redScore: Int by mutableStateOf(0)
        private set

    /**
     * 以「判和 / 长将判负」结束时，评估条不能再写「已成杀」——
     * 长将判负不是将死，棋盘上根本没有杀棋。这里存一句更准确的措辞。
     */
    var evalOverride: String? by mutableStateOf(null)
        private set
    var statusText: String by mutableStateOf("轮到你走（红方）")
        private set
    var statusWarn: Boolean by mutableStateOf(false)
        private set
    var toast: String? by mutableStateOf(null)
        private set
    var toastKind: String by mutableStateOf("")
        private set
    var engineInfo: String by mutableStateOf("本地引擎就绪")
        private set

    // 场景与存档
    var scene: XQScene by mutableStateOf(XQScene.standard())
        private set
    var history: List<HistoryItem> by mutableStateOf(emptyList())
        private set
    var moveMarks: Map<Int, String> by mutableStateOf(emptyMap())
        private set
    var levelKey: String by mutableStateOf("hard")
        private set
    var modeKey: String by mutableStateOf("engine")
        private set

    // 打谱演示
    var demoMode: Boolean by mutableStateOf(false)
        private set
    var demoTotal: Int by mutableStateOf(0)
        private set
    var demoDone: Int by mutableStateOf(0)
        private set
    var demoPlaying: Boolean by mutableStateOf(false)
        private set
    var demoNote: String by mutableStateOf("")
        private set
    private var demoMoves: List<Move> = emptyList()
    private var demoTicker: Job? = null

    val canDemo: Boolean get() = scene.canDemo

    private var record: GameRecord? = null
    private var pendingAnalysis: Triple<ByteArray, Move, Int>? = null
    private var collectedEvals: MutableList<MoveEval> = ArrayList()
    private var collectedFlags = GameFlags()

    init {
        store.load()
        load(XQScene.standard(), silent = true)
    }

    // ---------- 场景 ----------

    fun load(newScene: XQScene, silent: Boolean = false) {
        scene = newScene
        val (resolvedBoard, resolvedMoves) = SceneCatalog.resolve(newScene)
        board = resolvedBoard.copyOf()
        turn = Side.RED
        history = emptyList()
        moveMarks = emptyMap()
        lastMove = null
        hintMove = null
        selected = -1
        targets = emptyList()
        gameOver = false
        thinking = false
        animating = false
        animProgress = 1f
        animCaptured = 0
        pendingAnalysis = null
        collectedEvals = ArrayList()
        collectedFlags = GameFlags()
        // 换场景就退出演示，避免上一局的演示序列串到新局面上
        demoTicker?.cancel()
        demoTicker = null
        demoPlaying = false
        demoMode = false
        demoTotal = 0
        demoDone = 0
        demoNote = ""

        val fen = Rules.parse(newScene.startFen)
        val items = ArrayList<HistoryItem>(resolvedMoves.size)
        var side = Side.RED
        for (m in resolvedMoves) {
            val label = Notation.label(fen, m)
            val cap = Rules.makeMove(fen, m)
            items.add(HistoryItem(m, cap, label, side))
            lastMove = m
            side = side.other
        }
        history = items
        turn = side

        if (newScene.kind == SceneKind.MATE || newScene.kind == SceneKind.STUDY) {
            store.markAttempt(newScene.id)
        }

        record = GameRecord(
            id = java.util.UUID.randomUUID().toString(),
            savedAt = java.time.Instant.now().toString(),
            sceneId = newScene.id,
            sceneName = newScene.title,
            level = levelKey,
            mode = modeKey,
            startFEN = newScene.startFen,
            moves = history.flatMap { listOf(it.move.from, it.move.to) },
            evals = emptyList(),
            flags = GameFlags(),
            result = "unfinished",
            finished = false,
            ply = history.size,
        )

        syncHash()
        updateCheckState()
        updateEval()
        statusText = "轮到你走（红方）—— ${newScene.title}"
        statusWarn = false
        if (!silent) {
            showToast(if (newScene.kind == SceneKind.GAME) "开始对局" else newScene.title, "")
        }
    }

    fun setLevel(key: String) {
        levelKey = key
    }

    fun setMode(key: String) {
        modeKey = key
    }

    // ---------- 走子 ----------

    fun tap(square: Int) {
        // 演示进行中不接受落子，免得和自动走子打架
        if (gameOver || thinking || animating || demoMode || turn != Side.RED) return
        if (selected >= 0) {
            val m = targets.firstOrNull { it.to == square }
            if (m != null) {
                play(m, track = true)
                return
            }
        }
        if (board[square].toInt() != 0 && Piece.isRed(board[square].toInt())) {
            selected = square
            hintMove = null
            targets = Rules.legalMoves(board, Side.RED).filter { it.from == square }
        } else {
            selected = -1
            targets = emptyList()
        }
    }

    fun play(m: Move, track: Boolean) {
        val cap = board[m.to]
        val label = Notation.label(board, m)
        val mover = turn
        val pre = if (track) board.copyOf() else null
        val ply = history.size + 1

        Rules.makeMove(board, m)
        board = board.copyOf() // 触发重组：ByteArray 是引用，必须换一份
        history = history + HistoryItem(m, cap, label, mover)
        lastMove = m
        selected = -1
        targets = emptyList()
        hintMove = null
        turn = turn.other

        if (pre != null) pendingAnalysis = Triple(pre, m, ply)

        syncHash()
        updateCheckState()

        // 落子瞬间先报吃子
        if (cap.toInt() != 0) {
            showToast("吃 ${Piece.side(cap.toInt()).shortLabel}${Piece.name(cap.toInt())}", "capture", 1.1)
        }

        animateMove(m, cap)
    }

    private fun animateMove(m: Move, captured: Byte) {
        animFrom = m.from
        animTo = m.to
        animPiece = board[m.to]
        animCaptured = captured
        animProgress = 0f
        animating = true

        viewModelScope.launch {
            val start = System.nanoTime()
            while (true) {
                val elapsed = (System.nanoTime() - start) / 1_000_000.0
                if (elapsed >= slideMs) break
                animProgress = if (slideMs > 0) (elapsed / slideMs).toFloat() else 1f
                delay(16)
            }
            animProgress = 1f

            // 滑到位之后再报将军/将死，节奏更像真人下棋
            delay(ANNOUNCE_DELAY_MS)
            announceCheck()

            delay(settleMs)
            animating = false
            animCaptured = 0
            onMoveSettled()
        }
    }

    private fun announceCheck() {
        if (gameOver) return
        val opponent = turn
        if (!Rules.inCheck(board, opponent)) return
        if (!Rules.hasLegalMove(board, opponent)) {
            showToast("${opponent.label}被将死", "mate", 2.2)
        } else {
            showToast("将 军！", "check", 1.3)
        }
    }

    private fun onMoveSettled() {
        // 打谱演示：走完一手就把节奏交回给播放器 —— 不做逐手分析，也不叫电脑走棋
        if (demoMode) {
            if (scheduleDemoNextIfNeeded()) return
            statusText = "打谱演示 $demoDone/$demoTotal" + if (demoNote.isEmpty()) "" else "　$demoNote"
            statusWarn = false
            return
        }
        if (!Rules.hasLegalMove(board, turn)) {
            finish(turn)
            return
        }
        // 判和排在将死/困毙之后：无子可动本身就是终局，不能被当成和棋。
        // 长将判负也在这里出结果 —— 否则双方会一直循环下去。
        val verdict = Rules.adjudicate(scene.startFen, history.map { it.move })
        if (verdict != null) {
            finishAdjudicated(verdict)
            return
        }
        updateEval()
        scheduleAnalysis()
        if (turn == Side.BLACK) {
            aiTurn()
        } else {
            statusText = "轮到你走（红方）"
            statusWarn = false
        }
    }

    private fun finish(loser: Side) {
        gameOver = true
        evalOverride = null // 避免留着上一次「判和 / 长将」的措辞
        val checked = Rules.inCheck(board, loser)
        val winner = if (loser == Side.RED) "黑方" else "红方"
        redScore = if (loser == Side.RED) -Engine.MATE else Engine.MATE
        updateCheckState()

        statusText = "${loser.label}" + (if (checked) "被将死" else "被困毙（无子可动同样判负）") + "，${winner}获胜。"
        statusWarn = true
        showToast(if (checked) "将 死" else "困 毙", "mate", 2.6)

        record?.let { r ->
            val updated = r.copy(
                result = if (loser == Side.BLACK) "win" else "loss",
                finished = true,
                evals = collectedEvals.toList(),
                flags = collectedFlags,
                ply = history.size,
                moves = history.flatMap { listOf(it.move.from, it.move.to) },
            )
            record = updated
            store.save(updated)
            if (loser == Side.BLACK) store.markSolved(scene.id)
        }
    }

    /**
     * 判和 / 长将判负。和 [finish] 分开写：
     * 和棋不该弹「将死」那种大字，也不该记成胜场。
     */
    private fun finishAdjudicated(verdict: Adjudication) {
        gameOver = true
        val winner = verdict.winner
        val isDraw = winner == null
        redScore = if (isDraw) 0 else if (winner == Side.RED) Engine.MATE else -Engine.MATE
        // 评估条上写「已成杀」是不对的（长将判负没有杀棋），单独给一句准确的
        evalOverride = if (isDraw) "和棋" else (if (winner == Side.RED) "红方" else "黑方") + "胜"
        updateCheckState()

        val head: String = if (winner == null) "和棋" else "${winner.label}获胜"
        statusText = "$head　${verdict.reason}。"
        statusWarn = true
        showToast(if (isDraw) "和 棋" else head, if (isDraw) "draw" else "mate", 2.6)

        record?.let { r ->
            val updated = r.copy(
                result = if (winner == Side.BLACK) "win" else if (isDraw) "draw" else "loss",
                finished = true,
                evals = collectedEvals.toList(),
                flags = collectedFlags,
                ply = history.size,
                moves = history.flatMap { listOf(it.move.from, it.move.to) },
            )
            record = updated
            store.save(updated)
            if (winner == Side.BLACK) store.markSolved(scene.id)
        }
    }

    // ---------- 逐手质量分析 ----------

    private fun scheduleAnalysis() {
        val job = pendingAnalysis ?: return
        pendingAnalysis = null
        val (preBoard, move, ply) = job
        val phase = Ability.phase(preBoard, ply)
        viewModelScope.launch(Dispatchers.Default) {
            val eval = analyze(preBoard, move) ?: return@launch
            withContext(Dispatchers.Main) {
                val e = eval.copy(ply = ply, phase = phase)
                collectedEvals.add(e)
                when (e.grade) {
                    "blunder" -> {
                        collectedFlags = collectedFlags.copy(blunders = collectedFlags.blunders + 1)
                        moveMarks = moveMarks + (ply to "??")
                    }
                    "mistake" -> {
                        collectedFlags = collectedFlags.copy(mistakes = collectedFlags.mistakes + 1)
                        moveMarks = moveMarks + (ply to "?")
                    }
                    "inaccuracy" -> {
                        collectedFlags = collectedFlags.copy(inaccuracies = collectedFlags.inaccuracies + 1)
                    }
                }
                // 本来有杀棋却没走出来 —— 这正是「攻杀把握」维度要扣分的行为。
                if (e.missedMate == true) {
                    collectedFlags = collectedFlags.copy(missedMate = collectedFlags.missedMate + 1)
                }
                persistRecord()
            }
        }
    }

    /**
     * 评估一手棋的失分。必须在落子**之前**调用（要的是走这手之前的局面）。
     *
     * 两次浅搜索：第一次问「最好能走成什么样」，第二次问「实际走成什么样」。
     * 分差即失分。与 iOS `Archive.analyze` 同一套口径。
     */
    private suspend fun analyze(before: ByteArray, move: Move, depth: Int = 4, budgetMs: Int = 450): MoveEval? {
        val history = searchHistory()
        return engineMutex.withLock {
            engine.resetForTesting()
            val best = engine.search(before, Side.RED, maxDepth = depth, timeMs = budgetMs, history = history)
            val after = before.copyOf()
            Rules.makeMove(after, move)
            val reply = engine.search(after, Side.BLACK, maxDepth = depth, timeMs = budgetMs, history = null)
            val actual = -reply.score
            var loss = maxOf(0, best.score - actual)
            if (best.score > Engine.MATE - 1000) loss = 0

            val missedMate = (best.score > Engine.MATE - 1000) && (actual <= Engine.MATE - 1000)
            MoveEval(
                ply = 0,
                redScore = actual,
                loss = loss,
                grade = Ability.grade(loss),
                bestLabel = best.move?.let { Notation.label(before, it) } ?: "",
                phase = "mid",
                missedMate = missedMate,
                playedLabel = Notation.label(before, move),
            )
        }
    }

    private fun persistRecord() {
        val r = record ?: return
        val updated = r.copy(
            evals = collectedEvals.toList(),
            flags = collectedFlags,
            ply = history.size,
            moves = history.flatMap { listOf(it.move.from, it.move.to) },
        )
        record = updated
        // 进行中的对局也存一份，避免中途退出丢进度
        if (!updated.finished && updated.ply > 0) store.save(updated)
    }

    // ---------- 电脑走棋 ----------

    /**
     * 交给搜索的着法历史：引擎靠它才知道哪些局面「已经出现过」（走回去按和棋算）。
     * 没有它，引擎在优势时会把绕圈当成正分继续走 —— 一盘赢棋被自己走成和棋。
     * `startFen` 必须一起给：残局 / 杀法 / 名局不是从标准开局摆起来的，
     * 少了它历史会被按标准开局重放，判出来的「重复」全是假的。
     */
    private fun searchHistory(): Engine.SearchHistory? =
        if (history.isEmpty()) null
        else Engine.SearchHistory(scene.startFen, history.map { it.move }, Side.RED)

    private fun aiTurn() {
        thinking = true
        statusText = "电脑计算中…"
        statusWarn = false

        val level = SearchLevel.named(levelKey)
        val snapshot = board.copyOf()
        val hist = searchHistory()
        viewModelScope.launch(Dispatchers.Default) {
            val res = engineMutex.withLock { engine.pickMove(snapshot, Side.BLACK, level, hist) }
            withContext(Dispatchers.Main) {
                thinking = false
                engineInfo = "本地引擎 ${res.depth} 层"
                val m = res.move
                if (m != null) play(m, track = false) else onMoveSettled()
            }
        }
    }

    // ---------- 提示 ----------

    /** @param onCandidates 回调也给了界面（AI 点评要拿候选着法）。 */
    fun requestHint(onCandidates: (List<CandidateMove>) -> Unit = {}) {
        if (thinking || animating || gameOver || turn != Side.RED) return
        thinking = true
        statusText = "正在计算…"
        val snapshot = board.copyOf()
        val hist = searchHistory()
        viewModelScope.launch(Dispatchers.Default) {
            val cands = engineMutex.withLock {
                engine.topMoves(snapshot, Side.RED, count = 4, maxDepth = 5, timeMs = 2200, history = hist)
            }
            withContext(Dispatchers.Main) {
                thinking = false
                val best = cands.firstOrNull()
                if (best == null) {
                    statusText = "没有可走的着法。"
                    return@withContext
                }
                hintMove = best.move

                val probe = board.copyOf()
                val cap = Rules.makeMove(probe, best.move)
                val mated = !Rules.hasLegalMove(probe, Side.BLACK)
                Rules.undoMove(probe, best.move, cap)

                statusText = "推荐 ${best.label}" + (if (mated) "（一步将死）" else "") +
                    "　" + Engine.scoreText(best.score)
                statusWarn = false
                onCandidates(cands)
            }
        }
    }

    fun clearHint() {
        hintMove = null
    }

    // ---------- 打谱演示 ----------

    /** 进入打谱演示：先把局面复位，再把整段棋谱解析成着法序列。 */
    fun startDemo() {
        if (!scene.canDemo || thinking) return
        demoTicker?.cancel()
        demoPlaying = false

        load(scene, silent = true)

        val b = Rules.parse(scene.startFen)
        var side = Side.RED
        val moves = ArrayList<Move>()
        for (label in scene.demoLine) {
            val m = Notation.findMove(b, side, label) ?: break
            moves.add(m)
            Rules.makeMove(b, m)
            side = side.other
        }
        if (moves.isEmpty()) {
            showToast("这段棋谱解析不出着法", "")
            return
        }

        demoMoves = moves
        demoTotal = moves.size
        demoDone = 0
        demoMode = true
        demoNote = ""
        statusText = "打谱演示：${scene.title}　共 $demoTotal 手，点「播放」开始"
        statusWarn = false
    }

    /** 演示时走下一手。 */
    fun demoStep() {
        if (!demoMode || demoDone >= demoTotal) {
            demoPlaying = false
            return
        }
        val m = demoMoves[demoDone]
        demoDone += 1
        demoNote = scene.demoNotes[demoDone] ?: ""
        play(m, track = false)
    }

    fun demoToggle() {
        if (!demoMode) {
            startDemo()
            return
        }
        if (demoPlaying) {
            demoPlaying = false
            return
        }
        if (demoDone >= demoTotal) { // 放完了再按就从头再演一遍
            demoDone = 0
            load(scene, silent = true)
            demoMode = true
            demoNote = ""
        }
        demoPlaying = true
        statusText = "打谱演示中…"
        demoStep()
    }

    fun exitDemo() {
        demoTicker?.cancel()
        demoTicker = null
        demoPlaying = false
        demoMode = false
        demoTotal = 0
        demoDone = 0
        demoNote = ""
        load(scene, silent = true)
        showToast("已退出演示", "")
    }

    /** 演示播放的节奏：等这一手的动画停下来，再走下一手。 */
    private fun scheduleDemoNextIfNeeded(): Boolean {
        if (!demoMode || !demoPlaying) return false
        if (demoDone >= demoTotal) {
            demoPlaying = false
            statusText = "演示结束（共 $demoTotal 手）"
            statusWarn = false
            return true
        }
        demoTicker = viewModelScope.launch {
            delay(620)
            if (!demoPlaying || !demoMode) return@launch
            statusText = "打谱演示 $demoDone/$demoTotal　$demoNote"
            demoStep()
        }
        return true
    }

    // ---------- 棋谱导入导出 ----------

    val exportFen: String get() = Rules.fen(board)

    val exportMoveText: String
        get() = if (history.isEmpty()) "" else Notation.movesToText(scene.startFen, history.map { it.move })

    /** 一段可以直接发出去的完整文本：局面、棋谱、坐标三种形式都在里面。 */
    val exportShareText: String
        get() {
            val out = ArrayList<String>()
            out.add("象棋教练 · ${scene.title}")
            val first = scene.note.split("\n").firstOrNull() ?: ""
            if (first.isNotEmpty()) out.add(first)
            out.add("")
            out.add("【初始局面】")
            out.add(scene.startFen)
            val moveText = exportMoveText
            if (moveText.isNotEmpty()) {
                out.add("")
                out.add("【棋谱】")
                out.add(moveText)
                out.add("")
                out.add("【着法坐标】")
                out.add(history.flatMap { listOf(it.move.from, it.move.to) }.joinToString(","))
            }
            out.add("")
            out.add("【当前局面】")
            out.add(exportFen)
            return out.joinToString("\n")
        }

    /** 导入局面或棋谱。返回 null 表示成功，否则返回给用户看的说明。 */
    fun importText(raw: String): String? {
        val text = raw.trim()
        if (text.isEmpty()) return "没有内容可导入。"

        // ① 局面串
        for (token in text.split(' ', '\n', '\t', '，', ',', '、', ';', '；')) {
            val t = token.trim('：', ':', '。', '(', ')', '（', '）')
            val fen = validatedFen(t)
            if (fen != null) {
                load(XQScene.custom("导入的局面", fen, "这是导入进来的局面。点「重开」可以回到这里。"), silent = true)
                showToast("已导入局面", "")
                return null
            }
        }

        // ② 中文棋谱
        val labels = text.split(' ', '\n', '\t').filter { s -> s.any { it in "平进退" } }
        if (labels.isNotEmpty()) return applyImportedMoveText(labels)

        // ③ 着法坐标串
        val nums = Regex("\\d+").findAll(text).map { it.value.toInt() }.toList()
        if (nums.size >= 2 && nums.size % 2 == 0 && nums.all { it in 0..89 }) {
            return applyImportedCoords(nums)
        }

        return "没认出可导入的内容。\n\n可以粘贴：\n· FEN 局面串\n· 中文棋谱，如「炮二平五 马8进7」\n· 着法坐标，如「67,40,19,46」"
    }

    private fun applyImportedMoveText(labels: List<String>): String? {
        val b = Rules.parse(Rules.START_FEN)
        var side = Side.RED
        val applied = ArrayList<Move>()
        var rejected: String? = null
        for (token in labels) {
            val m = Notation.findMove(b, side, token)
            if (m == null) {
                rejected = token
                break
            }
            applied.add(m)
            Rules.makeMove(b, m)
            side = side.other
        }
        if (applied.isEmpty()) return "第一手「${rejected ?: labels[0]}」从标准开局走不通。"
        val note = if (rejected == null) "从标准开局起，已按棋谱走完 ${applied.size} 手。"
        else "已走 ${applied.size} 手；「$rejected」之后的着法没认出来，停在合法处。"
        installImported("导入的棋谱", applied, note)
        showToast("已导入棋谱（${applied.size} 手）", "")
        return null
    }

    private fun applyImportedCoords(nums: List<Int>): String? {
        val b = Rules.parse(Rules.START_FEN)
        var side = Side.RED
        val applied = ArrayList<Move>()
        var i = 0
        while (i + 1 < nums.size) {
            val m = Move(nums[i], nums[i + 1])
            if (Rules.legalMoves(b, side).none { it == m }) {
                if (applied.isEmpty()) return "第一手「${nums[i]}→${nums[i + 1]}」在当前局面不合法。"
                break
            }
            applied.add(m)
            Rules.makeMove(b, m)
            side = side.other
            i += 2
        }
        if (applied.isEmpty()) return "没能识别出任何合法着法。"
        installImported("导入的棋谱", applied, "按坐标导入，共 ${applied.size} 手。")
        showToast("已导入棋谱（${applied.size} 手）", "")
        return null
    }

    private fun installImported(title: String, moves: List<Move>, note: String) {
        scene = XQScene.custom(title, Rules.START_FEN, note)
        board = Rules.parse(Rules.START_FEN)
        history = emptyList()
        moveMarks = emptyMap()
        collectedEvals = ArrayList()
        collectedFlags = GameFlags()
        turn = Side.RED
        selected = -1
        targets = emptyList()
        hintMove = null
        lastMove = null
        gameOver = false
        thinking = false
        animating = false
        animProgress = 1f
        pendingAnalysis = null
        demoMode = false

        val items = ArrayList<HistoryItem>()
        var side = Side.RED
        for (m in moves) {
            val label = Notation.label(board, m)
            val cap = Rules.makeMove(board, m)
            items.add(HistoryItem(m, cap, label, side))
            lastMove = m
            side = side.other
        }
        board = board.copyOf()
        history = items
        turn = side

        record = GameRecord(
            id = java.util.UUID.randomUUID().toString(),
            savedAt = java.time.Instant.now().toString(),
            sceneId = scene.id,
            sceneName = scene.title,
            level = levelKey,
            mode = modeKey,
            startFEN = scene.startFen,
            moves = history.flatMap { listOf(it.move.from, it.move.to) },
            evals = emptyList(),
            flags = GameFlags(),
            result = "unfinished",
            finished = false,
            ply = history.size,
        )
        syncHash()
        updateCheckState()
        updateEval()
        statusText = note
        statusWarn = false
    }

    /** 校验并规范化一个局面串。返回 null 表示这不是一个可用的局面。 */
    fun validatedFen(s: String): String? = validatedFEN(s)

    // ---------- 悔棋 ----------

    fun undo() {
        if (thinking || animating || history.isEmpty()) return
        val b = board.copyOf()
        val items = history.toMutableList()
        var t = turn

        // 退回到自己该走的状态
        while (items.isNotEmpty() && t != Side.RED) {
            val h = items.removeAt(items.size - 1)
            Rules.undoMove(b, h.move, h.captured)
            t = t.other
        }
        if (items.size >= 2) {
            val h1 = items.removeAt(items.size - 1)
            Rules.undoMove(b, h1.move, h1.captured); t = t.other
            val h2 = items.removeAt(items.size - 1)
            Rules.undoMove(b, h2.move, h2.captured); t = t.other
            if (t != Side.RED && items.isNotEmpty()) {
                val h3 = items.removeAt(items.size - 1)
                Rules.undoMove(b, h3.move, h3.captured); t = t.other
            }
        }
        board = b
        history = items
        turn = t
        selected = -1
        targets = emptyList()
        hintMove = null
        gameOver = false
        evalOverride = null
        pendingAnalysis = null
        lastMove = items.lastOrNull()?.move
        collectedEvals = collectedEvals.filter { it.ply <= items.size }.toMutableList()
        moveMarks = moveMarks.filterKeys { it <= items.size }

        record?.let { r ->
            record = r.copy(
                finished = false,
                result = "unfinished",
                ply = items.size,
                moves = items.flatMap { listOf(it.move.from, it.move.to) },
                evals = collectedEvals.toList(),
                flags = collectedFlags,
            )
        }
        syncHash()
        updateCheckState()
        updateEval()
        statusText = "已悔棋，轮到你走（红方）"
        statusWarn = false
    }

    // ---------- 辅助 ----------

    private fun syncHash() {
        engine.syncHash(board, turn)
    }

    private fun updateCheckState() {
        checkSide = if (!gameOver && Rules.inCheck(board, turn)) turn else null
    }

    private fun updateEval() {
        if (gameOver) return
        val snapshot = board.copyOf()
        val side = turn
        val hist = searchHistory()
        /* 评估条要跟着每一手实时刷新，所以用浅搜索（depth 3）。
           但**杀法题必须更深**：从公开题库导入的题最深到六手，depth 3 一次都看不到杀棋，
           评估条会显示「黑方明显占优」—— 而红方其实有必杀，这会把学生直接带偏。
           组成局面子力少、加深很便宜，所以按场景区分。 */
        val depth = if (scene.kind == SceneKind.MATE) 6 else 3
        viewModelScope.launch(Dispatchers.Default) {
            val r = engineMutex.withLock {
                engine.search(snapshot, side, maxDepth = depth, timeMs = 500, history = hist)
            }
            withContext(Dispatchers.Main) {
                redScore = if (side == Side.RED) r.score else -r.score
            }
        }
    }

    private fun showToast(text: String, kind: String, duration: Double = 1.6) {
        toast = text
        toastKind = kind
        viewModelScope.launch {
            delay((duration * 1000).toLong())
            if (toast == text) toast = null
        }
    }

    fun showMessage(text: String, kind: String = "") = showToast(text, kind, 2.0)

    // ---------- 供界面展示 ----------

    val boardFen: String get() = Rules.fen(board)

    val currentRecord: GameRecord? get() = record

    fun saveCurrentGame() {
        val r = record ?: return
        if (history.isEmpty()) return
        val updated = r.copy(
            savedAt = java.time.Instant.now().toString(),
            evals = collectedEvals.toList(),
            flags = collectedFlags,
            ply = history.size,
            moves = history.flatMap { listOf(it.move.from, it.move.to) },
        )
        record = updated
        store.save(updated)
        showMessage("已存入战绩")
    }

    fun loadGame(g: GameRecord) {
        scene = XQScene(
            id = g.sceneId, kind = SceneKind.GAME, title = g.sceneName,
            startFen = g.startFEN, note = "",
        )
        board = Rules.parse(g.startFEN)
        history = emptyList()
        moveMarks = emptyMap()
        collectedEvals = g.evals.toMutableList()
        collectedFlags = g.flags
        moveMarks = g.evals.filter { it.grade == "mistake" || it.grade == "blunder" }
            .associate { it.ply to (if (it.grade == "blunder") "??" else "?") }
        turn = Side.RED
        selected = -1
        targets = emptyList()
        hintMove = null
        gameOver = false
        thinking = false
        animating = false
        animProgress = 1f
        pendingAnalysis = null
        demoMode = false

        val items = ArrayList<HistoryItem>()
        var side = Side.RED
        for (m in g.movePairs) {
            val label = Notation.label(board, m)
            val cap = Rules.makeMove(board, m)
            items.add(HistoryItem(m, cap, label, side))
            lastMove = m
            side = side.other
        }
        board = board.copyOf()
        history = items
        turn = side
        record = g
        syncHash()
        updateCheckState()
        updateEval()
        statusText = "已载入「${g.sceneName}」，轮到你走（红方）"
        statusWarn = false
        showToast("已载入存档", "")
    }

    /** 复盘摘要（不需要 API Key，纯本地）。 */
    fun reviewDigest(): ReviewDigest? = currentRecord?.let { ReviewDigest.build(it) }

    /** 让退出对局时把进度存下来（对应 iOS 的 `persistRecord`）。 */
    fun persistOnExit() {
        if (!gameOver) persistRecord()
    }

    override fun onCleared() {
        super.onCleared()
        demoTicker?.cancel()
    }
}

/** 校验并规范化一个局面串（把 iOS 的 `GameState.validatedFEN` 搬成顶层函数，便于测试）。 */
fun validatedFEN(s: String): String? {
    val rows = s.split('/')
    if (rows.size != 10) return null
    val b = ByteArray(Rules.SQUARES)
    for ((r, row) in rows.withIndex()) {
        if (row.length != 9) return null
        for ((c, ch) in row.withIndex()) {
            if (ch == '.') continue
            val p = Piece.fromChar[ch] ?: return null
            b[r * 9 + c] = p
        }
    }
    // 必须恰好一个帅、一个将，且都在九宫之内 —— 否则引擎会算出离谱的结果
    var redKings = 0
    var blackKings = 0
    for (i in 0 until Rules.SQUARES) {
        if (b[i] == Piece.code(Piece.TYPE_KING, Side.RED)) redKings++
        if (b[i] == Piece.code(Piece.TYPE_KING, Side.BLACK)) blackKings++
    }
    if (redKings != 1 || blackKings != 1) return null
    val kr = Rules.kingIndex(b, Side.RED)
    val kb = Rules.kingIndex(b, Side.BLACK)
    if (kr < 0 || kb < 0) return null
    if (kr / 9 !in 7..9 || kr % 9 !in 3..5) return null
    if (kb / 9 !in 0..2 || kb % 9 !in 3..5) return null
    if (Rules.kingsFacing(b)) return null
    return Rules.fen(b)
}
