import SwiftUI

struct SettingsView: View {
    @ObservedObject var config: AIConfig
    @ObservedObject var archive: Archive
    @Environment(\.dismiss) private var dismiss

    @State private var message = ""
    @State private var messageKind = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://api.deepseek.com", text: $config.baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("接口地址")
                } footer: {
                    Text("填根域名或完整地址都行，程序会自动补 /chat/completions。任何兼容 OpenAI 格式的接口都可以。")
                }

                Section {
                    SecureField("sk-...", text: $config.apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("API Key")
                } footer: {
                    Text("只保存在这台设备上，不会上传。代码仓库里也没有它。")
                }

                Section {
                    TextField("deepseek-flash", text: $config.model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    HStack {
                        Text("温度")
                        Spacer()
                        TextField("0.6", value: $config.temperature, format: .number)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 70)
                    }
                    HStack {
                        Text("max_tokens")
                        Spacer()
                        TextField("6000", value: $config.maxTokens, format: .number)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 90)
                    }
                    HStack {
                        Text("超时（秒）")
                        Spacer()
                        TextField("180", value: $config.timeoutSec, format: .number)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 90)
                    }
                } header: {
                    Text("模型参数")
                } footer: {
                    Text("推理模型会先输出一长段思维链且计入 max_tokens，低于 2500 正文可能为空；整局复盘建议 6000 以上。")
                }

                if !message.isEmpty {
                    Section {
                        Text(message)
                            .font(.system(size: 13))
                            .foregroundStyle(messageKind == "err" ? Palette.red : Palette.jade)
                    }
                }

                Section {
                    Button {
                        Task { await fetchModels() }
                    } label: {
                        HStack { Text("拉取模型列表"); Spacer(); if busy { ProgressView().controlSize(.small) } }
                    }
                    .disabled(busy)

                    Button {
                        Task { await testConnection() }
                    } label: {
                        Text("测试连接")
                    }
                    .disabled(busy)
                }

                Section {
                    Button("恢复默认配置") {
                        config.restoreDefaults()
                        message = "已恢复默认配置。"
                        messageKind = "ok"
                    }
                    Button("清空全部存档与练习记录", role: .destructive) {
                        archive.resetAll()
                        message = "本机所有对局存档与练习记录已清空。"
                        messageKind = "ok"
                    }
                }
            }
            .navigationTitle("模型设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") {
                        if config.maxTokens < 256 { config.maxTokens = 6000 }
                        config.save()
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }

    private func fetchModels() async {
        busy = true
        message = "正在拉取…"
        messageKind = ""
        do {
            let list = try await LLMClient.listModels(config: config)
            message = "接口返回 \(list.count) 个模型：\n" + list.joined(separator: "、")
            messageKind = "ok"
            if !list.isEmpty && !list.contains(config.model) { config.model = list[0] }
        } catch {
            message = "拉取失败：\(error.localizedDescription)"
            messageKind = "err"
        }
        busy = false
    }

    private func testConnection() async {
        busy = true
        message = "正在测试…（推理模型可能要十几秒）"
        messageKind = ""
        do {
            let r = try await LLMClient.testConnection(config: config)
            message = "连接正常，\(Double(r.ms) / 1000.0) 秒返回。\n正文：\(r.reply.isEmpty ? "(空)" : r.reply)\n本次思维链消耗 \(r.reasoningTokens) token"
            messageKind = "ok"
        } catch {
            message = "连接失败：\(error.localizedDescription)"
            messageKind = "err"
        }
        busy = false
    }
}
