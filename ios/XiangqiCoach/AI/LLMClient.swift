import Foundation

/// DeepSeek / 任意 OpenAI 兼容接口的客户端
///
/// 两个必须处理的点：
///  1. 推理模型会先吐一长段 `reasoning_content`，它**计入 max_tokens**，
///     预算不够时正文会空。所以正文为空但思维链非空时自动加倍重试。
///  2. 流式与非流式都要能用 —— 拿不到流就退回一次性请求。
final class LLMClient {

    struct Result {
        var content = ""
        var reasoning = ""
        var completionTokens = 0
        var reasoningTokens = 0
        var truncated = false
        var retried = 0
        var maxTokensUsed = 0
    }

    enum LLMError: LocalizedError {
        case notConfigured
        case badURL
        case http(Int, String)
        case empty

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "尚未配置 API Key，请先到「设置」里填写。"
            case .badURL: return "接口地址不合法，请检查设置里的 Base URL。"
            case .http(let code, let msg): return "HTTP \(code)：\(msg)"
            case .empty: return "模型没有返回任何内容。"
            }
        }
    }

    // MARK: 请求

    /// 流式对话。onReasoning / onDelta 会在主线程回调（用于实时刷新界面）
    static func chat(messages: [[String: String]],
                     config: AIConfig = .shared,
                     maxTokens: Int? = nil,
                     temperature: Double? = nil,
                     onReasoning: ((String) -> Void)? = nil,
                     onDelta: ((String) -> Void)? = nil) async throws -> Result {

        guard config.isConfigured else { throw LLMError.notConfigured }
        guard let url = config.chatEndpoint else { throw LLMError.badURL }

        let base = maxTokens ?? config.maxTokens
        var lastError: Error?

        // 最多尝试两次：第一次发现正文被思维链吃光，就用双倍预算重试
        for attempt in 0..<2 {
            let tokens = min(base * (1 << attempt), 16000)
            do {
                var r = try await perform(url: url, config: config, messages: messages,
                                          tokens: tokens,
                                          temperature: temperature ?? config.temperature,
                                          stream: (onDelta != nil || onReasoning != nil),
                                          onReasoning: onReasoning, onDelta: onDelta)
                r.retried = attempt
                r.maxTokensUsed = tokens
                let hasText = !r.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                let hasReason = !r.reasoning.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if hasText || !hasReason || attempt == 1 { return r }
            } catch {
                lastError = error
                break
            }
        }
        if let e = lastError { throw e }
        throw LLMError.empty
    }

    private static func perform(url: URL, config: AIConfig, messages: [[String: String]],
                                tokens: Int, temperature: Double, stream: Bool,
                                onReasoning: ((String) -> Void)?,
                                onDelta: ((String) -> Void)?) async throws -> Result {

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = config.timeoutSec
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = [
            "model": config.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": tokens,
            "stream": stream
        ]
        if stream { body["stream_options"] = ["include_usage": true] }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        if !stream {
            let (data, resp) = try await URLSession.shared.data(for: req)
            try check(resp, data)
            return try parsePlain(data)
        }

        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            var text = ""
            for try await line in bytes.lines { text += line }
            throw LLMError.http(http.statusCode, String(text.prefix(300)))
        }
        return try await parseStream(bytes, onReasoning: onReasoning, onDelta: onDelta)
    }

    private static func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            var msg = String(data: data, encoding: .utf8) ?? ""
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let err = obj["error"] as? [String: Any],
               let m = err["message"] as? String {
                msg = m
            }
            throw LLMError.http(http.statusCode, String(msg.prefix(300)))
        }
    }

    private static func parsePlain(_ data: Data) throws -> Result {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LLMError.empty
        }
        var r = Result()
        if let choices = obj["choices"] as? [[String: Any]], let first = choices.first {
            if let msg = first["message"] as? [String: Any] {
                r.content = msg["content"] as? String ?? ""
                r.reasoning = msg["reasoning_content"] as? String ?? ""
            }
            if let fr = first["finish_reason"] as? String { r.truncated = (fr == "length") }
        }
        readUsage(obj, into: &r)
        return r
    }

    private static func parseStream(_ bytes: URLSession.AsyncBytes,
                                    onReasoning: ((String) -> Void)?,
                                    onDelta: ((String) -> Void)?) async throws -> Result {
        var r = Result()
        for try await raw in bytes.lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("data:") else { continue }
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            if payload.isEmpty || payload == "[DONE]" { continue }
            guard let data = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            if let choices = obj["choices"] as? [[String: Any]], let first = choices.first {
                if let fr = first["finish_reason"] as? String, !fr.isEmpty {
                    r.truncated = (fr == "length")
                }
                if let delta = first["delta"] as? [String: Any] {
                    if let rs = delta["reasoning_content"] as? String, !rs.isEmpty {
                        r.reasoning += rs
                        if let cb = onReasoning {
                            let total = r.reasoning
                            await MainActor.run { cb(total) }
                        }
                    }
                    if let c = delta["content"] as? String, !c.isEmpty {
                        r.content += c
                        if let cb = onDelta {
                            let total = r.content
                            await MainActor.run { cb(total) }
                        }
                    }
                }
            }
            readUsage(obj, into: &r)
        }
        return r
    }

    private static func readUsage(_ obj: [String: Any], into r: inout Result) {
        guard let u = obj["usage"] as? [String: Any] else { return }
        if let c = u["completion_tokens"] as? Int { r.completionTokens = c }
        if let d = u["completion_tokens_details"] as? [String: Any],
           let rt = d["reasoning_tokens"] as? Int { r.reasoningTokens = rt }
    }

    // MARK: 辅助

    static func listModels(config: AIConfig = .shared) async throws -> [String] {
        guard let url = config.modelsEndpoint else { throw LLMError.badURL }
        var req = URLRequest(url: url)
        req.timeoutInterval = 30
        req.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return [] }
        return list.compactMap { $0["id"] as? String }
    }

    static func testConnection(config: AIConfig = .shared) async throws -> (ms: Int, reply: String, reasoningTokens: Int) {
        let t0 = Date()
        let r = try await chat(messages: [["role": "user", "content": "只回复两个字：正常"]],
                               config: config, maxTokens: 1500, temperature: 0)
        return (Int(Date().timeIntervalSince(t0) * 1000), r.content.trimmingCharacters(in: .whitespacesAndNewlines), r.reasoningTokens)
    }

    /// 从模型回复里稳妥地抽出 JSON（兼容 ```json 包裹、前后废话）
    static func extractJSON(_ text: String) -> [String: Any]? {
        var s = text.replacingOccurrences(of: "```json", with: "```")
        if let start = s.range(of: "```") {
            let after = s[start.upperBound...]
            if let end = after.range(of: "```") { s = String(after[..<end.lowerBound]) }
        }
        guard let a = s.firstIndex(of: "{"), let b = s.lastIndex(of: "}"), a < b else { return nil }
        let json = String(s[a...b])
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
