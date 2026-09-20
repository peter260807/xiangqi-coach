import Foundation

/// 搜索等级：深度越大、容错越小，越接近「不留情」
struct SearchLevel {
    let key: String
    let label: String
    let depth: Int
    let timeMs: Int
    let slack: Int32   // 入门档会挑分数接近的着法，故意留破绽

    static let all: [SearchLevel] = [
        SearchLevel(key: "easy",   label: "入门", depth: 1,  timeMs: 600,  slack: 320),
        SearchLevel(key: "normal", label: "初级", depth: 3,  timeMs: 1200, slack: 110),
        SearchLevel(key: "hard",   label: "中级", depth: 5,  timeMs: 2200, slack: 35),
        SearchLevel(key: "expert", label: "高级", depth: 8,  timeMs: 3500, slack: 0),
        SearchLevel(key: "master", label: "大师", depth: 12, timeMs: 6000, slack: 0)
    ]

    static func named(_ key: String) -> SearchLevel {
        all.first { $0.key == key } ?? all[2]
    }
}

struct SearchResult {
    var move: Move?
    var score: Int32 = 0
    var depth: Int = 0
    var nodes: Int = 0
}

struct CandidateMove {
    var move: Move
    var score: Int32
    var depth: Int
    var label: String
}

/// 搜索引擎：Alpha-Beta + 置换表 + 静态搜索 + 杀手着法
///
/// 所有对外入口都串行跑在同一条后台队列上，保证 UI 不卡，
/// 同时避免多个搜索同时改内部状态。
final class Engine {

    static let shared = Engine()

    static let mate: Int32 = 200_000
    static let infinite: Int32 = 100_000_000

    private let queue = DispatchQueue(label: "com.peter260807.xiangqi.engine", qos: .userInitiated)

    // MARK: Zobrist

    private var zobrist: [[UInt64]] = []
    private var zSide: UInt64 = 0
    private var hash: UInt64 = 0

    // MARK: 置换表

    private struct TTEntry {
        var key: UInt64 = 0
        var score: Int32 = 0
        var depth: Int8 = -1
        var flag: Int8 = 0
        var from: Int8 = -1
        var to: Int8 = -1
    }
    private let ttBits = 18
    private var ttMask: Int { (1 << ttBits) - 1 }
    private var tt: [TTEntry]

    private let flagExact: Int8 = 0
    private let flagLower: Int8 = 1
    private let flagUpper: Int8 = 2

    // MARK: 启发信息

    private var killers: [(Move?, Move?)] = []
    private var history = [Int32](repeating: 0, count: 90 * 90)

    // MARK: 时间与节点

    private var nodes = 0
    private var deadline: UInt64 = 0
    private var aborted = false

    private init() {
        tt = [TTEntry](repeating: TTEntry(), count: 1 << ttBits)
        buildZobrist()
    }

    private func buildZobrist() {
        var seed: UInt64 = 0x9E3779B97F4A7C15
        func next() -> UInt64 {
            seed ^= seed << 13
            seed ^= seed >> 7
            seed ^= seed << 17
            return seed
        }
        zobrist = (0..<15).map { _ in (0..<90).map { _ in next() } }
        zSide = next()
    }

    private func computeHash(_ b: [Int8], _ side: Side) -> UInt64 {
        var h: UInt64 = 0
        for i in 0..<90 where b[i] != 0 { h ^= zobrist[Int(b[i])][i] }
        if side == .black { h ^= zSide }
        return h
    }

    /// 外部（界面）在别处改过棋盘后，用它对齐哈希
    func syncHash(_ b: [Int8], _ side: Side) {
        queue.sync { self.hash = self.computeHash(b, side) }
    }

    @inline(__always)
    private func doMove(_ b: inout [Int8], _ m: Move) -> Int8 {
        let p = b[m.from], cap = b[m.to]
        if cap != 0 { hash ^= zobrist[Int(cap)][m.to] }
        hash ^= zobrist[Int(p)][m.from] ^ zobrist[Int(p)][m.to]
        hash ^= zSide
        b[m.to] = p
        b[m.from] = 0
        return cap
    }

    @inline(__always)
    private func undo(_ b: inout [Int8], _ m: Move, _ cap: Int8) {
        let p = b[m.to]
        b[m.from] = p
        b[m.to] = cap
        hash ^= zSide
        hash ^= zobrist[Int(p)][m.from] ^ zobrist[Int(p)][m.to]
        if cap != 0 { hash ^= zobrist[Int(cap)][m.to] }
    }

    // MARK: 局面评估

    /// 子力价值（厘兵）
    private static let pieceValue: [Int32] = [60000, 200, 200, 400, 900, 450, 100]

    /// 位置价值表（红方视角，第 0 行是对方底线；黑方按行镜像）
    private static let pstPawn: [[Int32]] = [
        [  0,  0,  0,  0,  0,  0,  0,  0,  0],
        [  0,  0,  0,  0,  0,  0,  0,  0,  0],
        [ 35, 45, 55, 70, 80, 70, 55, 45, 35],
        [ 25, 35, 45, 60, 70, 60, 45, 35, 25],
        [ 15, 20, 28, 40, 48, 40, 28, 20, 15],
        [  6,  8, 10, 14, 18, 14, 10,  8,  6],
        [  0,  0,  0,  0,  0,  0,  0,  0,  0],
        [  0,  0,  0,  0,  0,  0,  0,  0,  0],
        [  0,  0,  0,  0,  0,  0,  0,  0,  0],
        [  0,  0,  0,  0,  0,  0,  0,  0,  0]
    ]
    private static let pstHorse: [[Int32]] = [
        [  0, -4,  0,  0,  0,  0,  0, -4,  0],
        [  0,  2,  4,  6,  6,  6,  4,  2,  0],
        [  2,  6, 10, 12, 14, 12, 10,  6,  2],
        [  4,  8, 14, 18, 20, 18, 14,  8,  4],
        [  4, 10, 16, 22, 24, 22, 16, 10,  4],
        [  2,  8, 14, 20, 22, 20, 14,  8,  2],
        [  0,  6, 12, 16, 18, 16, 12,  6,  0],
        [  0,  4,  8, 10, 10, 10,  8,  4,  0],
        [  0,  0,  2,  4,  4,  4,  2,  0,  0],
        [ -6, -4,  0,  2,  2,  2,  0, -4, -6]
    ]
    private static let pstCannon: [[Int32]] = [
        [  6,  4,  0, -6, -8, -6,  0,  4,  6],
        [  6,  6,  2,  2,  2,  2,  2,  6,  6],
        [  4,  6,  8, 10, 12, 10,  8,  6,  4],
        [  2,  4,  6,  8, 10,  8,  6,  4,  2],
        [  2,  4,  6,  8,  8,  8,  6,  4,  2],
        [  2,  4,  6,  8,  8,  8,  6,  4,  2],
        [  2,  4,  6,  8, 10,  8,  6,  4,  2],
        [  0,  2,  4,  6,  8,  6,  4,  2,  0],
        [  0,  0,  2,  4,  4,  4,  2,  0,  0],
        [  0,  0,  0,  0,  0,  0,  0,  0,  0]
    ]
    private static let pstRook: [[Int32]] = [
        [  8, 10, 10, 12, 12, 12, 10, 10,  8],
        [ 10, 12, 12, 14, 14, 14, 12, 12, 10],
        [  6,  8, 10, 12, 14, 12, 10,  8,  6],
        [  6,  8, 10, 12, 14, 12, 10,  8,  6],
        [  4,  6, 10, 12, 14, 12, 10,  6,  4],
        [  4,  6, 10, 12, 14, 12, 10,  6,  4],
        [  2,  6,  8, 10, 12, 10,  8,  6,  2],
        [  2,  4,  6,  8, 10,  8,  6,  4,  2],
        [  0,  2,  4,  6,  8,  6,  4,  2,  0],
        [  0,  0,  2,  4,  4,  4,  2,  0,  0]
    ]

    /// 红方视角的静态评估
    func evaluate(_ b: [Int8]) -> Int32 {
        var s: Int32 = 0
        for i in 0..<90 {
            let p = b[i]
            if p == 0 { continue }
            let red = Piece.isRed(p)
            let t = Piece.type(p)
            var v = Engine.pieceValue[t]
            let r = Rules.row(i), c = Rules.col(i)
            switch t {
            case Piece.typePawn:   v += Engine.pstPawn[red ? r : 9 - r][c]
            case Piece.typeHorse:  v += Engine.pstHorse[red ? r : 9 - r][c]
            case Piece.typeCannon: v += Engine.pstCannon[red ? r : 9 - r][c]
            case Piece.typeRook:   v += Engine.pstRook[red ? r : 9 - r][c]
            default: break
            }
            s += red ? v : -v
        }
        return s
    }

    // MARK: 着法排序

    private func orderMoves(_ b: [Int8], _ moves: [Move], _ ply: Int, _ ttMove: Move?) -> [Move] {
        let k = killers[min(ply, 63)]
        var scored: [(Int32, Move)] = []
        scored.reserveCapacity(moves.count)
        for m in moves {
            var s: Int32 = 0
            let cap = b[m.to]
            if let t = ttMove, t == m {
                s = 100_000_000
            } else if cap != 0 {
                s = 10_000_000 + Engine.pieceValue[Piece.type(cap)] * 16 - Engine.pieceValue[Piece.type(b[m.from])]
            } else if let k0 = k.0, k0 == m {
                s = 9_000_000
            } else if let k1 = k.1, k1 == m {
                s = 8_900_000
            } else {
                s = history[m.from * 90 + m.to]
            }
            scored.append((s, m))
        }
        scored.sort { $0.0 > $1.0 }
        return scored.map { $0.1 }
    }

    // MARK: 计时

    private func nowMs() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }

    private func checkTime() {
        if (nodes & 511) == 0 && nowMs() > deadline { aborted = true }
    }

    // MARK: 静态搜索

    private func quiesce(_ b: inout [Int8], _ side: Side, _ alphaIn: Int32, _ beta: Int32, _ ply: Int, _ qd: Int) -> Int32 {
        checkTime()
        if aborted { return 0 }
        nodes += 1

        let sign: Int32 = side == .red ? 1 : -1
        let stand = sign * evaluate(b)
        var alpha = alphaIn
        if stand >= beta { return beta }
        if stand > alpha { alpha = stand }
        if qd <= 0 { return alpha }

        let all = Rules.genMoves(b, side)
        var caps: [Move] = []
        for m in all where b[m.to] != 0 { caps.append(m) }
        let ordered = orderMoves(b, caps, min(ply, 63), nil)

        var best = stand
        for m in ordered {
            let cap = doMove(&b, m)
            if Rules.inCheck(b, side) || Rules.kingsFacing(b) {
                undo(&b, m, cap)
                continue
            }
            let sc = -quiesce(&b, side.other, -beta, -alpha, ply + 1, qd - 1)
            undo(&b, m, cap)
            if aborted { return 0 }
            if sc > best { best = sc }
            if best > alpha { alpha = best }
            if alpha >= beta { break }
        }
        return best
    }

    // MARK: 主搜索

    private func negamax(_ b: inout [Int8], _ side: Side, _ depth: Int, _ alphaIn: Int32, _ beta: Int32, _ ply: Int) -> Int32 {
        checkTime()
        if aborted { return 0 }
        nodes += 1

        let alphaOrig = alphaIn
        var alpha = alphaIn
        let plyKey = min(ply, 63)
        let h = hash
        // 注意：必须用 truncatingIfNeeded。UInt64 随机哈希有一半概率大于 Int.max，
        // 直接 Int(h) 会触发运行时断言崩溃。
        let slot = Int(truncatingIfNeeded: h) & ttMask

        var ttMove: Move? = nil
        let entry = tt[slot]
        if entry.key == h {
            if entry.from >= 0 {
                ttMove = Move(from: Int(entry.from), to: Int(entry.to))
            }
            if Int(entry.depth) >= depth && ply > 0 {
                var hs = entry.score
                if hs > Engine.mate - 1000 { hs -= Int32(ply) }
                else if hs < -Engine.mate + 1000 { hs += Int32(ply) }
                if entry.flag == flagExact { return hs }
                if entry.flag == flagLower && hs >= beta { return hs }
                if entry.flag == flagUpper && hs <= alpha { return hs }
            }
        }

        if depth <= 0 { return quiesce(&b, side, alpha, beta, ply, 8) }

        let raw = Rules.genMoves(b, side)
        let moves = orderMoves(b, raw, plyKey, ttMove)

        var best = -Engine.infinite
        var bestMove: Move? = nil
        var anyLegal = false
        var searchedOne = false

        for m in moves {
            let cap = doMove(&b, m)
            if Rules.inCheck(b, side) || Rules.kingsFacing(b) {
                undo(&b, m, cap)
                continue
            }
            anyLegal = true

            var sc: Int32
            if !searchedOne {
                // 首着必须用全窗口：此时 alpha 可能仍是 -infinite
                sc = -negamax(&b, side.other, depth - 1, -beta, -alpha, ply + 1)
            } else {
                sc = -negamax(&b, side.other, depth - 1, -alpha - 1, -alpha, ply + 1)
                if sc > alpha && sc < beta {
                    sc = -negamax(&b, side.other, depth - 1, -beta, -alpha, ply + 1)
                }
            }
            searchedOne = true
            undo(&b, m, cap)
            if aborted { return 0 }

            if sc > best { best = sc; bestMove = m }
            if best > alpha { alpha = best }
            if alpha >= beta {
                if cap == 0 {
                    let kk = killers[plyKey]
                    if kk.0 != m { killers[plyKey] = (m, kk.0) }
                    history[m.from * 90 + m.to] += Int32(depth * depth)
                }
                break
            }
        }

        if !anyLegal { return -Engine.mate + Int32(ply) }

        var store = best
        if store > Engine.mate - 1000 { store += Int32(ply) }
        else if store < -Engine.mate + 1000 { store -= Int32(ply) }
        let flag: Int8 = best <= alphaOrig ? flagUpper : (best >= beta ? flagLower : flagExact)
        var te = TTEntry()
        te.key = h
        te.score = store
        te.depth = Int8(clamping: depth)
        te.flag = flag
        te.from = Int8(bestMove?.from ?? -1)
        te.to = Int8(bestMove?.to ?? -1)
        tt[slot] = te

        return best
    }

    // MARK: 根节点

    private func prepare() {
        killers = Array(repeating: (nil, nil), count: 64)
        history = [Int32](repeating: 0, count: 90 * 90)
        nodes = 0
        aborted = false
        // 置换表按槽位残留，键不匹配会被忽略，不清空也安全。
    }

    private func rootMoves(_ b: [Int8], _ side: Side, excluded: [Move]) -> [Move] {
        let all = Rules.genMoves(b, side)
        var work = b
        var res: [Move] = []
        for m in all {
            if excluded.contains(m) { continue }
            let cap = Rules.makeMove(&work, m)
            let ok = !Rules.inCheckByGeneration(work, side) && !Rules.kingsFacing(work)
            Rules.undoMove(&work, m, cap)
            if ok { res.append(m) }
        }
        return res
    }

    private func rootSearch(board: [Int8], side: Side, maxDepth: Int, timeMs: Int, excluded: [Move]) -> SearchResult {
        var b = board
        hash = computeHash(b, side)
        deadline = nowMs() + UInt64(max(80, timeMs))

        var moves = rootMoves(b, side, excluded: excluded)
        if moves.isEmpty { return SearchResult(move: nil, score: -Engine.mate, depth: 0, nodes: 0) }

        moves = orderMoves(b, moves, 0, nil)

        let sign: Int32 = side == .red ? 1 : -1
        var bestMove: Move? = moves[0]
        var bestScore = sign * evaluate(b)
        var reached = 0

        for d in 1...max(1, maxDepth) {
            var alpha = -Engine.infinite
            var localBest: Move? = nil
            var localScore = -Engine.infinite
            var completed = true

            for m in moves {
                let cap = doMove(&b, m)
                let sc = -negamax(&b, side.other, d - 1, -Engine.infinite, -alpha, 1)
                undo(&b, m, cap)
                if aborted { completed = false; break }
                if sc > localScore { localScore = sc; localBest = m }
                if sc > alpha { alpha = sc }
            }

            if !completed { break }
            if let lb = localBest {
                bestMove = lb
                bestScore = localScore
                reached = d
                if let idx = moves.firstIndex(of: lb), idx > 0 {
                    moves.remove(at: idx)
                    moves.insert(lb, at: 0)
                }
            }
            if abs(bestScore) > Engine.mate - 1000 { break }
        }

        return SearchResult(move: bestMove, score: bestScore, depth: reached, nodes: nodes)
    }

    // MARK: 对外接口（全部串行）

    func search(board: [Int8], side: Side, maxDepth: Int, timeMs: Int, completion: @escaping (SearchResult) -> Void) {
        queue.async {
            self.prepare()
            let r = self.rootSearch(board: board, side: side, maxDepth: maxDepth, timeMs: timeMs, excluded: [])
            DispatchQueue.main.async { completion(r) }
        }
    }

    /// 多路分析：给出前 n 个候选着法，供教练点评与「让模型选一个」使用
    func topMoves(board: [Int8], side: Side, count: Int, maxDepth: Int, timeMs: Int, completion: @escaping ([CandidateMove]) -> Void) {
        queue.async {
            self.prepare()
            var excluded: [Move] = []
            var out: [CandidateMove] = []
            let budget = max(400, timeMs)

            for i in 0..<count {
                let slice = max(300, budget / (count - i))
                let r = self.rootSearch(board: board, side: side, maxDepth: maxDepth, timeMs: slice, excluded: excluded)
                guard let mv = r.move else { break }
                out.append(CandidateMove(move: mv, score: r.score, depth: r.depth,
                                         label: Notation.label(board: board, move: mv)))
                excluded.append(mv)
                if abs(r.score) > Engine.mate - 1000 { break }
            }
            DispatchQueue.main.async { completion(out) }
        }
    }

    func pickMove(board: [Int8], side: Side, level: SearchLevel, completion: @escaping (SearchResult) -> Void) {
        queue.async {
            self.prepare()
            let res = self.rootSearch(board: board, side: side, maxDepth: level.depth, timeMs: level.timeMs, excluded: [])

            guard let picked = res.move, level.slack > 0 else {
                DispatchQueue.main.async { completion(res) }
                return
            }
            // 入门档故意在接近最优的着法里随机挑，让新手有得下
            var work = board
            let legal = Rules.legalMoves(board, side)
            var candidates: [Move] = []
            for m in legal {
                let cap = Rules.makeMove(&work, m)
                let sub = self.rootSearch(board: work, side: side.other, maxDepth: 1, timeMs: 120, excluded: [])
                Rules.undoMove(&work, m, cap)
                if res.score - (-sub.score) <= level.slack { candidates.append(m) }
            }
            if candidates.isEmpty {
                DispatchQueue.main.async { completion(res) }
                return
            }
            let chosen = candidates.randomElement()!
            DispatchQueue.main.async {
                completion(SearchResult(move: chosen, score: res.score, depth: res.depth, nodes: res.nodes))
            }
        }
    }

    /// 评分 → 红方胜率
    static func winRate(_ redScore: Int32) -> Double {
        if redScore > mate - 1000 { return 1 }
        if redScore < -mate + 1000 { return 0 }
        let k = 1.0 / (1.0 + pow(10.0, -Double(redScore) / 400.0))
        return min(0.98, max(0.02, k))
    }

    static func scoreText(_ v: Int32) -> String {
        if v > mate - 1000 { return "红方已成杀" }
        if v < -mate + 1000 { return "黑方已成杀" }
        if v > 150 { return "红方明显占优" }
        if v > 50 { return "红方稍优" }
        if v < -150 { return "黑方明显占优" }
        if v < -50 { return "黑方稍优" }
        return "均势"
    }
}
