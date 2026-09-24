import XCTest
@testable import XiangqiCoach

/// 棋谱库校验。
///
/// 库里的局面全是手工编排的，最容易出的问题不是「引擎算不出杀」，
/// 而是「局面本身摆错了」—— 比如黑方开局就已经无子可动（等于随便走一步就赢），
/// 或者压根没在将军却被当成杀局。这类错误光看棋谱看不出来，必须逐条过引擎。
final class LibraryTests: XCTestCase {

    private let lib = XiangqiLibrary.loadFromBundle()

    override func setUp() {
        super.setUp()
        Engine.shared.resetForTesting()
    }

    func testLibraryIsBundledAndNonEmpty() {
        XCTAssertFalse(lib.mates.isEmpty, "library.json 没打进 App bundle，检查 ios/XiangqiCoach/Resources/")
        XCTAssertFalse(lib.openings.isEmpty, "开局库为空")
        XCTAssertFalse(lib.studies.isEmpty, "残局库为空")
        XCTAssertEqual(lib.version, 1)
    }

    func testEveryMatePuzzleIsPlayableAndActuallyWins() {
        XCTAssertFalse(lib.mates.isEmpty)
        for m in lib.mates {
            let b = Rules.parse(m.fen)
            XCTAssertEqual(b.count, 90, "\(m.name)：FEN 解析出的盘面长度不对")

            XCTAssertGreaterThan(Rules.legalMoves(b, .red).count, 0, "\(m.name)：红方无子可动")
            XCTAssertTrue(Rules.hasLegalMove(b, .black),
                          "\(m.name)：黑方开局就无子可动 —— 这是退化局面，随便走一步就赢")
            XCTAssertFalse(Rules.inCheck(b, .black), "\(m.name)：黑方开局不应已被将军")
            XCTAssertFalse(Rules.inCheck(b, .red), "\(m.name)：红方一上来就处于被将状态")
            XCTAssertFalse(Rules.kingsFacing(b), "\(m.name)：摆出了白脸将")

            let r = Engine.shared.searchSync(board: b, side: .red, maxDepth: 6, timeMs: 8000)
            XCTAssertGreaterThan(r.score, Engine.mate - 1000,
                                 "\(m.name)：引擎在 6 层内没找到成杀（实际评估 \(r.score)）")
            if let mv = r.move {
                XCTAssertTrue(Rules.isLegal(b, .red, mv), "\(m.name)：引擎返回的着法本身不合法")
                var probe = b
                _ = Rules.makeMove(&probe, mv)
                XCTAssertFalse(Rules.hasLegalMove(probe, .black) && !Rules.inCheck(probe, .black),
                               "\(m.name)：推荐的着法把黑方逼成困毙而非将死，题目描述需修正")
            }
        }
    }

    /// 杀局应当真的有一个「最优解」，而不是所有着法都一样好 ——
    /// 否则练习页给提示时就失去了意义
    func testMatePuzzlesHaveADistinctBestMove() {
        for m in lib.mates {
            let b = Rules.parse(m.fen)
            let cands = Engine.shared.topMovesSync(board: b, side: .red, count: 2, maxDepth: 5, timeMs: 3000)
            guard cands.count >= 2 else { continue }
            XCTAssertGreaterThan(cands[0].score, cands[1].score,
                                 "\(m.name)：前两个候选着法评估相同，题目没有区分度")
        }
    }

    func testEveryOpeningLineIsLegalMoveByMove() {
        XCTAssertFalse(lib.openings.isEmpty)
        for o in lib.openings {
            var b = Rules.parse(Rules.startFEN)
            var side: Side = .red
            var ply = 0
            for token in o.line.split(separator: " ").map(String.init) {
                ply += 1
                guard let m = Notation.findMove(board: b, side: side, text: token) else {
                    XCTFail("\(o.name)：第 \(ply) 手「\(token)」在盘面上不合法")
                    break
                }
                _ = Rules.makeMove(&b, m)
                side = side.other
            }
            XCTAssertGreaterThanOrEqual(ply, 4, "\(o.name)：开局谱太短，起不到演示作用")
            XCTAssertFalse(Rules.inCheck(b, .red), "\(o.name)：走完开局谱后红方被将")
            XCTAssertFalse(Rules.inCheck(b, .black), "\(o.name)：走完开局谱后黑方被将")
        }
    }

    func testEveryStudyPositionIsWellFormed() {
        XCTAssertFalse(lib.studies.isEmpty)
        for s in lib.studies {
            let b = Rules.parse(s.fen)
            XCTAssertGreaterThan(Rules.legalMoves(b, .red).count, 0, "\(s.name)：红方无子可动")
            XCTAssertTrue(Rules.hasLegalMove(b, .black), "\(s.name)：黑方无子可动")
            XCTAssertFalse(Rules.inCheck(b, .red), "\(s.name)：红方一上来就处于被将状态")
            XCTAssertFalse(Rules.kingsFacing(b), "\(s.name)：摆出了白脸将")
            XCTAssertLessThan(Rules.material(b), 60, "\(s.name)：名为残局，子力却还很多")
        }
    }

    /// 难度文案必须说得出**手数**，不能一律「多步杀」。
    ///
    /// 起因：`difficultyText` 原来是一个写死到「十」的数组 `cn[mateIn - 1]`，
    /// 11 手以上全部掉进 tier 兜底、显示「多步杀」。用 Pikafish 求解深杀之后
    /// 库里有 30 手杀，这个洞就露出来了（网页端 `XQSTORE.tierText` 同一处、同时修的）。
    func testDifficultyTextReportsMoveCount() {
        func text(_ mateIn: Int?) -> String {
            MatePuzzle(id: "t", name: "n", tier: 3, fen: Rules.startFEN,
                       idea: nil, set: "s", line: nil, mateIn: mateIn).difficultyText
        }
        XCTAssertEqual(text(1), "一步杀")
        // ⚠️ 2 手刻意是「二」不是「两」：既有文案与网页端筛选徽标都用「二」
        XCTAssertEqual(text(2), "二步杀")
        XCTAssertEqual(text(10), "十步杀")
        XCTAssertEqual(text(11), "十一步杀", "11 手原来会退化成「多步杀」")
        XCTAssertEqual(text(20), "二十步杀", "整十不加个位")
        XCTAssertEqual(text(28), "二十八步杀")
        XCTAssertEqual(text(30), "三十步杀")

        // 边界与退化
        XCTAssertNil(MatePuzzle.cnNum(0), "0 手没有中文写法")
        XCTAssertNil(MatePuzzle.cnNum(100), "超过 99 手不编造（当前库里最深 30 手）")
        XCTAssertEqual(text(nil), "多步杀", "没有 mateIn 的老条目退回 tier 文案，不能变空串")

        // 与真实库里最深的一题对一遍，确认这不是空转
        if let deepest = lib.mates.max(by: { ($0.mateIn ?? 0) < ($1.mateIn ?? 0) }),
           let n = deepest.mateIn {
            XCTAssertNotEqual(deepest.difficultyText, "多步杀",
                              "库里最深一题「\(deepest.name)」（\(n) 手）应当报出手数")
        }
    }

    func testSceneCatalogCoversWholeLibrary() {
        let scenes = SceneCatalog.all(lib)
        XCTAssertEqual(scenes.count,
                       1 + lib.allClassics.count + lib.mates.count + lib.openings.count + lib.studies.count)
        XCTAssertEqual(scenes.first?.id, "start")
        for s in scenes {
            let resolved = SceneCatalog.resolve(s)
            XCTAssertEqual(resolved.board.count, 90)
            // 开局库预摆的着法必须全部落地，否则场景显示的局面与描述不符
            if s.kind == .opening {
                XCTAssertEqual(resolved.moves.count, s.preloadLabels.count,
                               "\(s.title)：有 \(s.preloadLabels.count - resolved.moves.count) 手开局谱没能摆上去")
            }
        }
    }
}
