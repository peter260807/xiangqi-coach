import XCTest
@testable import XiangqiCoach

/// 中文棋谱记法测试。
///
/// 红方纵线自右向左记作 一~九，黑方自左向右记作 1~9；
/// 同一纵线上有两个同类子时改用「前/后」。这两条规则最容易写反，
/// 所以除了定点用例，还用「每个合法着法 label 出去再 findMove 回来必须是同一手」
/// 做一轮往返验证 —— 记谱和解析只要有一边不对称，往返就会掉出来。
final class NotationTests: XCTestCase {

    private func at(_ r: Int, _ c: Int) -> Int { r * 9 + c }

    func testStandardNotationForCommonMoves() {
        let b = Rules.parse(Rules.startFEN)
        let cases: [(String, Int, Int)] = [
            // 红方：汉字数字
            ("炮二平五", at(7, 7), at(7, 4)),
            ("炮八平五", at(7, 1), at(7, 4)),
            ("马二进三", at(9, 7), at(7, 6)),
            ("马八进七", at(9, 1), at(7, 2)),
            ("车九进一", at(9, 0), at(8, 0)),
            ("车一进一", at(9, 8), at(8, 8)),
            ("兵七进一", at(6, 2), at(5, 2)),
            ("兵三进一", at(6, 6), at(5, 6)),
            ("相三进五", at(9, 6), at(7, 4)),
            ("相七进五", at(9, 2), at(7, 4)),
            ("仕四进五", at(9, 5), at(8, 4)),
            ("仕六进五", at(9, 3), at(8, 4)),
            ("帅五进一", at(9, 4), at(8, 4)),
            // 黑方：阿拉伯数字，纵线方向相反
            ("炮8平5", at(2, 7), at(2, 4)),
            ("炮2平5", at(2, 1), at(2, 4)),
            ("马8进7", at(0, 7), at(2, 6)),
            ("马2进3", at(0, 1), at(2, 2)),
            ("卒3进1", at(3, 2), at(4, 2)),
            ("卒7进1", at(3, 6), at(4, 6)),
            ("车1进1", at(0, 0), at(1, 0)),
            ("车9进1", at(0, 8), at(1, 8))
        ]
        for (expected, from, to) in cases {
            XCTAssertEqual(Notation.label(board: b, move: Move(from: from, to: to)), expected)
        }
    }

    func testRearwardMovesUseRetreatCharacter() {
        let b = Rules.parse(Rules.startFEN)
        // 先让红车走到 (7,0)，它就已经过河，再退回 (9,0)
        var after = b
        _ = Rules.makeMove(&after, Move(from: at(9, 0), to: at(0, 0)))
        XCTAssertEqual(Notation.label(board: after, move: Move(from: at(0, 0), to: at(2, 0))), "车九退二")
    }

    func testFrontAndRearDisambiguation() {
        let b = Rules.parse("....k..../........./........./........./........./....R..../....R..../........./........./....K....")
        // 红方「前」指更靠近对方的那个，也就是行号更小的
        XCTAssertEqual(Notation.label(board: b, move: Move(from: at(5, 4), to: at(5, 3))), "前车平六")
        XCTAssertEqual(Notation.label(board: b, move: Move(from: at(6, 4), to: at(6, 3))), "后车平六")
        // 两个车记法必须不同，否则解析时会产生歧义
        XCTAssertNotEqual(Notation.label(board: b, move: Move(from: at(5, 4), to: at(5, 3))),
                          Notation.label(board: b, move: Move(from: at(6, 4), to: at(6, 3))))
    }

    /// 记谱 → 反查必须还原成同一手。跑遍随机对局里的每一个合法着法。
    func testLabelAndFindMoveAreInverseOnEveryLegalMove() {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red
        var checked = 0

        for _ in 0..<25 {
            for m in Rules.legalMoves(b, side) {
                let label = Notation.label(board: b, move: m)
                XCTAssertFalse(label.contains("?"), "着法 \(m) 没能生成记谱")
                let back = Notation.findMove(board: b, side: side, text: label)
                XCTAssertEqual(back, m, "局面 \(Rules.fen(b)) 的 \(label) 反查不回原着法")
                checked += 1
            }
            guard let pick = Rules.legalMoves(b, side).randomElement() else { break }
            _ = Rules.makeMove(&b, pick)
            side = side.other
        }
        XCTAssertGreaterThan(checked, 800, "往返验证的样本量不足")
    }

    func testMovesToTextProducesNumberedLine() {
        var b = Rules.parse(Rules.startFEN)
        let line = ["炮二平五", "马8进7", "马二进三", "车9平8"]
        var moves: [Move] = []
        var side: Side = .red
        for token in line {
            guard let m = Notation.findMove(board: b, side: side, text: token) else {
                return XCTFail("开局着法 \(token) 解析失败")
            }
            moves.append(m)
            _ = Rules.makeMove(&b, m)
            side = side.other
        }
        let text = Notation.movesToText(startFEN: Rules.startFEN, moves: moves)
        XCTAssertEqual(text, "1. 炮二平五  马8进7  2. 马二进三  车9平8")
    }

    func testFindMoveRejectsIllegalAndGarbageInput() {
        let b = Rules.parse(Rules.startFEN)
        XCTAssertNil(Notation.findMove(board: b, side: .red, text: "炮二平九"), "不合法着法应返回 nil")
        XCTAssertNil(Notation.findMove(board: b, side: .red, text: "车五进三"), "盘上没有这个子")
        XCTAssertNil(Notation.findMove(board: b, side: .red, text: ""), "空串应返回 nil")
        XCTAssertNil(Notation.findMove(board: b, side: .red, text: "随便写点什么"))
        // 允许夹杂空白，大模型输出常带空格
        XCTAssertNotNil(Notation.findMove(board: b, side: .red, text: " 炮二平五 "), "应容忍首尾空白")
    }
}
