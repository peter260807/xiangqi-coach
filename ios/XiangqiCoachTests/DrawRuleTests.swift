import XCTest
@testable import XiangqiCoach

/// 对局层的终局判定（判和 / 长将判负）。
///
/// 为什么值得单独一个测试文件：这是**规则**，不是搜索。判错的后果是
/// 「用户明明和棋却判他输」，比棋力弱严重得多。而且这条缺口是实测出来的 ——
/// 对局台 20 局自对弈里有 45% 的棋是被循环吃掉的（详见 docs/strength-plan.md 的 P2）。
///
/// 与 `tools/test-draw.js` 是一一对应的两份测试，改判定逻辑时两边都要过。
final class DrawRuleTests: XCTestCase {

    private func sq(_ r: Int, _ c: Int) -> Int { r * 9 + c }

    private func adjudicate(_ fen: String, _ moves: [Move]) -> Adjudication? {
        Rules.adjudicate(startFEN: fen, moves: moves)
    }

    // MARK: - 1. 长将判负

    /// 黑将 e0、红帅 f9、红车 d2。红车在 d2/f2 之间来回、每一步都照将，
    /// 黑将只能在 e0/d0 之间躲 —— 两个来回之后 d2+e0 这个局面第三次出现。
    private let perpetual = "...k...../........./....R..../........./........./........./........./........./........./.....K..."

    private func perpetualCycle() -> [Move] {
        let a = sq(2, 4), b = sq(2, 3)
        let e0 = sq(0, 3), d0 = sq(0, 4)
        return [Move(from: a, to: b), Move(from: e0, to: d0),
                Move(from: b, to: a), Move(from: d0, to: e0)]
    }

    func testPerpetualCheckLosesForChecker() {
        let cycle = perpetualCycle()

        // 先确认这个局面是「可走的」：红车确实能走到 d2
        let board = Rules.parse(perpetual)
        XCTAssertTrue(Rules.legalMoves(board, .red).contains(Move(from: sq(2, 4), to: sq(2, 3))),
                      "长将测试局面的第一手必须是合法着法，否则测的是别的东西")

        // 走 4 手只重复两次，不该判
        XCTAssertNil(adjudicate(perpetual, cycle), "4 手时该局面只出现两次，不能判终局")

        // 走 8 手 → 三次重复，红方长将判负
        let verdict = adjudicate(perpetual, cycle + cycle)
        XCTAssertNotNil(verdict)
        XCTAssertEqual(verdict?.winner, .black, "红方长将，应判黑方获胜")
        XCTAssertTrue(verdict?.reason.contains("长将") ?? false, "理由里要写明是长将：\(verdict?.reason ?? "nil")")
        XCTAssertTrue(verdict?.reason.contains("红方") ?? false, "理由里要点名是哪一方：\(verdict?.reason ?? "nil")")
    }

    /// 「红方每一手都将军、黑方每一手都不是」是长将判定的前提，
    /// 单独验一遍 —— 万一局面摆错了，上面那条测的就不是长将了。
    func testPerpetualCheckPremiseHolds() {
        var b = Rules.parse(perpetual)
        var side = Side.red
        var checks: [Bool] = []
        for m in perpetualCycle() + perpetualCycle() {
            _ = Rules.makeMove(&b, m)
            side = side.other
            checks.append(Rules.inCheck(b, side))
        }
        XCTAssertEqual(checks, [true, false, true, false, true, false, true, false])
    }

    // MARK: - 2. 纯三次重复（无人长将）→ 判和

    /// 双方各一个车在同一侧来回挪：既不吃子也不将军，纯循环。
    private let quietRep = ".....k.../........./........./........./r......../R......../........./........./........./...K....."

    private func quietCycle() -> [Move] {
        [Move(from: sq(5, 0), to: sq(5, 1)), Move(from: sq(4, 0), to: sq(4, 1)),
         Move(from: sq(5, 1), to: sq(5, 0)), Move(from: sq(4, 1), to: sq(4, 0))]
    }

    func testThreefoldWithoutCheckIsDraw() {
        let cycle = quietCycle()
        XCTAssertNil(adjudicate(quietRep, cycle), "只走 4 手（重复两次）不该判终局")

        let verdict = adjudicate(quietRep, cycle + cycle)
        XCTAssertNotNil(verdict)
        XCTAssertNil(verdict?.winner, "双方都不长将 → 判和，不能误判成某一方输")
        XCTAssertTrue(verdict?.reason.contains("三次重复") ?? false, "理由应为三次重复：\(verdict?.reason ?? "nil")")
    }

    // MARK: - 3. 「谁在长将」这个判定本身

    private func cyc(_ pairs: [(Side, Bool)]) -> [(side: Side, check: Bool)] {
        pairs.map { (side: $0.0, check: $0.1) }
    }

    func testPerpetualCheckerBranches() {
        let R: (Side, Bool) = (.red, true), r: (Side, Bool) = (.red, false)
        let B: (Side, Bool) = (.black, true), b: (Side, Bool) = (.black, false)

        XCTAssertEqual(Rules.perpetualChecker(cyc([R, b, R, b])), .red, "红全将、黑全不将 → 红方长将")
        XCTAssertEqual(Rules.perpetualChecker(cyc([r, B, r, B])), .black, "黑全将、红全不将 → 黑方长将")

        // 实战里极难摆出来的两个分支，用合成数据直接测
        XCTAssertNil(Rules.perpetualChecker(cyc([R, B, R, B])), "双方都长将 → 规则判和，不能判某一方输")
        XCTAssertNil(Rules.perpetualChecker(cyc([r, b, r, b])), "双方都不将 → null")

        XCTAssertNil(Rules.perpetualChecker(cyc([R, b, r, b])), "红方只要有一手漏了将军，就不算长将")
        XCTAssertNil(Rules.perpetualChecker([]), "空循环不能算「全都将军」")
    }

    // MARK: - 4. 60 回合无吃子

    /// 走一条「不回头的长路」：每手都不吃子、且保证任何局面出现次数 < 2。
    /// 这样 120 手内不会先撞上三次重复，能干净地测到「60 回合无吃子」这一条。
    /// `captureAtPly` 用来在中途插一手吃子，验证计数会被清零。
    private func quietWalk(fen: String, plies: Int,
                           captureAtPly: Int? = nil) -> (moves: [Move], captures: [Int], reached: Int) {
        func key(_ bb: [Int8], _ s: Side) -> String {
            Rules.fen(bb) + "|" + (s == .red ? "r" : "b")
        }
        var b = Rules.parse(fen)
        var side = Side.red
        var seen: [String: Int] = [key(b, side): 1]
        var moves: [Move] = []
        var captures: [Int] = []

        for j in 0..<plies {
            var picked: (m: Move, cap: Int8, key: String, ns: Side)?
            var bestOpts = -1
            for m in Rules.legalMoves(b, side) {
                var work = b
                let cap = Rules.makeMove(&work, m)
                let ns = side.other
                let k = key(work, ns)
                let fits = (j == captureAtPly) ? (cap != 0) : (cap == 0 && (seen[k] ?? 0) < 2)
                guard fits else { continue }
                // 一层前瞻：数落子后还剩几条「新鲜」走法，挑最多的，
                // 否则贪心会把自己走进死角（JS 侧实测剩 117 手就走不动了）。
                var opts = 0
                for m2 in Rules.legalMoves(work, ns) {
                    var w2 = work
                    let c2 = Rules.makeMove(&w2, m2)
                    let k2 = key(w2, ns.other)
                    if c2 == 0 && (seen[k2] ?? 0) < 2 { opts += 1 }
                }
                if opts > bestOpts { bestOpts = opts; picked = (m, cap, k, ns) }
            }
            guard let p = picked else { return (moves, captures, moves.count) }
            if p.cap != 0 { captures.append(j) }
            _ = Rules.makeMove(&b, p.m)
            moves.append(p.m)
            seen[p.key] = (seen[p.key] ?? 0) + 1
            side = p.ns
        }
        return (moves, captures, moves.count)
    }

    func testNoCaptureRuleConstant() {
        XCTAssertEqual(Rules.noCapturePlies, 120, "60 回合 = 双方各 60 手 = 120 个半回合")
    }

    func testSixtyMoveRuleBoundary() {
        let walk = quietWalk(fen: quietRep, plies: 121)
        XCTAssertEqual(walk.reached, 121, "走不出 121 手不吃子的路，下面两条就测不到东西了")
        XCTAssertEqual(walk.captures.count, 0)

        XCTAssertNil(adjudicate(quietRep, Array(walk.moves.prefix(119))), "119 手时还没到 60 回合")

        let verdict = adjudicate(quietRep, Array(walk.moves.prefix(120)))
        XCTAssertNotNil(verdict)
        XCTAssertNil(verdict?.winner)
        XCTAssertTrue(verdict?.reason.contains("60 回合无吃子") ?? false,
                      "理由应为 60 回合无吃子：\(verdict?.reason ?? "nil")")
    }

    func testCaptureResetsTheNoCaptureCounter() {
        let walk = quietWalk(fen: quietRep, plies: 121, captureAtPly: 0)
        XCTAssertGreaterThanOrEqual(walk.reached, 120, "对照序列要够 120 手，否则测了个空")
        XCTAssertEqual(walk.captures, [0], "对照序列应当只有第一手吃了子")

        // 长度和上面那条完全相同，只差第一手吃了个子 —— 那边判和，这里不能判
        XCTAssertNil(adjudicate(quietRep, Array(walk.moves.prefix(120))),
                     "吃过子的手数不能凭总数算「无吃子」")
    }

    // MARK: - 5. 没到终局就不该乱判

    func testNotOverStaysNil() {
        XCTAssertNil(Rules.adjudicate(startFEN: Rules.startFEN, moves: []))
        if let first = Rules.legalMoves(Rules.parse(Rules.startFEN), .red).first {
            XCTAssertNil(Rules.adjudicate(startFEN: Rules.startFEN, moves: [first]))
        } else {
            XCTFail("开局应当有合法着法")
        }
    }
}
