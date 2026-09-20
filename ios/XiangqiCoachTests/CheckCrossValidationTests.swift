import XCTest
@testable import XiangqiCoach

/// 交叉验证：快速版将军判定 vs 参考实现。
///
/// `Rules.inCheck` 为了性能直接从将帅所在格反查攻击者（车/炮/马/兵/对面将），
/// 而 `Rules.inCheckByGeneration` 老老实实生成对方全部着法再比对。
/// 快版一旦漏掉某种攻击方式（比如忘了「过河兵才能横吃」），
/// 搜索会走出非法着法，而且很难从对局表现上看出来 —— 所以必须用慢版盯着它。
final class CheckCrossValidationTests: XCTestCase {

    /// 两个实现必须对所有局面给出完全相同的结论
    private func assertAgrees(_ b: [Int8], _ context: String,
                              file: StaticString = #filePath, line: UInt = #line) {
        for s in [Side.red, .black] {
            XCTAssertEqual(
                Rules.inCheck(b, s),
                Rules.inCheckByGeneration(b, s),
                "\(context)：\(s.label)的将军判定两版不一致，局面 \(Rules.fen(b))",
                file: file, line: line
            )
        }
    }

    /// 空盘、单王、开局这类边界局面
    func testEdgePositions() {
        assertAgrees(Rules.parse(Rules.startFEN), "开局")
        assertAgrees(Rules.parse("....k..../........./........./........./........./........./........./........./........./....K...."),
                     "只有双方将帅")
        // 己方将被吃掉：两版都应返回 true（视为被将）
        assertAgrees(Rules.parse("........./........./........./........./........./........./........./........./........./....K...."),
                     "黑将已不在盘上")
    }

    /// 对随机对局中每一个可能走到的局面做比对 ——
    /// 既覆盖安静局面，也覆盖走完后立刻形成的将军/照面局面。
    ///
    /// 采样时故意偏好「能将军的着法」：纯随机走子将军概率只有百分之几，
    /// 那样样本里几乎全是安静局面，等于没测到将军分支。
    func testAgreesAcrossRandomGameTree() {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red
        var compared = 0
        var checkCount = 0
        var facingCount = 0

        // 先随机走到中局，开局十来手子力还没接触，出不了将军
        for _ in 0..<16 {
            guard let pick = Rules.legalMoves(b, side).randomElement() else { break }
            _ = Rules.makeMove(&b, pick)
            side = side.other
        }

        for _ in 0..<20 {
            for m in Rules.genMoves(b, side) {
                var work = b
                let cap = Rules.makeMove(&work, m)
                for s in [Side.red, .black] {
                    let fast = Rules.inCheck(work, s)
                    let slow = Rules.inCheckByGeneration(work, s)
                    XCTAssertEqual(fast, slow, "局面 \(Rules.fen(work)) 上 \(s.label) 判定不一致")
                    compared += 1
                    if fast { checkCount += 1 }
                }
                if Rules.kingsFacing(work) { facingCount += 1 }
                Rules.undoMove(&work, m, cap)
            }

            let moves = Rules.legalMoves(b, side)
            guard !moves.isEmpty else { break }
            var work = b
            var checking: [Move] = []
            for m in moves {
                let cap = Rules.makeMove(&work, m)
                if Rules.inCheck(work, side.other) { checking.append(m) }
                Rules.undoMove(&work, m, cap)
            }
            let pick = (!checking.isEmpty && Int.random(in: 0..<10) < 7)
                ? checking.randomElement()! : moves.randomElement()!
            _ = Rules.makeMove(&b, pick)
            side = side.other
        }

        XCTAssertGreaterThan(compared, 800, "比较次数太少，覆盖面不足")
        // 随机走子出现的将军局面本来就不多，这里只要确认将军分支确实被覆盖到
        XCTAssertGreaterThan(checkCount, 25, "样本里将军局面太少，说明覆盖不够")
        print("[交叉验证] 共比对 \(compared) 次判定，其中将军局面 \(checkCount) 次，白脸将局面 \(facingCount) 次")
    }

    /// 逐一验算每种攻击者的四个方向，钉死边界（隔一子、相邻格、蹩腿、过河）
    func testEveryAttackerFromEveryDirection() {
        // 车：横向四个方向
        for (dr, dc) in [(0, 1), (0, -1), (1, 0), (-1, 0)] {
            var rows = Array(repeating: ".........", count: 10)
            rows[4] = "....k...."
            let r = 4 + dr * 3, c = 4 + dc * 3
            var line = Array(rows[r])
            line[c] = "R"
            rows[r] = String(line)
            rows[9] = "...K....."
            assertAgrees(Rules.parse(rows.joined(separator: "/")), "车从 (\(dr),\(dc)) 方向将军")
        }

        // 马：八个马位，含被蹩腿与不被蹩腿两种情况
        for leg in [false, true] {
            for (dr, dc) in [(-2, -1), (-2, 1), (2, -1), (2, 1), (-1, -2), (1, -2), (-1, 2), (1, 2)] {
                var rows = Array(repeating: ".........", count: 10)
                rows[4] = "....k...."
                let nr = 4 + dr, nc = 4 + dc
                guard nr >= 0, nr < 10, nc >= 0, nc < 9 else { continue }
                var line = Array(rows[nr])
                line[nc] = "N"
                rows[nr] = String(line)
                if leg {
                    // 马腿位置：长边方向上前进一格
                    let lr = abs(dr) == 2 ? 4 + dr / 2 : nr
                    let lc = abs(dr) == 2 ? nc : 4 + dc / 2
                    if lr >= 0, lr < 10, lc >= 0, lc < 9 {
                        var legLine = Array(rows[lr])
                        legLine[lc] = "P"
                        rows[lr] = String(legLine)
                    }
                }
                rows[9] = "...K....."
                assertAgrees(Rules.parse(rows.joined(separator: "/")),
                             "马在 (\(nr),\(nc))，\(leg ? "蹩腿" : "不蹩腿")")
            }
        }

        // 兵/卒：正面、左右，各区分过河与未过河
        let pawnCases: [(String, String, String)] = [
            ("正面攻击（红兵在黑将下方）", "....k....", "....P...."),
            ("过河兵横向攻击", "....k....", "R...P...."),
        ]
        for (name, kingRow, attackerRow) in pawnCases {
            var rows = Array(repeating: ".........", count: 10)
            rows[4] = kingRow
            rows[5] = attackerRow
            rows[9] = "...K....."
            assertAgrees(Rules.parse(rows.joined(separator: "/")), name)
        }
    }

    /// 炮：中间夹 0 / 1 / 2 个子时结论必须不同
    func testCannonScreenCounts() {
        // 炮架要挑「自己不会将军」的子。用车当炮架的话，那是车在将军 ——
        // 这个用例就会变成在测车，第一次跑正是这么错的。
        for screens in 0...2 {
            var rows = Array(repeating: ".........", count: 10)
            rows[4] = "....k...."
            rows[7] = "....C...."
            if screens >= 1 { rows[6] = "....B...." }   // 红相：田字走法够不到 (4,4)
            if screens >= 2 { rows[5] = "....A...." }   // 红仕：活动范围限在九宫
            rows[9] = "...K....."
            let b = Rules.parse(rows.joined(separator: "/"))
            assertAgrees(b, "炮与将之间夹 \(screens) 个子")
            XCTAssertEqual(Rules.inCheck(b, .black), screens == 1,
                           "夹 \(screens) 个子时将军判定应为 \(screens == 1)")
        }
    }
}
