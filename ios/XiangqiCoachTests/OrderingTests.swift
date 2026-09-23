import XCTest
@testable import XiangqiCoach

/// 着法排序的测试（P1-2：SEE + 静态棋理）。JS 侧对应 `tools/test-order.js`。
///
/// 为什么排序需要独立的测试：
///   排序**不改变搜索结果**（alpha-beta 的根节点分数与着法顺序无关），
///   所以「引擎没报错、棋路看着还行」完全不能证明排序是对的 ——
///   排序错了只会让搜索变慢，或者更糟：让 SEE 悄悄改坏了棋盘。
///
/// 本文件盯三件事：
///   1. **SEE 的交换序列算得对**。期望值全部手算，不是从实现里抄的。
///   2. **SEE 把盘面原样还回来了**。它是「就地改棋盘再还原」的写法，漏一格不会抛异常，
///      只会让后面的搜索算到一盘不存在的棋 —— 这类 bug 最擅长躲在「没报错」后面。
///   3. **亏本吃真的被压到安静着法之后了**。这是这次改动的主诉求。
///
/// 另外，固定深度下的**节点数**才是排序质量的主要指标，那个在
/// `tools/order-ab-swift.js`（Swift）与 `tools/order-ab.js`（JS）里。
/// 本文件只保证「算的是对的」，不保证「算得快」。
final class OrderingTests: XCTestCase {

    private func at(_ r: Int, _ c: Int) -> Int { r * 9 + c }

    override func setUp() {
        super.setUp()
        Engine.shared.resetForTesting()
    }

    /// FEN 自证：10 行 × 9 字符。少写一个点，`Rules.parse` 照样吐 90 格，
    /// 只是整盘棋错位 —— 看上去「解析成功」。
    private func fen(_ rows: [String], file: StaticString = #filePath, line: UInt = #line) -> [Int8] {
        XCTAssertEqual(rows.count, 10, "FEN 行数不对", file: file, line: line)
        for (i, r) in rows.enumerated() {
            XCTAssertEqual(r.count, 9, "FEN 第 \(i) 行不是 9 个字符：'\(r)'", file: file, line: line)
        }
        return Rules.parse(rows.joined(separator: "/"))
    }

    private func snapshot(_ b: [Int8]) -> String { b.map { String($0) }.joined(separator: ",") }

    // MARK: - 1. SEE 的交换序列（期望值手算）

    /// 局面 A：红兵(4,4) 吃 黑车(3,4)，没人能吃回来 → 净赚一整个车 = +900
    private var A: [Int8] {
        fen(["....k....", ".........", ".........", "....r....", "....P....",
             ".........", ".........", ".........", ".........", "....K...."])
    }
    /// 局面 B：红车(5,8) 吃 黑卒(5,0)，黑卒(4,0) 吃回来 → 100 - 900 = -800
    private var B: [Int8] {
        fen(["...k.....", ".........", ".........", ".........", "p........",
             "p.......R", ".........", ".........", ".........", ".....K..."])
    }
    /// 局面 C：红车吃黑车（平换），黑卒吃回来 → 900 - 900 = 0
    private var C: [Int8] {
        fen(["...k.....", ".........", ".........", ".........", "p........",
             "r.......R", ".........", ".........", ".........", ".....K..."])
    }
    /// 局面 D：红炮(5,8) 隔着黑卒(5,5) 打掉黑车(5,0)，黑卒(4,0) 吃炮 → 900 - 450 = +450
    private var D: [Int8] {
        fen(["...k.....", ".........", ".........", ".........", "p........",
             "r....p..C", ".........", ".........", ".........", ".....K..."])
    }
    /// 局面 E：红车吃卒(100) → 黑卒吃车(900) → 红马吃卒(100)
    /// f(3)=100、f(2)=900-100=800、f(1)=100-800 = **-700**
    /// （多步交换必须算到「对方会停下来」为止）
    private var E: [Int8] {
        fen(["...k.....", ".........", ".........", ".N.......", "p........",
             "p.......R", ".........", ".........", ".........", ".....K..."])
    }

    func testSeeExchangeSequencesMatchHandComputedValues() {
        XCTAssertEqual(Engine.shared.seeCapture(A, at(4, 4), at(3, 4), .red), 900,
                       "兵吃车、无人吃回 → +900")
        XCTAssertEqual(Engine.shared.seeCapture(B, at(5, 8), at(5, 0), .red), -800,
                       "车吃兵、被兵吃回 → -800")
        XCTAssertEqual(Engine.shared.seeCapture(C, at(5, 8), at(5, 0), .red), 0,
                       "车吃车、被兵吃回 → 0（平换）")
        XCTAssertEqual(Engine.shared.seeCapture(D, at(5, 8), at(5, 0), .red), 450,
                       "炮隔架打车、被兵吃回 → +450（炮比车便宜）")
        XCTAssertEqual(Engine.shared.seeCapture(E, at(5, 8), at(5, 0), .red), -700,
                       "三步交换 → -700")
    }

    func testSeeIsSymmetricWhenFlipColors() {
        /* 把 B 局面上下翻转：红车改在 (4,8)，黑卒改在 (4,0)/(5,0) 的镜像处 */
        let flipped = fen([".....K...", ".........", ".........", ".........", "P.......r",
                           "P........", ".........", ".........", ".........", "...k....."])
        XCTAssertEqual(Engine.shared.seeCapture(flipped, at(4, 8), at(4, 0), .black), -800,
                       "同一手棋换成黑方视角，结果必须镜像一致")
    }

    // MARK: - 2. SEE 必须把盘面原样还回来

    func testSeeLeavesNoTraceOnTheBoard() {
        let cases: [(String, [Int8], Int, Int)] = [
            ("A", A, at(4, 4), at(3, 4)),
            ("B", B, at(5, 8), at(5, 0)),
            ("C", C, at(5, 8), at(5, 0)),
            ("D", D, at(5, 8), at(5, 0)),
            ("E", E, at(5, 8), at(5, 0)),
        ]
        for (name, board, from, to) in cases {
            var b = board
            let before = snapshot(b)
            _ = Engine.shared.seeCapture(b, from, to, .red)
            XCTAssertEqual(snapshot(b), before, "SEE(\(name)) 走完之后棋盘必须逐格不变")
        }
    }

    func testRepeatedSeeDoesNotCorruptTheBoard() {
        var b = E
        let before = snapshot(b)
        for _ in 0..<50 { _ = Engine.shared.seeCapture(b, at(5, 8), at(5, 0), .red) }
        XCTAssertEqual(snapshot(b), before, "连续 50 次 SEE 之后棋盘仍然必须逐格不变")
    }

    func testSeeOnEmptySquareIsZeroAndHarmless() {
        var b = A
        let before = snapshot(b)
        XCTAssertEqual(Engine.shared.seeCapture(b, at(4, 4), at(3, 3), .red), 0,
                       "对空格调用 SEE 应返回 0")
        XCTAssertEqual(snapshot(b), before, "对空格调用 SEE 不该碰棋盘")
    }

    // MARK: - 3. leastAttacker：找的必须是**最便宜**的那一个

    func testLeastAttackerPrefersTheCheapestPiece() {
        let both = fen(["...k.....", ".........", ".........", ".........", "p........",
                        "....r....", ".........", ".........", ".........", ".....K..."])
        let a = Engine.shared.leastAttacker(both, at(5, 0), .black)
        XCTAssertEqual(a?.value, 100, "同时被卒和车攻击 → 必须选卒")
        XCTAssertEqual(a?.from, at(4, 0))

        let rookOnly = fen(["...k.....", ".........", ".........", ".........", ".........",
                            "....r....", ".........", ".........", ".........", ".....K..."])
        let a2 = Engine.shared.leastAttacker(rookOnly, at(5, 0), .black)
        XCTAssertEqual(a2?.value, 900, "卒拿掉之后只剩车")
        XCTAssertEqual(a2?.from, at(5, 4))
    }

    func testHorseLegBlockingDisqualifiesTheHorse() {
        let blocked = fen(["...k.....", ".........", ".........", ".N.......", ".p.......",
                           ".........", ".........", ".........", ".........", ".....K..."])
        let free = fen(["...k.....", ".........", ".........", ".N.......", ".........",
                        ".........", ".........", ".........", ".........", ".....K..."])
        XCTAssertNil(Engine.shared.leastAttacker(blocked, at(5, 0), .red),
                     "马腿被别 → 不算攻击者")
        let a = Engine.shared.leastAttacker(free, at(5, 0), .red)
        XCTAssertEqual(a?.value, 400, "马腿空了 → 马算攻击者")
        XCTAssertEqual(a?.from, at(3, 1))
    }

    func testCannonNeedsExactlyOneScreen() {
        let withScreen = D
        let noScreen = fen(["...k.....", ".........", ".........", ".........", "p........",
                            "r.......C", ".........", ".........", ".........", ".....K..."])
        let a = Engine.shared.leastAttacker(withScreen, at(5, 0), .red)
        XCTAssertEqual(a?.value, 450, "炮隔一个架 → 算攻击者")
        XCTAssertEqual(a?.from, at(5, 8))
        XCTAssertNil(Engine.shared.leastAttacker(noScreen, at(5, 0), .red),
                     "没有炮架 → 炮不算攻击者")
    }

    func testPawnSidewaysCaptureRequiresCrossingTheRiver() {
        let notCrossed = fen(["...k.....", ".........", ".........", ".........", ".p.......",
                              ".........", ".........", ".........", ".........", ".....K..."])
        let crossed = fen(["...k.....", ".........", ".........", ".........", ".........",
                           ".p.......", ".........", ".........", ".........", ".....K..."])
        XCTAssertNil(Engine.shared.leastAttacker(notCrossed, at(4, 2), .black),
                     "未过河的黑卒不能横着吃")
        let a = Engine.shared.leastAttacker(crossed, at(5, 2), .black)
        XCTAssertEqual(a?.value, 100, "过河的黑卒可以横着吃")
        XCTAssertEqual(a?.from, at(5, 1))
    }

    func testAdvisorAndElephantAttackDiagonally() {
        let b = fen(["...k.....", ".........", ".........", ".........", ".........",
                     ".........", ".........", "...B.....", "....A....", ".....K..."])
        let a = Engine.shared.leastAttacker(b, at(7, 5), .red)
        XCTAssertEqual(a?.value, 200, "士可以斜一步吃")
        XCTAssertEqual(a?.from, at(8, 4))
        let a2 = Engine.shared.leastAttacker(b, at(5, 1), .red)
        XCTAssertEqual(a2?.value, 200, "象可以斜两步吃（象眼空）")
        XCTAssertEqual(a2?.from, at(7, 3))
    }

    /// 将/帅**不算**攻击者。
    ///
    /// 这条以前漏了，而它是实测的关键：算上它将时，SEE 会把「在敌将旁边吃子」算成
    /// -60000 级巨亏、再降到所有安静着法之后 —— SEE 反而比不改还慢。
    /// 也是「两端同一套算法」的检查点：JS 侧 `leastAttacker` 同样不算
    /// （见 `tools/test-order.js` 的同一组断言）。
    func testKingIsNotCountedAsAttacker() {
        /* 黑将 (0,4) 是 (1,4) 唯一的黑方攻击者；红车摆在 (1,4) 上等着被吃。
           红帅挪到 (9,3)，免得两将照面 —— 照面的局面不合法，测它没意义。 */
        let kingOnly = fen(["....k....", "....R....", ".........", ".........",
                            ".........", ".........", ".........", ".........",
                            ".........", "...K....."])
        XCTAssertNil(Engine.shared.leastAttacker(kingOnly, at(1, 4), .black),
                     "将不算攻击者（它是唯一能吃到的子）")

        // 自证：同一个局面上「换成车」必须能被找到 —— 否则上面那条也可能是因为
        // 棋子根本没摆上而恒为 nil，属于「因为错误的原因通过」。
        let rookThere = fen(["....k....", "....R...r", ".........", ".........",
                             ".........", ".........", ".........", ".........",
                             ".........", "...K....."])
        let ctrl = Engine.shared.leastAttacker(rookThere, at(1, 4), .black)
        XCTAssertEqual(ctrl?.value, 900, "（自证）同一局面换成黑车就能找到")
        XCTAssertEqual(ctrl?.from, at(1, 8))
    }

    // MARK: - 4. 位置价值表增量（安静着法的静态棋理）
    /// ⚠️ 这一节第一版写错过，留个记录：当时拿一张**全空**的盘去取增量，
    /// 两条断言都给出 0，而「红兵前进与黑卒前进得分相同」那条还**通过了**（0 == 0）——
    /// 「因为错误的原因通过」。所以下面用真的有棋子的局面，并额外断言值不为 0。
    private var adv: [Int8] {
        fen(["....k....", ".........", ".........", "....p....", "....P....",
             ".........", "....P....", "R........", ".........", "....K...."])
    }

    func testPstDeltaRewardsAdvancingAndMirrorsForBlack() {
        let b = adv
        XCTAssertEqual(b[at(6, 4)], Piece.code(Piece.typePawn, .red), "前提：(6,4) 是红兵")
        XCTAssertEqual(b[at(3, 4)], Piece.code(Piece.typePawn, .black), "前提：(3,4) 是黑卒")
        XCTAssertEqual(b[at(7, 0)], Piece.code(Piece.typeRook, .red), "前提：(7,0) 是红车")

        let a1 = Engine.shared.pstDelta(b, at(6, 4), at(5, 4))   // 红兵前进（未过河 → 过河）
        let a2 = Engine.shared.pstDelta(b, at(4, 4), at(3, 4))   // 红兵过河后再进
        XCTAssertGreaterThan(a1, 0, "红兵前进得正分")
        XCTAssertGreaterThan(a2, a1, "过河兵再进得分更高")

        let redAdvance = Engine.shared.pstDelta(b, at(6, 4), at(5, 4))
        let blackAdvance = Engine.shared.pstDelta(b, at(3, 4), at(4, 4))
        XCTAssertGreaterThan(redAdvance, 0)
        XCTAssertEqual(redAdvance, blackAdvance, "红兵前进与黑卒前进得分必须相同（行镜像正确）")

        XCTAssertLessThan(Engine.shared.pstDelta(b, at(7, 0), at(9, 0)), 0, "退子得负分")
        XCTAssertEqual(Engine.shared.pstDelta(b, at(9, 4), at(8, 4)), 0, "帅没有位置表")
        XCTAssertEqual(Engine.shared.pstDelta(b, at(5, 4), at(4, 4)), 0, "起点没有子时返回 0")
    }

    // MARK: - 5. 四层排序

    private func orderOf(_ board: [Int8], _ side: Side) -> [Move] {
        Engine.shared.resetForTesting()
        return Engine.shared.orderMoves(board, Rules.genMoves(board, side), 0, nil)
    }

    func testLosingCaptureIsOrderedAfterAllQuietMoves() {
        let list = orderOf(B, .red)
        guard let idx = list.firstIndex(of: Move(from: at(5, 8), to: at(5, 0))) else {
            return XCTFail("B 局面里那一手吃子应该在着法表里")
        }
        XCTAssertEqual(idx, list.count - 1,
                       "亏本吃（车吃兵被兵吃回）必须排到所有安静着法之后，实际位置 \(idx)/\(list.count)")
    }

    func testGoodCaptureIsOrderedFirst() {
        let list = orderOf(A, .red)
        let idx = list.firstIndex(of: Move(from: at(4, 4), to: at(3, 4)))
        XCTAssertEqual(idx, 0, "好吃子（兵吃车、无人吃回）应排第一位，实际 \(String(describing: idx))")
    }

    func testEqualTradeIsNotDemoted() {
        let list = orderOf(C, .red)
        let idx = list.firstIndex(of: Move(from: at(5, 8), to: at(5, 0)))
        XCTAssertEqual(idx, 0, "平换（SEE = 0）仍算「好/等吃子」，不该降级")
    }

    /// 门控自证：吃大子 / 平换时不该去算 SEE（省掉最贵的那一步）。
    /// 同时这条也证明「SEE 这条路真的被走到了」—— 否则下面那个断言会永远为真。
    ///
    /// ⚠️ 门控只能在**根节点排序这一层**断言。第一版拿 `searchSync` 去要求「一次 SEE
    /// 都不算」，结果拿到 18 次 —— 不是引擎错，是断言写错了：整棵搜索树的深处必然
    /// 还有别的「可能亏」的吃子（比如车落点被卒吃回之后，车再回头吃卒）。JS 侧
    /// `tools/test-order.js` 用的也是同一层，两端必须一致。
    func testSeeGateSkipsObviouslySafeCapturesAndRunsOnDoubtfulOnes() {
        Engine.shared.resetForTesting()
        _ = Engine.shared.orderMoves(C, Rules.genMoves(C, .red), 0, nil)
        XCTAssertEqual(Engine.shared.seeCallCount, 0,
                       "车吃车（被吃子价值 ≥ 吃子方价值）不该触发 SEE")

        Engine.shared.resetForTesting()
        _ = Engine.shared.orderMoves(B, Rules.genMoves(B, .red), 0, nil)
        XCTAssertGreaterThan(Engine.shared.seeCallCount, 0, "车吃兵（可能亏）必须触发 SEE")

        // ply 门控：浅层算、深层不算。
        // 这条是实测的产物（整棵树都算 SEE 会让中局每节点贵 19%，固定时间反而更浅），
        // 必须有断言看着 —— 否则以后有人把那个 `ply > seeMaxPly` 去掉，
        // 节点数和耗时会悄悄退回去，而所有单测照样全绿。
        // 边界两侧各测一次：ply = seeMaxPly 要算，ply = seeMaxPly + 1 不能算。
        let maxPly = Engine.seeMaxPly
        Engine.shared.resetForTesting()
        _ = Engine.shared.orderMoves(B, Rules.genMoves(B, .red), maxPly, nil)
        XCTAssertGreaterThan(Engine.shared.seeCallCount, 0,
                             "ply = seeMaxPly(\(maxPly)) 仍然算 SEE")

        Engine.shared.resetForTesting()
        _ = Engine.shared.orderMoves(B, Rules.genMoves(B, .red), maxPly + 1, nil)
        XCTAssertEqual(Engine.shared.seeCallCount, 0,
                       "ply > seeMaxPly(\(maxPly)) 之后不再算 SEE")

        // 真实搜索里 SEE 这条路确实被走到了（否则上面全是可以只测不用的死代码）
        Engine.shared.resetForTesting()
        let r3 = Engine.shared.searchSync(board: Rules.parse(Rules.startFEN), side: .red,
                                          maxDepth: 4, timeMs: 20000)
        XCTAssertGreaterThan(r3.seeCalls, 0, "（自证）真实搜索中 SEE 被调用过")
        XCTAssertNotNil(r3.move, "（自证）真实搜索返回了合法着法")
        XCTAssertGreaterThanOrEqual(r3.depth, 1)
    }

    // MARK: - 6. 排序只许变快，不许变分

    /// alpha-beta 在根节点用全窗口搜到底，拿到的**分数**与着法顺序无关。
    /// 所以「改排序前后同一局面同一深度的分数必须完全相同」是一条硬约束 ——
    /// 它同时是 SEE 不许改坏棋盘的间接证明（棋盘被改坏，分数几乎必然变化）。
    ///
    /// 这三个参考值是**改排序之前**的引擎跑出来的，JS 侧 `tools/test-order.js`
    /// 用的是同一批数字 —— 两端引擎在这里必须给出同一个答案。
    func testSearchScoreIsUnchangedByOrdering() {
        let cases: [(String, [Int8], Int32)] = [
            ("标准开局", Rules.parse(Rules.startFEN), 8),
            ("中局", Rules.parse("r.nbakar./........./.cn...n.c/p.p.p...p/......p.."
                                 + "/..P....../P...P.P.P/.C..C.N../........./RNBAKABR."), -186),
            ("残局", Rules.parse("..bakab.r/........./........./........./....P...."
                                 + "/...R...../........./....N..../........./....K...."), -220),
        ]
        for (name, board, expected) in cases {
            Engine.shared.resetForTesting()
            let r = Engine.shared.searchSync(board: board, side: .red, maxDepth: 4, timeMs: 60000)
            XCTAssertEqual(r.score, expected,
                           "\(name) 深度 4 的分数与改排序之前必须完全相同（现在 \(r.score) / 参考 \(expected)）")
        }
    }
}
