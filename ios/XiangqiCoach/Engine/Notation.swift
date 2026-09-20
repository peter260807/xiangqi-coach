import Foundation

/// 标准中文棋谱记法
/// 红方用汉字一~九（自右向左数），黑方用数字 1~9（自左向右数）。
enum Notation {

    private static let cnNum = ["一", "二", "三", "四", "五", "六", "七", "八", "九"]

    /// 纵线编号：红方从右往左为一~九，黑方从左往右为 1~9
    private static func fileNumber(_ col: Int, _ red: Bool) -> Int {
        red ? 9 - col : col + 1
    }

    private static func numLabel(_ n: Int, _ red: Bool) -> String {
        if !red { return String(n) }
        guard n >= 1 && n <= 9 else { return String(n) }
        return cnNum[n - 1]
    }

    /// 同一纵线上有多个同类子时用「前/中/后」区分
    private static func ordinal(_ idx: Int, _ count: Int) -> String {
        if count == 2 { return idx == 0 ? "前" : "后" }
        if count == 3 { return ["前", "中", "后"][idx] }
        let table = ["前", "二", "三", "四", "五"]
        return idx < table.count ? table[idx] : ""
    }

    /// 把一步棋写成中文记谱，如「炮二平五」「马八进七」
    static func label(board: [Int8], move: Move) -> String {
        let p = board[move.from]
        guard p != 0 else { return "?" }
        let red = Piece.isRed(p)
        let name = Piece.name(p)
        let r1 = Rules.row(move.from), c1 = Rules.col(move.from)
        let r2 = Rules.row(move.to), c2 = Rules.col(move.to)

        // 同纵线同类子 → 用前/后代替起始纵线
        var sameCol: [Int] = []
        for i in 0..<90 where board[i] == p && Rules.col(i) == c1 { sameCol.append(i) }

        var lead: String
        if sameCol.count > 1 {
            sameCol.sort { red ? Rules.row($0) < Rules.row($1) : Rules.row($0) > Rules.row($1) }
            let idx = sameCol.firstIndex(of: move.from) ?? 0
            lead = ordinal(idx, sameCol.count) + name
        } else {
            lead = name + numLabel(fileNumber(c1, red), red)
        }

        if r2 == r1 { return lead + "平" + numLabel(fileNumber(c2, red), red) }

        let forward = red ? (r2 < r1) : (r2 > r1)
        let t = Piece.type(p)
        // 马、象、士走斜线，进退后面跟目标纵线；其余跟步数
        let diagonal = (t == Piece.typeHorse || t == Piece.typeElephant || t == Piece.typeAdvisor)
        let step = diagonal ? numLabel(fileNumber(c2, red), red)
                            : numLabel(abs(r2 - r1), red)
        return lead + (forward ? "进" : "退") + step
    }

    /// 一串着法转成棋谱文本
    static func movesToText(startFEN: String, moves: [Move]) -> String {
        var b = Rules.parse(startFEN)
        var parts: [String] = []
        var turn: Side = .red
        for (i, m) in moves.enumerated() {
            let lab = label(board: b, move: m)
            if turn == .red { parts.append("\(i / 2 + 1). \(lab)") } else { parts.append(lab) }
            _ = Rules.makeMove(&b, m)
            turn = turn.other
        }
        return parts.joined(separator: "  ")
    }

    /// 按棋谱文本反查着法，用于校验大模型给的着法是否合法
    static func findMove(board: [Int8], side: Side, text: String) -> Move? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
        guard !clean.isEmpty else { return nil }
        for m in Rules.legalMoves(board, side) where label(board: board, move: m) == clean {
            return m
        }
        return nil
    }
}
