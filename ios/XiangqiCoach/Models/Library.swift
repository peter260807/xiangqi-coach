import Foundation

// MARK: - 棋谱库数据结构（对应 shared/library.json）

struct MatePuzzle: Codable, Identifiable {
    let id: String
    let name: String
    let tier: Int
    let fen: String
    let idea: String
}

struct OpeningLine: Codable, Identifiable {
    let id: String
    let name: String
    let style: String
    let line: String
    let desc: String
}

struct StudyPuzzle: Codable, Identifiable {
    let id: String
    let name: String
    let fen: String
    let desc: String
}

struct XiangqiLibrary: Codable {
    var version: Int
    var mates: [MatePuzzle]
    var openings: [OpeningLine]
    var studies: [StudyPuzzle]

    static let empty = XiangqiLibrary(version: 0, mates: [], openings: [], studies: [])

    /// 从 App bundle 读取 shared/library.json（打包时由 tools 同步进来）
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
}

struct XQScene: Identifiable, Equatable {
    var id: String
    var kind: SceneKind
    var title: String
    var startFEN: String
    var note: String
    /// 开局库专用：要预先摆上的着法
    var preloadLabels: [String]

    static func == (a: XQScene, b: XQScene) -> Bool { a.id == b.id }

    static func standard() -> XQScene {
        XQScene(id: "start", kind: .game, title: "标准开局",
              startFEN: Rules.startFEN,
              note: "红先行。初学者可以先试「炮二平五」抢占中路。",
              preloadLabels: [])
    }
}

/// 把棋谱库摊平成可选场景列表
enum SceneCatalog {
    static func all(_ lib: XiangqiLibrary) -> [XQScene] {
        var out: [XQScene] = [.standard()]
        for m in lib.mates {
            out.append(XQScene(id: "mate:\(m.id)", kind: .mate, title: m.name,
                             startFEN: m.fen,
                             note: m.idea + "\n\n轮到你走，找出成杀的那一步。想不出来就点「提示」。",
                             preloadLabels: []))
        }
        for o in lib.openings {
            out.append(XQScene(id: "opening:\(o.id)", kind: .opening, title: o.name,
                             startFEN: Rules.startFEN,
                             note: o.desc + "\n\n已按谱摆好前几手，可以用「悔棋」逐步回看。",
                             preloadLabels: o.line.split(separator: " ").map(String.init)))
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
