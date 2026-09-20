import Foundation

// MARK: - 基本类型

enum Side: Int8 {
    case red = 0
    case black = 1

    var other: Side { self == .red ? .black : .red }
    var label: String { self == .red ? "红方" : "黑方" }
    var shortLabel: String { self == .red ? "红" : "黑" }
}

/// 棋子编码
/// - 0 空
/// - 1...7   红：帅 仕 相 马 车 炮 兵
/// - 8...14  黑：将 士 象 马 车 炮 卒
enum Piece {
    static let empty: Int8 = 0

    /// 棋子类型，与红黑无关：0 将 1 士 2 象 3 马 4 车 5 炮 6 兵
    static let typeKing = 0
    static let typeAdvisor = 1
    static let typeElephant = 2
    static let typeHorse = 3
    static let typeRook = 4
    static let typeCannon = 5
    static let typePawn = 6

    static func isRed(_ c: Int8) -> Bool { c >= 1 && c <= 7 }
    static func side(_ c: Int8) -> Side { c <= 7 ? .red : .black }
    static func type(_ c: Int8) -> Int { Int(c <= 7 ? c - 1 : c - 8) }
    static func code(_ type: Int, _ side: Side) -> Int8 {
        Int8(side == .red ? type + 1 : type + 8)
    }

    /// 显示用汉字，索引即编码
    static let chars: [Character] = [".", "帅", "仕", "相", "马", "车", "炮", "兵",
                                     "将", "士", "象", "马", "车", "炮", "卒"]

    /// 从棋谱字符串解析用
    static let fromChar: [Character: Int8] = [
        "K": 1, "A": 2, "B": 3, "N": 4, "R": 5, "C": 6, "P": 7,
        "k": 8, "a": 9, "b": 10, "n": 11, "r": 12, "c": 13, "p": 14
    ]

    static func name(_ c: Int8) -> String {
        guard c > 0 && Int(c) < chars.count else { return "?" }
        return String(chars[Int(c)])
    }
}

struct Move: Equatable, Hashable {
    var from: Int
    var to: Int
}

// MARK: - 走子规则

/// 中国象棋规则引擎。只负责「什么能走、什么算合法」，不做搜索。
struct Rules {

    static let startFEN = "rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR"

    // 方向常量
    static let dir4: [(Int, Int)] = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    static let diag: [(Int, Int)] = [(-1, -1), (-1, 1), (1, -1), (1, 1)]
    /// 马：前两项是落点偏移，后两项是马腿偏移
    static let horse: [(Int, Int, Int, Int)] = [
        (-2, -1, -1, 0), (-2, 1, -1, 0), (2, -1, 1, 0), (2, 1, 1, 0),
        (-1, -2, 0, -1), (1, -2, 0, -1), (-1, 2, 0, 1), (1, 2, 0, 1)
    ]

    @inline(__always) static func row(_ i: Int) -> Int { i / 9 }
    @inline(__always) static func col(_ i: Int) -> Int { i % 9 }
    @inline(__always) static func index(_ r: Int, _ c: Int) -> Int { r * 9 + c }
    @inline(__always) static func inBoard(_ r: Int, _ c: Int) -> Bool {
        r >= 0 && r < 10 && c >= 0 && c < 9
    }

    // MARK: 棋盘读写

    static func parse(_ fen: String) -> [Int8] {
        var b = [Int8](repeating: 0, count: 90)
        let rows = fen.split(separator: "/")
        for r in 0..<min(10, rows.count) {
            let chars = Array(rows[r])
            for c in 0..<min(9, chars.count) {
                let ch = chars[c]
                if ch == "." { continue }
                b[r * 9 + c] = Piece.fromChar[ch] ?? 0
            }
        }
        return b
    }

    static func fen(_ b: [Int8]) -> String {
        var rows: [String] = []
        for r in 0..<10 {
            var s = ""
            for c in 0..<9 {
                let p = b[r * 9 + c]
                if p == 0 { s.append("."); continue }
                if let entry = Piece.fromChar.first(where: { $0.value == p }) {
                    s.append(entry.key)
                } else {
                    s.append(".")
                }
            }
            rows.append(s)
        }
        return rows.joined(separator: "/")
    }

    // MARK: 着法生成

    /// 生成伪合法着法（不检查走后是否被将）
    static func genMoves(_ b: [Int8], _ side: Side) -> [Move] {
        var out: [Move] = []
        out.reserveCapacity(48)
        let red = side == .red

        for i in 0..<90 {
            let p = b[i]
            if p == 0 { continue }
            if Piece.isRed(p) != red { continue }

            let r = row(i), c = col(i)
            let t = Piece.type(p)

            switch t {
            case Piece.typeKing:
                let rMin = red ? 7 : 0, rMax = red ? 9 : 2
                for d in Rules.dir4 {
                    let nr = r + d.0, nc = c + d.1
                    if nr < rMin || nr > rMax || nc < 3 || nc > 5 { continue }
                    let q = b[nr * 9 + nc]
                    if q != 0 && Piece.isRed(q) == red { continue }
                    out.append(Move(from: i, to: nr * 9 + nc))
                }

            case Piece.typeAdvisor:
                let rMin = red ? 7 : 0, rMax = red ? 9 : 2
                for d in Rules.diag {
                    let nr = r + d.0, nc = c + d.1
                    if nr < rMin || nr > rMax || nc < 3 || nc > 5 { continue }
                    let q = b[nr * 9 + nc]
                    if q != 0 && Piece.isRed(q) == red { continue }
                    out.append(Move(from: i, to: nr * 9 + nc))
                }

            case Piece.typeElephant:
                let rMin = red ? 5 : 0, rMax = red ? 9 : 4
                for d in Rules.diag {
                    let nr = r + 2 * d.0, nc = c + 2 * d.1
                    if nr < rMin || nr > rMax || nc < 0 || nc > 8 { continue }
                    if b[(r + d.0) * 9 + (c + d.1)] != 0 { continue }   // 塞象眼
                    let q = b[nr * 9 + nc]
                    if q != 0 && Piece.isRed(q) == red { continue }
                    out.append(Move(from: i, to: nr * 9 + nc))
                }

            case Piece.typeHorse:
                for h in Rules.horse {
                    let nr = r + h.0, nc = c + h.1
                    if !inBoard(nr, nc) { continue }
                    if b[(r + h.2) * 9 + (c + h.3)] != 0 { continue }   // 蹩马腿
                    let q = b[nr * 9 + nc]
                    if q != 0 && Piece.isRed(q) == red { continue }
                    out.append(Move(from: i, to: nr * 9 + nc))
                }

            case Piece.typeRook:
                for d in Rules.dir4 {
                    var nr = r + d.0, nc = c + d.1
                    while inBoard(nr, nc) {
                        let q = b[nr * 9 + nc]
                        if q == 0 {
                            out.append(Move(from: i, to: nr * 9 + nc))
                        } else {
                            if Piece.isRed(q) != red { out.append(Move(from: i, to: nr * 9 + nc)) }
                            break
                        }
                        nr += d.0; nc += d.1
                    }
                }

            case Piece.typeCannon:
                for d in Rules.dir4 {
                    var nr = r + d.0, nc = c + d.1
                    var jumped = false
                    while inBoard(nr, nc) {
                        let q = b[nr * 9 + nc]
                        if !jumped {
                            if q == 0 {
                                out.append(Move(from: i, to: nr * 9 + nc))
                            } else {
                                jumped = true   // 找到炮架
                            }
                        } else if q != 0 {
                            if Piece.isRed(q) != red { out.append(Move(from: i, to: nr * 9 + nc)) }
                            break
                        }
                        nr += d.0; nc += d.1
                    }
                }

            case Piece.typePawn:
                let fwd = red ? -1 : 1
                let pr = r + fwd
                if inBoard(pr, c) {
                    let q = b[pr * 9 + c]
                    if q == 0 || Piece.isRed(q) != red { out.append(Move(from: i, to: pr * 9 + c)) }
                }
                let crossed = red ? (r <= 4) : (r >= 5)
                if crossed {
                    for dc in [-1, 1] {
                        let nc = c + dc
                        if !inBoard(r, nc) { continue }
                        let q = b[r * 9 + nc]
                        if q == 0 || Piece.isRed(q) != red { out.append(Move(from: i, to: r * 9 + nc)) }
                    }
                }

            default: break
            }
        }
        return out
    }

    // MARK: 局面判定

    static func kingIndex(_ b: [Int8], _ side: Side) -> Int {
        let target = Piece.code(Piece.typeKing, side)
        for i in 0..<90 where b[i] == target { return i }
        return -1
    }

    /// 将帅照面（白脸将）—— 这种局面下「谁走谁输」，属于非法局面
    static func kingsFacing(_ b: [Int8]) -> Bool {
        let kr = kingIndex(b, .red), kb = kingIndex(b, .black)
        if kr < 0 || kb < 0 { return false }
        let c = col(kr)
        if c != col(kb) { return false }
        let r1 = min(row(kr), row(kb)), r2 = max(row(kr), row(kb))
        if r2 - r1 < 2 { return true }
        for r in (r1 + 1)..<r2 where b[r * 9 + c] != 0 { return false }
        return true
    }

    /// 某方是否正被将军
    ///
    /// 搜索里这个函数会被调用几十万次，所以从将/帅所在格直接反查攻击者，
    /// 而不是生成对方全部着法再比对 —— 实测快一个数量级。
    /// `inCheckByGeneration` 保留为参考实现，测试里两者要完全一致。
    static func inCheck(_ b: [Int8], _ side: Side) -> Bool {
        let ki = kingIndex(b, side)
        if ki < 0 { return true }
        let r = row(ki), c = col(ki)
        let oppRed = side.other == .red

        // 1) 车 / 炮 / 将：沿四条直线
        for d in Rules.dir4 {
            var nr = r + d.0, nc = c + d.1
            var screens = 0
            while inBoard(nr, nc) {
                let q = b[nr * 9 + nc]
                if q != 0 {
                    if Piece.isRed(q) == oppRed {
                        let t = Piece.type(q)
                        if screens == 0 {
                            if t == Piece.typeRook { return true }
                            if t == Piece.typeKing && abs(nr - r) + abs(nc - c) == 1 { return true }
                        } else {
                            if t == Piece.typeCannon { return true }
                            break
                        }
                    }
                    screens += 1
                    if screens > 1 { break }
                }
                nr += d.0; nc += d.1
            }
        }

        // 2) 马：看八个马位，并检查它蹩不蹩腿
        for h in Rules.horse {
            let hr = r + h.0, hc = c + h.1
            if !inBoard(hr, hc) { continue }
            let q = b[hr * 9 + hc]
            if q == 0 || Piece.isRed(q) != oppRed { continue }
            if Piece.type(q) != Piece.typeHorse { continue }
            // 马从 (hr,hc) 走到 (r,c) 时的马腿位置
            let legR: Int, legC: Int
            if abs(h.0) == 2 {
                legR = r + h.0 / 2; legC = hc
            } else {
                legR = hr; legC = c + h.1 / 2
            }
            if inBoard(legR, legC) && b[legR * 9 + legC] == 0 { return true }
        }

        // 3) 兵 / 卒：正面一格 + 过河后的左右
        let pawn = Piece.code(Piece.typePawn, side.other)
        let fwd = oppRed ? -1 : 1        // 对方兵推进的方向
        // 对方兵在 (r - fwd, c) 时正好攻击到 (r, c)
        let ar = r - fwd
        if inBoard(ar, c) && b[ar * 9 + c] == pawn { return true }
        for dc in [-1, 1] {
            let ac = c + dc
            if !inBoard(r, ac) { continue }
            if b[r * 9 + ac] != pawn { continue }
            // 只有过河后的兵才能横着吃
            let crossed = oppRed ? (r <= 4) : (r >= 5)
            if crossed { return true }
        }

        return false
    }

    /// 参考实现：生成对方全部着法再比对。仅用于测试交叉验证。
    static func inCheckByGeneration(_ b: [Int8], _ side: Side) -> Bool {
        let ki = kingIndex(b, side)
        if ki < 0 { return true }
        let moves = genMoves(b, side.other)
        for m in moves where m.to == ki { return true }
        return false
    }

    static func makeMove(_ b: inout [Int8], _ m: Move) -> Int8 {
        let cap = b[m.to]
        b[m.to] = b[m.from]
        b[m.from] = 0
        return cap
    }

    static func undoMove(_ b: inout [Int8], _ m: Move, _ cap: Int8) {
        b[m.from] = b[m.to]
        b[m.to] = cap
    }

    /// 完全合法着法（走后不能自己被将，也不能形成白脸将）
    static func legalMoves(_ b: [Int8], _ side: Side) -> [Move] {
        let pseudo = genMoves(b, side)
        var out: [Move] = []
        out.reserveCapacity(pseudo.count)
        var work = b
        for m in pseudo {
            let cap = makeMove(&work, m)
            if !inCheck(work, side) && !kingsFacing(work) { out.append(m) }
            undoMove(&work, m, cap)
        }
        return out
    }

    static func hasLegalMove(_ b: [Int8], _ side: Side) -> Bool {
        let pseudo = genMoves(b, side)
        var work = b
        for m in pseudo {
            let cap = makeMove(&work, m)
            let ok = !inCheck(work, side) && !kingsFacing(work)
            undoMove(&work, m, cap)
            if ok { return true }
        }
        return false
    }

    /// 某一手是否合法
    static func isLegal(_ b: [Int8], _ side: Side, _ m: Move) -> Bool {
        var work = b
        let cap = makeMove(&work, m)
        let ok = !inCheck(work, side) && !kingsFacing(work)
        undoMove(&work, m, cap)
        return ok
    }

    // MARK: 子力统计

    /// 子力价值（按类型索引：将 士 象 马 车 炮 兵）
    ///
    /// 这张表曾经多写了一个元素，导致整体错位一格 —— 马被算成 2 分、车算成 4 分、
    /// 炮算成 9 分。它决定 `material()` 的数值，进而决定「是否进入残局」的判定，
    /// 错位会让残局阶段的统计整个偏掉，而表面上看不出任何异常。
    static let worth: [Double] = [0, 2, 2, 4, 9, 4.5, 1]

    /// 场上剩余子力（不含将帅），用于判断是否进入残局
    static func material(_ b: [Int8]) -> Double {
        var total: Double = 0
        for i in 0..<90 {
            let p = b[i]
            if p == 0 { continue }
            let t = Piece.type(p)
            if t == Piece.typeKing { continue }
            total += worth[t]
        }
        return total
    }
}
