package com.peter260807.xiangqicoach.engine

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.math.exp
import kotlin.math.roundToInt

// MARK: - 对局记录

/** 一手棋的引擎分析结果。 */
@Serializable
data class MoveEval(
    val ply: Int,
    val redScore: Int,
    val loss: Int,
    /** ok / inaccuracy / mistake / blunder */
    val grade: String,
    val bestLabel: String = "",
    /** opening / mid / end */
    val phase: String = "mid",
    /** 这一手原本有杀棋却没能走出来。可选是为了让加字段之前的旧存档仍能解码。 */
    val missedMate: Boolean? = null,
    /**
     * 实际走的那一手的中文记谱。**在分析时就存下来**，不要在复盘时靠重放反推 ——
     * 重放依赖「着法序列是完整的」，而实战里 `moves` 曾经只装了红方着法，
     * 重放出来是另一盘棋，`played` 会指到不相干的着法而输出看起来毫无破绽。
     * 旧存档没有这个字段 → 显示「（记谱缺失）」，不猜。
     */
    val playedLabel: String? = null,
)

@Serializable
data class GameFlags(
    val blunders: Int = 0,
    val mistakes: Int = 0,
    val inaccuracies: Int = 0,
    val missedMate: Int = 0,
    val matedByOpponent: Int = 0,
)

/**
 * 一盘棋的存档。
 *
 * ⚠️ 字段名与 JSON 结构**必须与 iOS / 网页版一致** —— 存档是纯 JSON，
 * 用户从一端导出来能在另一端读进去。改字段名等于改存档格式。
 */
@Serializable
data class GameRecord(
    val id: String,
    /** ISO8601 字符串。**刻意不用平台时间类型**：这个类要能在纯 JVM 单测里构造，
       而两端的时间表示不同，字符串是唯一不会互相误解的表示。 */
    val savedAt: String = "",
    val sceneId: String = "",
    val sceneName: String = "",
    val level: String = "hard",
    val mode: String = "ai",
    val startFEN: String = Rules.START_FEN,
    /** 扁平化的 [from, to, from, to, ...]。 */
    val moves: List<Int> = emptyList(),
    val evals: List<MoveEval> = emptyList(),
    val flags: GameFlags = GameFlags(),
    /** win / loss / draw / unfinished */
    val result: String = "unfinished",
    val finished: Boolean = false,
    val ply: Int = 0,
) {
    val movePairs: List<Move>
        get() {
            val out = ArrayList<Move>(moves.size / 2)
            var i = 0
            while (i + 1 < moves.size) {
                out.add(Move(moves[i], moves[i + 1]))
                i += 2
            }
            return out
        }

    val resultLabel: String
        get() = when (result) {
            "win" -> "胜"
            "loss" -> "负"
            "draw" -> "和"
            else -> if (finished) "和" else "未完"
        }
}

// MARK: - 复盘摘要

/**
 * 把**已经算好的**逐手分析（loss / grade / bestLabel / phase / missedMate）
 * 整理成一份结构化复盘。
 *
 * 起因：复盘原来只把「第N手 <分数>」这一串数字喂给大模型，
 * 而每手其实都算出了 grade/loss/bestLabel —— 全被丢掉了。
 * 那串数字没有语义，模型只能猜哪一步是转折点，猜不准；人也读不出信息。
 *
 * 这份摘要做两件事：
 *   ① 让「不配 API Key 也能复盘」成立（[text] 完全由数据生成，秒出、确定）
 *   ② 让大模型拿到的事实是**确定的**，它只负责讲「为什么」和「练什么」
 *
 * ⚠️ 这里只做「读数」，不做棋理推断。任何关于「该怎么走」的结论
 *    都必须来自引擎给的 `bestLabel`，不能由本类型编。
 *    （与 web 端 `XQSTORE.reviewDigest` 是同一套定义，两边字段名保持一致。）
 */
class ReviewDigest {

    class PhaseStat(
        val key: String,
        val name: String,
        val moves: Int,
        val avgLoss: Int?,
        val blunder: Int,
        val mistake: Int,
        val inaccuracy: Int,
    )

    class KeyMoment(
        val ply: Int,
        val round: Int,
        val phase: String,
        val played: String,
        val loss: Int,
        val grade: String,
        val gradeName: String,
        val best: String,
        val missedMate: Boolean,
    )

    var rounds = 0
    var result = "unfinished"
    var movesCount = 0
    var blunder = 0
    var mistake = 0
    var inaccuracy = 0
    var missedMate = 0
    var phases: List<PhaseStat> = emptyList()
    var keys: List<KeyMoment> = emptyList()

    /** 平均丢分最高、且样本 ≥3 手的阶段（样本不足时为 null —— 一手棋定不了「你中局弱」）。 */
    var worst: PhaseStat? = null

    /**
     * 各阶段平均丢分的**等权**平均。不把所有手混在一起平均 ——
     * 否则残局手少的时候会被开局的手数稀释掉。
     */
    var avgLoss = 0

    val text: String
        get() {
            val L = ArrayList<String>()
            val res = when (result) {
                "win" -> "你（红方）获胜"
                "loss" -> "你（红方）落败"
                "draw" -> "和棋"
                else -> "对局进行中"
            }
            L.add("【结果】$res　共 $rounds 回合")

            L.add("")
            L.add("【失误分布】")
            for (p in phases) {
                if (p.moves <= 0) continue
                val bits = ArrayList<String>()
                if (p.blunder > 0) bits.add("严重失误 ${p.blunder}")
                if (p.mistake > 0) bits.add("失误 ${p.mistake}")
                if (p.inaccuracy > 0) bits.add("不够精确 ${p.inaccuracy}")
                L.add(
                    "  ${p.name}（${p.moves} 手，平均丢分 ${p.avgLoss ?: 0}）" +
                        if (bits.isEmpty()) "：没有明显问题" else "：" + bits.joinToString(" · "),
                )
            }

            if (keys.isEmpty()) {
                L.add("")
                L.add("【关键时刻】没有严重失误、失误或漏杀。")
            } else {
                L.add("")
                L.add("【关键时刻】按丢分排序")
                for (k in keys) {
                    L.add(
                        "  第 ${k.ply} 手（第 ${k.round} 回合，${k.phase}）${k.played} —— " +
                            if (k.missedMate) "漏杀" else "${k.gradeName}，丢 ${k.loss} 分",
                    )
                    if (k.best.isNotEmpty()) L.add("      引擎认为该走：${k.best}")
                }
            }

            if (missedMate > 0) {
                L.add("")
                L.add("【漏杀】有 $missedMate 手本来可以直接成杀，没有走出来。")
            }

            L.add("")
            L.add("【结论】")
            val w = worst
            if (w != null && (w.avgLoss ?: 0) > 0) {
                L.add(
                    "  平均丢分最高的是${w.name}（${w.avgLoss} 分 / 手，${w.moves} 手）。" +
                        "整体平均 $avgLoss 分 / 手。",
                )
            } else {
                L.add("  这盘没有值得单拎出来的阶段性问题。整体平均 $avgLoss 分 / 手。")
            }
            if (blunder > 0) {
                val top = keys.firstOrNull { it.grade == "blunder" }
                if (top != null) {
                    L.add("  最大的一处是第 ${top.ply} 手的 ${top.played}（丢 ${top.loss} 分）。")
                }
            }
            return L.joinToString("\n")
        }

    /**
     * 喂给大模型的结构化事实。与 [text] 同一份数据，
     * 但去掉了「结论」段 —— 那一段是留给模型写的。
     */
    val promptLines: List<String>
        get() {
            val L = ArrayList<String>()
            L.add("【已由本地引擎逐手算好，可直接引用，不要自行推测】")
            var head = "我执红方，共 $rounds 回合。严重失误 $blunder 次、" +
                "失误 $mistake 次、不够精确 $inaccuracy 次"
            if (missedMate > 0) head += "、漏杀 $missedMate 次"
            L.add("$head。")
            val ph = phases.filter { it.moves > 0 }
                .map { "${it.name} ${it.moves} 手/平均丢 ${it.avgLoss ?: 0} 分" }
            L.add("分阶段：" + ph.joinToString("；") + "。")
            if (keys.isEmpty()) {
                L.add("没有严重失误、失误或漏杀。")
            } else {
                L.add("按丢分排序的关键时刻（「丢分」= 引擎认为的最好走法与我实际走法之间的分差）：")
                for (k in keys) {
                    var s = "  · 第 ${k.ply} 手（第 ${k.round} 回合，${k.phase}）我走了 ${k.played}，丢 ${k.loss} 分"
                    if (k.missedMate) s += "（这一步本来可以直接成杀）"
                    if (k.best.isNotEmpty()) s += "；引擎建议走 ${k.best}"
                    L.add("$s。")
                }
            }
            return L
        }

    companion object {
        val phaseNames = mapOf("opening" to "开局", "mid" to "中局", "end" to "残局")
        val gradeNames = mapOf(
            "blunder" to "严重失误",
            "mistake" to "失误",
            "inaccuracy" to "不够精确",
            "ok" to "正常",
        )

        /** 失分分级阈值（单位：厘兵），与 web `TH` 一致。 */
        const val TH_INACCURACY = 100
        const val TH_MISTAKE = 300
        const val TH_BLUNDER = 800

        /** 前 12 回合算开局。 */
        const val OPENING_PLIES = 24

        /** 场上子力低于此值算残局。 */
        const val ENDGAME_MATERIAL = 3200.0

        /**
         * 平均值取整。
         *
         * ⚠️ **刻意用「四舍五入」的语义而不是 Kotlin 的 `.roundToInt()`**：
         * JS 的 `Math.round(-0.5)` 是 `-0`（向 +∞ 取），`roundToInt` 是远离零取。
         * 好在这里的数值都非负，两者一致；但这是**碰巧**一致，
         * 所以这里显式写成 `floor(x + 0.5)`，与 JS 的定义对齐，不依赖运气。
         */
        private fun avgInt(xs: List<Int>): Int {
            if (xs.isEmpty()) return 0
            return Math.floor(xs.sum().toDouble() / xs.size + 0.5).toInt()
        }

        /**
         * 从对局记录生成摘要。没有逐手分析时返回 null（打谱演示、旧存档）。
         *
         * 与 web 端 `XQSTORE.reviewDigest` 是同一套定义；`test-copies.js` 那种
         * 「两份实现必须同答案」的守门断言在 Android 侧由 `ReviewDigestTest` 承担。
         */
        fun build(record: GameRecord): ReviewDigest? {
            if (record.evals.isEmpty()) return null
            val d = ReviewDigest()
            d.result = record.result

            val evals = record.evals
            /* 每手走的什么，直接取分析时存下来的 playedLabel。
               别再把「反推」当成数据来源 —— 能存就存。 */
            val maxPly = evals.maxOf { it.ply }
            /* 回合数取两个来源的较大者：完整序列更准；旧存档里它只有红方着法，
               那时用「最大分析手数」兜底，最多少算半回合。 */
            d.rounds = maxOf((record.moves.size + 1) / 2, (maxPly + 1) / 2)

            d.movesCount = evals.size
            d.blunder = evals.count { it.grade == "blunder" }
            d.mistake = evals.count { it.grade == "mistake" }
            d.inaccuracy = evals.count { it.grade == "inaccuracy" }
            d.missedMate = evals.count { it.missedMate == true }

            d.phases = listOf("opening", "mid", "end").map { key ->
                val list = evals.filter { it.phase == key }
                PhaseStat(
                    key = key,
                    name = phaseNames[key] ?: key,
                    moves = list.size,
                    avgLoss = if (list.isEmpty()) null else avgInt(list.map { it.loss }),
                    blunder = list.count { it.grade == "blunder" },
                    mistake = list.count { it.grade == "mistake" },
                    inaccuracy = list.count { it.grade == "inaccuracy" },
                )
            }

            /* 关键时刻：只看真正扣分的（严重失误 / 失误 / 漏杀），按丢分降序取前 6。
               「不够精确」不进来 —— 阈值只有 100 分，列出来会把真正的问题埋掉。 */
            d.keys = evals
                .filter { it.grade == "blunder" || it.grade == "mistake" || it.missedMate == true }
                .sortedByDescending { it.loss }
                .take(6)
                .map { e ->
                    KeyMoment(
                        ply = e.ply,
                        round = (e.ply + 1) / 2,
                        phase = phaseNames[e.phase] ?: "中局",
                        played = if (!e.playedLabel.isNullOrEmpty()) e.playedLabel else "（记谱缺失）",
                        loss = e.loss,
                        grade = e.grade,
                        gradeName = gradeNames[e.grade] ?: e.grade,
                        best = e.bestLabel,
                        missedMate = e.missedMate == true,
                    )
                }

            d.worst = d.phases
                .filter { it.moves >= 3 && it.avgLoss != null }
                .maxByOrNull { it.avgLoss ?: 0 }
            val vals = d.phases.mapNotNull { it.avgLoss }
            d.avgLoss = if (vals.isEmpty()) 0
            else Math.floor(vals.sum().toDouble() / vals.size + 0.5).toInt()
            return d
        }
    }
}

// MARK: - 能力维度

class AbilityDimension(
    val id: String,
    val name: String,
    val score: Int,
    val note: String,
) {
    val level: String
        get() = when {
            score >= 70 -> "good"
            score >= 45 -> "mid"
            else -> "bad"
        }
}

class AbilityReport {
    var dimensions: List<AbilityDimension> = emptyList()
    var games = 0
    var finished = 0
    var wins = 0
    var losses = 0
    var winRate = 0
    var avgPly = 0
    var blunders = 0
    var mistakes = 0
    var missedMate = 0
    var solvedMates = 0
    var mateTotal = 0
    var overall = 0
    var hasData = false
}

/** 训练推荐的一条。 */
class Drill(
    val id: String,
    val sceneId: String,
    val badge: String,
    val title: String,
    val desc: String,
)

/**
 * 存档的**纯计算**部分：能力画像与训练推荐。
 *
 * 与 web 端 `XQSTORE.abilities` / `XQSTORE.drills` 是同一套算式 ——
 * 三端给同一个用户画像（她换端不该看到不同的「你最弱的是残局」）。
 * 落盘（文件读写）不在这里，见 app 模块的 `ArchiveStore`。
 */
object Ability {

    private fun lossToScore(loss: Double): Int {
        if (loss <= 0) return 100
        return maxOf(0, minOf(100, (100.0 * exp(-loss / 420.0)).roundToInt()))
    }

    private fun avg(xs: List<Int>): Double = if (xs.isEmpty()) 0.0 else xs.sum().toDouble() / xs.size

    fun abilities(games: List<GameRecord>, solvedIds: Set<String>, mateTotal: Int): AbilityReport {
        val rep = AbilityReport()
        val withEval = games.filter { it.evals.isNotEmpty() }

        val openLoss = ArrayList<Int>()
        val midLoss = ArrayList<Int>()
        val endLoss = ArrayList<Int>()
        var totalPly = 0
        var mated = 0
        var missed = 0
        var blunders = 0
        var mistakes = 0
        var wins = 0
        var finished = 0

        for (g in games) {
            for (e in g.evals) {
                when (e.phase) {
                    "opening" -> openLoss.add(e.loss)
                    "end" -> endLoss.add(e.loss)
                    else -> midLoss.add(e.loss)
                }
            }
            totalPly += g.ply
            missed += g.flags.missedMate
            blunders += g.flags.blunders
            mistakes += g.flags.mistakes
            if (g.finished) {
                finished++
                if (g.result == "win") wins++
                else if (g.result == "loss") mated++
            }
        }

        val solved = solvedIds.size
        val ratio = if (mateTotal > 0) solved.toDouble() / mateTotal else 0.0

        val attack = maxOf(0, minOf(100, (ratio * 100).roundToInt() - minOf(35, missed * 7)))

        var defendBase = 62.0 + ratio * 22.0
        if (finished > 0) defendBase -= (mated.toDouble() / finished) * 30.0
        defendBase -= minOf(25.0, blunders * 1.6)
        val defend = maxOf(0, minOf(100, defendBase.roundToInt()))

        val hasPlay = withEval.isNotEmpty()
        val opening = if (hasPlay) lossToScore(avg(openLoss)) else 0
        val midgame = if (hasPlay) lossToScore(avg(midLoss)) else 0
        val endgame = if (hasPlay) lossToScore(avg(endLoss)) else 0

        rep.dimensions = listOf(
            AbilityDimension(
                "opening", "开局稳健", opening,
                if (openLoss.isEmpty()) "还没有对局数据"
                else "前 12 回合平均失分 ${avg(openLoss).roundToInt()}",
            ),
            AbilityDimension(
                "midgame", "中局战术", midgame,
                if (midLoss.isEmpty()) "还没有对局数据"
                else "中局平均失分 ${avg(midLoss).roundToInt()}",
            ),
            AbilityDimension(
                "endgame", "残局收官", endgame,
                if (endLoss.isEmpty()) "还没有进入过残局的记录"
                else "残局平均失分 ${avg(endLoss).roundToInt()}",
            ),
            AbilityDimension(
                "attack", "攻杀把握", attack,
                "杀法已通 $solved/$mateTotal 关" + (if (missed > 0) "，漏杀 $missed 次" else ""),
            ),
            AbilityDimension(
                "defend", "防守意识", defend,
                if (finished > 0) "已结束 $finished 局，被将死 $mated 局" else "还没有完整对局数据",
            ),
        )

        rep.games = games.size
        rep.finished = finished
        rep.wins = wins
        rep.losses = mated
        rep.blunders = blunders
        rep.mistakes = mistakes
        rep.missedMate = missed
        rep.solvedMates = solved
        rep.mateTotal = mateTotal
        rep.winRate = if (finished > 0) (wins.toDouble() / finished * 100).roundToInt() else 0
        rep.avgPly = if (games.isEmpty()) 0 else totalPly / games.size
        rep.hasData = hasPlay || solved > 0

        /* ⚠️ 这里**刻意保留**「还没有…」这个前缀判断，而不是换成一个显式的布尔字段。
           它是三端共用的判据：文案改了却忘了改判断，画像的总体分会悄悄跟着变。 */
        val valid = rep.dimensions.filter {
            !it.note.startsWith("还没有") || it.id == "attack" || it.id == "defend"
        }
        rep.overall = if (valid.isEmpty()) 0
        else Math.floor(valid.map { it.score }.sum().toDouble() / valid.size + 0.5).toInt()
        return rep
    }

    /**
     * 训练推荐。完全没有数据时给一套新手起步组合（两道一步杀 + 一条开局谱）。
     */
    fun drills(
        games: List<GameRecord>,
        solvedIds: Set<String>,
        library: XiangqiLibrary,
        limit: Int = 3,
    ): List<Drill> {
        val rep = abilities(games, solvedIds, library.mates.size)

        if (!rep.hasData) {
            val starter = ArrayList<Drill>()
            for (m in library.mates.filter { it.tier == 1 }.take(2)) {
                starter.add(
                    Drill(
                        "mate:${m.id}", "mate:${m.id}", "杀法", m.name,
                        m.difficultyText + " · 先从这里熟悉杀棋的感觉",
                    ),
                )
            }
            library.openings.firstOrNull()?.let { o ->
                starter.add(
                    Drill(
                        "opening:${o.id}", "opening:${o.id}", "开局", o.name,
                        "先把最常见开局的头几手走熟",
                    ),
                )
            }
            return starter.take(limit)
        }

        data class Plan(val kind: String, val badge: String, val why: String)
        val plan = mapOf(
            "opening" to Plan("opening", "布局", "开局阶段失分偏多，先把常见开局的前几手走熟"),
            "midgame" to Plan("mate", "杀法", "中局丢子偏多，用杀法练习练「一眼看出杀棋」"),
            "endgame" to Plan("study", "残局", "残局收不住，先把几个基本胜残局走通"),
            "attack" to Plan("mate", "杀法", "有杀棋机会没抓住，专项练成杀套路"),
            "defend" to Plan("mate", "防守", "容易被将死，反过来多看杀法就知道怎么防"),
        )

        val out = ArrayList<Drill>()
        val seen = HashSet<String>()
        for (dim in rep.dimensions.sortedBy { it.score }) {
            if (out.size >= limit) break
            val p = plan[dim.id] ?: continue

            when (p.kind) {
                "opening" -> {
                    for (o in library.openings) {
                        if (out.size >= limit) break
                        val key = "opening:${o.id}"
                        if (!seen.add(key)) continue
                        out.add(Drill(key, key, p.badge, o.name, "${o.style} · ${p.why}"))
                    }
                }
                "study" -> {
                    for (s in library.studies) {
                        if (out.size >= limit) break
                        val key = "study:${s.id}"
                        if (!seen.add(key)) continue
                        out.add(Drill(key, key, p.badge, s.name, p.why))
                    }
                }
                else -> {
                    val unsolved = library.mates.filter { !solvedIds.contains("mate:${it.id}") }
                    val pool = (if (unsolved.isEmpty()) library.mates else unsolved).sortedBy { it.tier }
                    for (m in pool) {
                        if (out.size >= limit) break
                        val key = "mate:${m.id}"
                        if (!seen.add(key)) continue
                        out.add(Drill(key, key, p.badge, m.name, m.difficultyText + " · " + p.why))
                    }
                }
            }
        }

        // 不足则用杀法补满
        if (out.size < limit) {
            for (m in library.mates) {
                if (out.size >= limit) break
                val key = "mate:${m.id}"
                if (!seen.add(key)) continue
                out.add(Drill(key, key, "杀法", m.name, "空闲时也可以练一练"))
            }
        }
        return out.take(limit)
    }

    /** 结合手数判断阶段。与 `Rules.material` 一起决定「开局 / 中局 / 残局」。 */
    fun phase(board: ByteArray, ply: Int): String {
        if (ply <= ReviewDigest.OPENING_PLIES) return "opening"
        return if (Rules.material(board) < ReviewDigest.ENDGAME_MATERIAL) "end" else "mid"
    }

    /** 按盘面判断阶段（不知道手数时用）。 */
    fun phase(board: ByteArray): String =
        if (Rules.material(board) < ReviewDigest.ENDGAME_MATERIAL) "end" else "mid"

    /**
     * 由失分反推分级。
     *
     * ⚠️ 阈值与 web 的 `TH` 一致（100 / 300 / 800）；改一边必须改三边。
     */
    fun grade(loss: Int): String = when {
        loss >= ReviewDigest.TH_BLUNDER -> "blunder"
        loss >= ReviewDigest.TH_MISTAKE -> "mistake"
        loss >= ReviewDigest.TH_INACCURACY -> "inaccuracy"
        else -> "ok"
    }
}
