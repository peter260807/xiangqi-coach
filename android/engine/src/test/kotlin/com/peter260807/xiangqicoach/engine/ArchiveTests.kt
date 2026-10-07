package com.peter260807.xiangqicoach.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * 能力画像与训练推荐的测试（对应 iOS 的 `ArchiveTests`）。
 *
 * 这部分逻辑直接决定「给用户显示什么评价、推荐练什么」，
 * 算错了不会崩，但会让人练错方向，所以用构造出来的对局数据把每一档都钉住。
 */
class ArchiveTests {

    // MARK: - 测试数据构造

    private fun eval(ply: Int, loss: Int, phase: String, grade: String = "ok") =
        MoveEval(ply = ply, redScore = 0, loss = loss, grade = grade, bestLabel = "炮二平五", phase = phase)

    private fun record(
        id: String = "t",
        ply: Int,
        result: String,
        finished: Boolean,
        evals: List<MoveEval> = emptyList(),
        flags: GameFlags = GameFlags(),
    ) = GameRecord(
        id = id, sceneId = "start", sceneName = "标准开局",
        level = "hard", mode = "engine", startFEN = Rules.START_FEN,
        moves = emptyList(), evals = evals, flags = flags, result = result,
        finished = finished, ply = ply,
    )

    private fun dim(rep: AbilityReport, id: String): AbilityDimension =
        rep.dimensions.first { it.id == id }

    private val lib: XiangqiLibrary get() = TestFixtures.sharedLibrary

    // MARK: - 能力画像

    @Test
    fun emptyArchiveReportsNoData() {
        val rep = Ability.abilities(emptyList(), emptySet(), mateTotal = 11)
        assertTrue(!rep.hasData)
        assertEquals(0, rep.games)
        assertEquals(0, rep.winRate)
        // 没有对局数据时三个分段维度给 0 分，并注明原因
        for (id in listOf("opening", "midgame", "endgame")) {
            assertEquals(0, dim(rep, id).score, id)
            assertTrue(dim(rep, id).note.startsWith("还没有"), id)
        }
        assertEquals(5, rep.dimensions.size)
    }

    @Test
    fun lowerLossScoresHigher() {
        val clean = Ability.abilities(
            listOf(
                record(
                    ply = 40, result = "win", finished = true,
                    evals = listOf(eval(1, 0, "opening"), eval(3, 0, "opening")),
                ),
            ),
            emptySet(), mateTotal = 11,
        )
        val sloppy = Ability.abilities(
            listOf(
                record(
                    ply = 40, result = "loss", finished = true,
                    evals = listOf(eval(1, 600, "opening"), eval(3, 900, "opening")),
                ),
            ),
            emptySet(), mateTotal = 11,
        )

        assertEquals(100, dim(clean, "opening").score, "零失分应当是满分")
        assertTrue(dim(clean, "opening").score > dim(sloppy, "opening").score)
        assertTrue(dim(sloppy, "opening").score < 50, "平均失分 750 应当明显偏低")
    }

    @Test
    fun phasesAreAggregatedSeparately() {
        val g = record(
            ply = 60, result = "loss", finished = true,
            evals = listOf(
                eval(2, 0, "opening"),
                eval(30, 1200, "mid"),
                eval(55, 0, "end"),
            ),
        )
        val rep = Ability.abilities(listOf(g), emptySet(), mateTotal = 11)
        assertEquals(100, dim(rep, "opening").score)
        assertEquals(100, dim(rep, "endgame").score)
        assertTrue(dim(rep, "opening").score > dim(rep, "midgame").score)
        assertTrue(dim(rep, "midgame").score < 100, "中局平均失分 1200，分数应明显偏低")
        assertTrue(dim(rep, "midgame").note.contains("1200"))
    }

    @Test
    fun attackDimensionFollowsSolvedMateCount() {
        val few = Ability.abilities(emptyList(), setOf("mate:m1"), mateTotal = 11)
        val many = Ability.abilities(emptyList(), (1..11).map { "mate:m$it" }.toSet(), mateTotal = 11)
        assertTrue(dim(many, "attack").score > dim(few, "attack").score)
        assertEquals(100, dim(many, "attack").score, "全部通关应当是满分")
        assertTrue(dim(many, "attack").note.contains("11/11"))
    }

    @Test
    fun missedMatesPenaliseAttackScore() {
        val flags = GameFlags(missedMate = 4)
        val withMisses = Ability.abilities(
            listOf(record(ply = 30, result = "loss", finished = true, flags = flags)),
            (1..11).map { "mate:m$it" }.toSet(), mateTotal = 11,
        )
        val clean = Ability.abilities(
            emptyList(), (1..11).map { "mate:m$it" }.toSet(), mateTotal = 11,
        )
        assertTrue(dim(withMisses, "attack").score < dim(clean, "attack").score, "漏杀应当扣攻杀分")
    }

    @Test
    fun defenceDropsWithLossesAndBlunders() {
        val solid = Ability.abilities(
            listOf(record(ply = 60, result = "win", finished = true)), emptySet(), mateTotal = 11,
        )
        val leaky = Ability.abilities(
            listOf(
                record(
                    ply = 30, result = "loss", finished = true,
                    flags = GameFlags(blunders = 6),
                ),
            ),
            emptySet(), mateTotal = 11,
        )
        assertTrue(dim(solid, "defend").score > dim(leaky, "defend").score)
    }

    @Test
    fun winRateAndAggregates() {
        val games = listOf(
            record(id = "a", ply = 40, result = "win", finished = true),
            record(id = "b", ply = 60, result = "win", finished = true),
            record(id = "c", ply = 50, result = "loss", finished = true),
            record(id = "d", ply = 10, result = "unfinished", finished = false),
        )
        val rep = Ability.abilities(games, emptySet(), mateTotal = 11)
        assertEquals(4, rep.games)
        assertEquals(3, rep.finished)
        assertEquals(2, rep.wins)
        assertEquals(67, rep.winRate)
        assertEquals(40, rep.avgPly, "平均手数应包含未完成的对局")
    }

    @Test
    fun overallScoreStaysInRange() {
        val games = listOf(
            record(
                ply = 40, result = "loss", finished = true,
                evals = listOf(eval(2, 900, "opening"), eval(20, 900, "mid"), eval(38, 900, "end")),
            ),
        )
        val rep = Ability.abilities(games, emptySet(), mateTotal = 11)
        assertTrue(rep.overall in 0..100)
        for (d in rep.dimensions) {
            assertTrue(d.score in 0..100, "${d.name} 的分数越界：${d.score}")
        }
    }

    // MARK: - 训练推荐

    @Test
    fun emptyArchiveRecommendsStarterDrills() {
        val drills = Ability.drills(emptyList(), emptySet(), lib, limit = 3)
        assertTrue(drills.isNotEmpty())
        assertTrue(drills.size <= 3)
        for (d in drills) {
            assertTrue(d.title.isNotEmpty())
            assertTrue(d.sceneId.contains(":"), "推荐项必须能定位到具体场景")
        }
        assertTrue(drills.any { it.sceneId.startsWith("mate:") }, "新手应当先练杀法")
    }

    @Test
    fun weakestDimensionDrivesRecommendation() {
        // 开局失分惨重 → 应当推开局库。
        // 注意要**先把杀法全部标成已通**，否则「攻杀把握」（= 已通 / 题库总数）
        // 会成为最弱项，推荐就跑到杀法去了 —— 这个用例第一次跑正是这么失败的。
        val allMates = lib.mates.map { "mate:${it.id}" }.toSet()
        val weakOpening = Ability.drills(
            listOf(
                record(
                    ply = 40, result = "loss", finished = true,
                    evals = listOf(eval(2, 1000, "opening"), eval(4, 1000, "opening"), eval(6, 1000, "opening")),
                ),
            ),
            allMates, lib, limit = 3,
        )
        assertTrue(
            weakOpening.any { it.sceneId.startsWith("opening:") },
            "开局最弱却推荐了别的：${weakOpening.map { it.sceneId }}",
        )

        // 杀法全没通 → 应当推杀法练习
        val weakAttack = Ability.drills(emptyList(), emptySet(), lib, limit = 3)
        assertTrue(weakAttack.any { it.sceneId.startsWith("mate:") })
    }

    @Test
    fun recommendationRespectsLimitAndUniqueness() {
        for (limit in listOf(1, 2, 3, 5)) {
            val drills = Ability.drills(emptyList(), emptySet(), lib, limit = limit)
            assertTrue(drills.size <= limit, "limit=$limit 返回了 ${drills.size} 条")
            assertEquals(drills.size, drills.map { it.id }.toSet().size, "推荐项有重复")
        }
    }

    @Test
    fun solvedPuzzlesAreDeprioritised() {
        // 把 tier 1 的杀法都标成已通，推荐就不该再优先给它们
        val tier1 = lib.mates.filter { it.tier == 1 }.map { "mate:${it.id}" }.toSet()
        val drills = Ability.drills(emptyList(), tier1, lib, limit = 2)
        assertTrue(
            drills.none { tier1.contains(it.sceneId) },
            "已经通关的题目不该继续推荐：${drills.map { it.sceneId }}",
        )
    }

    // MARK: - 对局记录编解码

    @Test
    fun gameRecordMovePairsRoundTrip() {
        val moves = listOf(67, 40, 19, 46, 81, 63)
        val g = GameRecord(
            id = "x", sceneId = "start", sceneName = "标准开局", level = "hard", mode = "engine",
            startFEN = Rules.START_FEN, moves = moves, result = "unfinished", finished = false, ply = 3,
        )
        assertEquals(listOf(Move(67, 40), Move(19, 46), Move(81, 63)), g.movePairs)
        assertEquals("未完", g.resultLabel)

        // 编解码后应当完全一致（存档靠 JSON 落盘）
        val json = kotlinx.serialization.json.Json { encodeDefaults = true }
        val text = json.encodeToString(GameRecord.serializer(), g)
        val back = json.decodeFromString(GameRecord.serializer(), text)
        assertEquals(g, back)

        // 旧存档缺字段也必须能读（缺 playedLabel / missedMate / flags 里的新字段）
        val legacy = """
            {"id":"old","savedAt":"2026-01-01T00:00:00Z","sceneId":"start","sceneName":"标准开局",
             "level":"hard","mode":"engine","startFEN":"${Rules.START_FEN}",
             "moves":[67,40],"evals":[{"ply":1,"redScore":10,"loss":200,"grade":"inaccuracy",
             "bestLabel":"炮二平五","phase":"opening"},
             {"ply":3,"redScore":-300,"loss":900,"grade":"blunder",
             "bestLabel":"马八进七","phase":"opening"}],
             "flags":{"blunders":0,"mistakes":0,"inaccuracies":1,"missedMate":0},"result":"loss",
             "finished":true,"ply":1}
        """.trimIndent()
        val decoded = json.decodeFromString(GameRecord.serializer(), legacy)
        assertEquals("old", decoded.id)
        assertEquals(2, decoded.evals.size)
        // 旧存档没有 playedLabel / missedMate：必须是 null 而不是解码失败
        assertEquals(null, decoded.evals[0].playedLabel, "旧存档缺 playedLabel 应当退化成 null")
        assertEquals(null, decoded.evals[0].missedMate, "旧存档缺 missedMate 应当退化成 null")
        assertEquals("loss", decoded.result)

        // 而且这份旧存档仍然必须能生成复盘（不能因为缺字段就整块不可用）
        val digest = ReviewDigest.build(decoded)
        assertNotNull(digest, "旧存档必须仍能生成复盘")
        assertEquals(2, digest.movesCount)
        // 缺 playedLabel → 显示「（记谱缺失）」，不猜
        assertTrue(
            digest.text.contains("（记谱缺失）"),
            "旧存档的记谱缺失提示没有出现：\n${digest.text}",
        )
    }
}
