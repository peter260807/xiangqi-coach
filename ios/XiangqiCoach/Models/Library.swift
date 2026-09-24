import Foundation

// MARK: - 棋谱库数据结构（对应 shared/library.json）

struct MatePuzzle: Codable, Identifiable {
    let id: String
    let name: String
    let tier: Int
    let fen: String
    /// 手写的那 11 道带讲解；从公开题库导入的没有这一项。
    /// ⚠️ 必须是**可选** —— 否则导入之后整个 library.json 都会解码失败
    /// （Codable 遇到缺字段是直接抛错，不会退化成空串），题库会变成空的。
    let idea: String?
    /// 导入来源，例如「适情雅趣」「基本杀法」。手写的 11 道没有这一项。
    let set: String?
    /// 由 tools/gen-lines.js（或 tools/import-puzzles.js）离线算出的解法路线
    /// （红黑双方都走引擎首选，也就是「最顽强防守下仍然成立的最短杀法」）。
    /// 老版本库文件里没有这一项，所以是可选的。
    let line: [String]?
    let mateIn: Int?

    /// 难度文案。`tier` 只有 1/2 两档（手写库用的），导入的题最多到 3，
    /// 所以优先按 mateIn 说清楚。
    var difficultyText: String {
        if let n = mateIn, let s = MatePuzzle.cnNum(n) { return s + "步杀" }
        if tier == 1 { return "一步杀" }
        if tier == 2 { return "两步杀" }
        return "多步杀"
    }

    /// 1~99 的中文数字。原来这里写死一个到「十」的数组 `cn[mateIn - 1]`，
    /// 于是 11 手以上全部掉进 tier 兜底、显示成「多步杀」——
    /// Pikafish 求解深杀之后库里有 30 手杀，这个洞就露出来了。
    ///
    /// ⚠️ 2 手**刻意**返回「二」不是「两」：原来 `cn[1]` 就是「二」，
    /// 库里 mateIn=2 的题一直显示「二步杀」，网页端训练页的筛选徽标也用「二」。
    /// 这次只是把上界从 10 提到 99，不该顺手改既有文案。
    static func cnNum(_ n: Int) -> String? {
        guard n >= 1 && n <= 99 else { return nil }
        let d = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
        if n < 10 { return d[n] }
        if n == 10 { return "十" }
        if n < 20 { return "十" + d[n % 10] }
        let head = d[n / 10] + "十"
        return n % 10 == 0 ? head : head + d[n % 10]
    }
}

struct OpeningLine: Codable, Identifiable {
    let id: String
    let name: String
    let style: String
    let line: String
    let desc: String
    let plies: Int?
}

struct StudyPuzzle: Codable, Identifiable {
    let id: String
    let name: String
    let fen: String
    let desc: String
}

/// 名局里某一手的解说
struct ClassicNote: Codable {
    let ply: Int
    let text: String
}

/// 古谱名局。着法序列属于史料，靠人工录入，
/// 由 tools/add-classics.js 逐手用引擎校验后才允许进库。
struct ClassicGame: Codable, Identifiable {
    let id: String
    let name: String
    let source: String
    let desc: String
    let line: String
    let plies: Int
    let mateIn: Int
    let highlights: [ClassicNote]?
}

/// 杀法分组。**必须是具名结构体，不能返回元组数组** ——
/// SwiftUI 的 `ForEach(id:)` 要一个 `KeyPath`，而 Swift 不支持指向元组成员的 key path，
/// 用元组会在编译期就报错（"key path cannot refer to tuple element"）。
struct MateGroup: Identifiable {
    var id: String { label }
    let label: String
    let items: [MatePuzzle]
}

struct XiangqiLibrary: Codable {
    var version: Int
    var mates: [MatePuzzle]
    var openings: [OpeningLine]
    var studies: [StudyPuzzle]
    /// 可选，方便库文件在加入名局之前生成的老版本仍能解码
    var classics: [ClassicGame]?

    var allClassics: [ClassicGame] { classics ?? [] }

    /// 杀法按来源分组。导入公开题库之后这里会有几百道题，
    /// 平铺一列既难找也难看；库里手写的 11 道不带 `set`，自然排在最前面。
    /// `solved` 是「已通关的 id 集合」（带 "mate:" 前缀），用于把没做过排在前面。
    func mateGroups(solved: Set<String> = []) -> [MateGroup] {
        var order: [String] = []
        var bucket: [String: [MatePuzzle]] = [:]
        for m in mates {
            let k = m.set ?? ""
            if bucket[k] == nil { bucket[k] = []; order.append(k) }
            bucket[k]!.append(m)
        }
        return order.map { k in
            let items = (bucket[k] ?? []).sorted { a, b in
                let da = solved.contains("mate:\(a.id)") ? 1 : 0
                let db = solved.contains("mate:\(b.id)") ? 1 : 0
                if da != db { return da < db }             // 没通关的在前
                return (a.mateIn ?? 99) < (b.mateIn ?? 99) // 再按手数从少到多
            }
            return MateGroup(label: k, items: items)
        }
    }

    static let empty = XiangqiLibrary(version: 0, mates: [], openings: [], studies: [], classics: [])

    /// 从 App bundle 读取 shared/library.json（构建前由 tools 同步进来）
    static func loadFromBundle() -> XiangqiLibrary {
        guard let url = Bundle.main.url(forResource: "library", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let lib = try? JSONDecoder().decode(XiangqiLibrary.self, from: data)
        else {
            return .empty
        }
        return lib
    }
}

// MARK: - 场景

enum SceneKind: String, Codable {
    case game      // 标准开局
    case mate      // 杀法练习
    case opening   // 开局库
    case study     // 实用残局
    case classic   // 古谱名局（打谱演示）
    case custom    // 用户导入的局面
}

struct XQScene: Identifiable, Equatable {
    var id: String
    var kind: SceneKind
    var title: String
    var startFEN: String
    var note: String
    /// 开局库专用：要预先摆上的着法
    var preloadLabels: [String]
    /// 打谱演示用的着法序列（名局全谱 / 杀法解法 / 开局谱）
    var demoLine: [String] = []
    /// 演示到第几手时的解说，键是手数（从 1 开始）
    var demoNotes: [Int: String] = [:]

    static func == (a: XQScene, b: XQScene) -> Bool { a.id == b.id }

    var canDemo: Bool { !demoLine.isEmpty }

    static func standard() -> XQScene {
        XQScene(id: "start", kind: .game, title: "标准开局",
              startFEN: Rules.startFEN,
              note: "红先行。初学者可以先试「炮二平五」抢占中路。",
              preloadLabels: [])
    }

    /// 由导入的棋谱/局面构造出来的临时场景
    static func custom(title: String, fen: String, note: String) -> XQScene {
        XQScene(id: "custom:\(UUID().uuidString)", kind: .custom, title: title,
                startFEN: fen, note: note, preloadLabels: [])
    }
}

/// 把棋谱库摊平成可选场景列表
enum SceneCatalog {
    static func all(_ lib: XiangqiLibrary) -> [XQScene] {
        var out: [XQScene] = [.standard()]

        for c in lib.allClassics {
            var notes: [Int: String] = [:]
            for h in (c.highlights ?? []) { notes[h.ply] = h.text }
            out.append(XQScene(id: "classic:\(c.id)", kind: .classic, title: c.name,
                             startFEN: Rules.startFEN,
                             note: c.source + "\n\n" + c.desc,
                             preloadLabels: [],
                             demoLine: c.line.split(separator: " ").map(String.init),
                             demoNotes: notes))
        }
        for m in lib.mates {
            /* 导入的题没有 idea（讲解是手写那 11 道才有的），
               用来源名兜底，别在提示里露出 "nil" 或空行。 */
            let lead = m.idea ?? (m.set.map { "选自《\($0)》。" } ?? "")
            let hint = "轮到你走，找出成杀的那一步。"
                + "想不出来可以点「提示」，或用「看解法」逐步演示。"
                + "\n\n（排局类题目的红方常常子力大落后，下方评估条因此可能显示对面占优 —— "
                + "它只反映子力，别以它为准。）"
            out.append(XQScene(id: "mate:\(m.id)", kind: .mate, title: m.name,
                             startFEN: m.fen,
                             note: lead.isEmpty ? hint : lead + "\n\n" + hint,
                             preloadLabels: [],
                             demoLine: m.line ?? []))
        }
        for o in lib.openings {
            let tokens = o.line.split(separator: " ").map(String.init)
            out.append(XQScene(id: "opening:\(o.id)", kind: .opening, title: o.name,
                             startFEN: Rules.startFEN,
                             note: o.desc + "\n\n已按谱摆好前几手，可以用「看解法」整段演示。",
                             preloadLabels: tokens,
                             demoLine: tokens))
        }
        for s in lib.studies {
            out.append(XQScene(id: "study:\(s.id)", kind: .study, title: s.name,
                             startFEN: s.fen, note: s.desc, preloadLabels: []))
        }
        return out
    }

    /// 按 id 找到场景并预摆开局着法，返回最终局面与已走着法
    static func resolve(_ scene: XQScene) -> (board: [Int8], moves: [Move]) {
        var b = Rules.parse(scene.startFEN)
        var moves: [Move] = []
        var turn: Side = .red
        for lab in scene.preloadLabels {
            guard let m = Notation.findMove(board: b, side: turn, text: lab) else { break }
            moves.append(m)
            _ = Rules.makeMove(&b, m)
            turn = turn.other
        }
        return (b, moves)
    }
}
