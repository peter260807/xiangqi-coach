package com.peter260807.xiangqicoach.engine

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// MARK: - 棋谱库数据结构（对应 shared/library.json）

/**
 * 一道杀法题。
 *
 * ⚠️ 可选字段**必须真的可选** —— iOS 侧吃过这个亏：导入公开题库之后新增了字段，
 * 老库里没有，用严格解码直接抛错，题库整个变空。Kotlin 这边靠 `@Serializable` +
 * 默认值实现同样的容错：缺字段退化成 null，而不是 decode 失败。
 */
@Serializable
data class MatePuzzle(
    val id: String,
    val name: String,
    val tier: Int,
    val fen: String,
    /** 手写的那 11 道带讲解；从公开题库导入的没有这一项。 */
    val idea: String? = null,
    /** 导入来源，例如「适情雅趣」「基本杀法」。手写的 11 道没有这一项。 */
    val set: String? = null,
    /**
     * 由 tools/gen-lines.js（或 tools/import-puzzles.js）离线算出的解法路线
     * （红黑双方都走引擎首选，也就是「最顽强防守下仍然成立的最短杀法」）。
     */
    val line: List<String>? = null,
    /** 每一步的走子方，与 line 同下标：`"red"` / `"black"`。 */
    val lineSides: List<String>? = null,
    val solvePlies: Int? = null,
    val mateIn: Int? = null,
) {
    /**
     * 难度文案。`tier` 只有 1/2/3 三档，导入的题最多到 3，
     * 所以优先按 mateIn 说清楚。
     */
    val difficultyText: String
        get() {
            val n = mateIn
            if (n != null) {
                val s = cnNum(n)
                if (s != null) return "${s}步杀"
            }
            if (tier == 1) return "一步杀"
            if (tier == 2) return "两步杀"
            return "多步杀"
        }

    companion object {
        /**
         * 1~99 的中文数字。
         *
         * 原来这里写死一个到「十」的数组 `cn[mateIn - 1]`，于是 11 手以上全部掉进
         * tier 兜底、显示成「多步杀」—— Pikafish 求解深杀之后库里有 30 手杀，这个洞就露出来了。
         *
         * ⚠️ 2 手**刻意**返回「二」不是「两」：原来 `cn[1]` 就是「二」，
         * 库里 mateIn=2 的题一直显示「二步杀」，网页端训练页的筛选徽标也用「二」。
         * 这次只是把上界从 10 提到 99，不该顺手改既有文案。
         */
        private val CN = arrayOf("零", "一", "二", "三", "四", "五", "六", "七", "八", "九")

        fun cnNum(n: Int): String? {
            if (n < 1 || n > 99) return null
            if (n < 10) return CN[n]
            if (n == 10) return "十"
            if (n < 20) return "十" + CN[n % 10]
            val head = CN[n / 10] + "十"
            return if (n % 10 == 0) head else head + CN[n % 10]
        }
    }
}

@Serializable
data class OpeningLine(
    val id: String,
    val name: String,
    val style: String,
    val line: String,
    @SerialName("desc") val desc: String = "",
    val plies: Int? = null,
)

@Serializable
data class StudyPuzzle(
    val id: String,
    val name: String,
    val fen: String,
    @SerialName("desc") val desc: String = "",
)

/** 名局里某一手的解说。 */
@Serializable
data class ClassicNote(val ply: Int, val text: String)

/**
 * 古谱名局。着法序列属于史料，靠人工录入，
 * 由 tools/add-classics.js 逐手用引擎校验后才允许进库。
 */
@Serializable
data class ClassicGame(
    val id: String,
    val name: String,
    val source: String = "",
    @SerialName("desc") val desc: String = "",
    val line: String,
    val plies: Int = 0,
    val mateIn: Int = 0,
    val highlights: List<ClassicNote>? = null,
)

/** 杀法分组（界面按来源分组展示用）。 */
data class MateGroup(val label: String, val items: List<MatePuzzle>) {
    val id: String get() = label
}

/** 棋谱库：`shared/library.json` 的 Kotlin 映射。 */
@Serializable
data class XiangqiLibrary(
    val version: Int = 0,
    val note: String? = null,
    val mates: List<MatePuzzle> = emptyList(),
    val openings: List<OpeningLine> = emptyList(),
    val studies: List<StudyPuzzle> = emptyList(),
    /** 可选，方便库文件在加入名局之前生成的老版本仍能解码。 */
    val classics: List<ClassicGame>? = null,
) {
    val allClassics: List<ClassicGame> get() = classics ?: emptyList()

    /**
     * 杀法按来源分组。导入公开题库之后这里会有几百道题，
     * 平铺一列既难找也难看；库里手写的 11 道不带 `set`，自然排在最前面。
     *
     * @param solved 已通关的 id 集合（带 `"mate:"` 前缀），用于把没做过的排在前面。
     */
    fun mateGroups(solved: Set<String> = emptySet()): List<MateGroup> {
        val order = ArrayList<String>()
        val bucket = LinkedHashMap<String, MutableList<MatePuzzle>>()
        for (m in mates) {
            val k = m.set ?: ""
            val list = bucket.getOrPut(k) { order.add(k); ArrayList() }
            list.add(m)
        }
        return order.map { k ->
            val items = bucket[k]!!.sortedWith(
                compareBy<MatePuzzle> { if (solved.contains("mate:${it.id}")) 1 else 0 }
                    .thenBy { it.mateIn ?: 99 },
            )
            MateGroup(k, items)
        }
    }

    companion object {
        val EMPTY = XiangqiLibrary()
    }
}

// MARK: - 场景

/**
 * 场景类型。
 *
 * ⚠️ `key` 会写进存档，**不要改已有常量的 key**（等价于改了存档格式）。
 */
enum class SceneKind(val key: String) {
    GAME("game"),
    MATE("mate"),
    OPENING("opening"),
    STUDY("study"),
    CLASSIC("classic"),
    CUSTOM("custom");

    companion object {
        fun ofKey(key: String?): SceneKind =
            entries.firstOrNull { it.key == key } ?: GAME
    }
}

/** 一个可以开局的场景：标准开局 / 杀法题 / 开局谱 / 残局 / 名局 / 用户导入。 */
data class XQScene(
    val id: String,
    val kind: SceneKind,
    val title: String,
    val startFen: String,
    val note: String,
    /** 开局库专用：要预先摆上的着法（中文记谱）。 */
    val preloadLabels: List<String> = emptyList(),
    /** 打谱演示用的着法序列（名局全谱 / 杀法解法 / 开局谱），中文记谱。 */
    val demoLine: List<String> = emptyList(),
    /** 演示到第几手时的解说，键是手数（从 1 开始）。 */
    val demoNotes: Map<Int, String> = emptyMap(),
) {
    val canDemo: Boolean get() = demoLine.isNotEmpty()

    override fun equals(other: Any?): Boolean = other is XQScene && other.id == id
    override fun hashCode(): Int = id.hashCode()

    companion object {
        fun standard() = XQScene(
            id = "start",
            kind = SceneKind.GAME,
            title = "标准开局",
            startFen = Rules.START_FEN,
            note = "红先行。初学者可以先试「炮二平五」抢占中路。",
        )

        fun custom(title: String, fen: String, note: String) = XQScene(
            id = "custom:${java.util.UUID.randomUUID()}",
            kind = SceneKind.CUSTOM,
            title = title,
            startFen = fen,
            note = note,
        )
    }
}

/**
 * 把棋谱库摊平成可选场景列表。
 *
 * 三类场景各给一个**单独构造**的入口：对局页每落一手就要重算一次，
 * 而杀法库有 981 道 —— 每次重算都重建近千个场景对象太浪费。
 * 有了这三个入口，菜单只需要按需构造被点中的那一个。
 */
object SceneCatalog {

    fun mateScene(m: MatePuzzle): XQScene {
        // 导入的题没有 idea（讲解是手写那 11 道才有的），用来源名兜底，
        // 别在提示里露出 "null" 或空行。
        val lead = m.idea ?: (m.set?.let { "选自《$it》。" } ?: "")
        val hint = "轮到你走，找出成杀的那一步。" +
            "想不出来可以点「提示」，或用「看解法」逐步演示。" +
            "\n\n（排局类题目的红方常常子力大落后，下方评估条因此可能显示对面占优 —— " +
            "它只反映子力，别以它为准。）"
        return XQScene(
            id = "mate:${m.id}",
            kind = SceneKind.MATE,
            title = m.name,
            startFen = m.fen,
            note = if (lead.isEmpty()) hint else lead + "\n\n" + hint,
            demoLine = m.line ?: emptyList(),
        )
    }

    fun openingScene(o: OpeningLine): XQScene {
        val tokens = o.line.split(' ').filter { it.isNotEmpty() }
        return XQScene(
            id = "opening:${o.id}",
            kind = SceneKind.OPENING,
            title = o.name,
            startFen = Rules.START_FEN,
            note = o.desc + "\n\n已按谱摆好前几手，可以用「看解法」整段演示。",
            preloadLabels = tokens,
            demoLine = tokens,
        )
    }

    fun studyScene(s: StudyPuzzle) = XQScene(
        id = "study:${s.id}",
        kind = SceneKind.STUDY,
        title = s.name,
        startFen = s.fen,
        note = s.desc,
    )

    fun all(lib: XiangqiLibrary): List<XQScene> {
        val out = ArrayList<XQScene>()
        out.add(XQScene.standard())
        for (c in lib.allClassics) {
            val notes = HashMap<Int, String>()
            for (h in c.highlights ?: emptyList()) notes[h.ply] = h.text
            out.add(
                XQScene(
                    id = "classic:${c.id}",
                    kind = SceneKind.CLASSIC,
                    title = c.name,
                    startFen = Rules.START_FEN,
                    note = c.source + "\n\n" + c.desc,
                    demoLine = c.line.split(' ').filter { it.isNotEmpty() },
                    demoNotes = notes,
                ),
            )
        }
        out.addAll(lib.mates.map { mateScene(it) })
        out.addAll(lib.openings.map { openingScene(it) })
        out.addAll(lib.studies.map { studyScene(it) })
        return out
    }

    /** 按 id 找到场景并预摆开局着法，返回最终局面与已走着法。 */
    fun resolve(scene: XQScene): Pair<ByteArray, List<Move>> {
        val b = Rules.parse(scene.startFen)
        val moves = ArrayList<Move>(scene.preloadLabels.size)
        var turn = Side.RED
        for (lab in scene.preloadLabels) {
            val m = Notation.findMove(b, turn, lab) ?: break
            moves.add(m)
            Rules.makeMove(b, m)
            turn = turn.other
        }
        return b to moves
    }
}
