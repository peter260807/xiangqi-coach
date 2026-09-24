import Foundation

// MARK: - 对局记录

struct MoveEval: Codable {
    var ply: Int
    var redScore: Int32
    var loss: Int32
    var grade: String      // ok / inaccuracy / mistake / blunder
    var bestLabel: String
    var phase: String      // opening / mid / end
    /// 这一手原本有杀棋却没能走出来。用可选类型是为了让加字段之前的旧存档仍能解码。
    var missedMate: Bool?
    /// 实际走的那一手的中文记谱。**在分析时就存下来**，不要在复盘时靠重放反推 ——
    /// 重放依赖「着法序列是完整的」，而实战里 `moves` 曾经只装了红方着法，
    /// 重放出来是另一盘棋，`played` 会指到不相干的着法而输出看起来毫无破绽。
    /// 旧存档没有这个字段 → 显示「（记谱缺失）」，不猜。
    var playedLabel: String?
}

struct GameFlags: Codable {
    var blunders = 0
    var mistakes = 0
    var inaccuracies = 0
    var missedMate = 0
    var matedByOpponent = 0
}

struct GameRecord: Codable, Identifiable {
    var id: String
    var savedAt: Date
    var sceneId: String
    var sceneName: String
    var level: String
    var mode: String
    var startFEN: String
    var moves: [Int]           // 扁平化的 [from, to, from, to, ...]
    var evals: [MoveEval]
    var flags: GameFlags
    var result: String         // win / loss / unfinished
    var finished: Bool
    var ply: Int

    var movePairs: [Move] {
        var out: [Move] = []
        var i = 0
        while i + 1 < moves.count {
            out.append(Move(from: moves[i], to: moves[i + 1]))
            i += 2
        }
        return out
    }

    var resultLabel: String {
        if result == "win" { return "胜" }
        if result == "loss" { return "负" }
        return finished ? "和" : "未完"
    }
}

// MARK: - 复盘摘要

/// 把**已经算好的**逐手分析（loss / grade / bestLabel / phase / missedMate）
/// 整理成一份结构化复盘。
///
/// 起因：复盘原来只把「第N手 <分数>」这一串数字喂给大模型，
/// 而每手其实都算出了 grade/loss/bestLabel —— 全被丢掉了。
/// 那串数字没有语义，模型只能猜哪一步是转折点，猜不准；人也读不出信息。
///
/// 这份摘要做两件事：
///   ① 让「不配 API Key 也能复盘」成立（`text` 完全由数据生成，秒出、确定）
///   ② 让大模型拿到的事实是**确定的**，它只负责讲「为什么」和「练什么」
///
/// ⚠️ 这里只做「读数」，不做棋理推断。任何关于「该怎么走」的结论
///    都必须来自引擎给的 `bestLabel`，不能由本类型编。
///    （与 web 端 `XQSTORE.reviewDigest` 是同一套定义，两边字段名保持一致。）
struct ReviewDigest {

    struct PhaseStat {
        var key: String
        var name: String
        var moves: Int
        var avgLoss: Int?
        var blunder: Int
        var mistake: Int
        var inaccuracy: Int
    }

    struct KeyMoment {
        var ply: Int
        var round: Int
        var phase: String
        var played: String
        var loss: Int32
        var grade: String
        var gradeName: String
        var best: String
        var missedMate: Bool
    }

    var rounds = 0
    var result = "unfinished"
    var counts = (moves: 0, blunder: 0, mistake: 0, inaccuracy: 0, missedMate: 0)
    var phases: [PhaseStat] = []
    var keys: [KeyMoment] = []
    /// 平均丢分最高、且样本 ≥3 手的阶段（样本不足时为 nil —— 一手棋定不了「你中局弱」）
    var worst: PhaseStat?
    /// 各阶段平均丢分的等权平均。**不把所有手混在一起平均** ——
    /// 否则残局手少的时候会被开局的手数稀释掉。
    var avgLoss = 0

    static let phaseNames = ["opening": "开局", "mid": "中局", "end": "残局"]
    static let gradeNames = ["blunder": "严重失误", "mistake": "失误",
                             "inaccuracy": "不够精确", "ok": "正常"]

    private static func avgInt(_ xs: [Int32]) -> Int {
        guard !xs.isEmpty else { return 0 }
        return Int((Double(xs.reduce(0) { $0 + $1 }) / Double(xs.count)).rounded())
    }

    /// 从对局记录生成摘要。没有逐手分析时返回 nil（打谱演示、旧存档）。
    static func build(_ record: GameRecord) -> ReviewDigest? {
        guard !record.evals.isEmpty else { return nil }
        var d = ReviewDigest()
        d.result = record.result

        let evals = record.evals
        /* 每手走的什么，直接取分析时存下来的 `playedLabel`。
           原来这里是「从 startFEN 重放 record.moves、边走边取 Notation.label」——
           看着更干净，但它依赖 `moves` 是完整着法序列；实测不是（详见 MoveEval 的注释）。
           别再把「反推」当成数据来源 —— 能存就存。 */
        let maxPly = evals.map { $0.ply }.max() ?? 0
        /* 回合数取两个来源的较大者：完整序列更准；旧存档里它只有红方着法，
           那时用「最大分析手数」兜底，最多少算半回合。 */
        d.rounds = max((record.moves.count + 1) / 2, (maxPly + 1) / 2)

        d.counts = (
            moves: evals.count,
            blunder: evals.filter { $0.grade == "blunder" }.count,
            mistake: evals.filter { $0.grade == "mistake" }.count,
            inaccuracy: evals.filter { $0.grade == "inaccuracy" }.count,
            missedMate: evals.filter { $0.missedMate == true }.count
        )

        d.phases = ["opening", "mid", "end"].map { key in
            let list = evals.filter { $0.phase == key }
            return PhaseStat(
                key: key, name: phaseNames[key] ?? key, moves: list.count,
                avgLoss: list.isEmpty ? nil : avgInt(list.map { $0.loss }),
                blunder: list.filter { $0.grade == "blunder" }.count,
                mistake: list.filter { $0.grade == "mistake" }.count,
                inaccuracy: list.filter { $0.grade == "inaccuracy" }.count
            )
        }

        /* 关键时刻：只看真正扣分的（严重失误 / 失误 / 漏杀），按丢分降序取前 6。
           「不够精确」不进来 —— 阈值只有 100 分，列出来会把真正的问题埋掉。 */
        d.keys = evals
            .filter { $0.grade == "blunder" || $0.grade == "mistake" || $0.missedMate == true }
            .sorted { $0.loss > $1.loss }
            .prefix(6)
            .map { e in
                KeyMoment(
                    ply: e.ply,
                    round: (e.ply + 1) / 2,
                    phase: phaseNames[e.phase] ?? "中局",
                    played: (e.playedLabel?.isEmpty == false) ? e.playedLabel! : "（记谱缺失）",
                    loss: e.loss,
                    grade: e.grade,
                    gradeName: gradeNames[e.grade] ?? e.grade,
                    best: e.bestLabel,
                    missedMate: e.missedMate == true
                )
            }

        let ranked = d.phases.filter { $0.moves >= 3 && $0.avgLoss != nil }
            .sorted { ($0.avgLoss ?? 0) > ($1.avgLoss ?? 0) }
        d.worst = ranked.first
        let vals = d.phases.compactMap { $0.avgLoss }
        d.avgLoss = vals.isEmpty ? 0 : Int((Double(vals.reduce(0, +)) / Double(vals.count)).rounded())
        return d
    }

    /// 本地复盘文案 —— 不依赖大模型，也不需要网络。
    var text: String {
        var L: [String] = []
        let res: String
        switch result {
        case "win": res = "你（红方）获胜"
        case "loss": res = "你（红方）落败"
        case "draw": res = "和棋"
        default: res = "对局进行中"
        }
        L.append("【结果】\(res)　共 \(rounds) 回合")

        L.append("")
        L.append("【失误分布】")
        for p in phases where p.moves > 0 {
            var bits: [String] = []
            if p.blunder > 0 { bits.append("严重失误 \(p.blunder)") }
            if p.mistake > 0 { bits.append("失误 \(p.mistake)") }
            if p.inaccuracy > 0 { bits.append("不够精确 \(p.inaccuracy)") }
            L.append("  \(p.name)（\(p.moves) 手，平均丢分 \(p.avgLoss ?? 0)）"
                     + (bits.isEmpty ? "：没有明显问题" : "：" + bits.joined(separator: " · ")))
        }

        if keys.isEmpty {
            L.append("")
            L.append("【关键时刻】没有严重失误、失误或漏杀。")
        } else {
            L.append("")
            L.append("【关键时刻】按丢分排序")
            for k in keys {
                L.append("  第 \(k.ply) 手（第 \(k.round) 回合，\(k.phase)）\(k.played) —— "
                         + (k.missedMate ? "漏杀" : "\(k.gradeName)，丢 \(k.loss) 分"))
                if !k.best.isEmpty { L.append("      引擎认为该走：\(k.best)") }
            }
        }

        if counts.missedMate > 0 {
            L.append("")
            L.append("【漏杀】有 \(counts.missedMate) 手本来可以直接成杀，没有走出来。")
        }

        L.append("")
        L.append("【结论】")
        if let w = worst, let wl = w.avgLoss, wl > 0 {
            L.append("  平均丢分最高的是\(w.name)（\(wl) 分 / 手，\(w.moves) 手）。"
                     + "整体平均 \(avgLoss) 分 / 手。")
        } else {
            L.append("  这盘没有值得单拎出来的阶段性问题。整体平均 \(avgLoss) 分 / 手。")
        }
        if counts.blunder > 0, let top = keys.first(where: { $0.grade == "blunder" }) {
            L.append("  最大的一处是第 \(top.ply) 手的 \(top.played)（丢 \(top.loss) 分）。")
        }
        return L.joined(separator: "\n")
    }

    /// 喂给大模型的结构化事实。与 `text` 同一份数据，
    /// 但去掉了「结论」段 —— 那一段是留给模型写的。
    var promptLines: [String] {
        var L: [String] = []
        L.append("【已由本地引擎逐手算好，可直接引用，不要自行推测】")
        var head = "我执红方，共 \(rounds) 回合。严重失误 \(counts.blunder) 次、"
            + "失误 \(counts.mistake) 次、不够精确 \(counts.inaccuracy) 次"
        if counts.missedMate > 0 { head += "、漏杀 \(counts.missedMate) 次" }
        L.append(head + "。")
        let ph = phases.filter { $0.moves > 0 }
            .map { "\($0.name) \($0.moves) 手/平均丢 \($0.avgLoss ?? 0) 分" }
        L.append("分阶段：" + ph.joined(separator: "；") + "。")
        if keys.isEmpty {
            L.append("没有严重失误、失误或漏杀。")
        } else {
            L.append("按丢分排序的关键时刻（「丢分」= 引擎认为的最好走法与我实际走法之间的分差）：")
            for k in keys {
                var s = "  · 第 \(k.ply) 手（第 \(k.round) 回合，\(k.phase)）我走了 \(k.played)，丢 \(k.loss) 分"
                if k.missedMate { s += "（这一步本来可以直接成杀）" }
                if !k.best.isEmpty { s += "；引擎建议走 \(k.best)" }
                L.append(s + "。")
            }
        }
        return L
    }
}

// MARK: - 能力维度

struct AbilityDimension: Identifiable {
    var id: String
    var name: String
    var score: Int
    var note: String

    var level: String {
        if score >= 70 { return "good" }
        if score >= 45 { return "mid" }
        return "bad"
    }
}

struct AbilityReport {
    var dimensions: [AbilityDimension] = []
    var games = 0
    var finished = 0
    var wins = 0
    var losses = 0
    var winRate = 0
    var avgPly = 0
    var blunders = 0
    var mistakes = 0
    var missedMate = 0
    var solvedMates = 0
    var mateTotal = 0
    var overall = 0
    var hasData = false
}

// MARK: - 训练推荐

struct Drill: Identifiable {
    var id: String
    var sceneId: String
    var badge: String
    var title: String
    var desc: String
}

// MARK: - 存档

/// 对局与练习记录。存在 Documents 下的 JSON 文件里 ——
/// 比 UserDefaults 更适合放这种会增长的数组数据。
final class Archive: ObservableObject {

    static let shared = Archive()

    @Published private(set) var games: [GameRecord] = []
    @Published private(set) var solvedDrills: Set<String> = []
    private var attempts: [String: Int] = [:]

    private struct Payload: Codable {
        var games: [GameRecord] = []
        var solved: [String: Date] = [:]
        var attempts: [String: Int] = [:]
    }

    private var url: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("xiangqi-archive.json")
    }

    private init() { load() }

    private func load() {
        guard let data = try? Data(contentsOf: url),
              let p = try? JSONDecoder().decode(Payload.self, from: data) else { return }
        games = p.games.sorted { $0.savedAt > $1.savedAt }
        solvedDrills = Set(p.solved.keys)
        attempts = p.attempts
    }

    private func persist() {
        let p = Payload(games: games,
                        solved: Dictionary(uniqueKeysWithValues: solvedDrills.map { ($0, Date()) }),
                        attempts: attempts)
        guard let data = try? JSONEncoder().encode(p) else { return }
        try? data.write(to: url, options: .atomic)
    }

    // MARK: 对局

    func save(_ record: GameRecord) {
        var r = record
        if r.savedAt.timeIntervalSince1970 == 0 { r.savedAt = Date() }
        if let idx = games.firstIndex(where: { $0.id == r.id }) {
            games[idx] = r
        } else {
            games.insert(r, at: 0)
        }
        if games.count > 200 { games = Array(games.prefix(200)) }
        persist()
    }

    func delete(_ id: String) {
        games.removeAll { $0.id == id }
        persist()
    }

    func clearGames() {
        games.removeAll()
        persist()
    }

    func resetAll() {
        games = []
        solvedDrills = []
        attempts = [:]
        persist()
    }

    // MARK: 练习计数

    func markAttempt(_ sceneId: String) {
        attempts[sceneId, default: 0] += 1
        persist()
    }

    /// 返回是否是首次通关
    @discardableResult
    func markSolved(_ sceneId: String) -> Bool {
        if solvedDrills.contains(sceneId) { return false }
        solvedDrills.insert(sceneId)
        persist()
        return true
    }

    // MARK: 逐手分析

    /// 评估一手棋的失分。必须在落子「之前」调用。
    static func analyze(before board: [Int8], move: Move, depth: Int = 4, budgetMs: Int = 450,
                        completion: @escaping (MoveEval?) -> Void) {
        Engine.shared.search(board: board, side: .red, maxDepth: depth, timeMs: budgetMs) { best in
            var after = board
            _ = Rules.makeMove(&after, move)
            Engine.shared.search(board: after, side: .black, maxDepth: depth, timeMs: budgetMs) { reply in
                let actual = -reply.score
                var loss = max(0, best.score - actual)
                if best.score > Engine.mate - 1000 { loss = 0 }

                var grade = "ok"
                if loss >= 800 { grade = "blunder" }
                else if loss >= 300 { grade = "mistake" }
                else if loss >= 100 { grade = "inaccuracy" }

                let missedMate = (best.score > Engine.mate - 1000) && (actual <= Engine.mate - 1000)
                let phase = Archive.phase(of: board)

                completion(MoveEval(ply: 0, redScore: actual, loss: loss, grade: grade,
                                    bestLabel: best.move.map { Notation.label(board: board, move: $0) } ?? "",
                                    phase: phase, missedMate: missedMate,
                                    playedLabel: Notation.label(board: board, move: move)))
            }
        }
    }

    static func phase(of board: [Int8]) -> String {
        Rules.material(board) < 32 ? "end" : "mid"
    }

    /// 结合手数判断阶段
    static func phase(of board: [Int8], ply: Int) -> String {
        if ply <= 24 { return "opening" }
        return phase(of: board)
    }

    // MARK: 能力画像

    private static func lossToScore(_ loss: Double) -> Int {
        if loss <= 0 { return 100 }
        return max(0, min(100, Int((100.0 * exp(-loss / 420.0)).rounded())))
    }

    private static func avg(_ xs: [Int32]) -> Double {
        guard !xs.isEmpty else { return 0 }
        return Double(xs.reduce(0, +)) / Double(xs.count)
    }

    func computeAbilities(mateTotal: Int) -> AbilityReport {
        Archive.abilities(games: games, solvedIds: solvedDrills, mateTotal: mateTotal)
    }

    /// 能力画像的纯函数实现 —— 不读磁盘，方便单元测试直接喂数据。
    static func abilities(games: [GameRecord], solvedIds: Set<String>, mateTotal: Int) -> AbilityReport {
        var rep = AbilityReport()
        let withEval = games.filter { !$0.evals.isEmpty }

        var openLoss: [Int32] = [], midLoss: [Int32] = [], endLoss: [Int32] = []
        var totalPly = 0, mated = 0, missed = 0, blunders = 0, mistakes = 0
        var wins = 0, finished = 0

        for g in games {
            for e in g.evals {
                switch e.phase {
                case "opening": openLoss.append(e.loss)
                case "end": endLoss.append(e.loss)
                default: midLoss.append(e.loss)
                }
            }
            totalPly += g.ply
            missed += g.flags.missedMate
            blunders += g.flags.blunders
            mistakes += g.flags.mistakes
            if g.finished {
                finished += 1
                if g.result == "win" { wins += 1 }
                else if g.result == "loss" { mated += 1 }
            }
        }

        let solved = solvedIds.count
        let ratio = mateTotal > 0 ? Double(solved) / Double(mateTotal) : 0

        let attack = max(0, min(100, Int((ratio * 100).rounded()) - min(35, missed * 7)))

        var defendBase = 62.0 + ratio * 22.0
        if finished > 0 { defendBase -= (Double(mated) / Double(finished)) * 30.0 }
        defendBase -= min(25.0, Double(blunders) * 1.6)
        let defend = max(0, min(100, Int(defendBase.rounded())))

        let hasPlay = !withEval.isEmpty
        let opening = hasPlay ? Archive.lossToScore(Archive.avg(openLoss)) : 0
        let midgame = hasPlay ? Archive.lossToScore(Archive.avg(midLoss)) : 0
        let endgame = hasPlay ? Archive.lossToScore(Archive.avg(endLoss)) : 0

        rep.dimensions = [
            AbilityDimension(id: "opening", name: "开局稳健", score: opening,
                             note: openLoss.isEmpty ? "还没有对局数据" : "前 12 回合平均失分 \(Int(Archive.avg(openLoss).rounded()))"),
            AbilityDimension(id: "midgame", name: "中局战术", score: midgame,
                             note: midLoss.isEmpty ? "还没有对局数据" : "中局平均失分 \(Int(Archive.avg(midLoss).rounded()))"),
            AbilityDimension(id: "endgame", name: "残局收官", score: endgame,
                             note: endLoss.isEmpty ? "还没有进入过残局的记录" : "残局平均失分 \(Int(Archive.avg(endLoss).rounded()))"),
            AbilityDimension(id: "attack", name: "攻杀把握", score: attack,
                             note: "杀法已通 \(solved)/\(mateTotal) 关" + (missed > 0 ? "，漏杀 \(missed) 次" : "")),
            AbilityDimension(id: "defend", name: "防守意识", score: defend,
                             note: finished > 0 ? "已结束 \(finished) 局，被将死 \(mated) 局" : "还没有完整对局数据")
        ]

        rep.games = games.count
        rep.finished = finished
        rep.wins = wins
        rep.blunders = blunders
        rep.mistakes = mistakes
        rep.missedMate = missed
        rep.solvedMates = solved
        rep.mateTotal = mateTotal
        rep.winRate = finished > 0 ? Int((Double(wins) / Double(finished) * 100).rounded()) : 0
        rep.avgPly = games.isEmpty ? 0 : totalPly / games.count
        rep.hasData = hasPlay || solved > 0

        let valid = rep.dimensions.filter { !$0.note.hasPrefix("还没有") || $0.id == "attack" || $0.id == "defend" }
        rep.overall = valid.isEmpty ? 0 : Int((Double(valid.map { $0.score }.reduce(0, +)) / Double(valid.count)).rounded())
        return rep
    }

    // MARK: 针对性训练

    func recommendDrills(library: XiangqiLibrary, limit: Int = 3) -> [Drill] {
        Archive.drills(games: games, solvedIds: solvedDrills, library: library, limit: limit)
    }

    /// 训练推荐的纯函数实现 —— 不读磁盘，测试可直接喂数据。
    static func drills(games: [GameRecord], solvedIds: Set<String>,
                       library: XiangqiLibrary, limit: Int = 3) -> [Drill] {
        let solvedDrills = solvedIds      // 桥接，函数体沿用原来的变量名
        let rep = abilities(games: games, solvedIds: solvedIds, mateTotal: library.mates.count)

        // 完全没有数据时给一套新手起步组合
        if !rep.hasData {
            var starter: [Drill] = []
            for m in library.mates.filter({ $0.tier == 1 }).prefix(2) {
                starter.append(Drill(id: "mate:\(m.id)", sceneId: "mate:\(m.id)", badge: "杀法",
                                     title: m.name, desc: m.difficultyText + " · 先从这里熟悉杀棋的感觉"))
            }
            if let o = library.openings.first {
                starter.append(Drill(id: "opening:\(o.id)", sceneId: "opening:\(o.id)", badge: "开局",
                                     title: o.name, desc: "先把最常见开局的头几手走熟"))
            }
            return Array(starter.prefix(limit))
        }

        let plan: [String: (kind: String, badge: String, why: String)] = [
            "opening": ("opening", "布局", "开局阶段失分偏多，先把常见开局的前几手走熟"),
            "midgame": ("mate", "杀法", "中局丢子偏多，用杀法练习练「一眼看出杀棋」"),
            "endgame": ("study", "残局", "残局收不住，先把几个基本胜残局走通"),
            "attack":  ("mate", "杀法", "有杀棋机会没抓住，专项练成杀套路"),
            "defend":  ("mate", "防守", "容易被将死，反过来多看杀法就知道怎么防")
        ]

        var out: [Drill] = []
        var seen = Set<String>()
        for dim in rep.dimensions.sorted(by: { $0.score < $1.score }) {
            guard out.count < limit, let p = plan[dim.id] else { continue }

            switch p.kind {
            case "opening":
                for o in library.openings where out.count < limit {
                    let key = "opening:\(o.id)"
                    if seen.contains(key) { continue }
                    seen.insert(key)
                    out.append(Drill(id: key, sceneId: key, badge: p.badge, title: o.name,
                                     desc: "\(o.style) · \(p.why)"))
                }
            case "study":
                for s in library.studies where out.count < limit {
                    let key = "study:\(s.id)"
                    if seen.contains(key) { continue }
                    seen.insert(key)
                    out.append(Drill(id: key, sceneId: key, badge: p.badge, title: s.name, desc: p.why))
                }
            default:
                let unsolved = library.mates.filter { !solvedDrills.contains("mate:\($0.id)") }
                let pool = (unsolved.isEmpty ? library.mates : unsolved).sorted { $0.tier < $1.tier }
                for m in pool where out.count < limit {
                    let key = "mate:\(m.id)"
                    if seen.contains(key) { continue }
                    seen.insert(key)
                    out.append(Drill(id: key, sceneId: key, badge: p.badge, title: m.name,
                                     desc: m.difficultyText + " · " + p.why))
                }
            }
        }

        // 不足则用杀法补满
        if out.count < limit {
            for m in library.mates where out.count < limit {
                let key = "mate:\(m.id)"
                if seen.contains(key) { continue }
                seen.insert(key)
                out.append(Drill(id: key, sceneId: key, badge: "杀法", title: m.name, desc: "空闲时也可以练一练"))
            }
        }
        return Array(out.prefix(limit))
    }
}
