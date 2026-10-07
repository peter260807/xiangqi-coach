/* uci-kotlin —— 把 `android/engine` 那个 Kotlin 引擎包成标准 UCI 子进程。
 *
 * 它存在的理由和 `tools/uci`（Swift 版）一模一样：App 里的引擎除了 App 自己没谁能驱动，
 * 而「改了搜索到底有没有变强」只能靠真下棋来量。有了这个前端，
 * 仓库现成的对局台（`tools/match.js`）与档位对局台（`tools/level-match/`）
 * **一行不改**就能把 Kotlin 引擎当选手测 —— 包括和 Swift 引擎直接对下量 Elo。
 *
 * 用法（由 `android/tools/uci/run.sh` 编译并生成启动脚本）：
 *   ./gradlew :uci-kotlin:installDist
 *   node tools/match.js --a uci:android/tools/uci/build/xq-uci-kotlin \
 *                       --b uci:tools/uci/build/xq-uci --ms 300 --games 40
 *
 * 协议范围与 Swift 版**逐条对齐**（差一条就会让对局台读出不一样的数）：
 *   uci / isready / ucinewgame / setoption(收下不用) / position / go / quit
 *   go 支持 depth、movetime、multipv；wtime/btime/movestogo 按剩余时间折算成 movetime
 *   另有非标准的 perft <深度>，用来和 Swift / JS 两份规则实现逐节点对数
 *
 * 一个已知限制（与 Swift 版相同）：go 是**阻塞**执行的，所以 go 期间发来的 stop
 * 处理不了。对局台只会用 depth / movetime 两种模式，不会用到 stop。
 */
package com.peter260807.xiangqicoach.uci

import com.peter260807.xiangqicoach.engine.Engine
import com.peter260807.xiangqicoach.engine.Move
import com.peter260807.xiangqicoach.engine.Notation
import com.peter260807.xiangqicoach.engine.Piece
import com.peter260807.xiangqicoach.engine.Rules
import com.peter260807.xiangqicoach.engine.Side
import java.io.PrintStream

/**
 * 输出。
 *
 * ⚠️ UCI 是「你问一句我答一句」的交互协议，**输出必须立刻冲出去**。
 * JVM 的 `System.out` 在接管道时默认是块缓冲的，缓冲住就等于整个协议卡死
 * （对局框架会一直等 `readyok`，现象是「引擎起来了但没反应」）。
 * Swift 版踩的是 `print` 的同一个坑，那边改用 FileHandle 直写。
 * 这里：显式 UTF-8 + 每行 flush。
 */
private val out: PrintStream = PrintStream(System.out, false, "UTF-8")

private fun say(line: String) {
    out.print(line)
    out.print('\n')
    out.flush()
}

// ---------- 坐标 ----------

/**
 * UCI 习惯的 a0-i9：列 a-i 自观察者左到右，行 0-9 自**红方底线**往上。
 * 项目内部是 `r*9+c`（r=0 是黑方底线），所以 `rank = 9 - r`。
 * 这一套和 Pikafish 一致，所以对局台能同时驱动两边。
 */
private fun squareName(idx: Int): String {
    val col = idx % 9
    val rank = 9 - idx / 9
    return "${('a' + col)}$rank"
}

private fun squareIndex(token: String): Int? {
    if (token.length != 2) return null
    val f = token[0]
    if (f !in 'a'..'i') return null
    val rank = token[1] - '0'
    if (rank !in 0..9) return null
    val row = 9 - rank
    val col = f - 'a'
    if (!Rules.inBoard(row, col)) return null
    return row * 9 + col
}

private fun moveName(m: Move): String = squareName(m.from) + squareName(m.to)

// ---------- 局面解析 ----------

/**
 * 容错解析 FEN：既吃项目自己的写法（`rnbakabnr/...` 用 `.` 填空），
 * 也吃标准写法（用数字表示连续空格、后面可跟 `w`/`b` 表示该谁走）。
 * 目标是「对局台喂什么都能收下」，而不是严格校验。
 */
private fun parseFen(text: String): Pair<ByteArray, Side>? {
    val fields = text.split(' ').filter { it.isNotEmpty() }
    if (fields.isEmpty()) return null
    val boardField = fields[0]
    val board = ByteArray(Rules.SQUARES)
    val rows = boardField.split('/')
    if (rows.size != 10) return null

    for ((r, rowText) in rows.withIndex()) {
        var c = 0
        for (ch in rowText) {
            if (ch.isDigit()) {
                c += ch - '0'
                continue
            }
            if (c >= 9) return null
            if (ch != '.') board[r * 9 + c] = Piece.fromChar[ch] ?: 0
            c++
        }
        if (c != 9) return null
    }

    // 第二个字段是走子方：标准 FEN 用 w/b（w = 红），也允许 r
    var side = Side.RED
    if (fields.size > 1) {
        when (fields[1].lowercase()) {
            "b", "black" -> side = Side.BLACK
            else -> side = Side.RED
        }
    }
    return board to side
}

// ---------- 对局状态 ----------

/** 棋盘 + 该谁走 + 走到这里的历史。 */
private class Session {
    var board: ByteArray = Rules.parse(Rules.START_FEN)
    var side: Side = Side.RED
    var moves: MutableList<Move> = ArrayList()

    /**
     * 这一局的起始局面。`position fen` 会改它 —— 搜索里的重复判定要靠它重建历史，
     * 少了它，历史会被按标准开局重放，判出来的「重复」全是假的。
     */
    var startFen: String = Rules.START_FEN
    var startSide: Side = Side.RED

    fun resetToStart() {
        board = Rules.parse(Rules.START_FEN)
        side = Side.RED
        startFen = Rules.START_FEN
        startSide = Side.RED
        moves = ArrayList()
    }

    /** 走到当前局面为止的历史，交给搜索做重复判定用。 */
    val searchHistory: Engine.SearchHistory?
        get() = if (moves.isEmpty()) null
        else Engine.SearchHistory(startFen, moves.toList(), startSide)

    /**
     * 查找并执行一手 UCI 着法。只接受**真合法**着法 —— 宁可报错也不要
     * 走出非法棋把对局台弄脏（对局台那边也会独立复验一次，两道关）。
     */
    fun play(uci: String): Boolean {
        if (uci.length != 4) return false
        val from = squareIndex(uci.substring(0, 2)) ?: return false
        val to = squareIndex(uci.substring(2, 4)) ?: return false
        val target = Move(from, to)
        val legal = Rules.legalMoves(board, side)
        if (legal.none { it == target }) return false
        Rules.makeMove(board, target)
        moves.add(target)
        side = side.other
        return true
    }

    /** `position startpos [moves ...]` / `position fen <fen...> [moves ...]` */
    fun setPosition(tokens: List<String>) {
        var i = 0
        if (i < tokens.size && tokens[i] == "startpos") {
            resetToStart()
            i++
        } else if (i < tokens.size && tokens[i] == "fen") {
            i++
            val fields = ArrayList<String>()
            while (i < tokens.size && tokens[i] != "moves") {
                fields.add(tokens[i]); i++
            }
            val parsed = parseFen(fields.joinToString(" "))
            if (parsed == null) {
                say("info string 无法解析的 FEN：${fields.joinToString(" ")}")
                return
            }
            board = parsed.first
            side = parsed.second
            startFen = fields[0] // 只取棋盘那一段（Rules.parse 只认棋盘串）
            startSide = parsed.second
            moves = ArrayList()
        } else {
            say("info string position 只支持 startpos / fen")
            return
        }

        if (i < tokens.size && tokens[i] == "moves") {
            i++
            while (i < tokens.size) {
                if (!play(tokens[i])) {
                    say("info string 非法着法，已忽略：${tokens[i]}（该 ${side.label} 走）")
                }
                i++
            }
        }
    }
}

// ---------- perft ----------

/** 规则层交叉验证的计数口径，与 Swift / JS 两份实现**逐节点对齐**。 */
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

// ---------- go 的限流参数 ----------

private class GoLimit {
    var depth = 64
    var movetime = 0
    /** 要几路候选。1 = 只要最佳着法（默认，与旧行为完全一致）。 */
    var multipv = 1
}

private fun parseGo(tokens: List<String>, side: Side): GoLimit {
    val limit = GoLimit()
    var wtime = 0
    var btime = 0
    var movestogo = 0
    var i = 0
    while (i < tokens.size) {
        val value = if (i + 1 < tokens.size) tokens[i + 1].toIntOrNull() else null
        when (tokens[i]) {
            "depth" -> { limit.depth = value ?: limit.depth; i += 2 }
            "movetime" -> { limit.movetime = value ?: 0; i += 2 }
            "multipv" -> { limit.multipv = maxOf(1, value ?: 1); i += 2 }
            "wtime" -> { wtime = value ?: 0; i += 2 }
            "btime" -> { btime = value ?: 0; i += 2 }
            "movestogo" -> { movestogo = value ?: 0; i += 2 }
            "infinite" -> { limit.depth = 64; limit.movetime = 0; i += 1 }
            // 收下但不实现，别把后面的字段吃掉
            "nodes", "winc", "binc", "mate", "searchmoves", "ponder" -> i += 2
            else -> i += 1
        }
    }
    if (limit.movetime == 0 && (wtime > 0 || btime > 0)) {
        val remain = if (side == Side.RED) wtime else btime
        val slices = if (movestogo > 0) movestogo else 30
        limit.movetime = maxOf(50, remain / maxOf(1, slices))
    }
    if (limit.movetime == 0 && limit.depth >= 64) limit.movetime = 1000
    return limit
}

// ---------- 主循环 ----------

fun main(args: Array<String>) {
    // 归因开关：与 Swift 版的 XQ_NO_LMR / XQ_NO_NULL 对应。
    // Android 上读不到环境变量，但**命令行程序**可以 —— 保留它，
    // 是为了让「同一个二进制、只差一个开关」的 A/B 能在对局台上原样复现。
    val engine = Engine(
        lmrEnabled = System.getenv("XQ_NO_LMR") == null,
        nullMoveEnabled = System.getenv("XQ_NO_NULL") == null,
        perpetualEnabled = System.getenv("XQ_NO_PERPETUAL") == null,
    )

    val session = Session()
    say("id name XiangqiCoach-Kotlin")
    say("id author XiangqiCoach")
    say("option name Hash type spin default 8 min 1 max 1024")

    val reader = System.`in`.bufferedReader()
    while (true) {
        val raw = reader.readLine() ?: break
        val line = raw.trim()
        if (line.isEmpty()) continue
        val tokens = line.split(' ').filter { it.isNotEmpty() }
        if (tokens.isEmpty()) continue

        when (tokens[0]) {
            "uci" -> say("uciok")

            "isready" -> say("readyok")

            "ucinewgame" -> {
                engine.resetForTesting()
                session.resetToStart()
            }

            "setoption" -> Unit // 收下就好，目前没有可配的选项

            "position" -> session.setPosition(tokens.drop(1))

            "go" -> {
                val limit = parseGo(tokens.drop(1), session.side)
                val t0 = System.nanoTime()
                // 每一手都从干净的置换表开始，A/B 才公平
                engine.resetForTesting()

                /* multipv = 1 时走原路径，**一字不改** —— 对局台全靠这条，
                   不能因为加功能引入任何行为差异。 */
                if (limit.multipv > 1) {
                    /* 逐个排除已选着法重搜，每一次都用**同一个固定深度**。
                       这里刻意不用 topMoves：它把时间预算按候选数切片，第 2、3 个候选
                       会搜得更浅，候选之间的分数就没法比 —— 而离线预计算要的正是
                       「同深度的前 N 个候选」。 */
                    val excluded = ArrayList<Move>()
                    val picked = ArrayList<Triple<Move, Int, Int>>()
                    // ⚠️ 这里必须是能 break 的循环。用 `repeat(n) { ... return@repeat }`
                    // 只能跳过当前这一轮、不能终止 —— 遇到「没有着法了」会白跑完剩下的轮次。
                    var k = 0
                    while (k < limit.multipv) {
                        k++
                        val r = engine.search(
                            session.board, session.side, limit.depth, limit.movetime,
                            excluded, session.searchHistory,
                        )
                        val mv = r.move ?: break
                        picked.add(Triple(mv, r.score, r.depth))
                        excluded.add(mv)
                        if (Math.abs(r.score) > Engine.MATE - 1000) break // 已是杀棋，再找没有意义
                    }
                    val spentMs = ((System.nanoTime() - t0) / 1_000_000).toInt()
                    val best = picked.firstOrNull()?.first
                    if (best == null) {
                        say("bestmove 0000")
                        continue
                    }
                    for ((k, p) in picked.withIndex()) {
                        say(
                            "info depth ${p.third} multipv ${k + 1} score cp ${p.second}"
                                + " nodes 0 time $spentMs pv ${moveName(p.first)}",
                        )
                    }
                    say("info string 中文记谱 ${Notation.label(session.board, best)}")
                    say("bestmove ${moveName(best)}")
                    continue
                }

                val result = engine.search(
                    session.board, session.side, limit.depth, limit.movetime,
                    emptyList(), session.searchHistory,
                )
                val spentMs = ((System.nanoTime() - t0) / 1_000_000).toInt()

                val best = result.move
                if (best == null) {
                    say("bestmove 0000") // 无子可动：对局台会先判终局，正常走不到这里
                    continue
                }
                val nps = if (spentMs > 0) result.nodes / spentMs else result.nodes
                say(
                    "info depth ${result.depth} score cp ${result.score} nodes ${result.nodes}"
                        + " time $spentMs nps $nps pv ${moveName(best)}",
                )
                say("info string 中文记谱 ${Notation.label(session.board, best)}")
                say("bestmove ${moveName(best)}")
            }

            "perft" -> {
                val depth = if (tokens.size > 1) (tokens[1].toIntOrNull() ?: 1) else 1
                val t0 = System.nanoTime()
                val total = perft(session.board, session.side, depth)
                val spentMs = (System.nanoTime() - t0) / 1_000_000
                // 逐根着法也报一遍：总数对不上时，能直接看出是哪一手分叉的
                for (m in Rules.legalMoves(session.board, session.side)) {
                    val b2 = session.board.copyOf()
                    val cap = Rules.makeMove(b2, m)
                    val sub = if (depth > 1) perft(b2, session.side.other, depth - 1) else 1L
                    Rules.undoMove(b2, m, cap)
                    say("perft-move ${moveName(m)} $sub")
                }
                say("perft $depth nodes $total time $spentMs")
            }

            /* ---------- 只用于「移植有没有抄错一行」的调试命令 ----------
             *
             * 这三个命令**不属于 UCI 协议**，对局台也不会发它们；它们存在的理由是
             * `tools/test-engine-parity.js` 要拿 JS 引擎当基准，逐局面比
             * 静态评估分 / 着法生成 / 中文记谱 —— 这三样比 Elo 对局确定性高得多，
             * 抄错一行 PST 表在对局里看不出来，在这里一定露馅。
             *
             * 着法输出用**位打包的整数再排序**：两个引擎的着法列表顺序本来不同，
             * 直接比字符串会因为排序差异误报；打包成整数后顺序唯一。 */
            "eval" -> {
                val fen = tokens.drop(1).joinToString(" ")
                val parsed = parseFen(fen)
                if (parsed == null) say("eval ?") else say("eval ${engine.evaluate(parsed.first)}")
            }

            "moves" -> {
                val side = if (tokens.size > 1 && tokens[1] == "b") Side.BLACK else Side.RED
                val fen = tokens.drop(2).joinToString(" ")
                val parsed = parseFen(fen)
                if (parsed == null) {
                    say("moves ?")
                } else {
                    val packed = Rules.genMoves(parsed.first, side)
                        .map { it.from * 90 + it.to }
                        .sorted()
                    say("moves ${packed.size} " + packed.joinToString(" "))
                }
            }

            "labels" -> {
                val side = if (tokens.size > 1 && tokens[1] == "b") Side.BLACK else Side.RED
                val fen = tokens.drop(2).joinToString(" ")
                val parsed = parseFen(fen)
                if (parsed == null) {
                    say("labels ?")
                } else {
                    val board = parsed.first
                    val packed = Rules.legalMoves(board, side).sortedBy { it.from * 90 + it.to }
                    // ⚠️ 末尾必须给一个**终结行**。调用方（tools/test-engine-parity.js）
                    // 是流式读的：只等到 "labels N" 就返回的话，后面的 label 行还没到，
                    // 于是看起来「Kotlin 一条记谱都没输出」。
                    say("labels ${packed.size}")
                    for (m in packed) say("label ${Notation.label(board, m)}")
                    say("labels-end")
                }
            }

            "quit" -> return

            else -> Unit // stop / ponderhit / debug 之类收下不做声，免得污染协议输出
        }
    }
}
