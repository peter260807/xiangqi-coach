import Foundation

// MARK: - 棋谱库数据结构（对应 shared/library.json）

struct MatePuzzle: Codable, Identifiable {
    let id: String
    let name: String
    let tier: Int
    let fen: String
    let idea: String
    /// 由 tools/gen-lines.js 离线算出的解法路线（红黑双方都走引擎首选，
    /// 也就是「最顽强防守下仍然成立的最短杀法」）。
    /// 老版本库文件里没有这一项，所以是可选的。
    let line: [String]?
    let mateIn: Int?
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

struct XiangqiLibrary: Codable {
    var version: Int
    var mates: [MatePuzzle]
    var openings: [OpeningLine]
    var studies: [StudyPuzzle]
    /// 可选，方便库文件在加入名局之前生成的老版本仍能解码
    var classics: [ClassicGame]?

    var allClassics: [ClassicGame] { classics ?? [] }

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
            out.append(XQScene(id: "mate:\(m.id)", kind: .mate, title: m.name,
                             startFEN: m.fen,
                             note: m.idea + "\n\n轮到你走，找出成杀的那一步。"
                                 + "想不出来可以点「提示」，或用「看解法」逐步演示。",
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
