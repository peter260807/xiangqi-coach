import XCTest
@testable import XiangqiCoach

/// 搜索层「和棋意识」的测试 —— 引擎知不知道自己在绕圈。
///
/// 和 `DrawRuleTests` 是两件事，别混：
///   - `DrawRuleTests` 验的是**对局层**（判定棋局终局，用户看得到的规则）；
///   - 本文件验的是**搜索层**：引擎在搜索里就认得「走回旧局面 = 和棋」。
///
/// 分开之前实测过：20 局自对弈有 9 局（45%）以三次重复告终。对局层只能把结局
/// 判对（判和 / 判长将负），**引擎自己还是会把循环当成正分去追**，一盘赢棋就被
/// 自己走成和棋。这一层修的是那个。JS 侧对应 `tools/test-rep-search.js`。
final class RepetitionSearchTests: XCTestCase {

    private func at(_ r: Int, _ c: Int) -> Int { r * 9 + c }

    override func setUp() {
        super.setUp()
        Engine.shared.resetForTesting()
    }

    /// 强制走某一手（把其它合法着法全排除），看引擎给这一手打多少分。
    /// 这是唯一能把「某一手值多少分」单独问出来的办法 —— 只看最佳着法
    /// 是区分不出「这手被判成和棋」和「这手本来就烂」的。
    private func forcedScore(_ board: [Int8], _ side: Side, _ m: Move,
                             depth: Int, history: Engine.SearchHistory?) -> Int32 {
        Engine.shared.resetForTesting()
        let excluded = Rules.legalMoves(board, side).filter { $0 != m }
        XCTAssertEqual(excluded.count, Rules.legalMoves(board, side).count - 1,
                       "排除表必须留下且只留下目标着法")
        return Engine.shared.searchSync(board: board, side: side, maxDepth: depth,
                                        timeMs: 20000, excluded: excluded, history: history).score
    }

    private func freeSearch(_ board: [Int8], _ side: Side,
                            depth: Int, history: Engine.SearchHistory?) -> SearchResult {
        Engine.shared.resetForTesting()
        return Engine.shared.searchSync(board: board, side: side, maxDepth: depth,
                                        timeMs: 20000, history: history)
    }

    // MARK: - 反复发生在第 1 层

    /// 标准开局，红黑各一个车上下挪一趟，正好回到开局 ——
    /// 于是「再挪一次」= 回到历史里的第 1 个局面 = 重复。
    private let shuffle: [Move] = [
        Move(from: 9 * 9 + 0, to: 8 * 9 + 0),
        Move(from: 0 * 9 + 0, to: 1 * 9 + 0),
        Move(from: 8 * 9 + 0, to: 9 * 9 + 0),
        Move(from: 1 * 9 + 0, to: 0 * 9 + 0)
    ]

    func testShufflePremiseIsLegalAndReturnsToStart() {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red
        for m in shuffle {
            XCTAssertTrue(Rules.legalMoves(b, side).contains(m), "挪车往返的每一手都必须合法")
            _ = Rules.makeMove(&b, m)
            side = side.other
        }
        XCTAssertEqual(Rules.fen(b), Rules.startFEN, "挪完一轮应当正好回到标准开局")
        XCTAssertEqual(side, .red, "回到开局时该红走")
    }

    func testMoveBackIntoHistoryScoresExactlyZero() {
        let board = Rules.parse(Rules.startFEN)
        let x = shuffle[0]
        let history = Engine.SearchHistory.fromStart(shuffle)

        let withH = forcedScore(board, .red, x, depth: 4, history: history)
        let noH = forcedScore(board, .red, x, depth: 4, history: nil)

        XCTAssertEqual(withH, 0, "走回旧局面 → 必须恰好判 0 分（和棋）")
        XCTAssertNotEqual(noH, 0, "同样的着法、同样的深度，不给历史就不该是 0 分")
        XCTAssertGreaterThan(withH, noH,
                             "价值翻转方向要对：劣势方会因此开始考虑求和（带历史 \(withH) > 无历史 \(noH)）")
    }

    /// 反着再验一次：上一条先跑了「带历史」，这一条立刻跑「不带历史」并期望拿到
    /// 干净的值 —— 如果重复局面状态跨搜索泄漏了，这里就会跟着变成 0。
    func testRepetitionStateDoesNotLeakIntoTheNextSearch() {
        let board = Rules.parse(Rules.startFEN)
        _ = forcedScore(board, .red, shuffle[0], depth: 4,
                        history: Engine.SearchHistory.fromStart(shuffle))
        let clean = forcedScore(board, .red, shuffle[0], depth: 4, history: nil)
        XCTAssertNotEqual(clean, 0, "上一次带历史的搜索不该影响这一次")
    }

    // MARK: - 反复发生在第 2 层（接线真的到了子树里）

    /// 黑将只能在 d0/d1 之间来回：红车 e5 封住整条 e 线（e0/e1 都去不了），
    /// 红车 a2 封住整条 2 线（d2 去不了）→ 黑方的应手是**被迫**的，红方躲不掉。
    private let boxed = "...k...../........./R......../........./........./....R..../........./........./........./....K...."
    /// 历史走的是同一段循环的前两拍：红车 e5->e6、黑将 d0->d1
    private var boxedHistory: Engine.SearchHistory {
        Engine.SearchHistory(startFEN: boxed,
                             moves: [Move(from: at(5, 4), to: at(6, 4)),
                                     Move(from: at(0, 3), to: at(1, 3))],
                             startSide: .red)
    }
    /// 根局面 = 循环的第 3 拍（红车在 e6、黑将在 d1），该红走
    private let boxedRootFEN = "........./...k...../R......../........./........./........./....R..../........./........./....K...."
    /// 红车 e6->e5 —— 走它，黑将被迫 d1->d0，正好回到历史起点
    private let boxedRepeat = Move(from: 6 * 9 + 4, to: 5 * 9 + 4)

    func testBlackKingIsForcedToShuttle() {
        var b = Rules.parse(boxed)
        let fromD0 = Rules.legalMoves(b, .black)
        XCTAssertEqual(fromD0.count, 1, "黑将在 d0 应当只剩一条合法着法，实际 \(fromD0.map { "\($0.from)>\($0.to)" })")
        XCTAssertEqual(fromD0.first, Move(from: at(0, 3), to: at(1, 3)))

        _ = Rules.makeMove(&b, Move(from: at(0, 3), to: at(1, 3)))
        let fromD1 = Rules.legalMoves(b, .black)
        XCTAssertEqual(fromD1.count, 1, "黑将在 d1 应当只剩一条合法着法，实际 \(fromD1.map { "\($0.from)>\($0.to)" })")
        XCTAssertEqual(fromD1.first, Move(from: at(1, 3), to: at(0, 3)))
    }

    func testRepetitionTwoPliesDeepIsStillDetected() {
        // 先把历史重放一遍，确认拼出来的根局面与预期一致
        var b = Rules.parse(boxed)
        for m in boxedHistory.moves { _ = Rules.makeMove(&b, m) }
        XCTAssertEqual(Rules.fen(b), boxedRootFEN, "历史重放后的根局面与预期一致")

        // 深度 2：叶子本来只会做静态评估（红多两个车 ≈ +1800）。
        // 带历史时它应当在**第 2 层**认出重复 → 0；不带就该停在静态分上。
        // 这一条就是「push/pop 接线真的到了子树」的证据。
        let board = Rules.parse(boxedRootFEN)
        let withH = forcedScore(board, .red, boxedRepeat, depth: 2, history: boxedHistory)
        let noH = forcedScore(board, .red, boxedRepeat, depth: 2, history: nil)

        XCTAssertEqual(withH, 0, "第 2 层的重复也要认 —— 带历史应当恰好 0 分，而不是静态分的 +1800")
        XCTAssertGreaterThan(noH, 1000, "不给历史时这一手就只是静态分，实际 \(noH)")
    }

    func testWinningSideAvoidsTheRepetition() {
        let board = Rules.parse(boxedRootFEN)
        let free = freeSearch(board, .red, depth: 2, history: boxedHistory)
        XCTAssertNotNil(free.move)
        XCTAssertNotEqual(free.move, boxedRepeat, "优势方不该选那手 0 分的重复着法")
        XCTAssertGreaterThan(free.score, 10000, "优势方应当拿到胜势分，实际 \(free.score)")

        let forced = forcedScore(board, .red, boxedRepeat, depth: 2, history: boxedHistory)
        XCTAssertEqual(forced, 0, "（对照）那手重复着法确实只有 0 分")
    }

    // MARK: - 劣势方会主动去找和棋

    /// 红方只剩一个帅，还被黑双车逼得只能在 d9/d8 两格来回（`boxed` 那组是上下镜像，
    /// 被迫来回的换成了红帅），而且红方是**输定**的那一方。
    /// 历史里已经走过一轮循环 → 红帅再挪一次就等于回到旧局面。
    private let lostFEN = "....k..../........./........./........./....r..../........./........./r......../........./...K....."

    private var lostCycle: [Move] {
        [Move(from: at(9, 3), to: at(8, 3)),   // 红帅 d9->d8
         Move(from: at(7, 0), to: at(7, 1)),   // 黑车 a7->b7
         Move(from: at(8, 3), to: at(9, 3)),   // 红帅 d8->d9
         Move(from: at(7, 1), to: at(7, 0))]   // 黑车 b7->a7 —— 一轮走完正好回到起点
    }

    func testLosingSideFindsTheDraw() {
        var b = Rules.parse(lostFEN)
        var side: Side = .red
        var redMoveCounts: [Int] = [Rules.legalMoves(b, .red).count]
        for m in lostCycle {
            XCTAssertTrue(Rules.legalMoves(b, side).contains(m), "循环着法 \(m) 必须合法")
            _ = Rules.makeMove(&b, m)
            side = side.other
            if side == .red { redMoveCounts.append(Rules.legalMoves(b, .red).count) }
        }
        XCTAssertEqual(Rules.fen(b), lostFEN, "一轮走完应当回到起点")
        XCTAssertEqual(redMoveCounts, [1, 1, 1], "红帅每一步都只有一条合法着法（来回是被迫的）")

        let board = Rules.parse(lostFEN)
        let history = Engine.SearchHistory(startFEN: lostFEN, moves: lostCycle, startSide: .red)
        let withH = forcedScore(board, .red, lostCycle[0], depth: 4, history: history)
        let noH = forcedScore(board, .red, lostCycle[0], depth: 4, history: nil)

        XCTAssertLessThan(noH, -10000, "不给历史时引擎看到的是「要被将死了」，实际 \(noH)")
        XCTAssertEqual(withH, 0, "同一手棋给了历史就变成 0 分（和棋）—— 劣势方会主动求和")
        XCTAssertGreaterThan(withH, noH, "价值翻转方向要对")
    }

    // MARK: - 性能护栏

    /// 最坏情况是「一段很长」：全程不吃子、不动兵，段起点停在 0。
    /// 用字典计数是这个护栏存在的原因 —— 换成每层往回线性扫描，这里会明显变慢。
    private func quietWalk(_ targetPlies: Int) -> [Move] {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red
        var prev: Move? = nil
        var out: [Move] = []
        var seen: Set<String> = [Rules.fen(b) + "\(side)"]

        for _ in 0..<targetPlies {
            var pick: Move? = nil
            for m in Rules.legalMoves(b, side) {
                if b[m.to] != 0 { continue }                                   // 不吃子
                if Piece.type(b[m.from]) == Piece.typePawn { continue }         // 不动兵
                if let p = prev, m.from == p.to && m.to == p.from { continue }  // 不立刻回头
                var probe = b
                _ = Rules.makeMove(&probe, m)
                if seen.contains(Rules.fen(probe) + "\(side.other)") { continue }
                pick = m
                break
            }
            guard let m = pick else { break }
            _ = Rules.makeMove(&b, m)
            prev = m
            side = side.other
            out.append(m)
            seen.insert(Rules.fen(b) + "\(side)")
        }
        return out
    }

    func testLongHistoryDoesNotSlowTheSearch() {
        let walk = quietWalk(120)
        XCTAssertEqual(walk.count, 120, "应当造出 120 手不吃子、不动兵的历史，实际 \(walk.count)")

        let board = Rules.parse(Rules.startFEN)
        func timed(_ history: Engine.SearchHistory?) -> (ms: Int, score: Int32) {
            Engine.shared.resetForTesting()
            let t0 = Date()
            let r = Engine.shared.searchSync(board: board, side: .red, maxDepth: 4,
                                             timeMs: 60000, history: history)
            return (Int(Date().timeIntervalSince(t0) * 1000), r.score)
        }
        let a = timed(nil)
        let b = timed(Engine.SearchHistory.fromStart(walk))

        XCTAssertEqual(a.score, b.score, "历史不该改变这里的最佳分")
        XCTAssertLessThan(b.ms, max(50, a.ms * 3), "120 手历史不拖慢搜索：\(a.ms)ms → \(b.ms)ms")
    }
}
