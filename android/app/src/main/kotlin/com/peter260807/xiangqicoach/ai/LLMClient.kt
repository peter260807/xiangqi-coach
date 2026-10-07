package com.peter260807.xiangqicoach.ai

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/** 大模型调用失败的原因。文案与 iOS `LLMClient.LLMError` 一致，便于对照排查。 */
class LLMException(message: String) : Exception(message)

/**
 * DeepSeek / 任意 OpenAI 兼容接口的客户端。
 *
 * 两个必须处理的点（与 iOS `LLMClient` 完全一致）：
 *  1. 推理模型会先吐一长段 `reasoning_content`，它**计入 max_tokens**，
 *     预算不够时正文会空。所以正文为空但思维链非空时自动加倍重试。
 *  2. 流式与非流式都要能用 —— 拿不到流就退回一次性请求。
 *
 * 用 `HttpURLConnection` 而不是 OkHttp：这个客户端只做「发一个 JSON、读一段流」，
 * 引一个网络库只为这点事不划算（APK 会大一截，还要处理 OkHttp 的版本对齐）。
 */
object LLMClient {

    class Result(
        var content: String = "",
        var reasoning: String = "",
        var completionTokens: Int = 0,
        var reasoningTokens: Int = 0,
        var truncated: Boolean = false,
        var retried: Int = 0,
        var maxTokensUsed: Int = 0,
    )

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * 流式对话。
     *
     * @param onReasoning / [onDelta] 会**在调用线程**回调（调用方自己在主线程上收）；
     *   非流式（两个都不给）时走一次性请求。
     */
    suspend fun chat(
        messages: List<Map<String, String>>,
        config: AIConfig,
        maxTokens: Int? = null,
        temperature: Double? = null,
        onReasoning: ((String) -> Unit)? = null,
        onDelta: ((String) -> Unit)? = null,
    ): Result {
        if (!config.isConfigured) throw LLMException("尚未配置 API Key，请先到「设置」里填写。")
        val endpoint = config.chatEndpoint ?: throw LLMException("接口地址不合法，请检查设置里的 Base URL。")

        // 这里绝不能写成 min(base * 2, 16000) —— 那个 16000 才是真正的瓶颈：
        // 就算把配置调到 5 万，也会被它压回 16000。iOS 侧踩过这个坑。
        val base = maxOf(256, maxTokens ?: config.maxTokens)
        var tokens = minOf(base, AIConfig.MAX_TOKENS_CEILING)
        var lastError: LLMException? = null
        var degraded = false

        // 最多三轮，每轮解决不同的问题：
        //   第 1 轮：按配置的预算
        //   第 2 轮：正文被思维链吃光 -> 预算翻倍
        //   第 3 轮：服务端不接受这个 max_tokens -> 退到保守值
        for (round in 0..2) {
            try {
                val r = perform(
                    endpoint = endpoint,
                    config = config,
                    messages = messages,
                    tokens = tokens,
                    temperature = temperature ?: config.temperature,
                    stream = onDelta != null || onReasoning != null,
                    onReasoning = onReasoning,
                    onDelta = onDelta,
                )
                r.retried = round
                r.maxTokensUsed = tokens
                val hasText = r.content.isNotBlank()
                val hasReason = r.reasoning.isNotBlank()
                if (hasText || !hasReason || round == 2) return r
                tokens = minOf(tokens * 2, AIConfig.MAX_TOKENS_CEILING) // 思维链把正文吃光了
            } catch (e: LLMException) {
                val msg = e.message ?: ""
                val isTooBig = msg.startsWith("HTTP 400") && msg.lowercase().contains("max_token")
                if (isTooBig && !degraded) {
                    // 服务商对 max_tokens 的上限不同，超了直接 400。
                    // 别让这一条把整个功能打死 —— 降到保守值重试一次。
                    lastError = e
                    degraded = true
                    tokens = AIConfig.SAFE_MAX_TOKENS
                } else {
                    throw e
                }
            }
        }
        throw lastError ?: LLMException("模型没有返回任何内容。")
    }

    // ---------- 实际请求 ----------

    private suspend fun perform(
        endpoint: String,
        config: AIConfig,
        messages: List<Map<String, String>>,
        tokens: Int,
        temperature: Double,
        stream: Boolean,
        onReasoning: ((String) -> Unit)?,
        onDelta: ((String) -> Unit)?,
    ): Result = withContext(Dispatchers.IO) {
        val url = try {
            URL(endpoint)
        } catch (e: Exception) {
            throw LLMException("接口地址不合法，请检查设置里的 Base URL。")
        }

        val body = buildJsonObject {
            put("model", config.model)
            put(
                "messages",
                buildJsonArray {
                    for (m in messages) {
                        add(
                            buildJsonObject {
                                put("role", m["role"] ?: "user")
                                put("content", m["content"] ?: "")
                            },
                        )
                    }
                },
            )
            put("temperature", temperature)
            put("max_tokens", tokens)
            put("stream", stream)
            if (stream) {
                put("stream_options", buildJsonObject { put("include_usage", true) })
            }
        }

        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = config.timeoutSec * 1000
            readTimeout = config.timeoutSec * 1000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Authorization", "Bearer ${config.apiKey}")
            setRequestProperty("Accept", if (stream) "text/event-stream" else "application/json")
        }

        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val errText = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                throw LLMException("HTTP $code：${errText.take(300)}")
            }
            if (stream) readStream(conn, onReasoning, onDelta) else readWhole(conn)
        } finally {
            conn.disconnect()
        }
    }

    /** 非流式：一次性读完整段 JSON。 */
    private fun readWhole(conn: HttpURLConnection): Result {
        val text = conn.inputStream.bufferedReader().use { it.readText() }
        val root = json.parseToJsonElement(text).jsonObject
        val choice = root["choices"]?.jsonArray?.firstOrNull()?.jsonObject
        val message = choice?.get("message")?.jsonObject
        val r = Result()
        r.content = message?.get("content")?.jsonPrimitive?.contentOrEmpty() ?: ""
        r.reasoning = message?.get("reasoning_content")?.jsonPrimitive?.contentOrEmpty()
            ?: message?.get("reasoning")?.jsonPrimitive?.contentOrEmpty() ?: ""
        applyUsage(root, r)
        r.truncated = choice?.get("finish_reason")?.jsonPrimitive?.contentOrEmpty() == "length"
        return r
    }

    /**
     * 流式：解析 SSE。
     *
     * ⚠️ 两个坑：
     *  1. 某些服务端在流里**夹空行**、或者把 `data:` 拆成多行 —— 只认 `data: ` 前缀，
     *     其余行直接跳过；遇到 `[DONE]` 收尾。
     *  2. `usage` 与正文**分开到达**（`stream_options.include_usage` 会让最后单独来一块），
     *     所以 token 统计要等流结束以后再落。
     */
    private fun readStream(
        conn: HttpURLConnection,
        onReasoning: ((String) -> Unit)?,
        onDelta: ((String) -> Unit)?,
    ): Result {
        val r = Result()
        val sb = StringBuilder()
        val rb = StringBuilder()
        BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { reader ->
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isBlank() || !line.startsWith("data:")) continue
                val payload = line.removePrefix("data:").trim()
                if (payload == "[DONE]") break
                val obj = try {
                    json.parseToJsonElement(payload).jsonObject
                } catch (e: Exception) {
                    continue // 半截 JSON：跳过，不中断整段流
                }
                obj["usage"]?.let { applyUsage(obj, r) }
                val choice = obj["choices"]?.jsonArray?.firstOrNull()?.jsonObject ?: continue
                val delta = choice["delta"]?.jsonObject
                val reason = delta?.get("reasoning_content")?.jsonPrimitive?.contentOrEmpty()
                    ?: delta?.get("reasoning")?.jsonPrimitive?.contentOrEmpty()
                if (!reason.isNullOrEmpty()) {
                    rb.append(reason)
                    onReasoning?.invoke(reason)
                }
                val piece = delta?.get("content")?.jsonPrimitive?.contentOrEmpty()
                if (!piece.isNullOrEmpty()) {
                    sb.append(piece)
                    onDelta?.invoke(piece)
                }
                if (choice["finish_reason"]?.jsonPrimitive?.contentOrEmpty() == "length") {
                    r.truncated = true
                }
            }
        }
        r.content = sb.toString()
        r.reasoning = rb.toString()
        return r
    }

    private fun applyUsage(root: JsonObject, r: Result) {
        val usage = root["usage"] as? JsonObject ?: return
        usage["completion_tokens"]?.jsonPrimitive?.contentOrEmpty()?.toIntOrNull()?.let {
            r.completionTokens = it
        }
        val details = usage["completion_tokens_details"] as? JsonObject
        details?.get("reasoning_tokens")?.jsonPrimitive?.contentOrEmpty()?.toIntOrNull()?.let {
            r.reasoningTokens = it
        }
    }

    private fun JsonPrimitive.contentOrEmpty(): String? = if (this is JsonPrimitive) content else null

    /**
     * 从模型输出里抠出第一段 JSON 对象。
     *
     * 模型常常在 JSON 外面包一层解释或 ```json 代码块，所以不能直接 parse 整段。
     * 与 iOS `LLMClient.extractJSON` 同一套做法：找第一个 `{`，再从尾部往回找 `}`。
     */
    fun extractJson(text: String): Map<String, String>? {
        val start = text.indexOf('{')
        if (start < 0) return null
        val end = text.lastIndexOf('}')
        if (end <= start) return null
        val slice = text.substring(start, end + 1)
        return try {
            val obj = json.parseToJsonElement(slice).jsonObject
            obj.entries.associate { (k, v) ->
                k to (v.jsonPrimitive.contentOrEmpty() ?: v.toString())
            }
        } catch (e: Exception) {
            null
        }
    }
}
