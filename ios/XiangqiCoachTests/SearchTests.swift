import XCTest
@testable import XiangqiCoach

/// 搜索引擎测试。
///
/// 重点不是「棋力够不够强」，而是「结果可不可信」：
/// 给出的着法必须合法、成杀必须真能杀、评估函数必须满足红黑镜像对称。
/// 这几条只要有一条破了，后面所有基于引擎的教练分析都会跟着失真。
final class SearchTests: XCTestCase {

    private func at(_ r: Int, _ c: Int) -> Int { r * 9 + c }

    override func setUp() {
        super.setUp()
        Engine.shared.resetForTesting()
    }

    /// 把局面做「上下翻转 + 红黑互换」—— 象棋的天然对称变换
    private func mirror(_ b: [Int8]) -> [Int8] {
        var out = [Int8](repeating: 0, count: 90)
        for i in 0..<90 where b[i] != 0 {
            let t = Piece.type(b[i])
            let opp: Side = Piece.isRed(b[i]) ? .black : .red
            out[(9 - Rules.row(i)) * 9 + Rules.col(i)] = Piece.code(t, opp)
        }
        return out
    }

    func testEvaluateIsAntisymmetricUnderMirroring() {
        let engine = Engine.shared
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red

        for _ in 0..<20 {
            let score = engine.evaluate(b)
            XCTAssertEqual(engine.evaluate(mirror(b)), -score,
                           "镜像局面的评估必须取反，局面 \(Rules.fen(b))")

            guard let pick = Rules.legalMoves(b, side).randomElement() else { break }
            _ = Rules.makeMove(&b, pick)
            side = side.other
        }
    }

    func testStartPositionEvaluationIsBalanced() {
        let score = Engine.shared.evaluate(Rules.parse(Rules.startFEN))
        XCTAssertEqual(score, 0, "开局的静态评估应当正好是均势")
    }

    /// 引擎给出的着法必须全部合法 —— 这是对外的硬承诺
    func testSearchNeverReturnsIllegalMove() {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red

        for _ in 0..<16 {
            let legal = Set(Rules.legalMoves(b, side))
            let r = Engine.shared.searchSync(board: b, side: side, maxDepth: 3, timeMs: 800)
            if let m = r.move {
                XCTAssertTrue(legal.contains(m),
                              "引擎在 \(Rules.fen(b)) 上给出了非法着法 \(m)")
                XCTAssertTrue(Rules.isLegal(b, side, m))
            } else {
                XCTAssertTrue(legal.isEmpty, "明明有合法着法，引擎却说没有 \(Rules.fen(b))")
            }
            guard let pick = Rules.legalMoves(b, side).randomElement() else { break }
            _ = Rules.makeMove(&b, pick)
            side = side.other
        }
    }

    /// 一步杀的局面必须被直接算出来，且分值落在「必胜」区间
    func testFindsMateInOne() {
        let b = Rules.parse("...pkp.../........./C......../....C..../........./........./........./........./........./...K.....")
        XCTAssertGreaterThan(Rules.legalMoves(b, .red).count, 0)
        let r = Engine.shared.searchSync(board: b, side: .red, maxDepth: 4, timeMs: 5000)
        XCTAssertGreaterThan(r.score, Engine.mate - 1000, "封闭炮杀局应当被识别为成杀")
        guard let m = r.move else { return XCTFail("没有返回着法") }

        var after = b
        _ = Rules.makeMove(&after, m)
        XCTAssertTrue(Rules.inCheck(after, .black), "推荐的着法应当将军")
        XCTAssertFalse(Rules.hasLegalMove(after, .black), "推荐的着法应当把对方将死")
    }

    /// 优势局面的分数必须是正的、劣势必须是负的（符号写反是这类引擎的经典 bug）
    func testScoreSignFollowsMaterialAdvantage() {
        // 黑方少一个车，红方走，分数应为正
        let redUp = Rules.parse("....k..../........./........./........./........./........./........./........./........./R...K....")
        let r1 = Engine.shared.searchSync(board: redUp, side: .red, maxDepth: 4, timeMs: 2000)
        XCTAssertGreaterThan(r1.score, 200, "红方多一个车，评估应当明显为正")

        // 同一局面换黑方走，分数应接近但符号相反
        let r2 = Engine.shared.searchSync(board: redUp, side: .black, maxDepth: 4, timeMs: 2000)
        XCTAssertLessThan(r2.score, 0, "换成黑方视角，评估应当为负")
    }

    /// 多路分析给出的候选不能重复，且顺序按评估从高到低
    func testTopMovesAreDistinctAndOrdered() {
        var b = Rules.parse(Rules.startFEN)
        _ = Rules.makeMove(&b, Move(from: at(7, 7), to: at(7, 4)))   // 炮二平五
        _ = Rules.makeMove(&b, Move(from: at(0, 7), to: at(2, 6)))   // 马8进7
        _ = Rules.makeMove(&b, Move(from: at(9, 7), to: at(7, 6)))   // 马二进三

        let cands = Engine.shared.topMovesSync(board: b, side: .red, count: 5, maxDepth: 4, timeMs: 2500)
        XCTAssertGreaterThanOrEqual(cands.count, 3, "至少该给出 3 个候选")
        XCTAssertEqual(Set(cands.map { $0.move }).count, cands.count, "候选着法有重复")
        for c in cands {
            XCTAssertTrue(Rules.isLegal(b, .red, c.move), "候选着法非法：\(c.label)")
            XCTAssertFalse(c.label.isEmpty)
        }
        for i in 1..<cands.count {
            XCTAssertGreaterThanOrEqual(cands[i - 1].score, cands[i].score, "候选没有按评估降序排列")
        }
    }

    func testWinRateMapping() {
        XCTAssertEqual(Engine.winRate(Engine.mate), 1, accuracy: 0.0001)
        XCTAssertEqual(Engine.winRate(-Engine.mate), 0, accuracy: 0.0001)
        XCTAssertEqual(Engine.winRate(0), 0.5, accuracy: 0.0001)
        XCTAssertGreaterThan(Engine.winRate(200), Engine.winRate(100))
        XCTAssertLessThan(Engine.winRate(-200), Engine.winRate(-100))
        // 无论多离谱的分值都夹在 [0.02, 0.98]
        XCTAssertLessThanOrEqual(Engine.winRate(50_000), 0.98)
        XCTAssertGreaterThanOrEqual(Engine.winRate(-50_000), 0.02)
    }

    func testScoreTextBuckets() {
        XCTAssertEqual(Engine.scoreText(Engine.mate), "红方已成杀")
        XCTAssertEqual(Engine.scoreText(-Engine.mate), "黑方已成杀")
        XCTAssertEqual(Engine.scoreText(0), "均势")
        XCTAssertEqual(Engine.scoreText(500), "红方明显占优")
        XCTAssertEqual(Engine.scoreText(-500), "黑方明显占优")
    }

    /// 迭代加深：给的时间越多，达到的层数不该更低（置换表复用应当让它单调）
    func testDeeperSearchReachesAtLeastAsDeep() {
        var b = Rules.parse(Rules.startFEN)
        _ = Rules.makeMove(&b, Move(from: at(7, 7), to: at(7, 4)))
        _ = Rules.makeMove(&b, Move(from: at(0, 7), to: at(2, 6)))

        let shallow = Engine.shared.searchSync(board: b, side: .red, maxDepth: 4, timeMs: 600)
        let deep = Engine.shared.searchSync(board: b, side: .red, maxDepth: 4, timeMs: 2500)
        XCTAssertGreaterThanOrEqual(deep.depth, shallow.depth)
        XCTAssertGreaterThan(deep.nodes, 0)
    }
}
