import Foundation

// ============================================================================
// 象棋引擎的 UCI 前端 —— 「对局台」的前半截
//
// 为什么需要它：App 里在用的 Swift 引擎是个 struct，除了 App 自己没谁能驱动，
// 于是「改完搜索到底有没有变强」只能靠感觉。这个前端把**同一个**引擎包成标准
// UCI 子进程，任何对局框架（本项目 tools/match.js、Cute Chess 等）都能驱动它。
//
// 编译方式和测量台一致：xcrun swiftc 把 Engine/*.swift 和本文件链成命令行程序，
// 不经过 Xcode、不碰 App 工程。见同目录 run.sh。
//
// 协议范围（故意保持最小，够对局用）：
//   uci / isready / ucinewgame / setoption(收下不用) / position / go / quit
//   go 支持 depth、movetime；wtime/btime/movestogo 按剩余时间折算成 movetime
//   另有非标准的 perft <深度>，用来和网页版引擎的规则实现逐节点对数
//
// 一个已知限制：go 是**阻塞**执行的，所以 go 期间发来的 stop 处理不了。
// 对局台只会用 depth / movetime 两种模式，不会用到 stop，所以先这样。
// ============================================================================

/// 输出。Swift 的 print 写管道是块缓冲的，而 UCI 是「你问一句我答一句」的
/// 交互协议 —— 缓冲住就等于整个协议卡死（对局框架会一直等 readyok）。
/// 所以一律走 FileHandle（直写系统调用，不缓冲），并且不再用 print，
/// 免得两种缓冲混在一起把输出顺序弄乱。
func say(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// MARK: - 坐标

/// UCI 习惯的 a0-i9：列 a-i 自观察者左到右，行 0-9 自红方底线往上。
/// 项目内部是 r*9+c（r=0 是黑方底线），所以 rank = 9 - r。
/// 这一套和 Pikafish 一致，所以对局台能同时驱动两边。
func squareName(_ idx: Int) -> String {
    let col = Rules.col(idx), rank = 9 - Rules.row(idx)
    return String(UnicodeScalar(UInt8(97 + col))) + String(rank)
}

func squareIndex(_ token: String) -> Int? {
    let chars = Array(token)
    guard chars.count == 2,
          let ascii = chars[0].asciiValue, ascii >= 97, ascii <= 105,
          let rank = chars[1].wholeNumberValue, rank >= 0, rank <= 9 else { return nil }
    let row = 9 - rank, col = Int(ascii - 97)
    guard Rules.inBoard(row, col) else { return nil }
    return Rules.index(row, col)
}

func moveName(_ m: Move) -> String { squareName(m.from) + squareName(m.to) }

// MARK: - 局面

/// 容错解析 FEN：既吃项目自己的写法（`rnbakabnr/...` 用 `.` 填空），
/// 也吃标准写法（用数字表示连续空格、后面可跟 `w`/`b` 表示该谁走）。
/// 目标是「对局台喂什么都能收下」，而不是严格校验。
func parseFEN(_ text: String) -> ([Int8], Side)? {
    let fields = text.split(separator: " ").map(String.init)
    guard let boardField = fields.first else { return nil }

    var board = [Int8](repeating: 0, count: 90)
    let rows = boardField.split(separator: "/")
    guard rows.count == 10 else { return nil }

    for (r, rowText) in rows.enumerated() {
        var c = 0
        for ch in rowText {
            if let digit = ch.wholeNumberValue, ch.isNumber {
                c += digit
                continue
            }
            guard c < 9 else { return nil }
            if ch != "." { board[r * 9 + c] = Piece.fromChar[ch] ?? 0 }
            c += 1
        }
        guard c == 9 else { return nil }
    }

    // 第二个字段是走子方：标准 FEN 用 w/b（w = 红），也允许 r
    var side: Side = .red
    if fields.count > 1 {
        switch fields[1].lowercased() {
        case "b", "black": side = .black
        default: side = .red
        }
    }
    return (board, side)
}

/// 对局状态：棋盘 + 该谁走 + 走到这里的历史
struct Session {
    var board = Rules.parse(Rules.startFEN)
    var side: Side = .red
    var moves: [Move] = []
    /// 这一局的起始局面。`position fen` 会改它 —— 搜索里的重复判定要靠它重建历史，
    /// 少了它，历史会被按标准开局重放，判出来的「重复」全是假的。
    var startFEN = Rules.startFEN
    var startSide: Side = .red

    mutating func resetToStart() {
        board = Rules.parse(Rules.startFEN)
        side = .red
        startFEN = Rules.startFEN
        startSide = .red
        moves = []
    }

    /// 走到当前局面为止的历史，交给搜索做重复判定用
    var searchHistory: Engine.SearchHistory? {
        moves.isEmpty ? nil
                      : Engine.SearchHistory(startFEN: startFEN, moves: moves, startSide: startSide)
    }

    /// 查找并执行一手 UCI 着法。只接受**真合法**着法 —— 宁可报错也不要
    /// 走出非法棋把对局台弄脏（对局台那边也会独立复验一次，两道关）
    mutating func play(uci: String) -> Bool {
        guard uci.count == 4,
              let from = squareIndex(String(uci.prefix(2))),
              let to = squareIndex(String(uci.suffix(2))) else { return false }
        let target = Move(from: from, to: to)
        guard Rules.legalMoves(board, side).contains(target) else { return false }
        _ = Rules.makeMove(&board, target)
        moves.append(target)
        side = side.other
        return true
    }

    /// `position startpos [moves ...]` / `position fen <fen...> [moves ...]`
    mutating func setPosition(_ tokens: [String]) {
        var i = 0
        if i < tokens.count, tokens[i] == "startpos" {
            resetToStart()
            i += 1
        } else if i < tokens.count, tokens[i] == "fen" {
            i += 1
            var fields: [String] = []
            while i < tokens.count, tokens[i] != "moves" { fields.append(tokens[i]); i += 1 }
            guard let parsed = parseFEN(fields.joined(separator: " ")) else {
                say("info string 无法解析的 FEN：\(fields.joined(separator: " "))")
                return
            }
            board = parsed.0
            side = parsed.1
            startFEN = fields[0]     // 只取棋盘那一段（Rules.parse 只认棋盘串）
            startSide = parsed.1
            moves = []
        } else {
            say("info string position 只支持 startpos / fen")
            return
        }

        if i < tokens.count, tokens[i] == "moves" {
            i += 1
            while i < tokens.count {
                if !play(uci: tokens[i]) {
                    say("info string 非法着法，已忽略：\(tokens[i])（该 \(side.label) 走）")
                }
                i += 1
            }
        }
    }
}

// MARK: - perft：和网页版引擎逐节点对数

/// 规则层的交叉验证用。本项目有两份独立的规则实现（Swift / JS），
/// 棋力改动都建立在「两边规则一致」这个前提上 —— 这个命令就是拿来验它的。
func perft(_ board: inout [Int8], _ side: Side, _ depth: Int) -> UInt64 {
    if depth == 0 { return 1 }
    let moves = Rules.legalMoves(board, side)
    if depth == 1 { return UInt64(moves.count) }
    var total: UInt64 = 0
    for m in moves {
        let cap = Rules.makeMove(&board, m)
        total += perft(&board, side.other, depth - 1)
        Rules.undoMove(&board, m, cap)
    }
    return total
}

// MARK: - go

struct GoLimit {
    var depth: Int = 64
    var movetime: Int = 0
}

func parseGo(_ tokens: [String], side: Side) -> GoLimit {
    var limit = GoLimit()
    var wtime = 0, btime = 0, movestogo = 0
    var i = 0
    while i < tokens.count {
        let value = i + 1 < tokens.count ? Int(tokens[i + 1]) : nil
        switch tokens[i] {
        case "depth":      limit.depth = value ?? limit.depth; i += 2
        case "movetime":   limit.movetime = value ?? 0; i += 2
        case "wtime":      wtime = value ?? 0; i += 2
        case "btime":      btime = value ?? 0; i += 2
        case "movestogo":  movestogo = value ?? 0; i += 2
        case "infinite":   limit.depth = 64; limit.movetime = 0; i += 1
        // 收下但不实现，别把后面的字段吃掉
        case "nodes", "winc", "binc", "mate", "searchmoves", "ponder": i += 2
        default: i += 1
        }
    }
    if limit.movetime == 0 && (wtime > 0 || btime > 0) {
        let remain = side == .red ? wtime : btime
        let slices = movestogo > 0 ? movestogo : 30
        limit.movetime = max(50, remain / max(1, slices))
    }
    if limit.movetime == 0 && limit.depth >= 64 { limit.movetime = 1000 }
    return limit
}

// MARK: - 主循环

var session = Session()
say("id name XiangqiCoach-Swift")
say("id author XiangqiCoach")
say("option name Hash type spin default 8 min 1 max 1024")

while let raw = readLine(strippingNewline: true) {
    let line = raw.trimmingCharacters(in: .whitespaces)
    if line.isEmpty { continue }
    let tokens = line.split(separator: " ").map(String.init)

    switch tokens[0] {
    case "uci":
        say("uciok")

    case "isready":
        say("readyok")

    case "ucinewgame":
        Engine.shared.resetForTesting()
        session.resetToStart()

    case "setoption":
        break   // 收下就好，目前没有可配的选项

    case "position":
        session.setPosition(Array(tokens.dropFirst()))

    case "go":
        let limit = parseGo(Array(tokens.dropFirst()), side: session.side)
        let start = DispatchTime.now().uptimeNanoseconds
        Engine.shared.resetForTesting()   // 每一手都从干净的置换表开始，A/B 才公平
        let result = Engine.shared.searchSync(board: session.board, side: session.side,
                                             maxDepth: limit.depth, timeMs: limit.movetime,
                                             history: session.searchHistory)
        let spentMs = Int((DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)

        guard let best = result.move else {
            say("bestmove 0000")   // 无子可动：对局台会先判终局，正常走不到这里
            continue
        }
        let nps = spentMs > 0 ? result.nodes / spentMs : result.nodes   // 节点/毫秒 = 千节点/秒
        say("info depth \(result.depth) score cp \(result.score) nodes \(result.nodes)"
            + " time \(spentMs) nps \(nps) pv \(moveName(best))")
        say("info string 中文记谱 \(Notation.label(board: session.board, move: best))")
        say("bestmove \(moveName(best))")

    case "perft":
        let depth = tokens.count > 1 ? (Int(tokens[1]) ?? 1) : 1
        let start = DispatchTime.now().uptimeNanoseconds
        var work = session.board
        let total = perft(&work, session.side, depth)
        let spentMs = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        // 逐根着法也报一遍：总数对不上时，能直接看出是哪一手分叉的
        for m in Rules.legalMoves(session.board, session.side) {
            var b2 = session.board
            let cap = Rules.makeMove(&b2, m)
            let sub = depth > 1 ? perft(&b2, session.side.other, depth - 1) : 1
            Rules.undoMove(&b2, m, cap)
            say("perft-move \(moveName(m)) \(sub)")
        }
        say("perft \(depth) nodes \(total) time \(Int(spentMs))")

    case "quit":
        exit(0)

    default:
        // stop / ponderhit / debug 之类收下不做声，免得污染协议输出
        break
    }
}
