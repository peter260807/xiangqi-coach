package com.peter260807.xiangqicoach.ai

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * 大模型接口配置。
 *
 * 默认对接 DeepSeek，但**任何兼容 OpenAI `/chat/completions` 格式的接口都能用**。
 *
 * ## 关于 API Key 的存放
 *
 * ⚠️ **绝不能把 Key 打进 APK**。iOS 侧的做法是 `AppConfig.local.plist`（在 .gitignore 里）
 * 预填、或者由用户在设置里填一次；Android 这边对应：
 *
 * - 首版用 `SharedPreferences`（应用私有目录）。Android 7 起系统默认整盘加密，
 *   应用私有目录其他应用读不到，对「用户自己的 API Key」这个敏感级别够用；
 * - **刻意不引 `androidx.security:security-crypto`**：那个库已经在 1.1.0-alpha 上停了很久，
 *   而且 `EncryptedSharedPreferences` 在部分机型上有 keystore 偶发失效的问题 ——
 *   为了一个用户自己填的 Key 引入这种风险不划算。
 *   真要更强保护（比如以后接企业账号），换 Keystore + AES-GCM 自己做，
 *   而不是引一个停更的库。
 */
class AIConfig(context: Context) {

    private val prefs = context.getSharedPreferences("xq.ai", Context.MODE_PRIVATE)

    var baseUrl: String by mutableStateOf(prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL)!!)
        private set
    var apiKey: String by mutableStateOf(prefs.getString(KEY_API_KEY, "")!!)
        private set
    var model: String by mutableStateOf(prefs.getString(KEY_MODEL, DEFAULT_MODEL)!!)
        private set

    /**
     * `max_tokens` 上限。
     *
     * DeepSeek 的推理模型会先输出一长段思维链，而**思维链计入 max_tokens**。
     * 给少了正文就是空的，而 HTTP 状态码依然是 200，没有任何报错。
     * 实测：短问答约 43、局面点评 770~6800、整局复盘 4855~5284。
     * 默认给到 5 万（`max_tokens` 只是上限，按实际产出计费，给足不会多花钱）。
     */
    var maxTokens: Int by mutableStateOf(prefs.getInt(KEY_MAX_TOKENS, DEFAULT_MAX_TOKENS))
        private set

    var temperature: Double by mutableStateOf(
        prefs.getString(KEY_TEMPERATURE, DEFAULT_TEMPERATURE.toString())!!.toDoubleOrNull()
            ?: DEFAULT_TEMPERATURE,
    )
        private set

    var timeoutSec: Int by mutableStateOf(prefs.getInt(KEY_TIMEOUT, 60))
        private set

    val isConfigured: Boolean get() = apiKey.isNotBlank()

    /** 完整的对话接口地址。用户只填 Base URL，路径由这里补。 */
    val chatEndpoint: String?
        get() {
            val base = baseUrl.trim().trimEnd('/')
            if (base.isEmpty()) return null
            return if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
        }

    fun update(
        baseUrl: String = this.baseUrl,
        apiKey: String = this.apiKey,
        model: String = this.model,
        maxTokens: Int = this.maxTokens,
        temperature: Double = this.temperature,
        timeoutSec: Int = this.timeoutSec,
    ) {
        this.baseUrl = baseUrl.trim()
        this.apiKey = apiKey.trim()
        this.model = model.trim()
        this.maxTokens = maxTokens.coerceIn(256, MAX_TOKENS_CEILING)
        this.temperature = temperature
        this.timeoutSec = timeoutSec.coerceIn(5, 300)
        prefs.edit()
            .putString(KEY_BASE_URL, this.baseUrl)
            .putString(KEY_API_KEY, this.apiKey)
            .putString(KEY_MODEL, this.model)
            .putInt(KEY_MAX_TOKENS, this.maxTokens)
            .putString(KEY_TEMPERATURE, this.temperature.toString())
            .putInt(KEY_TIMEOUT, this.timeoutSec)
            .apply()
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
        const val DEFAULT_MODEL = "deepseek-flash"
        const val DEFAULT_MAX_TOKENS = 50_000
        const val DEFAULT_TEMPERATURE = 0.7

        /**
         * `max_tokens` 的天花板。只用来防住手抖填个离谱的数 ——
         * 实测 DeepSeek 接口连 20 万都收，真正的上限在模型侧。
         */
        const val MAX_TOKENS_CEILING = 200_000

        /**
         * 服务端嫌 `max_tokens` 太大时退到的保守值。
         * 各家 OpenAI 兼容接口的上限差别很大（8K / 16K / 64K 都有），
         * 走一次降级总比整个功能报错好。
         */
        const val SAFE_MAX_TOKENS = 8192

        private const val KEY_BASE_URL = "baseUrl"
        private const val KEY_API_KEY = "apiKey"
        private const val KEY_MODEL = "model"
        private const val KEY_MAX_TOKENS = "maxTokens"
        private const val KEY_TEMPERATURE = "temperature"
        private const val KEY_TIMEOUT = "timeoutSec"
    }
}
