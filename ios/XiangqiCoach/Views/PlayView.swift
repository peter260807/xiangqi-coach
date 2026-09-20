import SwiftUI

struct PlayView: View {
    @ObservedObject var game: GameState
    @Binding var showSettings: Bool

    /// 横竖两个方向都宽松（iPad 全屏、iPad 分屏的大部分）才走左右分栏。
    /// iPhone 横屏宽度也是 regular，但高度很紧 —— 那时候竖排反而更好用。
    @Environment(\.horizontalSizeClass) private var hSize
    @Environment(\.verticalSizeClass) private var vSize

    @State private var candidates: [CandidateMove] = []
    @State private var showCoach = false
    @State private var panelTitle = "教练"
    @State private var panelBody = ""
    @State private var panelBusy = false
    @State private var askText = ""
    @State private var showAskField = false
    /// 自动化截图时可用 SIMCTL_CHILD_START_NOTATION=1 直接打开棋谱面板
    @State private var showNotation = ProcessInfo.processInfo.environment["START_NOTATION"] == "1"

    private var scenes: [XQScene] { SceneCatalog.all(game.library) }

    /// 宽高都宽松（iPad 全屏、iPad 分屏的大部分）时走左右分栏：
    /// 棋盘占左边，操作与棋谱记录占右边 —— 不用来回滚动，棋盘也能吃满高度。
    private var isWide: Bool { hSize == .regular && vSize == .regular }

    var body: some View {
        Group {
            if isWide { wideLayout } else { compactLayout }
        }
        .background(Palette.paper.ignoresSafeArea())
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 9) {
                    Text("象")
                        .font(.system(size: 19, weight: .semibold, design: .serif))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(LinearGradient(colors: [Color(red: 0.753, green: 0.224, blue: 0.169),
                                                            Color(red: 0.553, green: 0.122, blue: 0.086)],
                                                   startPoint: .top, endPoint: .bottom))
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 0) {
                        Text("象棋教练").font(.system(size: 16, weight: .semibold))
                        Text(game.engineInfo).font(.system(size: 10.5)).foregroundStyle(Palette.ink3)
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 16) {
                    Button { showNotation = true } label: {
                        Image(systemName: "square.and.arrow.up.on.square")
                    }
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
        }
        .sheet(isPresented: $showCoach) { coachSheet }
        .sheet(isPresented: $showNotation) { NotationSheet(game: game) }
    }

    // MARK: - 布局

    /// 窄屏（iPhone 竖屏 / 横屏）：竖着排，靠滚动
    private var compactLayout: some View {
        ScrollView {
            VStack(spacing: 12) {
                evalBar
                boardArea
                statusBar
                controls
                moveList
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 96)   // 给底部标签栏留出空间，否则最后一行控件会被压住
        }
    }

    /// 宽屏（iPad）：左右分栏，棋盘在左、控制与记录在右
    private var wideLayout: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(spacing: 10) {
                evalBar
                boardArea
                statusBar
            }
            .frame(maxWidth: 640)

            ScrollView {
                VStack(spacing: 8) {
                    controls
                    moveList
                }
                .padding(.bottom, 32)
            }
            // 给个区间而不是固定宽度：竖屏 iPad 宽度紧张时让出空间给棋盘
            .frame(minWidth: 330, idealWidth: 380, maxWidth: 420)
        }
        .padding(.horizontal, 22)
        .padding(.top, 8)
    }

    // MARK: - 胜率条

    private var evalBar: some View {
        let pct = Engine.winRate(game.redScore)
        let redPct = Int((pct * 100).rounded())
        return VStack(spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("红方").font(.system(size: 12)).foregroundStyle(Palette.ink3)
                Text("\(redPct)%").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.red)
                Spacer()
                Text(Engine.scoreText(game.redScore))
                    .font(.system(size: 12)).foregroundStyle(Palette.ink2)
                Spacer()
                Text("\(100 - redPct)%").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.black)
                Text("黑方").font(.system(size: 12)).foregroundStyle(Palette.ink3)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(red: 0.871, green: 0.847, blue: 0.800))
                    Capsule()
                        .fill(LinearGradient(colors: [Color(red: 0.553, green: 0.122, blue: 0.086),
                                                      Color(red: 0.753, green: 0.224, blue: 0.169)],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, geo.size.width * pct))
                }
            }
            .frame(height: 9)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.line, lineWidth: 0.5))
    }

    // MARK: - 棋盘区（含飘字提示）

    private var boardArea: some View {
        ZStack(alignment: .top) {
            BoardView(game: game)
                .contentShape(Rectangle())
                .onTapGesture { /* 位置由下面的手势覆盖处理 */ }

            BoardTapOverlay(game: game)

            if let t = game.toast {
                Text(t)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 7)
                    .background(toastColor(game.toastKind))
                    .clipShape(Capsule())
                    .padding(.top, 12)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        // 必须给整个棋盘区定死比例：点击层里的 GeometryReader 是贪婪的，
        // 不约束的话它会把 ZStack 撑满可用高度，状态栏就被顶到屏幕最底下了。
        .aspectRatio(BoardMetrics.aspect, contentMode: .fit)
        .animation(.easeOut(duration: 0.2), value: game.toast)
    }

    private func toastColor(_ kind: String) -> Color {
        switch kind {
        case "capture": return Palette.amber.opacity(0.95)
        case "check": return Palette.red.opacity(0.95)
        case "mate": return Palette.jade.opacity(0.95)
        default: return Palette.ink.opacity(0.9)
        }
    }

    // MARK: - 状态条

    private var statusBar: some View {
        HStack(spacing: 9) {
            Circle()
                .fill(game.statusWarn ? Palette.red
                      : (game.thinking ? Palette.ink3 : Palette.red))
                .frame(width: 8, height: 8)
                .opacity(game.thinking ? 0.45 : 1)
            Text(game.statusText)
                .font(.system(size: 13))
                .foregroundStyle(game.statusWarn ? Palette.red : Palette.ink2)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 42, alignment: .leading)
        .background(game.statusWarn ? Palette.redSoft : Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.line, lineWidth: 0.5))
    }

    // MARK: - 控制区

    private var controls: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                actionButton("提示", icon: "lightbulb") { requestHint() }
                actionButton("悔棋", icon: "arrow.uturn.backward") { game.undo() }
                actionButton("重开", icon: "arrow.clockwise") { game.load(scene: game.scene) }
            }

            // 有谱可演的场景才出现：名局全谱、杀法解法、开局谱
            if game.canDemo || game.demoMode { demoBar }

            sceneMenu

            HStack(spacing: 8) {
                levelMenu
                actionButton("存档", icon: "square.and.arrow.down") {
                    game.saveCurrentGame()
                }
            }

            modeMenu

            HStack(spacing: 8) {
                Button {
                    askText = ""
                    showAskField = false
                    coach(question: nil)
                } label: {
                    Label("AI 点评局面", systemImage: "text.bubble")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Palette.jade)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(panelBusy)

                Button {
                    review()
                } label: {
                    Label("复盘", systemImage: "doc.text.magnifyingglass")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Palette.card)
                        .foregroundStyle(Palette.ink)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Palette.line, lineWidth: 0.5))
                }
                .disabled(panelBusy)
            }
        }
    }

    /// 打谱演示控制条
    private var demoBar: some View {
        VStack(spacing: 8) {
            if game.demoMode {
                HStack {
                    Text("演示 \(game.demoDone)/\(game.demoTotal)")
                        .font(.system(size: 11)).foregroundStyle(Palette.ink3)
                    Spacer()
                    ProgressView(value: Double(game.demoDone), total: Double(max(1, game.demoTotal)))
                        .frame(maxWidth: 130)
                }
                HStack(spacing: 8) {
                    Button {
                        game.demoToggle()
                    } label: {
                        Label(game.demoPlaying ? "暂停" : "播放",
                              systemImage: game.demoPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Palette.jade)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    actionButton("下一手", icon: "forward.frame") {
                        if !game.demoPlaying { game.demoStep() }
                    }
                    actionButton("退出", icon: "xmark") { game.exitDemo() }
                }
                if !game.demoNote.isEmpty {
                    Text(game.demoNote)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.ink2)
                        .lineSpacing(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(Palette.jadeSoft)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
            } else {
                Button {
                    game.startDemo()
                } label: {
                    Label("看解法（逐步演示这段谱）", systemImage: "play.rectangle")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Palette.card)
                        .foregroundStyle(Palette.ink)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Palette.line, lineWidth: 0.5))
                }
            }
        }
    }

    private func actionButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 14))
                Text(title).font(.system(size: 12, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(Palette.card)
            .foregroundStyle(Palette.ink)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Palette.line, lineWidth: 0.5))
        }
    }

    private var sceneMenu: some View {
        Menu {
            Button("标准开局（红先）") { game.load(scene: .standard()) }
            Menu("杀法练习") {
                ForEach(scenes.filter { $0.kind == .mate }) { s in
                    Button(s.title) { game.load(scene: s) }
                }
            }
            Menu("开局库") {
                ForEach(scenes.filter { $0.kind == .opening }) { s in
                    Button(s.title) { game.load(scene: s) }
                }
            }
            Menu("实用残局") {
                ForEach(scenes.filter { $0.kind == .study }) { s in
                    Button(s.title) { game.load(scene: s) }
                }
            }
        } label: {
            HStack {
                Image(systemName: "list.bullet.rectangle")
                Text(game.scene.title).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
            }
            .font(.system(size: 13))
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Palette.card)
            .foregroundStyle(Palette.ink)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Palette.line, lineWidth: 0.5))
        }
    }

    private var levelMenu: some View {
        Menu {
            ForEach(SearchLevel.all, id: \.key) { lv in
                Button(lv.label) { game.levelKey = lv.key }
            }
        } label: {
            HStack {
                Image(systemName: "gauge.with.dots.needle.33percent")
                Text("难度：\(SearchLevel.named(game.levelKey).label).")
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
            }
            .font(.system(size: 12.5))
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Palette.card)
            .foregroundStyle(Palette.ink)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Palette.line, lineWidth: 0.5))
        }
    }

    private var modeMenu: some View {
        Menu {
            Button("本地引擎") { game.modeKey = "engine" }
            Button("引擎 + 大模型协作") { game.modeKey = "hybrid" }
        } label: {
            HStack {
                Image(systemName: "cpu")
                Text(game.modeKey == "hybrid" ? "对手：引擎 + 大模型协作" : "对手：本地引擎")
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
            }
            .font(.system(size: 12.5))
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Palette.card)
            .foregroundStyle(Palette.ink)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Palette.line, lineWidth: 0.5))
        }
    }

    // MARK: - 走子记录

    private var moveList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(game.scene.title).font(.system(size: 11)).foregroundStyle(Palette.ink3)
                Spacer()
                Text("\(Int(ceil(Double(game.history.count) / 2.0))) 回合")
                    .font(.system(size: 11)).foregroundStyle(Palette.ink3)
            }
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 6)

            Divider().background(Palette.lineSoft)

            if game.history.isEmpty {
                Text("对局记录会显示在这里")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Palette.ink3)
                    .padding(14)
            } else {
                let rows = stride(from: 0, to: game.history.count, by: 2).map { $0 }
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(rows, id: \.self) { i in
                        HStack(spacing: 10) {
                            Text("\(i / 2 + 1).")
                                .font(.system(size: 12.5, design: .monospaced))
                                .foregroundStyle(Palette.ink3)
                                .frame(width: 24, alignment: .trailing)
                            moveCell(game.history[i], ply: i + 1)
                            if i + 1 < game.history.count {
                                moveCell(game.history[i + 1], ply: i + 2)
                            } else {
                                Spacer().frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
            }
        }
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.line, lineWidth: 0.5))
    }

    private func moveCell(_ h: HistoryItem, ply: Int) -> some View {
        let mark = game.moveMarks[ply]
        return HStack(spacing: 3) {
            Text(h.label)
                .font(.system(size: 12.5))
                .foregroundStyle(h.side == .red ? Palette.red : Palette.black)
            if let m = mark {
                Text(m)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(m == "??" ? Palette.red : Palette.amber)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 教练面板

    private var coachSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !candidates.isEmpty && panelTitle.contains("着法建议") {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("引擎候选").font(.system(size: 12)).foregroundStyle(Palette.ink3)
                            ForEach(Array(candidates.enumerated()), id: \.offset) { idx, c in
                                HStack {
                                    Text("\(idx + 1). \(c.label)")
                                        .font(.system(size: 13.5, weight: idx == 0 ? .semibold : .regular))
                                    Spacer()
                                    Text("\(c.score)").font(.system(size: 12, design: .monospaced))
                                        .foregroundStyle(Palette.ink3)
                                    if idx == 0 {
                                        Text("推荐")
                                            .font(.system(size: 10, weight: .semibold))
                                            .padding(.horizontal, 6).padding(.vertical, 2)
                                            .background(Palette.jadeSoft)
                                            .foregroundStyle(Palette.jade)
                                            .clipShape(Capsule())
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                        .padding(13)
                        .background(Palette.card)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Palette.line, lineWidth: 0.5))
                    }

                    Text(panelBody.isEmpty ? "正在准备…" : panelBody)
                        .font(.system(size: 14))
                        .lineSpacing(4)
                        .foregroundStyle(panelTitle.contains("失败") || panelTitle.contains("没有正文")
                                         ? Palette.red : Palette.ink2)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if showAskField {
                        HStack(spacing: 8) {
                            TextField("继续问教练…", text: $askText)
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { sendAsk() }
                            Button("提问") { sendAsk() }
                                .buttonStyle(.borderedProminent)
                                .tint(Palette.jade)
                        }
                    }
                }
                .padding(16)
            }
            .background(Palette.paper.ignoresSafeArea())
            .navigationTitle(panelTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if panelBusy {
                        ProgressView().controlSize(.small)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        if !panelBody.isEmpty && !panelBusy {
                            Button {
                                showAskField = true
                            } label: { Image(systemName: "bubble.left.and.text.bubble.right") }
                        }
                        Button("关闭") { showCoach = false }
                    }
                }
            }
        }
    }

    private func sendAsk() {
        let q = askText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        showAskField = false
        coach(question: q)
    }

    // MARK: - 大模型动作

    private func requestHint() {
        game.requestHint { cands in
            candidates = cands
            guard let best = cands.first else { return }
            panelTitle = "着法建议"
            panelBody = "首选：\(best.label)　评估 \(best.score)\n\n"
                + cands.enumerated().map { "\($0.offset + 1). \($0.element.label)　评估 \($0.element.score)" }
                    .joined(separator: "\n")
            showCoach = true
        }
    }

    private func requireConfig() -> Bool {
        if AIConfig.shared.isConfigured { return true }
        panelTitle = "尚未配置模型"
        panelBody = "点右上角齿轮填写接口地址、API Key 和模型名。\n\n默认已填好 DeepSeek 的地址，通常只需确认 Key。"
        showCoach = true
        return false
    }

    private func coach(question: String?) {
        guard !panelBusy, requireConfig() else { return }
        panelBusy = true
        panelTitle = "教练点评"
        panelBody = "正在整理局面并请求模型…"
        showCoach = true

        let ctx = Prompts.PositionContext(
            board: game.board,
            side: game.turn,
            moveText: Notation.movesToText(startFEN: game.scene.startFEN,
                                           moves: game.history.map { $0.move }),
            engineScore: game.redScore,
            candidates: candidates,
            inCheck: Rules.inCheck(game.board, game.turn)
        )
        let t0 = Date()

        Task {
            do {
                let r = try await LLMClient.chat(
                    messages: Prompts.coach(ctx, question: question),
                    maxTokens: 4000,
                    onReasoning: { total in
                        panelTitle = "教练点评（思考中 \(total.count) 字）"
                    },
                    onDelta: { total in
                        panelBody = total
                    }
                )
                finishPanel(r, t0)
            } catch {
                panelTitle = "调用失败"
                panelBody = error.localizedDescription
            }
            panelBusy = false
        }
    }

    private func review() {
        guard !panelBusy, requireConfig() else { return }
        guard game.history.count >= 6 else {
            panelTitle = "复盘"
            panelBody = "至少走满 3 个回合再复盘比较有意义，先多下几步。"
            showCoach = true
            return
        }
        panelBusy = true
        panelTitle = "复盘报告"
        panelBody = "正在整理棋谱…"
        showCoach = true

        let record = game.currentRecord
        var trace: [String] = []
        if let evals = record?.evals {
            trace = evals.map { "第\($0.ply)手 \($0.redScore)" }
        }
        let ctx = Prompts.ReviewContext(
            moveText: Notation.movesToText(startFEN: game.scene.startFEN,
                                           moves: game.history.map { $0.move }),
            result: game.gameOver ? "对局已结束" : "对局进行中",
            endBoard: game.board,
            evalTrace: trace
        )
        let t0 = Date()

        Task {
            do {
                let r = try await LLMClient.chat(
                    messages: Prompts.review(ctx),
                    maxTokens: 8000,
                    onReasoning: { total in
                        panelTitle = "复盘报告（思考中 \(total.count) 字）"
                    },
                    onDelta: { total in
                        panelBody = total
                    }
                )
                finishPanel(r, t0)
            } catch {
                panelTitle = "调用失败"
                panelBody = error.localizedDescription
            }
            panelBusy = false
        }
    }

    private func finishPanel(_ r: LLMClient.Result, _ t0: Date) {
        let text = r.content.trimmingCharacters(in: .whitespacesAndNewlines)
        panelTitle = panelTitle.replacingOccurrences(of: "（[^）]*）$", with: "", options: .regularExpression)
        if text.isEmpty {
            panelTitle += "（没有正文）"
            panelBody = "模型这次没有返回正文，输出全花在思维链上了。\n\n"
                + "到「设置」把 max_tokens 调大（建议 5000 以上），或换用 deepseek-v4-pro。"
        } else {
            panelTitle += String(format: "（%.1f 秒）", Date().timeIntervalSince(t0))
            panelBody = text + (r.truncated ? "\n\n—— 输出已达 max_tokens 上限，最后一段可能被截断。" : "")
        }
    }
}

// MARK: - 棋盘点击命中

/// 用透明层单独处理点击，避免滚动与点击手势冲突
private struct BoardTapOverlay: View {
    @ObservedObject var game: GameState

    var body: some View {
        GeometryReader { geo in
            let scale = geo.size.width / BoardMetrics.logicalW
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { location in
                    let lx = location.x / scale
                    let ly = location.y / scale
                    let c = Int(((lx - BoardMetrics.margin) / BoardMetrics.cell).rounded())
                    let r = Int(((ly - BoardMetrics.margin) / BoardMetrics.cell).rounded())
                    guard r >= 0, r < 10, c >= 0, c < 9 else { return }
                    let dx = lx - BoardMetrics.x(c)
                    let dy = ly - BoardMetrics.y(r)
                    guard (dx * dx + dy * dy).squareRoot() <= BoardMetrics.cell * 0.56 else { return }
                    game.tap(square: r * 9 + c)
                }
        }
    }
}
