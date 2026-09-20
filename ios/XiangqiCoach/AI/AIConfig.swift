import Foundation
import SwiftUI

/// 模型配置。默认值来自 bundle 里的 AppConfig.plist，
/// 用户改过之后写进 UserDefaults，以后以用户值为准。
///
/// 仓库里提交的 AppConfig.plist 是空 Key；本机可以放一个 AppConfig.local.plist
/// （已 gitignore）预填自己的 Key，代码会优先读它。
final class AIConfig: ObservableObject {

    static let shared = AIConfig()

    @Published var baseURL: String
    @Published var apiKey: String
    @Published var model: String
    @Published var temperature: Double
    @Published var maxTokens: Int
    @Published var timeoutSec: Double

    /// 取接口根地址，兼容用户填了完整 /chat/completions 的情况
    var chatEndpoint: URL? {
        var s = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.isEmpty else { return nil }
        if s.hasSuffix("/chat/completions") { return URL(string: s) }
        return URL(string: s + "/chat/completions")
    }

    var modelsEndpoint: URL? {
        var s = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.isEmpty else { return nil }
        if s.hasSuffix("/chat/completions") {
            s = String(s.dropLast("/chat/completions".count))
        }
        return URL(string: s + "/models")
    }

    var isConfigured: Bool {
        !apiKey.trimmingCharacters(in: .whitespaces).isEmpty && chatEndpoint != nil
    }

    private init() {
        let d = AIConfig.bundledDefaults()
        baseURL = UserDefaults.standard.string(forKey: "ai.baseURL") ?? d.baseURL
        apiKey = UserDefaults.standard.string(forKey: "ai.apiKey") ?? d.apiKey
        model = UserDefaults.standard.string(forKey: "ai.model") ?? d.model

        let t = UserDefaults.standard.object(forKey: "ai.temperature") as? Double
        temperature = t ?? d.temperature
        let m = UserDefaults.standard.object(forKey: "ai.maxTokens") as? Int
        maxTokens = m ?? d.maxTokens
        let to = UserDefaults.standard.object(forKey: "ai.timeoutSec") as? Double
        timeoutSec = to ?? d.timeoutSec
    }

    func save() {
        let u = UserDefaults.standard
        u.set(baseURL, forKey: "ai.baseURL")
        u.set(apiKey, forKey: "ai.apiKey")
        u.set(model, forKey: "ai.model")
        u.set(temperature, forKey: "ai.temperature")
        u.set(maxTokens, forKey: "ai.maxTokens")
        u.set(timeoutSec, forKey: "ai.timeoutSec")
        objectWillChange.send()
    }

    func restoreDefaults() {
        let u = UserDefaults.standard
        ["ai.baseURL", "ai.apiKey", "ai.model", "ai.temperature", "ai.maxTokens", "ai.timeoutSec"]
            .forEach { u.removeObject(forKey: $0) }
        let d = AIConfig.bundledDefaults()
        baseURL = d.baseURL
        apiKey = d.apiKey
        model = d.model
        temperature = d.temperature
        maxTokens = d.maxTokens
        timeoutSec = d.timeoutSec
        objectWillChange.send()
    }

    // MARK: bundle 默认值

    private struct Defaults {
        var baseURL = "https://api.deepseek.com"
        var apiKey = ""
        var model = "deepseek-flash"
        var temperature = 0.6
        var maxTokens = 6000
        var timeoutSec = 180.0
    }

    private static func bundledDefaults() -> Defaults {
        var out = Defaults()
        // 先找本机的 local 配置（不提交仓库），再退回模板
        for name in ["AppConfig.local", "AppConfig"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "plist"),
                  let dict = NSDictionary(contentsOf: url) as? [String: Any] else { continue }
            if let v = dict["baseURL"] as? String, !v.isEmpty { out.baseURL = v }
            if let v = dict["apiKey"] as? String, !v.isEmpty { out.apiKey = v }
            if let v = dict["model"] as? String, !v.isEmpty { out.model = v }
            if let v = dict["temperature"] as? Double { out.temperature = v }
            if let v = dict["maxTokens"] as? Int { out.maxTokens = v }
            if let v = dict["timeoutSec"] as? Double { out.timeoutSec = v }
            if out.apiKey.isEmpty == false { break }
        }
        return out
    }
}
