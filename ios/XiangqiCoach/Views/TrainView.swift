import SwiftUI

struct TrainView: View {
    @ObservedObject var game: GameState
    @Binding var tab: Int
    @ObservedObject private var archive = Archive.shared

    private var library: XiangqiLibrary { game.library }

    /// 列表在 iPad 上自动排成两列，iPhone 上仍然是一列
    private let drillCols = [GridItem(.adaptive(minimum: 340), spacing: 10)]
    /// 每组杀法最多展开多少道。与网页端 app.js 的 MATE_PAGE 保持一致。
    private let matePageSize = 40

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                let rep = archive.computeAbilities(mateTotal: library.mates.count)
                let drills = archive.recommendDrills(library: library, limit: 3)
                let weakest = rep.dimensions.min { $0.score < $1.score }

                SectionHeader(title: "为你推荐",
                              trailing: rep.hasData ? (weakest.map { "弱项：\($0.name)" } ?? "") : "先下一局，系统才知道你的弱项")

                if drills.isEmpty {
                    emptyCard("开始一局对弈后，这里会给出针对性建议")
                } else {
                    LazyVGrid(columns: drillCols, spacing: 10) {
                        ForEach(drills) { d in
                            DrillRow(badge: d.badge, title: d.title, subtitle: d.desc) {
                                openScene(d.sceneId)
                            }
                        }
                    }
                }

                /* 杀法按来源分组、每组只展开前 40 道。
                   导入公开题库之后这里会有几百道题 —— 平铺一列既难找也难看。
                   组内「没通关的在前、手数少的在前」，所以下一道该练什么永远在第一屏。
                   （与网页端 app.js 的 mateGroups / MATE_PAGE 是同一套做法。） */
                let groups = library.mateGroups(solved: Set(archive.solvedDrills))
                ForEach(groups, id: \.label) { g in
                    SectionHeader(title: g.label.isEmpty ? "杀法练习" : "杀法 · \(g.label)",
                                  trailing: "\(g.items.filter { archive.solvedDrills.contains("mate:\($0.id)") }.count) / \(g.items.count) 已通")
                    LazyVGrid(columns: drillCols, spacing: 10) {
                        ForEach(Array(g.items.prefix(matePageSize))) { m in
                            let done = archive.solvedDrills.contains("mate:\(m.id)")
                            DrillRow(badge: done ? "✓" : "杀",
                                     title: m.name,
                                     subtitle: m.difficultyText) {
                                openScene("mate:\(m.id)")
                            }
                        }
                    }
                    if g.items.count > matePageSize {
                        Text("…… 这一组还有 \(g.items.count - matePageSize) 道未列出（列表太长会拖慢页面）。先把上面这些练完。")
                            .font(.system(size: 12))
                            .foregroundStyle(Palette.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                SectionHeader(title: "开局库")
                LazyVGrid(columns: drillCols, spacing: 10) {
                    ForEach(library.openings) { o in
                        DrillRow(badge: "局", title: o.name, subtitle: o.style) {
                            openScene("opening:\(o.id)")
                        }
                    }
                }

                SectionHeader(title: "实用残局")
                LazyVGrid(columns: drillCols, spacing: 10) {
                    ForEach(library.studies) { s in
                        DrillRow(badge: "残", title: s.name, subtitle: "红先取胜") {
                            openScene("study:\(s.id)")
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 96)
            .frame(maxWidth: 1000)   // iPad 上别把列表拉成一条超长的横条
        }
        .background(Palette.paper.ignoresSafeArea())
        .navigationTitle("训练")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func openScene(_ id: String) {
        guard let s = SceneCatalog.all(library).first(where: { $0.id == id }) else { return }
        // 走 requestScene：当前这盘棋有棋可丢时会先问一句（弹窗挂在根视图上）
        game.requestScene(s)
        tab = 0
    }

    private func emptyCard(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13))
            .foregroundStyle(Palette.ink3)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
            .background(Palette.card)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.line, lineWidth: 0.5))
    }
}

struct StatsView: View {
    @ObservedObject var game: GameState
    @Binding var tab: Int
    @ObservedObject private var archive = Archive.shared

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                let rep = archive.computeAbilities(mateTotal: game.library.mates.count)

                // 手机上排成 4 列；iPad 上按可用宽度自动多排几个
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 86, maximum: 210), spacing: 8)], spacing: 8) {
                    StatCard(value: "\(rep.games)", label: "总对局")
                    StatCard(value: rep.finished > 0 ? "\(rep.winRate)%" : "—", label: "胜率",
                             tone: rep.finished > 0 && rep.winRate >= 50 ? "good" : "bad")
                    StatCard(value: "\(rep.avgPly)", label: "平均回合")
                    StatCard(value: "\(rep.solvedMates)/\(rep.mateTotal)", label: "杀法通关", tone: "good")
                    StatCard(value: "\(rep.blunders)", label: "严重失误", tone: rep.blunders > 0 ? "bad" : "good")
                    StatCard(value: "\(rep.mistakes)", label: "失误", tone: rep.mistakes > 0 ? "warn" : "good")
                    StatCard(value: "\(rep.missedMate)", label: "漏杀", tone: rep.missedMate > 0 ? "bad" : "good")
                    StatCard(value: "\(rep.dimensions.count)", label: "能力维度")
                }

                SectionHeader(title: "能力画像",
                              trailing: rep.hasData ? "综合 \(rep.overall) 分" : "暂无数据")

                VStack(alignment: .leading, spacing: 14) {
                    ForEach(rep.dimensions) { d in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(d.name).font(.system(size: 13)).foregroundStyle(Palette.ink2)
                                Spacer()
                                Text("\(d.score)")
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                                    .foregroundStyle(toneColor(d.level))
                            }
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color(red: 0.902, green: 0.882, blue: 0.839))
                                    Capsule().fill(toneColor(d.level))
                                        .frame(width: max(4, geo.size.width * Double(d.score) / 100))
                                }
                            }
                            .frame(height: 7)
                            Text(d.note).font(.system(size: 11.5)).foregroundStyle(Palette.ink3)
                        }
                    }
                }
                .padding(14)
                .background(Palette.card)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.line, lineWidth: 0.5))

                HStack {
                    Text("对局存档").font(.system(size: 12)).foregroundStyle(Palette.ink3)
                    Spacer()
                    if !archive.games.isEmpty {
                        Button("清空") {
                            archive.clearGames()
                        }
                        .font(.system(size: 12))
                    }
                }
                .padding(.horizontal, 4)
                .padding(.top, 4)

                if archive.games.isEmpty {
                    Text("还没有存档。\n下完一局会自动存起来，也可以随时点「存档」。")
                        .font(.system(size: 13))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Palette.ink3)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 30)
                        .background(Palette.card)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.line, lineWidth: 0.5))
                } else {
                    ForEach(archive.games.prefix(30)) { g in
                        gameRow(g)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 96)
            .frame(maxWidth: 1000)   // iPad 上别把内容拉成一条超长的横条
        }
        .background(Palette.paper.ignoresSafeArea())
        .navigationTitle("战绩")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func toneColor(_ level: String) -> Color {
        switch level {
        case "good": return Palette.jade
        case "mid": return Palette.amber
        default: return Palette.red
        }
    }

    private func gameRow(_ g: GameRecord) -> some View {
        let tone: String = g.result == "win" ? "good" : (g.result == "loss" ? "bad" : "mid")
        let fg: Color = g.result == "win" ? Palette.jade : (g.result == "loss" ? Palette.red : Palette.ink2)
        let bg: Color = g.result == "win" ? Palette.jadeSoft : (g.result == "loss" ? Palette.redSoft : Palette.paperDeep)
        let df = DateFormatter()
        df.dateFormat = "M/d HH:mm"

        return HStack(spacing: 11) {
            Text(g.resultLabel)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(fg)
                .frame(width: 34, height: 34)
                .background(bg)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

            VStack(alignment: .leading, spacing: 1) {
                Text(g.sceneName)
                    .font(.system(size: 13.5, weight: .semibold))
                    .lineLimit(1)
                Text("\(df.string(from: g.savedAt)) · \(Int(ceil(Double(g.ply) / 2.0))) 回合"
                     + (g.flags.blunders > 0 ? " · 严重失误 \(g.flags.blunders)" : ""))
                    .font(.system(size: 11.5))
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)

            Button("载入") {
                game.requestLoadGame(g)
                tab = 0
            }
            .font(.system(size: 12))
            .buttonStyle(.bordered)

            Button {
                archive.delete(g.id)
            } label: { Image(systemName: "trash").font(.system(size: 12)) }
            .buttonStyle(.bordered)
            .tint(Palette.red)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.line, lineWidth: 0.5))
        .opacity(tone.isEmpty ? 1 : 1)
    }
}
