import SwiftUI
import UIKit

/// 棋谱面板：导出局面与棋谱，或者把外面的局面/棋谱粘进来。
///
/// 导出刻意给三种形式：FEN 便于程序读，中文棋谱便于人读，
/// 坐标串容错性最好（不依赖记法实现）。导入按同样三种形式依次尝试。
struct NotationSheet: View {
    @ObservedObject var game: GameState
    @Environment(\.dismiss) private var dismiss

    @State private var importText = ""
    @State private var message: String?
    @State private var messageIsError = false
    @State private var copiedKey: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("把下面任意一段贴到别处，或者用「导入」把外面的局面/棋谱拿回来。")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.ink3)

                    block(title: "当前局面（FEN）", text: game.exportFEN, key: "fen")

                    if !game.exportMoveText.isEmpty {
                        block(title: "棋谱", text: game.exportMoveText, key: "moves")
                    }

                    ShareLink(item: game.exportShareText) {
                        Label("分享完整棋谱", systemImage: "square.and.arrow.up")
                            .font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Palette.jade)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    Divider().background(Palette.lineSoft)

                    importBlock
                }
                .padding(16)
            }
            .background(Palette.paper.ignoresSafeArea())
            .navigationTitle("棋谱")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    // MARK: - 导出块

    private func block(title: String, text: String, key: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.ink3)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    copiedKey = key
                    Task {
                        try? await Task.sleep(nanoseconds: 1_200_000_000)
                        if copiedKey == key { copiedKey = nil }
                    }
                } label: {
                    Label(copiedKey == key ? "已复制" : "复制",
                          systemImage: copiedKey == key ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 11.5))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.jade)
            }
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Palette.ink2)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Palette.card)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Palette.line, lineWidth: 0.5))
        }
    }

    // MARK: - 导入块

    private var importBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("导入局面或棋谱")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Palette.ink3)

            TextEditor(text: $importText)
                .font(.system(size: 12, design: .monospaced))
                .frame(minHeight: 96)
                .padding(6)
                .background(Palette.card)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Palette.line, lineWidth: 0.5))
                .scrollContentBackground(.hidden)

            Text("支持三种：FEN 局面串、中文棋谱（炮二平五 马8进7）、着法坐标（67,40,19,46）")
                .font(.system(size: 11))
                .foregroundStyle(Palette.ink3)

            HStack(spacing: 8) {
                Button {
                    let err = game.importText(importText)
                    if let err {
                        message = err
                        messageIsError = true
                    } else {
                        message = "导入成功，已切到「导入的」局面。"
                        messageIsError = false
                        importText = ""
                    }
                } label: {
                    Text("导入")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Palette.jade)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(importText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button {
                    importText = ""
                    message = nil
                } label: {
                    Text("清空")
                        .font(.system(size: 13))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Palette.card)
                        .foregroundStyle(Palette.ink)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Palette.line, lineWidth: 0.5))
                }
                .frame(width: 92)
            }

            if let message {
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(messageIsError ? Palette.red : Palette.jade)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(messageIsError ? Palette.redSoft : Palette.jadeSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
        }
    }
}
