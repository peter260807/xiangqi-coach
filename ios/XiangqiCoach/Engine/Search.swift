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
    /// 这次搜索里 SEE 被算过多少次。**自证用**：排序里新加的那条路如果一次都没走到，
    /// 说明它其实是死代码，而「没报错」看不出来这件事。
    var seeCalls: Int = 0
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

    // MARK: LMR（后期着法缩减）

    /// 排在后面的安静着法，先用**浅一点的深度**搜；分数够高再全深度重搜。
    ///
    /// 为什么值：一个节点里真正有希望的往往只有排序后的前几个着法，
    /// 后面的安静着法绝大多数会被 alpha-beta 直接剪掉。用浅深度快速否掉它们，
    /// 省下的时间换成深度 —— 这是与空着裁剪并列的两大剪枝之一。
    ///
    /// 三条保守约束（都踩过坑的典型来源）：
    /// - 深度不够不启用（`lmrMinDepth`）：太浅时缩放会失真
    /// - 排序后的前 `lmrFullMoves` 个着法不缩减：它们已经是有希望的那些
    /// - **被将军时不用**、**吃子不缩减**：这两类着法往往是唯一的解，缩减会漏杀
    static let lmrMinDepth = 3
    static let lmrFullMoves = 3

    /// 缩减量表：行 = 深度，列 = 着法序号（从 1 起）。
    ///
    /// `r = 0.75 + ln(d)·ln(m) / 2.25`（与主流引擎同一量级），取整后夹在 0…4。
    /// 预计算成表是为了不在热点循环里调 `log` —— 每个节点、每个着法都要查它一次。
    static let lmrTable: [[Int8]] = {
        var t = [[Int8]](repeating: [Int8](repeating: 0, count: 64), count: 64)
        for d in 1..<64 {
            for m in 1..<64 {
                let v = 0.75 + log(Double(d)) * log(Double(m)) / 2.25
                t[d][m] = Int8(max(0, min(4, Int(v))))
            }
        }
        return t
    }()

    // MARK: 空着裁剪（null move pruning）

    /// 低于这个深度不做空着裁剪 —— 剪掉 2 层后几乎没得搜，反而失真。
    static let nullMoveMinDepth = 3

    /// 空着之后缩减几层。用固定值而不是 `2 + depth/6` 那种自适应，
    /// 是为了**便于归因**：出问题时只需怀疑一个参数，而不是两处联动。
    static let nullMoveR = 2

    /// 归因开关（用环境变量控制，便于用同一个二进制跑所有变体）。
    ///
    /// **LMR 与空着裁剪默认是关的** —— 它们在 40 局 A/B 里还没证明自己
    /// （得分率 47.5%、Elo −17、区间 [−118,+83] 跨 0，虽然深度 +2.5 层）。
    /// 未验证的行为改动不该默认在 App 里生效：宁可先留着开关，
    /// 等大样本 A/B 给出正证据再翻默认值。
    ///
    ///   `XQ_LMR=1`    打开 LMR
    ///   `XQ_NULL=1`   打开空着裁剪
    ///   `XQ_NO_LMR=1` / `XQ_NO_NULL=1`  强制关闭（优先级更高，防止将来翻默认值时
    ///                 旧脚本的语义静默反转）
    ///
    /// 长将判负是**已验证**的（机制有确定性验证 + 40 局 A/B 得分率 58.8%），
    /// 所以默认开启，只留 `XQ_NO_PERPETUAL=1` 用于归因对照。
    private static func flag(_ on: String, _ off: String) -> Bool {
        let env = ProcessInfo.processInfo.environment
        if env[off] != nil { return false }
        return env[on] != nil
    }

    static let lmrEnabled = flag("XQ_LMR", "XQ_NO_LMR")
    static let nullMoveEnabled = flag("XQ_NULL", "XQ_NO_NULL")
    static let perpetualEnabled = ProcessInfo.processInfo.environment["XQ_NO_PERPETUAL"] == nil

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
    /// 上一次搜索是不是「空着」。**连续两次空着没有意义**（等于双方各放弃一手、
    /// 局面回到原样），而且会一直递归下去 —— 所以空着之后必须禁用一次。
    private var nullMoveOk = true

    /// 这次搜索算了多少次 SEE（自证用，见 SearchResult.seeCalls）
    private var seeCalls = 0

    /// 自证用：排序阶段到底算过几次 SEE。
    /// 测试拿它证明「门控真的跳过了那些明显安全的吃子」，而不是把 SEE 算了个遍。
    /// 注意只在**排序这一层**看才有意义 —— 整棵搜索树的深处必然还有别的可疑吃子。
    var seeCallCount: Int { seeCalls }

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

    // MARK: 静态交换评估（SEE）与排序用的静态棋理
    //
    // P1-2。原来的排序只有「TT 着法 → 吃子(MVV-LVA) → 杀手 → 历史」，两个毛病：
    //
    //   1. **亏本吃排在所有安静着法前面。** `pieceValue[cap] * 16 - pieceValue[attacker]`
    //      只知道「吃到的值多少」，不知道**目标格有没有人守**。于是「车吃兵、立刻被兵
    //      吃回来」排在最前面 —— 这种着法每个节点都要展开一整棵子树才算得出「亏了 800」。
    //   2. **安静着法没有任何静态信息。** 兜底分只有历史表，而历史表在**开局**几乎攒不出
    //      区分度（局面高度对称、分数大量并列）→ 排序退化成近似随机 → 剪枝率崩掉。
    //      实测这就是「同样 32 个棋子，开局 8 层要 2833 万节点、中局只要 343 万」的根因。
    //
    // 这两件事的期望值都是**实测**出来的，不是照抄标准做法（见 tools/order-ab.js）：
    // 位置表增量单独用就把平均节点数压到 76.8%，而 SEE **必须**排除将/帅才有正收益
    // （不排除时它把正常吃子算成巨亏、反而比不改还慢）。

    /// 位置价值表的取值（红方视角、黑方按行镜像）—— 与 `evaluate` 里的取法必须一致
    ///
    /// 注：SEE / 排序这几块都是 `internal` 而不是 `private`，是为了让
    /// `XiangqiCoachTests` 能用 `@testable import` 直接断言它们 ——
    /// 和 `evaluate` 一样。SEE 是「就地改棋盘再还原」的写法，出问题不抛异常、
    /// 只是悄悄算错，没有独立断言看着不行。
    static func pstValue(_ type: Int, _ red: Bool, _ r: Int, _ c: Int) -> Int32 {
        let row = red ? r : 9 - r
        switch type {
        case Piece.typePawn:   return pstPawn[row][c]
        case Piece.typeHorse:  return pstHorse[row][c]
        case Piece.typeCannon: return pstCannon[row][c]
        case Piece.typeRook:   return pstRook[row][c]
        default:               return 0
        }
    }

    /// 位置价值表的**增量**：走完之后这颗子在位置表上值多少、减掉原来值多少。
    ///
    /// 别小看它 —— 位置表本身已经把「过河兵推进」「马往前跳」「车占好线」都编码进去了，
    /// 所以这一个差值就同时覆盖了这几条，成本只有两次查表。
    /// 方向：不需要按颜色翻符号 —— 行镜像之后，「红兵前进」和「黑卒前进」都会让
    /// 分值变大，所以「增量 > 0」对两边都等于「这颗子变好了」。
    /// 见上面 `pstValue` 的说明：本函数与 SEE、排序那几块同样放开到 internal
    func pstDelta(_ b: [Int8], _ from: Int, _ to: Int) -> Int32 {
        let p = b[from]
        let red = Piece.isRed(p)
        let t = Piece.type(p)
        let before = Engine.pstValue(t, red, Rules.row(from), Rules.col(from))
        let after = Engine.pstValue(t, red, Rules.row(to), Rules.col(to))
        return (after - before) * Engine.pstWeight
    }

    /// `side` 方攻击 `sq` 上那颗子的**最便宜**的子。
    ///
    /// 必须是「找最小」而不是「列全部」—— SEE 交换序列的每一步都要调一次，
    /// 列全部再排序会把成本放大好几倍。按价值从低到高依次试：
    /// 兵 100 → 士/象 200 → 马 400 → 炮 450 → 车 900。
    ///
    /// ⚠️ **故意不算将/帅。** 它的「吃回」在象棋里经常是非法的（那个格子被自己人挡着时
    /// 将在原地就违规，或者格子另外被别的子守住），SEE 不知道这些，会把正常吃子算成
    /// -60000 级的巨亏再打到安静着法后面去。实测不排除将/帅时 SEE 反而让搜索变慢。
    /// 见上面 `pstValue` 的说明：本函数同样放开到 internal 供测试直接断言
    func leastAttacker(_ b: [Int8], _ sq: Int, _ side: Side) -> (from: Int, value: Int32)? {
        let r = Rules.row(sq), c = Rules.col(sq)
        let red = side == .red

        // 兵/卒（100）
        let pawn = Piece.code(Piece.typePawn, side)
        let fwd = red ? r + 1 : r - 1
        if Rules.inBoard(fwd, c) && b[Rules.index(fwd, c)] == pawn {
            return (Rules.index(fwd, c), 100)
        }
        // 横着吃的兵必须已过河：红兵过河 = 行 ≤ 4，黑卒过河 = 行 ≥ 5
        if red ? r <= 4 : r >= 5 {
            if c > 0 && b[Rules.index(r, c - 1)] == pawn { return (Rules.index(r, c - 1), 100) }
            if c < 8 && b[Rules.index(r, c + 1)] == pawn { return (Rules.index(r, c + 1), 100) }
        }

        // 士（200）：斜一步，且必须在本方九宫内
        let advisor = Piece.code(Piece.typeAdvisor, side)
        for d in Rules.diag {
            let ar = r + d.0, ac = c + d.1
            if ac < 3 || ac > 5 { continue }
            if red ? (ar < 7 || ar > 9) : (ar < 0 || ar > 2) { continue }
            if b[Rules.index(ar, ac)] == advisor { return (Rules.index(ar, ac), 200) }
        }

        // 象（200）：斜两步，象眼要空，且不过河（红象只在行 5~9，黑象只在行 0~4）
        let elephant = Piece.code(Piece.typeElephant, side)
        for d in Rules.diag {
            let br = r + 2 * d.0, bc = c + 2 * d.1
            if !Rules.inBoard(br, bc) { continue }
            if red ? br < 5 : br > 4 { continue }
            if b[Rules.index(br, bc)] != elephant { continue }
            if b[Rules.index(r + d.0, c + d.1)] != Piece.empty { continue }
            return (Rules.index(br, bc), 200)
        }

        // 马（400）：Rules.horse 是「从马出发」的偏移，攻击 sq 的马在 (r-dr, c-dc)，腿相对马算
        let horse = Piece.code(Piece.typeHorse, side)
        for h in Rules.horse {
            let hr = r - h.0, hc = c - h.1
            if !Rules.inBoard(hr, hc) { continue }
            if b[Rules.index(hr, hc)] != horse { continue }
            let lr = hr + h.2, lc = hc + h.3
            if !Rules.inBoard(lr, lc) { continue }
            if b[Rules.index(lr, lc)] != Piece.empty { continue }
            return (Rules.index(hr, hc), 400)
        }

        // 炮（450）：必须正好隔一个炮架（第一个碰到的子当架，再碰到的才是炮）
        let cannon = Piece.code(Piece.typeCannon, side)
        for d in Rules.dir4 {
            var tr = r + d.0, tc = c + d.1
            var screen = false
            while Rules.inBoard(tr, tc) {
                let t = b[Rules.index(tr, tc)]
                if !screen {
                    if t != Piece.empty { screen = true }
                } else if t != Piece.empty {
                    if t == cannon { return (Rules.index(tr, tc), 450) }
                    break
                }
                tr += d.0; tc += d.1
            }
        }

        // 车（900）：四个方向碰到的第一个子
        let rook = Piece.code(Piece.typeRook, side)
        for d in Rules.dir4 {
            var ur = r + d.0, uc = c + d.1
            while Rules.inBoard(ur, uc) {
                let u = b[Rules.index(ur, uc)]
                if u != Piece.empty {
                    if u == rook { return (Rules.index(ur, uc), 900) }
                    break
                }
                ur += d.0; uc += d.1
            }
        }

        return nil
    }

    /// 走 `from → to` 这一手吃子的 SEE 净收益。正数 = 赚，0 = 平换，负数 = 亏本吃。
    ///
    /// 算法（自己推的，查到的几个版本索引记不牢、容易写错）：
    ///   设 u = [u1, u2, …] 为每一步「进攻方用的那颗子」的价值（u1 = 走子方的子）。
    ///   第 k 步**吃到**的东西价值 G[k]：G[1] = 被吃子的价值，G[k] = u[k-1]。
    ///   记 f(k) = 第 k 步进攻方的净收益，则 f(n) = G[n]、f(k) = G[k] - max(0, f(k+1))，
    ///   答案就是 f(1)。
    ///
    /// 例（JS 侧有对应的单元测试，两边必须同答案）：
    ///   车(900)吃兵(100)、被兵吃回来 → u=[900,100]，G=[100,900] → f(1)=100-900 = **-800**
    ///   兵(100)吃车(900)、没人吃回来 → u=[100]，G=[900] → f(1) = 900
    ///   车(900)吃车(900)、被兵吃回来 → u=[900,100]，G=[900,900] → f(1)=900-900 = **0**
    ///
    /// 棋盘是**取值**传进来的：Swift 数组是写时复制，进函数时并不复制，只有真去改它
    /// 才复制 90 字节。比原先设想的「逐格记录再还原」简单得多，而且**不可能漏还原** ——
    /// 调用方的棋盘压根没被碰过。
    /// 见上面 `pstValue` 的说明：本函数同样放开到 internal 供测试直接断言
    func seeCapture(_ boardIn: [Int8], _ from: Int, _ to: Int, _ side: Side) -> Int32 {
        let victim = boardIn[to]
        if victim == Piece.empty { return 0 }

        var b = boardIn
        var u: [Int32] = [Engine.pieceValue[Piece.type(b[from])]]
        b[to] = b[from]
        b[from] = Piece.empty

        var cur = side.other
        var guardCount = 0
        while guardCount < 24 {
            guardCount += 1
            guard let att = leastAttacker(b, to, cur) else { break }
            u.append(att.value)
            b[to] = b[att.from]
            b[att.from] = Piece.empty
            cur = cur.other
        }

        // G = [被吃子的价值, u1, …, u(n-1)]，从尾部往前取 max(0, ·)
        var val: Int32 = 0
        if u.count >= 2 {
            for k in stride(from: u.count - 2, through: 0, by: -1) {
                val = u[k] - max(0, val)
            }
        }
        return Engine.pieceValue[Piece.type(victim)] - max(0, val)
    }

    // MARK: 着法排序
    //
    //   TT 着法                                 100,000,000
    //   好/等吃子（SEE ≥ 0）                     20,000,000 + MVV-LVA
    //   杀手着法 1 / 2                          15,000,000 / 14,000,000
    //   安静着法                                10,000,000 + 位置表增量 + 历史
    //   亏本吃（SEE < 0）                        1,000,000 + SEE
    //
    // 两条纪律：
    //   1. **亏本吃必须降到安静着法之后。** 它的价值是负的，排在前面只会让每个节点都白
    //      展开一整棵子树去证明「果然亏了」。
    //   2. **SEE 只在「可能亏」的时候算。** 被吃子比吃子方的子更值钱时（吃大子 / 平换），
    //      即使被吃回来也不亏，MVV-LVA 就够了 —— 这一条把 SEE 的调用次数砍掉大半，
    //      因为 SEE 里每一步都要做一次射线扫描，它比排序里其它任何一项都贵。

    private static let scoreTT: Int32 = 100_000_000
    private static let scoreGoodCap: Int32 = 20_000_000
    private static let scoreKiller1: Int32 = 15_000_000
    private static let scoreKiller2: Int32 = 14_000_000
    private static let scoreQuiet: Int32 = 10_000_000
    private static let scoreBadCap: Int32 = 1_000_000
    /// 位置表增量的权重。实测 4 / 8 / 16 三档几乎并列（73.5% / 74.5% / 74.6% 的节点数），
    /// 取中间的 8 —— 这个常数不值得再调（差别落在局面间的正常波动里）。
    private static let pstWeight: Int32 = 8
    /// 历史分数的上限。历史表靠「同一着法反复造成截断」累积、随深度平方增长；
    /// 完全不封顶会让它盖掉位置表增量（实测不封顶时节点数是 78.2% 对 74.4%）。
    /// 注：在实测的深度范围内这个上限其实**基本不触发**，它是一条保险丝。
    private static let histCap: Int32 = 4096

    /// SEE 只在 **ply ≤ 这个值** 的时候算（浅层）。
    ///
    /// 为什么不是整棵树都算 —— 实测（`tools/order-fuzz.js --mode time`，150 个随机局面）：
    /// 整棵树都算 SEE 时，**开局**节点省 16%，但**中局**因为吃子多、SEE 的射线扫描贵，
    /// 每千节点/秒从 2684 掉到 2177（慢 19%），而中局的节点只省下 5% ——
    /// 一进一出，固定时间下反而比不改**更浅**（改动前多搜到一层的局面 14:3）。
    /// 残局几乎不受影响（那里位置表增量才是主角）。
    ///
    /// 限制到浅层能保住 SEE 大部分的好处（浅 4 层时开局节点数是 78.2%，整棵树是 77.0%），
    /// 却把深层的调用全砍掉 —— 深层的节点数占绝大多数，代价主要在那儿。
    /// 实测浅 4 层的组法比整棵树浅层无关的那两版都更靠前（对改动前 9:5、对浅 1 层 5:1）。
    ///
    /// 放开到 internal（而不是 private）是为了让测试**贴着边界两侧**各断言一次：
    /// ply = 本值要算 SEE、ply = 本值+1 不能算。测试里硬编码 4 的话，
    /// 以后调这个值，那条断言就会变成在测别的东西、而且照样全绿。
    static let seeMaxPly = 4

    /// 见上面 `pstValue` 的说明：本函数同样放开到 internal 供测试直接断言顺序
    func orderMoves(_ b: [Int8], _ moves: [Move], _ ply: Int, _ ttMove: Move?) -> [Move] {
        let k = killers[min(ply, 63)]
        // 第三个分量是原始下标：Swift 的 sort 不保证稳定，而 JS 的 sort 是稳定的。
        // 不加这个「平局按原顺序」，同样的局面在两个引擎里排序会不一样，
        // 「两端是同一套算法」这条就名存实亡了。
        var scored: [(Int32, Move, Int)] = []
        scored.reserveCapacity(moves.count)
        for (i, m) in moves.enumerated() {
            var s: Int32 = 0
            let cap = b[m.to]
            if let t = ttMove, t == m {
                s = Engine.scoreTT
            } else if cap != Piece.empty {
                let capVal = Engine.pieceValue[Piece.type(cap)]
                let attVal = Engine.pieceValue[Piece.type(b[m.from])]
                let mvv = capVal * 16 - attVal
                if capVal >= attVal || ply > Engine.seeMaxPly {
                    // 吃大子 / 平换：再差也不会亏，不必花 SEE。
                    // 深于 seeMaxPly 的节点也走这一支：那里节点数占绝大多数，
                    // 而 SEE 的射线扫描在最贵的节点上最不划算（理由见 seeMaxPly 的注释）
                    s = Engine.scoreGoodCap + mvv
                } else {
                    seeCalls += 1
                    let see = seeCapture(b, m.from, m.to, Piece.side(b[m.from]))
                    s = see >= 0 ? Engine.scoreGoodCap + mvv : Engine.scoreBadCap + see
                }
            } else if let k0 = k.0, k0 == m {
                s = Engine.scoreKiller1
            } else if let k1 = k.1, k1 == m {
                s = Engine.scoreKiller2
            } else {
                let hv = history[m.from * 90 + m.to]
                s = Engine.scoreQuiet + pstDelta(b, m.from, m.to)
                    + (hv > Engine.histCap ? Engine.histCap : hv)
            }
            scored.append((s, m, i))
        }
        scored.sort { $0.0 != $1.0 ? $0.0 > $1.0 : $0.2 < $1.2 }
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

    // MARK: 重复局面（搜索里的「和棋意识」）

    /// 走到搜索根**之前**的棋局历史。
    ///
    /// 有了它，引擎才知道哪些局面「已经出现过」—— 走回去按和棋算（0 分）。
    /// 没有它的时候（P2-1 之前的状态）：引擎不知道自己在绕圈，一盘赢棋会被自己
    /// 走成三次重复，只能靠对局层兜住判和，等于白送一局。
    struct SearchHistory {
        /// 棋局起始局面（与 `Rules.startFEN` 同格式的棋盘串）
        var startFEN: String
        /// 从起始局面到搜索根的着法
        var moves: [Move]
        var startSide: Side

        init(startFEN: String = Rules.startFEN, moves: [Move], startSide: Side = .red) {
            self.startFEN = startFEN
            self.moves = moves
            self.startSide = startSide
        }

        /// 从某个局面开始的整局棋（界面里的对局走这条）
        static func fromStart(_ moves: [Move]) -> SearchHistory {
            SearchHistory(startFEN: Rules.startFEN, moves: moves, startSide: .red)
        }
    }

    /// 当前「不可逆段」上的局面。
    ///
    /// 除了哈希，还带着「走到这个局面的那一手」的信息：`mover` 是走子方、
    /// `check` 是这一手有没有将军。带这两个字段是为了在重复发生时能构造出
    /// 循环体交给 `Rules.perpetualChecker`，把**长将判负**也搬进搜索 ——
    /// 否则搜索只知道「重复 = 和棋」，会主动走进长将循环捞半分，到对局层却被判负。
    ///
    /// 栈底那项（段的起点）的 `mover` / `check` 没有意义，不会被读。
    private var repStack: [(h: UInt64, fresh: Bool, mover: Side, check: Bool)] = []
    /// 段内每个局面出现过几次。用字典是**有意的**：换成每层往回线性扫描，
    /// 安静残局里一段能有上百手，每个节点都要多扫上百次比较。
    private var repCount: [UInt64: Int] = [:]
    /// 进入新的不可逆段时，把上一段的计数表暂存起来（回退时要还回去）
    private var repSaved: [[UInt64: Int]] = []

    /// 这一手之后，之前的局面还有可能重现吗？吃子 / 走兵 → 不可能（兵只进不退）
    private static func isIrreversible(_ piece: Int8, _ cap: Int8) -> Bool {
        cap != 0 || Piece.type(piece) == Piece.typePawn
    }

    /// 这个局面「子力够不够做空着裁剪」。
    ///
    /// **残局必须禁用**：象棋残局里「放弃一手」常常反而变好（zugzwang，
    /// 车兵 / 马兵残局尤其明显），拿它去剪枝会把赢棋判成输棋。
    ///
    /// 判据刻意收得保守：只有本方**还有车 / 炮 / 马**才算子力足够。士象不参与进攻，
    /// 「士象全 对 无子」通常也是和棋 —— 把它们算进来会让本该禁用的局面误开空着裁剪。
    ///
    /// 只在 `depth >= nullMoveMinDepth` 时调用；找到第一个子就返回，
    /// 所以这次全盘扫描摊到浅节点上是划算的。
    private func hasNonPawnMaterial(_ b: [Int8], _ side: Side) -> Bool {
        let wantRed = (side == .red)
        for i in 0..<90 {
            let p = b[i]
            if p == 0 { continue }
            if Piece.isRed(p) != wantRed { continue }
            let t = Piece.type(p)
            if t == Piece.typeRook || t == Piece.typeCannon || t == Piece.typeHorse {
                return true
            }
        }
        return false
    }

    /// 把「根节点 + 它之前的棋局历史」装进路径栈
    private func repInit(_ history: SearchHistory?) {
        guard let h = history, !h.moves.isEmpty else {
            repStack = [(h: hash, fresh: false, mover: .red, check: false)]
            repCount = [hash: 1]
            repSaved = []
            return
        }
        var b = Rules.parse(h.startFEN)
        var side = h.startSide
        var keys: [UInt64] = [computeHash(b, side)]
        var segs: [Int] = [0]
        // 与 keys 同下标：走到 keys[i] 的那一手的（走子方, 是否将军）。
        // 下标 0 是起始局面，没有「走到它的那一手」，填占位值（不会被读）。
        var infos: [(Side, Bool)] = [(.red, false)]
        var segStart = 0
        for m in h.moves {
            let irrev = Engine.isIrreversible(b[m.from], b[m.to])
            let mover = side
            _ = Rules.makeMove(&b, m)
            side = side.other
            if irrev { segStart = keys.count }
            keys.append(computeHash(b, side))
            // 走完这一手后 side 已经是对方，「对方被将」就等于「这一手是将军」
            infos.append((mover, Rules.inCheck(b, side)))
            segs.append(segStart)
        }
        // 以真实棋盘为准：万一调用方给的历史和棋盘不是同一路棋，也不至于引入假重复
        keys[keys.count - 1] = hash
        // 只装「最后一个不可逆段」—— 更早的局面不可能重现了
        let from = segs[segs.count - 1]
        repStack = []
        repCount = [:]
        repSaved = []
        for i in from..<keys.count {
            repStack.append((h: keys[i], fresh: i == from,
                             mover: infos[i].0, check: infos[i].1))
            repCount[keys[i], default: 0] += 1
        }
        // 根节点不是 repPush 压进去的，它不需要在下一次 repPop 时还原计数表
        if !repStack.isEmpty { repStack[0].fresh = false }
    }

    /// 走子之后把新局面压进路径栈 —— 必须在 doMove **之后**调用（要读新局面）。
    ///
    /// `mover` 是刚落子的那一方（此时走子权已经交给它的对手）。
    /// **返回「这一手是否将军」** —— LMR 要用它决定该不该缩减；顺手返回，
    /// 省得再算一次 `inCheck`（它每个节点都要跑，不能重复付钱）。
    @discardableResult
    private func repPush(_ b: [Int8], _ m: Move, _ cap: Int8, _ mover: Side) -> Bool {
        let fresh = Engine.isIrreversible(b[m.to], cap)
        if fresh {
            repSaved.append(repCount)
            repCount = [:]
        }
        // 走完后轮到对手 —— 对手被将，就等于这一手是将军
        let givesCheck = Rules.inCheck(b, mover.other)
        repStack.append((h: hash, fresh: fresh, mover: mover, check: givesCheck))
        repCount[hash, default: 0] += 1
        return givesCheck
    }

    private func repPop() {
        guard let e = repStack.popLast() else { return }
        let c = (repCount[e.h] ?? 0) - 1
        if c <= 0 { repCount.removeValue(forKey: e.h) } else { repCount[e.h] = c }
        if e.fresh, let prev = repSaved.popLast() { repCount = prev }
    }

    /// 当前局面在本段路径上出现过 → 按和棋算（0 分）。
    ///
    /// 这里是**两次重复**就判和，比正式的「三次重复」保守一层。搜索里要防的是
    /// 「双方都愿意重复」导致的无限循环，宁可早判：判早了只会让优势方更主动地躲开
    /// 循环，不会把赢棋判成和棋。对局层仍然是三次重复才判（P2-1 的 `Rules.adjudicate`），
    /// **两处不一致是刻意的**。
    private func repIsDraw() -> Bool {
        repStack.count > 1 && (repCount[hash] ?? 0) > 1
    }

    /// 当前局面重复了 —— 那这是「长将循环」吗？
    ///
    /// 返回长将的一方（**该方判负**）；nil 表示普通重复，按和棋算。
    ///
    /// 判据与对局层的 `Rules.adjudicate` 用的是**同一个** `Rules.perpetualChecker`：
    /// 只取出「上次出现当前局面 → 现在」这一段的着法（走子方 + 是否将军）交给它，
    /// 由它去认谁在长将。这样搜索和裁判对长将的看法终于一致 ——
    /// 从前搜索只认「重复 = 0 分」，于是优势方会主动走进长将循环捞半分，
    /// 到对局层却被判负（两批 A/B 各有 2 局栽在这上面，是结构性的）。
    ///
    /// 搜索仍然是**两次重复**就介入（对局层是三次），这个不一致刻意保留：
    /// 防的是「双方都愿意重复」导致的无限循环，宁可早判。
    private func repPerpetualLoser() -> Side? {
        guard repStack.count > 1 else { return nil }
        // 栈顶（下标 count-1）就是当前局面，从它下面一个位置往前找「上一次出现」
        var prev = -1
        var i = repStack.count - 2
        while i >= 0 {
            if repStack[i].h == hash { prev = i; break }
            i -= 1
        }
        guard prev >= 0, prev + 1 < repStack.count else { return nil }

        var cycle = [(side: Side, check: Bool)]()
        cycle.reserveCapacity(repStack.count - prev - 1)
        for k in (prev + 1)..<repStack.count {
            cycle.append((side: repStack[k].mover, check: repStack[k].check))
        }
        guard !cycle.isEmpty else { return nil }
        return Rules.perpetualChecker(cycle)
    }

    // MARK: 主搜索

    private func negamax(_ b: inout [Int8], _ side: Side, _ depth: Int, _ alphaIn: Int32, _ beta: Int32, _ ply: Int) -> Int32 {
        checkTime()
        if aborted { return 0 }

        // 重复局面必须在置换表**之前**判。0 分是「相对路径」的结论 —— 同一个局面
        // 从别的路径搜过来并不等于和棋，把它当普通评分存进置换表会污染后续搜索。
        // 也因为要提前返回，这里天然不会把评分写进表里。
        if ply > 0 && repIsDraw() {
            // 先问一句「这是不是长将循环」：是的话长将方判负（给绝杀分，按 ply 递减，
            // 与「无合法着法」同一套表示），而不是判和。
            if Engine.perpetualEnabled, let loser = repPerpetualLoser() {
                return loser == side ? -Engine.mate + Int32(ply) : Engine.mate - Int32(ply)
            }
            return 0
        }

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

        // 空着裁剪和 LMR 都要知道「当前节点是否被将军」，合起来只算一次。
        // 只在深度够时才付这笔钱 —— `inCheck` 要扫全盘找将。
        let needInCheck = depth >= min(Engine.nullMoveMinDepth, Engine.lmrMinDepth)
        let inCheckNow = needInCheck ? Rules.inCheck(b, side) : false

        // 空着裁剪：先「放弃一手」试探。如果对手**多走一步**仍然够不到 beta，
        // 说明这个局面已经好到不必细算 —— 直接按 beta 剪枝。
        // 放在着法生成**之前**：剪枝成功连着法都不用生成。
        //
        // 三个前提缺一不可：① 不被将军（被将时每一步都可能是唯一的解）
        // ② 上一次不是空着（连续空着等于双方都放弃一手，会无限递归）
        // ③ 子力足够（残局的 zugzwang 会让「放弃一手」反而变好）
        if Engine.nullMoveEnabled,
           depth >= Engine.nullMoveMinDepth, nullMoveOk, !inCheckNow,
           hasNonPawnMaterial(b, side) {
            // 缩减后**至少留 1 层**，剩下的交给静态搜索兜底。
            //
            // ⚠️ 这里原来写的是 `if depth - 1 - r > 0`，那个条件在「搜索深度 4」
            // 这类常见场景下**永远不会成立** —— negamax 里拿到的 depth 最大只有
            // `maxDepth - 1`（rootSearch 传的是 d-1），也就是 3，而 3-1-2 = 0 不 > 0。
            // 结果是空着裁剪**静默失效**：没有任何报错，只是节点数一个没少。
            // 教训：「深度够不够」的判据只留一处（上面的 `minDepth`），别再叠加
            // 一个看起来更严格、实际永远不成立的守卫。
            let nmDepth = max(1, depth - 1 - Engine.nullMoveR)
            // 空着：棋盘不动，只把走子权交给对方 —— 哈希里的走子方项要跟着翻
            hash ^= zSide
            nullMoveOk = false
            let sc = -negamax(&b, side.other, nmDepth, -beta, -beta + 1, ply + 1)
            nullMoveOk = true
            hash ^= zSide
            if aborted { return 0 }
            if sc >= beta {
                // 不写置换表：这是「少算了一层」的结论，当普通评分存进去会污染搜索
                return beta
            }
        }

        let raw = Rules.genMoves(b, side)
        let moves = orderMoves(b, raw, plyKey, ttMove)

        var best = -Engine.infinite
        var bestMove: Move? = nil
        var anyLegal = false
        var searchedOne = false
        /// 已经搜索过的合法着法数（不是循环下标 —— 非法着法被 continue 跳过，
        /// 用下标会让缩减判断偏早）
        var moveIdx = 0

        // LMR 的两个前提：深度够、着法够多（浅节点上不值得这么做）
        let lmrPossible = Engine.lmrEnabled
            && depth >= Engine.lmrMinDepth && moves.count > Engine.lmrFullMoves
        // `inCheckNow` 已在上面（空着裁剪那一段）算过，这里直接复用，不重复付钱

        for m in moves {
            let cap = doMove(&b, m)
            if Rules.inCheck(b, side) || Rules.kingsFacing(b) {
                undo(&b, m, cap)
                continue
            }
            anyLegal = true
            let givesCheck = repPush(b, m, cap, side)

            // LMR：只缩减「排序靠后的安静着法」。吃子、将军、被将军三类都不缩减 ——
            // 它们往往是唯一的解，缩减会把正确着法漏掉（宁可少省一点时间）。
            var reduced = 0
            if lmrPossible, moveIdx >= Engine.lmrFullMoves,
               cap == 0, !inCheckNow, !givesCheck {
                reduced = Int(Engine.lmrTable[min(depth, 63)][min(moveIdx + 1, 63)])
                // 缩减后至少要留 1 层可搜，否则等于不搜
                reduced = min(reduced, max(0, depth - 2))
            }

            var sc: Int32
            if !searchedOne {
                // 首着必须用全窗口：此时 alpha 可能仍是 -infinite
                sc = -negamax(&b, side.other, depth - 1, -beta, -alpha, ply + 1)
            } else if reduced > 0 {
                // 先用缩减深度 + 零窗口试探，够好再按全深度重搜。
                //
                // ⚠️ 重搜是**两步**，和下面 PVS 分支保持一致：先零窗口确认它确实超过
                // alpha，再开全窗口取精确值。只做第一步会漏掉落在 (alpha, beta) 区间里的
                // 精确值 —— 那个值要写进置换表、也会成为 PV，不精确会顺着树往上放大。
                sc = -negamax(&b, side.other, depth - 1 - reduced,
                              -alpha - 1, -alpha, ply + 1)
                if sc > alpha {
                    sc = -negamax(&b, side.other, depth - 1, -alpha - 1, -alpha, ply + 1)
                    if sc > alpha && sc < beta {
                        sc = -negamax(&b, side.other, depth - 1, -beta, -alpha, ply + 1)
                    }
                }
            } else {
                sc = -negamax(&b, side.other, depth - 1, -alpha - 1, -alpha, ply + 1)
                if sc > alpha && sc < beta {
                    sc = -negamax(&b, side.other, depth - 1, -beta, -alpha, ply + 1)
                }
            }
            searchedOne = true
            moveIdx += 1
            repPop()
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
        seeCalls = 0
        aborted = false
        // 重复局面路径栈每次都从 rootSearch 的 repInit 重建；这里清掉是为了
        // 「搜完之后不留状态」—— 上一次搜索的路径不该影响下一次。
        repStack = []
        repCount = [:]
        repSaved = []
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

    /// - Parameter history: 走到 `board` 为止的着法历史。给了它，引擎才知道哪些局面
    ///   「已经出现过」→ 走回去按和棋算。不给也能跑，但那样搜索是**没有局面记忆**的，
    ///   会往循环里走（这正是 P2-2 要修的东西）。
    private func rootSearch(board: [Int8], side: Side, maxDepth: Int, timeMs: Int,
                            excluded: [Move], history: SearchHistory?) -> SearchResult {
        var b = board
        hash = computeHash(b, side)
        deadline = nowMs() + UInt64(max(80, timeMs))
        repInit(history)

        var moves = rootMoves(b, side, excluded: excluded)
        if moves.isEmpty {
            repInit(nil)
            return SearchResult(move: nil, score: -Engine.mate, depth: 0, nodes: 0)
        }

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
                repPush(b, m, cap, side)
                let sc = -negamax(&b, side.other, d - 1, -Engine.infinite, -alpha, 1)
                repPop()
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

        return SearchResult(move: bestMove, score: bestScore, depth: reached, nodes: nodes,
                            seeCalls: seeCalls)
    }

    // MARK: 对外接口（全部串行）

    func search(board: [Int8], side: Side, maxDepth: Int, timeMs: Int,
                history: SearchHistory? = nil,
                completion: @escaping (SearchResult) -> Void) {
        queue.async {
            self.prepare()
            let r = self.rootSearch(board: board, side: side, maxDepth: maxDepth, timeMs: timeMs,
                                    excluded: [], history: history)
            DispatchQueue.main.async { completion(r) }
        }
    }

    /// 同步搜索。仅供测试与需要就地取结果的场景使用 ——
    /// 会阻塞调用线程，界面代码请一律走上面的异步接口。
    ///
    /// - Parameter excluded: 排除掉的着法。多路分析（`topMovesSync`）靠它逐个换着法，
    ///   测试靠它把「某一手值多少分」单独问出来 —— 只看最佳着法是分不出
    ///   「这手被判成和棋」和「这手本来就烂」的。
    func searchSync(board: [Int8], side: Side, maxDepth: Int, timeMs: Int,
                    excluded: [Move] = [], history: SearchHistory? = nil) -> SearchResult {
        queue.sync {
            self.prepare()
            return self.rootSearch(board: board, side: side, maxDepth: maxDepth, timeMs: timeMs,
                                   excluded: excluded, history: history)
        }
    }

    /// 同步多路分析，同上
    func topMovesSync(board: [Int8], side: Side, count: Int, maxDepth: Int, timeMs: Int,
                      history: SearchHistory? = nil) -> [CandidateMove] {
        queue.sync {
            self.prepare()
            var excluded: [Move] = []
            var out: [CandidateMove] = []
            let budget = max(400, timeMs)
            for i in 0..<count {
                let slice = max(300, budget / (count - i))
                let r = self.rootSearch(board: board, side: side, maxDepth: maxDepth, timeMs: slice,
                                        excluded: excluded, history: history)
                guard let mv = r.move else { break }
                out.append(CandidateMove(move: mv, score: r.score, depth: r.depth,
                                         label: Notation.label(board: board, move: mv)))
                excluded.append(mv)
                if abs(r.score) > Engine.mate - 1000 { break }
            }
            return out
        }
    }

    /// 重置内部状态（测试用，避免用例之间通过置换表互相影响）
    func resetForTesting() {
        queue.sync {
            self.prepare()
            for i in 0..<tt.count { tt[i] = TTEntry() }
        }
    }

    /// 多路分析：给出前 n 个候选着法，供教练点评与「让模型选一个」使用
    func topMoves(board: [Int8], side: Side, count: Int, maxDepth: Int, timeMs: Int,
                  history: SearchHistory? = nil,
                  completion: @escaping ([CandidateMove]) -> Void) {
        queue.async {
            self.prepare()
            var excluded: [Move] = []
            var out: [CandidateMove] = []
            let budget = max(400, timeMs)

            for i in 0..<count {
                let slice = max(300, budget / (count - i))
                let r = self.rootSearch(board: board, side: side, maxDepth: maxDepth, timeMs: slice,
                                        excluded: excluded, history: history)
                guard let mv = r.move else { break }
                out.append(CandidateMove(move: mv, score: r.score, depth: r.depth,
                                         label: Notation.label(board: board, move: mv)))
                excluded.append(mv)
                if abs(r.score) > Engine.mate - 1000 { break }
            }
            DispatchQueue.main.async { completion(out) }
        }
    }

    func pickMove(board: [Int8], side: Side, level: SearchLevel,
                  history: SearchHistory? = nil,
                  completion: @escaping (SearchResult) -> Void) {
        queue.async {
            self.prepare()
            let res = self.rootSearch(board: board, side: side, maxDepth: level.depth,
                                      timeMs: level.timeMs, excluded: [], history: history)

            guard res.move != nil, level.slack > 0 else {
                DispatchQueue.main.async { completion(res) }
                return
            }
            // 入门档故意在接近最优的着法里随机挑，让新手有得下
            var work = board
            let legal = Rules.legalMoves(board, side)
            var candidates: [Move] = []
            for m in legal {
                let cap = Rules.makeMove(&work, m)
                // 这一层是「1 步之后的静态分」，只是给入门档挑个不离开最优太远的着法。
                // 故意不传 history：这里的棋盘是 board + m，而 history 只到 board，
                // 硬塞进去会把 board 从路径上顶掉，反而可能造出假重复。
                let sub = self.rootSearch(board: work, side: side.other, maxDepth: 1, timeMs: 120,
                                          excluded: [], history: nil)
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
