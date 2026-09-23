import Foundation
import SwiftUI

struct HistoryItem {
    var move: Move
    var captured: Int8
    var label: String
    var side: Side
}

/// 需要二次确认的破坏性操作。
///
/// 「重开」按钮就挨着「悔棋」，误触一下整盘就没了；场景菜单里换一局、
/// 训练页点开一个练习，同样会把这盘棋清掉。三种入口共用这一个弹窗 ——
/// 文案和确认后的动作都在这里定义，免得各写一份还互相对不上。
enum ConfirmKind {
    /// 重开本局：局面不变，只把着法清空
    case restart(moves: Int, title: String)
    /// 换到另一个场景：局面整个换掉
    case switchScene(scene: XQScene, moves: Int)
    /// 载入存档：局面换成存档里的，进度也一起换成存档的
    case loadGame(record: GameRecord, moves: Int)

    var title: String {
        switch self {
        case .restart: return "重开本局？"
        case .switchScene: return "换一局？"
        case .loadGame: return "载入存档？"
        }
    }

    var confirmLabel: String {
        switch self {
        case .restart: return "重开"
        case .switchScene: return "换局"
        case .loadGame: return "载入"
        }
    }

    var message: String {
        switch self {
        case let .restart(moves, title):
            return "已走的 \(moves) 手会全部清掉，回到「\(title)」的初始局面。"
        case let .switchScene(scene, moves):
            return "当前这局的 \(moves) 手会被丢掉，改从「\(scene.title)」重新开始。"
        case let .loadGame(record, moves):
            return "当前这局的 \(moves) 手会被丢掉，改成载入存档「\(record.sceneName)」。"
        }
    }
}

/// 对局状态机。所有流程控制都走这里，视图只负责呈现。
///
/// 走子刻意拆成两步：棋盘状态立即更新，视觉用约 0.46 秒滑过去，
/// 再停 0.52 秒 —— 合计约 1 秒，让人看清「谁走到了哪里、吃了什么」。
@MainActor
final class GameState: ObservableObject {

    // MARK: 破坏性操作的二次确认

    /// 待确认的操作。视图只负责把它渲染成弹窗，判断与执行都在模型里
    @Published var pendingConfirm: ConfirmKind?

    /// 「重开」：场上还有棋就先问一句。空盘重开等于什么都没发生，不打扰
    func requestRestart() {
        if history.isEmpty {
            load(scene: scene)
        } else {
            pendingConfirm = .restart(moves: history.count, title: scene.title)
        }
    }

    /// 换场景（场景菜单与训练页都走它）：和「重开」一样会丢掉当前这盘棋
    func requestScene(_ target: XQScene) {
        if history.isEmpty {
            load(scene: target)
        } else {
            pendingConfirm = .switchScene(scene: target, moves: history.count)
        }
    }

    /// 确认弹窗里的「确定」被按下
    func confirmPending() {
        guard let kind = pendingConfirm else { return }
        pendingConfirm = nil
        switch kind {
        case .restart: load(scene: scene)
        case let .switchScene(target, _): load(scene: target)
        case let .loadGame(record, _): loadGame(record)
        }
    }

    /// 载入存档（战绩页的「载入」）：同样会丢掉当前这盘棋
    func requestLoadGame(_ record: GameRecord) {
        if history.isEmpty {
            loadGame(record)
        } else {
            pendingConfirm = .loadGame(record: record, moves: history.count)
        }
    }

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
    /// 以「判和 / 长将判负」结束时，评估条不能再写「已成杀」——
    /// 长将判负不是将死，棋盘上根本没有杀棋。这里存一句更准确的措辞。
    /// 只在 `gameOver` 为真时被视图采用，所以重开/悔棋后不必特意清空。
    @Published var evalOverride: String?
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
        // 换场景就退出演示，避免上一局的演示序列串到新局面上
        demoTicker?.cancel()
        demoTicker = nil
        demoPlaying = false
        demoMode = false
        demoTotal = 0
        demoDone = 0
        demoNote = ""

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
        // 演示进行中不接受落子，免得和自动走子打架
        guard !gameOver, !thinking, !animating, !demoMode, turn == .red else { return }
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
        // 打谱演示：走完一手就把节奏交回给播放器 —— 不做逐手分析，也不叫电脑走棋
        if demoMode {
            if scheduleDemoNextIfNeeded() { return }
            statusText = "打谱演示 \(demoDone)/\(demoTotal)"
                + (demoNote.isEmpty ? "" : "　" + demoNote)
            statusWarn = false
            return
        }
        if !Rules.hasLegalMove(board, turn) {
            finish(loser: turn)
            return
        }
        // 判和排在将死/困毙之后：无子可动本身就是终局，不能被当成和棋。
        // 长将判负也在这里出结果 —— 否则双方会一直循环下去
        // （对局台实测 20 局里有 45% 是在循环里结束的）。
        if let verdict = Rules.adjudicate(startFEN: scene.startFEN,
                                         moves: history.map { $0.move }) {
            finishAdjudicated(verdict)
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
        evalOverride = nil          // 避免留着上一次「判和 / 长将」的措辞
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

    /// 判和 / 长将判负。和 `finish(loser:)` 分开写：
    /// 和棋不该弹「将死」那种大字，也不该记成胜场。
    private func finishAdjudicated(_ verdict: Adjudication) {
        gameOver = true
        let winner = verdict.winner
        let isDraw = winner == nil
        redScore = isDraw ? 0 : (winner == .red ? Engine.mate : -Engine.mate)
        // 评估条上写「已成杀」是不对的（长将判负没有杀棋），单独给一句准确的
        evalOverride = isDraw ? "和棋" : ((winner == .red ? "红方" : "黑方") + "胜")
        updateCheckState()

        let head = winner.map { $0.label + "获胜" } ?? "和棋"
        statusText = head + "　" + verdict.reason + "。"
        statusWarn = true
        showToast(isDraw ? "和 棋" : head, kind: isDraw ? "draw" : "mate", duration: 2.6)

        if var r = record {
            r.result = (winner == .black) ? "win" : (isDraw ? "draw" : "loss")
            r.finished = true
            r.evals = collectedEvals
            r.flags = collectedFlags
            r.ply = history.count
            r.moves = history.flatMap { [$0.move.from, $0.move.to] }
            record = r
            Archive.shared.save(r)
            if winner == .black { Archive.shared.markSolved(scene.id) }
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
            // 本来有杀棋却没走出来 —— 这正是「攻杀把握」维度要扣分的行为。
            // 之前这里只留了一句空注释、没有累加计数，导致该维度永远拿满分。
            if e.missedMate == true {
                self.collectedFlags.missedMate += 1
            }
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

    /// 交给搜索的着法历史：引擎靠它才知道哪些局面「已经出现过」（走回去按和棋算）。
    /// 没有它，引擎在优势时会把绕圈当成正分继续走 —— 一盘赢棋被自己走成和棋。
    /// startFEN 必须一起给：残局 / 杀法 / 名局不是从标准开局摆起来的，
    /// 少了它历史会被按标准开局重放，判出来的「重复」全是假的。
    private var searchHistory: Engine.SearchHistory? {
        history.isEmpty ? nil
                        : Engine.SearchHistory(startFEN: scene.startFEN,
                                               moves: history.map { $0.move },
                                               startSide: .red)
    }

    private func aiTurn() {
        thinking = true
        let hybrid = (modeKey == "hybrid") && AIConfig.shared.isConfigured
        statusText = hybrid ? "电脑（大模型思考中）…" : "电脑计算中…"
        statusWarn = false
        if hybrid { hybridTurn(); return }

        let level = SearchLevel.named(levelKey)
        let snapshot = board
        Engine.shared.pickMove(board: snapshot, side: .black, level: level,
                               history: searchHistory) { [weak self] res in
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
        Engine.shared.topMoves(board: snapshot, side: .black, count: 5, maxDepth: 5,
                               timeMs: 2500, history: searchHistory) { [weak self] cands in
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
                    // 预算跟随设置里的 max_tokens。原来写死 2500 ——
                    // 推理模型的思维链动辄 5000+，预算不够时模型给不出着法，
                    // 会**静默**回退到引擎首选，看起来像"大模型没起作用"。
                    let r = try await LLMClient.chat(messages: msgs, maxTokens: nil, temperature: 0.3)

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
        Engine.shared.topMoves(board: snapshot, side: .red, count: 4, maxDepth: 5,
                               timeMs: 2200, history: searchHistory) { [weak self] cands in
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

    // MARK: - 打谱演示

    @Published var demoMode = false
    @Published var demoTotal = 0
    @Published var demoDone = 0
    @Published var demoPlaying = false
    @Published var demoNote = ""
    private var demoMoves: [Move] = []
    private var demoTicker: Task<Void, Never>?

    var canDemo: Bool { scene.canDemo }

    /// 进入打谱演示：先把局面复位，再把整段棋谱解析成着法序列。
    /// 演示期间不接受落子、也不叫电脑走棋，纯看谱。
    func startDemo() {
        guard scene.canDemo, !thinking else { return }
        demoTicker?.cancel()
        demoPlaying = false

        load(scene: scene, silent: true)

        var b = Rules.parse(scene.startFEN)
        var side: Side = .red
        var moves: [Move] = []
        for label in scene.demoLine {
            guard let m = Notation.findMove(board: b, side: side, text: label) else { break }
            moves.append(m)
            _ = Rules.makeMove(&b, m)
            side = side.other
        }
        guard !moves.isEmpty else {
            showToast("这段棋谱解析不出着法", kind: "")
            return
        }

        demoMoves = moves
        demoTotal = moves.count
        demoDone = 0
        demoMode = true
        demoNote = ""
        statusText = "打谱演示：\(scene.title)　共 \(demoTotal) 手，点「播放」开始"
        statusWarn = false
    }

    /// 演示时走下一手
    func demoStep() {
        guard demoMode, demoDone < demoTotal else {
            demoPlaying = false
            return
        }
        let m = demoMoves[demoDone]
        demoDone += 1
        demoNote = scene.demoNotes[demoDone] ?? ""
        play(move: m, track: false)
    }

    func demoToggle() {
        guard demoMode else { startDemo(); return }
        if demoPlaying { demoPlaying = false; return }
        if demoDone >= demoTotal {          // 放完了再按就从头再演一遍
            demoDone = 0
            let s = scene
            load(scene: s, silent: true)
            demoMode = true
            demoNote = ""
        }
        demoPlaying = true
        statusText = "打谱演示中…"
        demoStep()
    }

    func exitDemo() {
        demoTicker?.cancel()
        demoTicker = nil
        demoPlaying = false
        demoMode = false
        demoTotal = 0
        demoDone = 0
        demoNote = ""
        load(scene: scene, silent: true)
        showToast("已退出演示", kind: "")
    }

    /// 演示播放的节奏：等这一手的动画停下来，再走下一手
    private func scheduleDemoNextIfNeeded() -> Bool {
        guard demoMode, demoPlaying else { return false }
        guard demoDone < demoTotal else {
            demoPlaying = false
            statusText = "演示结束（共 \(demoTotal) 手）"
            statusWarn = false
            return true
        }
        demoTicker = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 620_000_000)
            guard let self, !Task.isCancelled, self.demoPlaying, self.demoMode else { return }
            self.statusText = "打谱演示 \(self.demoDone)/\(self.demoTotal)　\(self.demoNote)"
            self.demoStep()
        }
        return true
    }

    // MARK: - 棋谱导入导出

    var exportFEN: String { Rules.fen(board) }

    var exportMoveText: String {
        guard !history.isEmpty else { return "" }
        return Notation.movesToText(startFEN: scene.startFEN, moves: history.map { $0.move })
    }

    /// 一段可以直接发出去的完整文本：局面、棋谱、坐标三种形式都在里面，
    /// 自己或别人再粘回来都能还原。
    var exportShareText: String {
        var out: [String] = []
        out.append("象棋教练 · \(scene.title)")
        if let first = scene.note.split(separator: "\n").first.map(String.init), !first.isEmpty {
            out.append(first)
        }
        out.append("")
        out.append("【初始局面】")
        out.append(scene.startFEN)
        if !exportMoveText.isEmpty {
            out.append("")
            out.append("【棋谱】")
            out.append(exportMoveText)
            out.append("")
            out.append("【着法坐标】")
            out.append(history.flatMap { [$0.move.from, $0.move.to] }
                        .map(String.init).joined(separator: ","))
        }
        out.append("")
        out.append("【当前局面】")
        out.append(exportFEN)
        return out.joined(separator: "\n")
    }

    /// 导入局面或棋谱。返回 nil 表示成功，否则返回给用户看的说明。
    @discardableResult
    func importText(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "没有内容可导入。" }

        // ① 局面串
        for token in text.split(whereSeparator: { " \n\t，,、;；".contains($0) }) {
            let t = token.trimmingCharacters(in: CharacterSet(charactersIn: "：:。()（）"))
            if let fen = GameState.validatedFEN(t) {
                let s = XQScene.custom(title: "导入的局面", fen: fen,
                                       note: "这是导入进来的局面。点「重开」可以回到这里。")
                load(scene: s, silent: true)
                showToast("已导入局面", kind: "")
                return nil
            }
        }

        // ② 中文棋谱
        let labels = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" })
            .map(String.init)
            .filter { $0.range(of: "[平进退]", options: .regularExpression) != nil }
        if !labels.isEmpty { return applyImportedMoveText(labels) }

        // ③ 着法坐标串
        let nums = text.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
        if nums.count >= 2, nums.count % 2 == 0, nums.allSatisfy({ $0 >= 0 && $0 < 90 }) {
            return applyImportedCoords(nums)
        }

        return "没认出可导入的内容。\n\n可以粘贴：\n· FEN 局面串\n· 中文棋谱，如「炮二平五 马8进7」\n· 着法坐标，如「67,40,19,46」"
    }

    /// 校验并规范化一个局面串。返回 nil 表示这不是一个可用的局面。
    static func validatedFEN(_ s: String) -> String? {
        let rows = s.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard rows.count == 10 else { return nil }
        var b = [Int8](repeating: 0, count: 90)
        for (r, row) in rows.enumerated() {
            guard row.count == 9 else { return nil }
            for (c, ch) in row.enumerated() {
                if ch == "." { continue }
                guard let p = Piece.fromChar[ch] else { return nil }
                b[r * 9 + c] = p
            }
        }
        // 必须恰好一个帅、一个将，且都在九宫之内 —— 否则引擎会算出离谱的结果
        var redKings = 0, blackKings = 0
        for i in 0..<90 {
            if b[i] == Piece.code(Piece.typeKing, .red) { redKings += 1 }
            if b[i] == Piece.code(Piece.typeKing, .black) { blackKings += 1 }
        }
        guard redKings == 1, blackKings == 1 else { return nil }
        let kr = Rules.kingIndex(b, .red), kb = Rules.kingIndex(b, .black)
        guard kr >= 0, kb >= 0 else { return nil }
        guard (7...9).contains(Rules.row(kr)), (3...5).contains(Rules.col(kr)) else { return nil }
        guard (0...2).contains(Rules.row(kb)), (3...5).contains(Rules.col(kb)) else { return nil }
        guard !Rules.kingsFacing(b) else { return nil }
        return Rules.fen(b)
    }

    private func applyImportedMoveText(_ labels: [String]) -> String? {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red
        var applied: [Move] = []
        var rejected: String?
        for token in labels {
            guard let m = Notation.findMove(board: b, side: side, text: token) else {
                rejected = token
                break
            }
            applied.append(m)
            _ = Rules.makeMove(&b, m)
            side = side.other
        }
        guard !applied.isEmpty else {
            return "第一手「\(rejected ?? labels[0])」从标准开局走不通。"
        }
        let note = rejected == nil
            ? "从标准开局起，已按棋谱走完 \(applied.count) 手。"
            : "已走 \(applied.count) 手；「\(rejected ?? "")」之后的着法没认出来，停在合法处。"
        installImported(title: "导入的棋谱", moves: applied, note: note)
        showToast("已导入棋谱（\(applied.count) 手）", kind: "")
        return nil
    }

    private func applyImportedCoords(_ nums: [Int]) -> String? {
        var b = Rules.parse(Rules.startFEN)
        var side: Side = .red
        var applied: [Move] = []
        var i = 0
        while i + 1 < nums.count {
            let m = Move(from: nums[i], to: nums[i + 1])
            guard Rules.legalMoves(b, side).contains(m) else {
                if applied.isEmpty {
                    return "第一手「\(nums[i])→\(nums[i + 1])」在当前局面不合法。"
                }
                break
            }
            applied.append(m)
            _ = Rules.makeMove(&b, m)
            side = side.other
            i += 2
        }
        guard !applied.isEmpty else { return "没能识别出任何合法着法。" }
        installImported(title: "导入的棋谱",
                        moves: applied,
                        note: "按坐标导入，共 \(applied.count) 手。")
        showToast("已导入棋谱（\(applied.count) 手）", kind: "")
        return nil
    }

    private func installImported(title: String, moves: [Move], note: String) {
        scene = XQScene.custom(title: title, fen: Rules.startFEN, note: note)
        board = Rules.parse(Rules.startFEN)
        history = []
        moveMarks = [:]
        collectedEvals = []
        collectedFlags = GameFlags()
        turn = .red
        selected = -1
        targets = []
        hintMove = nil
        lastMove = nil
        gameOver = false
        thinking = false
        animating = false
        pendingAnalysis = nil
        demoMode = false

        for m in moves {
            let label = Notation.label(board: board, move: m)
            let cap = Rules.makeMove(&board, m)
            history.append(HistoryItem(move: m, captured: cap, label: label, side: turn))
            lastMove = m
            turn = turn.other
        }
        record = GameRecord(id: UUID().uuidString, savedAt: Date(),
                            sceneId: scene.id, sceneName: scene.title,
                            level: levelKey, mode: modeKey, startFEN: scene.startFEN,
                            moves: history.flatMap { [$0.move.from, $0.move.to] },
                            evals: [], flags: GameFlags(), result: "unfinished",
                            finished: false, ply: history.count)
        refreshLegal()
        updateCheckState()
        updateEval()
        statusText = note
        statusWarn = false
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
        // 评估条也要知道「这盘棋已经出现过哪些局面」：优势方被逼和 / 弱势方求和，
        // 显示 0 才是实话。不给历史的话它会一直报着已经拿不到的分数。
        Engine.shared.search(board: snapshot, side: side, maxDepth: 3, timeMs: 500,
                             history: searchHistory) { [weak self] r in
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
