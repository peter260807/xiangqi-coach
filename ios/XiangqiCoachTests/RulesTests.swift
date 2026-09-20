import XCTest
@testable import XiangqiCoach

/// 规则层测试。
///
/// 象棋规则最容易写错的就是那几处「有子挡着就不能走」的地方 —— 马腿、象眼、
/// 炮架、过河兵，外加九宫限制和白脸将。这些全部由两组断言兜住：
/// 一是「开局双方合法着法数 = 44」这个公认基准，二是下面逐条定点用例。
///
/// 定点用例同时故意留出「不该出现的着法」的断言 —— 只测「能走」是不够的，
/// 马腿写反时「能走」的断言往往照样通过。
final class RulesTests: XCTestCase {

    private let start = Rules.parse(Rules.startFEN)

    private func at(_ r: Int, _ c: Int) -> Int { r * 9 + c }

    /// 用行字符串建局面（按 row0 … row9 顺序），不足 10 行自动补空行
    private func board(_ rows: String...) -> [Int8] {
        var parts = rows
        while parts.count < 10 { parts.append(".........") }
        return Rules.parse(parts.joined(separator: "/"))
    }

    // MARK: - 基准

    func testStartPositionHas44LegalMovesForBothSides() {
        XCTAssertEqual(Rules.legalMoves(start, .red).count, 44, "红方开局合法着法数应为 44")
        XCTAssertEqual(Rules.legalMoves(start, .black).count, 44, "黑方开局合法着法数应为 44")
    }

    func testStartPositionHasNoCheckAndNoFacingKings() {
        XCTAssertFalse(Rules.inCheck(start, .red))
        XCTAssertFalse(Rules.inCheck(start, .black))
        XCTAssertFalse(Rules.kingsFacing(start))
        XCTAssertTrue(Rules.hasLegalMove(start, .red))
        XCTAssertTrue(Rules.hasLegalMove(start, .black))
    }

    /// 开局每个棋子的着法数都是公认值，比总数更细，错了能直接定位到是哪种子
    func testStartPositionMoveCountByPieceType() {
        var byType: [Int: Int] = [:]
        for m in Rules.legalMoves(start, .red) {
            byType[Piece.type(start[m.from]), default: 0] += 1
        }
        XCTAssertEqual(byType[Piece.typeRook], 4, "开局每车 2 步，双车共 4")
        XCTAssertEqual(byType[Piece.typeHorse], 4, "开局每马 2 步，双马共 4")
        XCTAssertEqual(byType[Piece.typeCannon], 24, "开局每炮 12 步，双炮共 24")
        XCTAssertEqual(byType[Piece.typePawn], 5, "五个兵各 1 步")
        XCTAssertEqual(byType[Piece.typeElephant], 4, "每相 2 步，双相共 4")
        XCTAssertEqual(byType[Piece.typeAdvisor], 2, "每仕 1 步，双仕共 2")
        XCTAssertEqual(byType[Piece.typeKing], 1, "帅 1 步")
    }

    // MARK: - 马腿

    func testHorseIsBlockedByItsLeg() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            ".........",
            "....P....",   // 红兵正好压在 (5,4) 号马的腿上
            "....N....",
            ".........",
            ".........",
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(5, 4) }
        let expected: Set<Int> = [at(7, 3), at(7, 5), at(4, 2), at(4, 6), at(6, 2), at(6, 6)]
        XCTAssertEqual(Set(moves.map { $0.to }), expected, "向上两个马位应被马腿挡住")
        XCTAssertEqual(moves.count, 6, "八面威风被压掉两面")
    }

    // MARK: - 象眼与过河

    func testElephantIsBlockedByItsEye() {
        // 红相在 (5,2)，两个落点是 (7,0) 与 (7,4)，
        // 对应的象眼分别是 (6,1) 和 (6,3) —— 象眼在起点与终点的正中间，不是别的格子。
        let b = board(
            "....k....",
            ".........",
            ".........",
            ".........",
            ".........",
            "..B......",
            ".P.......",   // 堵住通往 (7,0) 的象眼
            ".........",
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(5, 2) }
        XCTAssertEqual(moves.map { $0.to }, [at(7, 4)], "(6,1) 有子时不能飞到 (7,0)")
    }

    func testElephantCannotCrossTheRiver() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            ".........",
            ".........",
            "..B......",   // 红相恰好踩在河界线上
            ".........",
            ".........",
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(5, 2) }
        XCTAssertEqual(Set(moves.map { $0.to }), Set([at(7, 0), at(7, 4)]), "相不能过河")
    }

    // MARK: - 炮

    func testCannonNeedsExactlyOneScreenToCapture() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            "....r....",   // 黑车是被吃的目标
            ".........",
            ".........",
            "....P....",   // 炮架
            "....C....",   // 红炮在 (7,4)
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(7, 4) }
        let tos = Set(moves.map { $0.to })
        XCTAssertTrue(tos.contains(at(3, 4)), "隔一个兵应当能打到黑车")
        XCTAssertFalse(tos.contains(at(5, 4)), "越过炮架后的空格不能落子")
        XCTAssertFalse(tos.contains(at(4, 4)), "越过炮架后的空格不能落子")
        XCTAssertFalse(tos.contains(at(6, 4)), "炮架是自己的子，不能吃")
        XCTAssertFalse(tos.contains(at(9, 4)), "不能吃自己的帅")
        XCTAssertEqual(moves.count, 10, "向下 1 步 + 左右各 4 步 + 吃车 1 步")
    }

    func testCannonCannotCaptureWithoutScreen() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            "....r....",   // 同一纵线上有目标，但中间没有任何炮架
            ".........",
            ".........",
            ".........",
            "....C....",
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(7, 4) }
        XCTAssertFalse(Set(moves.map { $0.to }).contains(at(3, 4)), "没有炮架时不能吃子")
    }

    // MARK: - 兵

    func testPawnBeforeRiverOnlyMovesForward() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            ".........",
            ".........",
            "..P......",   // 红兵在 (5,2)，尚未过河
            ".........",
            ".........",
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(5, 2) }
        XCTAssertEqual(moves.map { $0.to }, [at(4, 2)], "过河前只能向前一步")
    }

    func testPawnAfterRiverCanAlsoMoveSideways() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            ".........",
            "..P......",   // (4,2) 已过河
            ".........",
            ".........",
            ".........",
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(4, 2) }
        XCTAssertEqual(Set(moves.map { $0.to }), Set([at(3, 2), at(4, 1), at(4, 3)]), "过河后可平走")
    }

    func testPawnNeverMovesBackward() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            ".........",
            "..P......",
            ".........",
            ".........",
            ".........",
            ".........",
            "....K...."
        )
        let moves = Rules.genMoves(b, .red).filter { $0.from == at(4, 2) }
        XCTAssertFalse(Set(moves.map { $0.to }).contains(at(5, 2)), "兵不能后退")
    }

    // MARK: - 九宫

    func testKingAndAdvisorAreConfinedToThePalace() {
        let b = board(
            "....k....",
            ".........",
            ".........",
            ".........",
            ".........",
            ".........",
            ".........",
            ".........",
            "....A....",   // 仕在九宫中心
            "....K...."
        )
        let kingMoves = Rules.genMoves(b, .red).filter { $0.from == at(9, 4) }
        // 中路 (8,4) 被自己的仕占着，所以帅只剩左右两个方向可走 —— 而且都不能出九宫
        XCTAssertEqual(Set(kingMoves.map { $0.to }), Set([at(9, 3), at(9, 5)]),
                       "帅只能在九宫内走；中路被己方士占住时不能前进")

        let advisorMoves = Rules.genMoves(b, .red).filter { $0.from == at(8, 4) }
        XCTAssertEqual(Set(advisorMoves.map { $0.to }), Set([at(7, 3), at(7, 5), at(9, 3), at(9, 5)]),
                       "仕只能沿斜线在九宫内走")
    }

    // MARK: - 白脸将

    func testKingsFacingIsDetected() {
        let facing = board(
            "....k....", ".........", ".........", ".........", ".........",
            ".........", ".........", ".........", ".........", "....K...."
        )
        XCTAssertTrue(Rules.kingsFacing(facing), "同列且中间无子即为白脸将")

        let blocked = board(
            "....k....", ".........", ".........", ".........", ".........",
            "....R....", ".........", ".........", ".........", "....K...."
        )
        XCTAssertFalse(Rules.kingsFacing(blocked), "中间隔着车就不算照面")
    }

    func testMoveExposingKingsFacingIsIllegal() {
        let b = board(
            "....k....", ".........", ".........", ".........", ".........",
            "....R....", ".........", ".........", ".........", "....K...."
        )
        let rookMoves = Rules.legalMoves(b, .red).filter { $0.from == at(5, 4) }
        XCTAssertTrue(rookMoves.allSatisfy { Rules.col($0.to) == 4 },
                      "车一旦离开第 e 线，将帅就照面，因此所有横走都应被禁止")
        // 8 = 沿 e 线上下 7 格 + 直接吃掉对面那只将。
        // 吃将当然不是正常对局里会出现的着法，但手工摆出来的局面确实会生成它，
        // 所以如实断言成 8，而不是按直觉写成 7。
        XCTAssertEqual(rookMoves.count, 8, "只能沿 e 线上下移动")
    }

    // MARK: - 困毙

    func testStalemateIsLegalMoveAbsentWithoutCheck() {
        // 黑将 (0,4) 的三个出路分别被两辆车（控 d、f 线）和一辆车（控第 1 行）封死，
        // 但黑方并没有被将军 —— 这正是「困毙」，按中国象棋规则同样判负。
        let b = board(
            "....k....",
            "R........",
            ".........",
            ".........",
            ".........",
            "...R.R...",
            ".........",
            ".........",
            ".........",
            "...K....."
        )
        XCTAssertFalse(Rules.inCheck(b, .black), "困毙局面下黑方不应处于被将状态")
        XCTAssertFalse(Rules.hasLegalMove(b, .black), "黑方应当无子可动")
        XCTAssertTrue(Rules.legalMoves(b, .black).isEmpty)
    }

    func testCheckIsDetectedForEachAttackerType() {
        // 车
        XCTAssertTrue(Rules.inCheck(board(
            "....k....", ".........", ".........", ".........", ".........",
            "....R....", ".........", ".........", ".........", "...K....."), .black), "车将军")
        // 炮：炮架是「将与该子之间遇到的第一子」，而且炮架自己不能就是攻击者。
        // 所以这里用相当炮架 —— 摆成车的话，那是车在将军，测的就不是炮了。
        XCTAssertTrue(Rules.inCheck(board(
            "....k....", ".........", ".........", "....B....", ".........",
            "....C....", ".........", ".........", ".........", "...K....."), .black), "炮借炮架将军")
        // 同一纵线上没有炮架时，炮不构成将军
        XCTAssertFalse(Rules.inCheck(board(
            "....k....", ".........", ".........", "....C....", ".........",
            ".........", ".........", ".........", ".........", "...K....."), .black), "无炮架不应算将军")
        // 马：(2,3) 到 (0,4) 正是一个马步，马腿落在 (1,3)
        XCTAssertTrue(Rules.inCheck(board(
            "....k....", ".........", "...N.....", ".........", ".........",
            ".........", ".........", ".........", ".........", "...K....."), .black), "马将军")
        // 同一个局面，把马腿别住就不再将军
        XCTAssertFalse(Rules.inCheck(board(
            "....k....", "...P.....", "...N.....", ".........", ".........",
            ".........", ".........", ".........", ".........", "...K....."), .black), "蹩马腿后不应算将军")
        // 兵
        XCTAssertTrue(Rules.inCheck(board(
            "....k....", "....P....", ".........", ".........", ".........",
            ".........", ".........", ".........", ".........", "...K....."), .black), "兵将军")
    }

    // MARK: - 走子/撤销

    func testMakeAndUndoRestoreBoardExactly() {
        var b = Rules.parse(Rules.startFEN)
        let snapshot = b
        var side: Side = .red
        var trail: [(Move, Int8)] = []

        for _ in 0..<60 {
            guard let m = Rules.legalMoves(b, side).randomElement() else { break }
            let cap = Rules.makeMove(&b, m)
            trail.append((m, cap))
            side = side.other
        }
        XCTAssertGreaterThan(trail.count, 30, "随机对局应当能走满 30 手以上")

        for (m, cap) in trail.reversed() { Rules.undoMove(&b, m, cap) }
        XCTAssertEqual(b, snapshot, "全部撤销后棋盘必须与初始完全一致")
    }

    func testIsLegalAgreesWithLegalMovesList() {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red
        for _ in 0..<25 {
            let legal = Set(Rules.legalMoves(b, side))
            for m in Rules.genMoves(b, side) {
                XCTAssertEqual(Rules.isLegal(b, side, m), legal.contains(m),
                               "isLegal 与 legalMoves 判定不一致：\(Rules.fen(b))")
            }
            guard let pick = Rules.legalMoves(b, side).randomElement() else { break }
            _ = Rules.makeMove(&b, pick)
            side = side.other
        }
    }

    // MARK: - 子力

    func testMaterialOfStartPosition() {
        // 每方：车 9×2 + 马 4×2 + 炮 4.5×2 + 相/象 2×2 + 仕/士 2×2 + 兵/卒 1×5 = 48，
        // 双方合计 96。这个基准值同时锁住了子力价值表的索引顺序 —— 表一错位，数字立刻就变。
        XCTAssertEqual(Rules.material(start), 96, accuracy: 0.001)
    }
}
