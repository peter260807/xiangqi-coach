import SwiftUI

@main
struct XiangqiCoachApp: App {
    @StateObject private var game: GameState

    init() {
        let lib = XiangqiLibrary.loadFromBundle()
        _game = StateObject(wrappedValue: GameState(library: lib))
    }

    var body: some Scene {
        WindowGroup {
            RootView(game: game)
                .tint(Palette.jade)
                .preferredColorScheme(.light)
        }
    }
}

struct RootView: View {
    @ObservedObject var game: GameState
    @ObservedObject private var archive = Archive.shared
    /// 默认落在「对弈」页；自动化截图时可用 SIMCTL_CHILD_START_TAB 指定其他页
    @State private var tab: Int = {
        if let s = ProcessInfo.processInfo.environment["START_TAB"], let i = Int(s), (0...2).contains(i) {
            return i
        }
        return 0
    }()
    @State private var showSettings = false

    var body: some View {
        // 不用 .sidebarAdaptable：iPad 上侧边栏会吃掉约 250pt 宽度，
        // 而这里最宝贵的就是棋盘的可用宽度；默认的顶部浮条只占高度、不占宽度。
        tabs
            .background(Palette.paper)
            .sheet(isPresented: $showSettings) {
                SettingsView(config: AIConfig.shared, archive: archive)
            }
            .onAppear { applyLaunchOverrides() }
    }

    /// 三个页面。单独抽出来是为了按系统版本套不同样式
    private var tabs: some View {
        TabView(selection: $tab) {
            PlayView(game: game, showSettings: $showSettings)
                .tabItem { Label("对弈", systemImage: "checkerboard.rectangle") }
                .tag(0)

            TrainView(game: game, tab: $tab)
                .tabItem { Label("训练", systemImage: "scope") }
                .tag(1)

            StatsView(game: game, tab: $tab)
                .tabItem { Label("战绩", systemImage: "chart.bar.fill") }
                .tag(2)
        }
    }

    /// 自动化截图用的启动钩子：
    /// `SIMCTL_CHILD_START_SCENE=classic:c1` 载入指定场景，
    /// 再给个 `SIMCTL_CHILD_START_DEMO=1` 就自动开始打谱演示。
    private func applyLaunchOverrides() {
        let env = ProcessInfo.processInfo.environment
        guard let sid = env["START_SCENE"],
              let scene = SceneCatalog.all(game.library).first(where: { $0.id == sid })
        else { return }
        game.load(scene: scene, silent: true)
        if env["START_DEMO"] == "1" {
            game.startDemo()
            game.demoToggle()   // 顺手开始播放，截图才能拍到演示中间的画面
        }
    }
}

// MARK: - 通用小控件

/// 统计数字卡
struct StatCard: View {
    var value: String
    var label: String
    var tone: String = ""   // "" / good / warn / bad

    private var color: Color {
        switch tone {
        case "good": return Palette.jade
        case "warn": return Palette.amber
        case "bad": return Palette.red
        default: return Palette.ink
        }
    }

    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.system(size: 19, weight: .semibold, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.system(size: 10.5))
                .foregroundStyle(Palette.ink3)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(Palette.line, lineWidth: 0.5))
    }
}

/// 分区标题
struct SectionHeader: View {
    var title: String
    var trailing: String?

    var body: some View {
        HStack {
            Text(title)
                .font(.system(size: 12))
                .foregroundStyle(Palette.ink3)
            Spacer()
            if let t = trailing {
                Text(t).font(.system(size: 11)).foregroundStyle(Palette.ink3)
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
    }
}

/// 训练 / 场景卡片行
struct DrillRow: View {
    var badge: String
    var title: String
    var subtitle: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Text(badge)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.jade)
                    .frame(width: 34, height: 34)
                    .background(Palette.jadeSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                    Text(subtitle)
                        .font(.system(size: 11.5))
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.ink3)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(Palette.card)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Palette.line, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }
}
