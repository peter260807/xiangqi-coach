import Foundation
import SwiftUI

struct HistoryItem {
    var move: Move
    var captured: Int8
    var label: String
    var side: Side
}

/// 对局状态机。所有流程控制都走这里，视图只负责呈现。
///
/// 走子刻意拆成两步：棋盘状态立即更新，视觉用约 0.46 秒滑过去，
/// 再停 0.52 秒 —— 合计约 1 秒，让人看清「谁走到了哪里、吃了什么」。
@MainActor
final class GameState: ObservableObject {

    static let slideMs = 460
    static let settleMs = 520
    static var totalAnimMs: Int { slideMs + settleMs }

    // 棋盘与流程
    @Published var board: [Int8] = Rules.parse(Rules.startFEN)
    @Published var turn: Side = .red
    @Published var selected: Int = -1
    @Published var targets: [Move] = []
    @Published var lastMove: Move?
    @Published var hintMove: Move?
    @Published var checkSide: Side?
    @Published var gameOver = false
    @Published var thinking = false

    // 动画
    @Published var animating = false
    @Published var animFrom = 0
    @Published var animTo = 0
    @Published var animPiece: Int8 = 0
    @Published var animProgress: Double = 1
    @Published var animCaptured: Int8 = 0

    // 展示
    @Published var redScore: Int32 = 0
    @Published var statusText = "轮到你走（红方）"
    @Published var statusWarn = false
    @Published var toast: String?
    @Published var toastKind = ""
    @Published var engineInfo = "本地引擎就绪"
    /// 混合对弈时模型给出的选择理由
    @Published var lastAINote = ""

    // 场景与存档
    @Published var scene: XQScene = .standard()
    @Published var history: [HistoryItem] = []
    @Published var moveMarks: [Int: String] = [:]
    @Published var levelKey = "hard"
    @Published var modeKey = "engine"

    let library: XiangqiLibrary
    private var record: GameRecord?
    private var pendingAnalysis: (board: [Int8], move: Move, ply: Int)?

    init(library: XiangqiLibrary) {
        self.library = library
        load(scene: .standard(), silent: true)
    }

    // MARK: - 场景

    func load(scene newScene: XQScene, silent: Bool = false) {
        scene = newScene
        let resolved = SceneCatalog.resolve(newScene)
        board = resolved.board
        turn = .red
        history = []
        moveMarks = [:]
        lastMove = nil
        hintMove = nil
        selected = -1
        targets = []
        gameOver = false
        thinking = false
        animating = false
        pendingAnalysis = nil

        var fen = Rules.parse(newScene.startFEN)
        for m in resolved.moves {
            let label = Notation.label(board: fen, move: m)
            let cap = Rules.makeMove(&fen, m)
            history.append(HistoryItem(move: m, captured: cap, label: label, side: turn))
            lastMove = m
            turn = turn.other
        }

        if newScene.kind == .mate || newScene.kind == .study {
            Archive.shared.markAttempt(newScene.id)
        }

        record = GameRecord(id: UUID().uuidString, savedAt: Date(),
                            sceneId: newScene.id, sceneName: newScene.title,
                            level: levelKey, mode: modeKey, startFEN: newScene.startFEN,
                            moves: history.flatMap { [$0.move.from, $0.move.to] },
                            evals: [], flags: GameFlags(), result: "unfinished",
                            finished: false, ply: history.count)

        refreshLegal()
        updateCheckState()
        updateEval()
        statusText = "轮到你走（红方）—— \(newScene.title)"
        statusWarn = false
        if !silent { showToast(newScene.kind == .game ? "开始对局" : newScene.title, kind: "") }
    }

    // MARK: - 走子

    func tap(square i: Int) {
        guard !gameOver, !thinking, !animating, turn == .red else { return }
        if selected >= 0 {
            if let m = targets.first(where: { $0.to == i }) {
                play(move: m, track: true)
                return
            }
        }
        if board[i] != 0 && Piece.isRed(board[i]) {
            selected = i
            hintMove = nil
            targets = Rules.legalMoves(board, .red).filter { $0.from == i }
        } else {
            selected = -1
            targets = []
        }
    }

    func play(move m: Move, track: Bool) {
        let cap = board[m.to]
        let label = Notation.label(board: board, move: m)
        let mover = turn
        let pre = track ? board : nil
        let ply = history.count + 1

        _ = Rules.makeMove(&board, m)
        history.append(HistoryItem(move: m, captured: cap, label: label, side: mover))
        lastMove = m
        selected = -1
        targets = []
        hintMove = nil
        turn = turn.other

        if let pre { pendingAnalysis = (pre, m, ply) }

        refreshLegal()
        updateCheckState()

        // 落子瞬间先报吃子
        if cap != 0 {
            showToast("吃 \(Piece.side(cap).shortLabel)\(Piece.name(cap))", kind: "capture", duration: 1.1)
        }

        animateMove(m, captured: cap)
    }

    private func animateMove(_ m: Move, captured: Int8) {
        animFrom = m.from
        animTo = m.to
        animPiece = board[m.to]
        animCaptured = captured
        animProgress = 0
        animating = true

        Task { [weak self] in
            guard let self else { return }
            let start = Date()
            while true {
                let elapsed = Date().timeIntervalSince(start) * 1000
                if elapsed >= Double(GameState.slideMs) { break }
                self.animProgress = elapsed / Double(GameState.slideMs)
                try? await Task.sleep(nanoseconds: 16_000_000)
            }
            self.animProgress = 1

            // 滑到位之后再报将军/将死，节奏更像真人下棋
            try? await Task.sleep(nanoseconds: 60_000_000)
            self.announceCheck()

            try? await Task.sleep(nanoseconds: UInt64(GameState.settleMs) * 1_000_000)
            self.animating = false
            self.animCaptured = 0
            self.onMoveSettled()
        }
    }

    private func announceCheck() {
        guard !gameOver else { return }
        let opponent = turn
        guard Rules.inCheck(board, opponent) else { return }
        if !Rules.hasLegalMove(board, opponent) {
            showToast("\(opponent.label)被将死", kind: "mate", duration: 2.2)
        } else {
            showToast("将 军！", kind: "check", duration: 1.3)
        }
    }

    private func onMoveSettled() {
        if !Rules.hasLegalMove(board, turn) {
            finish(loser: turn)
            return
        }
        updateEval()
        scheduleAnalysis()
        if turn == .black {
            aiTurn()
        } else {
            statusText = "轮到你走（红方）"
            statusWarn = false
        }
    }

    private func finish(loser: Side) {
        gameOver = true
        let checked = Rules.inCheck(board, loser)
        let winner = loser == .red ? "黑方" : "红方"
        redScore = loser == .red ? -Engine.mate : Engine.mate
        updateCheckState()

        statusText = "\(loser.label)" + (checked ? "被将死" : "被困毙（无子可动同样判负）") + "，\(winner)获胜。"
        statusWarn = true
        showToast(checked ? "将 死" : "困 毙", kind: "mate", duration: 2.6)

        if var r = record {
            r.result = (loser == .black) ? "win" : "loss"
            r.finished = true
            r.evals = collectedEvals
            r.flags = collectedFlags
            r.ply = history.count
            r.moves = history.flatMap { [$0.move.from, $0.move.to] }
            record = r
            Archive.shared.save(r)
            if loser == .black { Archive.shared.markSolved(scene.id) }
        }
    }

    // MARK: - 逐手质量分析

    private var collectedEvals: [MoveEval] = []
    private var collectedFlags = GameFlags()

    private func scheduleAnalysis() {
        guard let job = pendingAnalysis else { return }
        pendingAnalysis = nil
        let phase = Archive.phase(of: job.board, ply: job.ply)
        Archive.analyze(before: job.board, move: job.move) { [weak self] eval in
            guard let self, var e = eval else { return }
            e.ply = job.ply
            e.phase = phase
            self.collectedEvals.append(e)
            if e.grade == "blunder" {
                self.collectedFlags.blunders += 1
                self.moveMarks[job.ply] = "??"
            } else if e.grade == "mistake" {
                self.collectedFlags.mistakes += 1
                self.moveMarks[job.ply] = "?"
            } else if e.grade == "inaccuracy" {
                self.collectedFlags.inaccuracies += 1
            }
            if e.redScore > Engine.mate - 1000 && e.loss == 0 { /* 已杀，无需特别标记 */ }
            self.persistRecord()
        }
    }

    private func persistRecord() {
        guard var r = record else { return }
        r.evals = collectedEvals
        r.flags = collectedFlags
        r.ply = history.count
        r.moves = history.flatMap { [$0.move.from, $0.move.to] }
        record = r
        // 进行中的对局也存一份，避免中途退出丢进度
        if !r.finished && r.ply > 0 { Archive.shared.save(r) }
    }

    // MARK: - 电脑走棋

    private func aiTurn() {
        thinking = true
        let hybrid = (modeKey == "hybrid") && AIConfig.shared.isConfigured
        statusText = hybrid ? "电脑（大模型思考中）…" : "电脑计算中…"
        statusWarn = false
        if hybrid { hybridTurn(); return }

        let level = SearchLevel.named(levelKey)
        let snapshot = board
        Engine.shared.pickMove(board: snapshot, side: .black, level: level) { [weak self] res in
            guard let self else { return }
            self.thinking = false
            self.engineInfo = "本地引擎 \(res.depth) 层"
            if let m = res.move { self.play(move: m, track: false) }
            else { self.onMoveSettled() }
        }
    }

    // MARK: - 混合对弈：引擎给合法候选，模型挑一个并说明理由

    private func hybridTurn() {
        let snapshot = board
        Engine.shared.topMoves(board: snapshot, side: .black, count: 5, maxDepth: 5, timeMs: 2500) { [weak self] cands in
            guard let self else { return }
            guard let first = cands.first else {
                self.thinking = false
                self.onMoveSettled()
                return
            }

            Task { [weak self] in
                guard let self else { return }
                var chosen = first.move
                var note = ""

                do {
                    let msgs = Prompts.pickMove(board: snapshot, side: .black, candidates: cands)
                    let r = try await LLMClient.chat(messages: msgs, maxTokens: 2500, temperature: 0.3)

                    if let obj = LLMClient.extractJSON(r.content),
                       let asked = obj["move"] as? String,
                       let m = Notation.findMove(board: snapshot, side: .black, text: asked) {
                        chosen = m
                        let reason = (obj["reason"] as? String) ?? ""
                        note = "模型选 \(asked)" + (reason.isEmpty ? "" : "：\(reason)")
                    } else {
                        note = "模型给不出可用着法，已回退引擎首选 \(Notation.label(board: snapshot, move: chosen))"
                    }
                } catch {
                    note = "大模型调用失败，已回退引擎首选（\(error.localizedDescription)）"
                }

                self.lastAINote = note
                self.thinking = false
                self.play(move: chosen, track: false)
            }
        }
    }

    /// 走子前先同步一次哈希，避免跨模块搜索后增量哈希错位
    private func prepareForMove() {
        Engine.shared.syncHash(board, turn)
    }

    // MARK: - 提示

    func requestHint(completion: (([CandidateMove]) -> Void)? = nil) {
        guard !thinking, !animating, !gameOver, turn == .red else { return }
        thinking = true
        statusText = "正在计算…"
        let snapshot = board
        Engine.shared.topMoves(board: snapshot, side: .red, count: 4, maxDepth: 5, timeMs: 2200) { [weak self] cands in
            guard let self else { return }
            self.thinking = false
            guard let best = cands.first else {
                self.statusText = "没有可走的着法。"
                return
            }
            self.hintMove = best.move

            var probe = self.board
            let cap = Rules.makeMove(&probe, best.move)
            let mated = !Rules.hasLegalMove(probe, .black)
            Rules.undoMove(&probe, best.move, cap)

            self.statusText = "推荐 \(best.label)" + (mated ? "（一步将死）" : "") + "　" + Engine.scoreText(best.score)
            self.statusWarn = false
            completion?(cands)
        }
    }

    // MARK: - 悔棋

    func undo() {
        guard !thinking, !animating, !history.isEmpty else { return }
        // 退回到自己该走的状态
        while !history.isEmpty && turn != .red {
            let h = history.removeLast()
            Rules.undoMove(&board, h.move, h.captured)
            turn = turn.other
        }
        if history.count >= 2 {
            let h1 = history.removeLast()
            Rules.undoMove(&board, h1.move, h1.captured); turn = turn.other
            let h2 = history.removeLast()
            Rules.undoMove(&board, h2.move, h2.captured); turn = turn.other
            if turn != .red, let h3 = history.popLast() {
                Rules.undoMove(&board, h3.move, h3.captured); turn = turn.other
            }
        }
        selected = -1
        targets = []
        hintMove = nil
        gameOver = false
        pendingAnalysis = nil
        lastMove = history.last?.move
        collectedEvals.removeAll { $0.ply > history.count }
        moveMarks = moveMarks.filter { $0.key <= history.count }
        if var r = record {
            r.finished = false
            r.result = "unfinished"
            r.ply = history.count
            r.moves = history.flatMap { [$0.move.from, $0.move.to] }
            r.evals = collectedEvals
            r.flags = collectedFlags
            record = r
        }
        refreshLegal()
        updateCheckState()
        updateEval()
        statusText = "已悔棋，轮到你走（红方）"
        statusWarn = false
    }

    // MARK: - 辅助

    private func refreshLegal() {
        Engine.shared.syncHash(board, turn)
    }

    private func updateCheckState() {
        if !gameOver, Rules.inCheck(board, turn) { checkSide = turn } else { checkSide = nil }
    }

    private func updateEval() {
        guard !gameOver else { return }
        let snapshot = board
        let side = turn
        Engine.shared.search(board: snapshot, side: side, maxDepth: 3, timeMs: 500) { [weak self] r in
            guard let self else { return }
            self.redScore = (side == .red) ? r.score : -r.score
        }
    }

    private func showToast(_ text: String, kind: String, duration: Double = 1.6) {
        toast = text
        toastKind = kind
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            guard let self else { return }
            if self.toast == text { self.toast = nil }
        }
    }

    func showMessage(_ text: String, kind: String = "") {
        showToast(text, kind: kind, duration: 2.0)
    }

    // MARK: - 供界面展示

    var boardFEN: String { Rules.fen(board) }

    var currentRecord: GameRecord? { record }

    func saveCurrentGame() {
        guard var r = record, !history.isEmpty else { return }
        r.savedAt = Date()
        r.evals = collectedEvals
        r.flags = collectedFlags
        r.ply = history.count
        r.moves = history.flatMap { [$0.move.from, $0.move.to] }
        record = r
        Archive.shared.save(r)
        showMessage("已存入战绩")
    }

    func loadGame(_ g: GameRecord) {
        let newScene = XQScene(id: g.sceneId, kind: .game, title: g.sceneName,
                             startFEN: g.startFEN, note: "", preloadLabels: [])
        scene = newScene
        board = Rules.parse(g.startFEN)
        history = []
        moveMarks = [:]
        collectedEvals = g.evals
        collectedFlags = g.flags
        for e in g.evals where e.grade == "mistake" || e.grade == "blunder" {
            moveMarks[e.ply] = (e.grade == "blunder") ? "??" : "?"
        }
        turn = .red
        selected = -1
        targets = []
        hintMove = nil
        gameOver = false
        thinking = false
        animating = false
        pendingAnalysis = nil

        for m in g.movePairs {
            let label = Notation.label(board: board, move: m)
            let cap = Rules.makeMove(&board, m)
            history.append(HistoryItem(move: m, captured: cap, label: label, side: turn))
            lastMove = m
            turn = turn.other
        }
        record = g
        refreshLegal()
        updateCheckState()
        updateEval()
        statusText = "已载入「\(g.sceneName)」，轮到你走（红方）"
        statusWarn = false
        showToast("已载入存档", kind: "")
    }
}

/// 空棋盘占位，供预览使用
extension GameState {
    static var preview: GameState { GameState(library: .loadFromBundle()) }
}
