import XCTest
@testable import XiangqiCoach

/// 能力画像与训练推荐的测试。
///
/// 这部分逻辑直接决定「给用户显示什么评价、推荐练什么」，
/// 算错了不会崩，但会让人练错方向，所以用构造出来的对局数据把每一档都钉住。
final class ArchiveTests: XCTestCase {

    // MARK: - 测试数据构造

    private func eval(_ ply: Int, loss: Int32, phase: String, grade: String = "ok") -> MoveEval {
        MoveEval(ply: ply, redScore: 0, loss: loss, grade: grade, bestLabel: "炮二平五", phase: phase)
    }

    private func record(id: String = "t", ply: Int, result: String, finished: Bool,
                        evals: [MoveEval] = [], flags: GameFlags = GameFlags()) -> GameRecord {
        GameRecord(id: id, savedAt: Date(), sceneId: "start", sceneName: "标准开局",
                   level: "hard", mode: "engine", startFEN: Rules.startFEN,
                   moves: [], evals: evals, flags: flags, result: result,
                   finished: finished, ply: ply)
    }

    private func dim(_ rep: AbilityReport, _ id: String) -> AbilityDimension {
        rep.dimensions.first { $0.id == id }!
    }

    // MARK: - 能力画像

    func testEmptyArchiveReportsNoData() {
        let rep = Archive.abilities(games: [], solvedIds: [], mateTotal: 11)
        XCTAssertFalse(rep.hasData)
        XCTAssertEqual(rep.games, 0)
        XCTAssertEqual(rep.winRate, 0)
        // 没有对局数据时三个分段维度给 0 分，并注明原因
        for id in ["opening", "midgame", "endgame"] {
            XCTAssertEqual(dim(rep, id).score, 0)
            XCTAssertTrue(dim(rep, id).note.hasPrefix("还没有"))
        }
        XCTAssertEqual(rep.dimensions.count, 5)
    }

    func testLowerLossScoresHigher() {
        let clean = Archive.abilities(
            games: [record(ply: 40, result: "win", finished: true,
                           evals: [eval(1, loss: 0, phase: "opening"), eval(3, loss: 0, phase: "opening")])],
            solvedIds: [], mateTotal: 11)
        let sloppy = Archive.abilities(
            games: [record(ply: 40, result: "loss", finished: true,
                           evals: [eval(1, loss: 600, phase: "opening"), eval(3, loss: 900, phase: "opening")])],
            solvedIds: [], mateTotal: 11)

        XCTAssertEqual(dim(clean, "opening").score, 100, "零失分应当是满分")
        XCTAssertGreaterThan(dim(clean, "opening").score, dim(sloppy, "opening").score)
        XCTAssertLessThan(dim(sloppy, "opening").score, 50, "平均失分 750 应当明显偏低")
    }

    func testPhasesAreAggregatedSeparately() {
        let g = record(ply: 60, result: "loss", finished: true, evals: [
            eval(2, loss: 0, phase: "opening"),
            eval(30, loss: 1200, phase: "mid"),
            eval(55, loss: 0, phase: "end")
        ])
        let rep = Archive.abilities(games: [g], solvedIds: [], mateTotal: 11)
        XCTAssertEqual(dim(rep, "opening").score, 100)
        XCTAssertEqual(dim(rep, "endgame").score, 100)
        XCTAssertGreaterThan(dim(rep, "opening").score, dim(rep, "midgame").score)
        XCTAssertLessThan(dim(rep, "midgame").score, 100, "中局平均失分 1200，分数应明显偏低")
        XCTAssertTrue(dim(rep, "midgame").note.contains("1200"))
    }

    func testAttackDimensionFollowsSolvedMateCount() {
        let few = Archive.abilities(games: [], solvedIds: ["mate:m1"], mateTotal: 11)
        let many = Archive.abilities(games: [], solvedIds: Set((1...11).map { "mate:m\($0)" }), mateTotal: 11)
        XCTAssertGreaterThan(dim(many, "attack").score, dim(few, "attack").score)
        XCTAssertEqual(dim(many, "attack").score, 100, "全部通关应当是满分")
        XCTAssertTrue(dim(many, "attack").note.contains("11/11"))
    }

    func testMissedMatesPenaliseAttackScore() {
        var flags = GameFlags(); flags.missedMate = 4
        let withMisses = Archive.abilities(
            games: [record(ply: 30, result: "loss", finished: true, flags: flags)],
            solvedIds: Set((1...11).map { "mate:m\($0)" }), mateTotal: 11)
        let clean = Archive.abilities(
            games: [], solvedIds: Set((1...11).map { "mate:m\($0)" }), mateTotal: 11)
        XCTAssertLessThan(dim(withMisses, "attack").score, dim(clean, "attack").score,
                          "漏杀应当扣攻杀分")
    }

    func testDefenceDropsWithLossesAndBlunders() {
        let solid = Archive.abilities(
            games: [record(ply: 60, result: "win", finished: true)], solvedIds: [], mateTotal: 11)
        var flags = GameFlags(); flags.blunders = 6
        let leaky = Archive.abilities(
            games: [record(ply: 30, result: "loss", finished: true, flags: flags)], solvedIds: [], mateTotal: 11)
        XCTAssertGreaterThan(dim(solid, "defend").score, dim(leaky, "defend").score)
    }

    func testWinRateAndAggregates() {
        let games = [
            record(id: "a", ply: 40, result: "win", finished: true),
            record(id: "b", ply: 60, result: "win", finished: true),
            record(id: "c", ply: 50, result: "loss", finished: true),
            record(id: "d", ply: 10, result: "unfinished", finished: false)
        ]
        let rep = Archive.abilities(games: games, solvedIds: [], mateTotal: 11)
        XCTAssertEqual(rep.games, 4)
        XCTAssertEqual(rep.finished, 3)
        XCTAssertEqual(rep.wins, 2)
        XCTAssertEqual(rep.winRate, 67)
        XCTAssertEqual(rep.avgPly, 40, "平均手数应包含未完成的对局")
    }

    func testOverallScoreStaysInRange() {
        let games = [record(ply: 40, result: "loss", finished: true, evals: [
            eval(2, loss: 900, phase: "opening"),
            eval(20, loss: 900, phase: "mid"),
            eval(38, loss: 900, phase: "end")
        ])]
        let rep = Archive.abilities(games: games, solvedIds: [], mateTotal: 11)
        XCTAssertTrue((0...100).contains(rep.overall))
        for d in rep.dimensions {
            XCTAssertTrue((0...100).contains(d.score), "\(d.name) 的分数越界：\(d.score)")
        }
    }

    // MARK: - 训练推荐

    func testEmptyArchiveRecommendsStarterDrills() {
        let lib = XiangqiLibrary.loadFromBundle()
        let drills = Archive.drills(games: [], solvedIds: [], library: lib, limit: 3)
        XCTAssertFalse(drills.isEmpty)
        XCTAssertLessThanOrEqual(drills.count, 3)
        for d in drills {
            XCTAssertFalse(d.title.isEmpty)
            XCTAssertTrue(d.sceneId.contains(":"), "推荐项必须能定位到具体场景")
        }
        XCTAssertTrue(drills.contains { $0.sceneId.hasPrefix("mate:") }, "新手应当先练杀法")
    }

    func testWeakestDimensionDrivesRecommendation() {
        let lib = XiangqiLibrary.loadFromBundle()

        // 开局失分惨重 → 应当推开局库。
        // 注意要先把一步杀标成已通，否则「攻杀把握」0 分会成为最弱项，推荐就跑到杀法去了 ——
        // 这个用例第一次跑正是这么失败的。
        let tier1 = Set(lib.mates.filter { $0.tier == 1 }.map { "mate:\($0.id)" })
        let weakOpening = Archive.drills(
            games: [record(ply: 40, result: "loss", finished: true, evals: [
                eval(2, loss: 1000, phase: "opening"),
                eval(4, loss: 1000, phase: "opening"),
                eval(6, loss: 1000, phase: "opening")
            ])],
            solvedIds: tier1, library: lib, limit: 3)
        XCTAssertTrue(weakOpening.contains { $0.sceneId.hasPrefix("opening:") },
                      "开局最弱却推荐了别的：\(weakOpening.map { $0.sceneId })")

        // 杀法全没通 → 应当推杀法练习
        let weakAttack = Archive.drills(games: [], solvedIds: [], library: lib, limit: 3)
        XCTAssertTrue(weakAttack.contains { $0.sceneId.hasPrefix("mate:") })
    }

    func testRecommendationRespectsLimitAndUniqueness() {
        let lib = XiangqiLibrary.loadFromBundle()
        for limit in [1, 2, 3, 5] {
            let drills = Archive.drills(games: [], solvedIds: [], library: lib, limit: limit)
            XCTAssertLessThanOrEqual(drills.count, limit)
            XCTAssertEqual(Set(drills.map { $0.id }).count, drills.count, "推荐项有重复")
        }
    }

    func testSolvedPuzzlesAreDeprioritisedInRecommendations() {
        let lib = XiangqiLibrary.loadFromBundle()
        // 把 tier 1 的杀法都标成已通，推荐就不该再优先给它们
        let tier1 = Set(lib.mates.filter { $0.tier == 1 }.map { "mate:\($0.id)" })
        let drills = Archive.drills(games: [], solvedIds: tier1, library: lib, limit: 2)
        XCTAssertFalse(drills.contains { tier1.contains($0.sceneId) },
                       "已经通关的题目不该继续推荐：\(drills.map { $0.sceneId })")
    }

    // MARK: - 对局记录编解码

    func testGameRecordMovePairsRoundTrip() {
        let moves = [67, 40, 19, 46, 81, 63]
        let g = GameRecord(id: "x", savedAt: Date(), sceneId: "start", sceneName: "标准开局",
                           level: "hard", mode: "engine", startFEN: Rules.startFEN,
                           moves: moves, evals: [], flags: GameFlags(), result: "unfinished",
                           finished: false, ply: 3)
        XCTAssertEqual(g.movePairs, [Move(from: 67, to: 40), Move(from: 19, to: 46), Move(from: 81, to: 63)])
        XCTAssertEqual(g.resultLabel, "未完")

        // 编解码后应当完全一致（存档靠 JSON 落盘）
        let data = try? JSONEncoder().encode(g)
        XCTAssertNotNil(data)
        let back = try? JSONDecoder().decode(GameRecord.self, from: data!)
        XCTAssertEqual(back?.moves, moves)
        XCTAssertEqual(back?.sceneName, "标准开局")
    }
}
