package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peter260807.xiangqicoach.ai.AIConfig
import com.peter260807.xiangqicoach.data.GameStore
import kotlinx.coroutines.launch

/**
 * 设置页：大模型接口 + 数据管理。
 *
 * ⚠️ **API Key 不随 App 分发**。iOS 侧是 `AppConfig.local.plist` 预填（在 .gitignore 里），
 * Android 这边没有预填机制 —— 由用户在设置里填一次，存在应用私有的
 * `SharedPreferences` 里（见 `AIConfig` 的类注释，那里解释了为什么不用
 * 已经停更的 `security-crypto`）。
 */
@Composable
fun SettingsScreen(
    aiConfig: AIConfig,
    store: GameStore,
    onClose: () -> Unit,
) {
    var baseUrl by remember { mutableStateOf(aiConfig.baseUrl) }
    var apiKey by remember { mutableStateOf(aiConfig.apiKey) }
    var model by remember { mutableStateOf(aiConfig.model) }
    var maxTokens by remember { mutableStateOf(aiConfig.maxTokens.toString()) }
    var temperature by remember { mutableStateOf(aiConfig.temperature.toString()) }
    var testResult by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun save() {
        aiConfig.update(
            baseUrl = baseUrl,
            apiKey = apiKey,
            model = model,
            maxTokens = maxTokens.toIntOrNull() ?: AIConfig.DEFAULT_MAX_TOKENS,
            temperature = temperature.toDoubleOrNull() ?: AIConfig.DEFAULT_TEMPERATURE,
        )
    }

    AlertDialog(
        onDismissRequest = {
            save()
            onClose()
        },
        title = { Text("设置", color = Palette.ink, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(
                Modifier
                    .verticalScroll(rememberScrollState())
                    .windowInsetsPadding(WindowInsets.safeDrawing),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                SectionTitle("大模型接口")
                LabeledField("Base URL", baseUrl, "https://api.deepseek.com/v1") { baseUrl = it }
                LabeledField("API Key", apiKey, "sk-…（只存在本机）") { apiKey = it }
                LabeledField("模型名", model, AIConfig.DEFAULT_MODEL) { model = it }
                LabeledField("模型输出上限 max_tokens", maxTokens, AIConfig.DEFAULT_MAX_TOKENS.toString()) {
                    maxTokens = it.filter { ch -> ch.isDigit() }
                }
                Text(
                    "推理模型的思维链也计入 max_tokens：给少了正文会是空的，" +
                        "而 HTTP 状态码依然是 200。实测点评 770~6800、复盘 4855~5284，" +
                        "所以默认给到 5 万。给足不会多花钱（按实际产出计费）。",
                    color = Palette.ink3, fontSize = 11.sp,
                )
                LabeledField("temperature", temperature, AIConfig.DEFAULT_TEMPERATURE.toString()) {
                    temperature = it
                }

                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SmallButton(if (testing) "测试中…" else "保存并测试") {
                        if (testing) return@SmallButton
                        save()
                        testing = true
                        testResult = null
                        scope.launch {
                            testResult = try {
                                Coach.ping(aiConfig)
                            } catch (e: Exception) {
                                "失败：${e.message}"
                            }
                            testing = false
                        }
                    }
                    SmallButton("恢复默认") {
                        baseUrl = AIConfig.DEFAULT_BASE_URL
                        model = AIConfig.DEFAULT_MODEL
                        maxTokens = AIConfig.DEFAULT_MAX_TOKENS.toString()
                        temperature = AIConfig.DEFAULT_TEMPERATURE.toString()
                    }
                }
                testResult?.let {
                    Text(
                        it,
                        color = if (it.startsWith("失败")) Palette.red else Palette.ink2,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }

                Spacer(Modifier.height(10.dp))
                SectionTitle("数据")
                SettingRow("对局记录", "${store.payload.games.size} 盘")
                SettingRow("已通关练习", "${store.solvedIds.size} 个")
                Spacer(Modifier.height(6.dp))
                SettingAction(
                    title = "清空全部记录",
                    subtitle = "对局记录与练习进度都会删掉，不可恢复",
                    danger = true,
                ) { confirmClear = true }

                Spacer(Modifier.height(10.dp))
                SectionTitle("关于")
                Text(
                    "象棋教练 Android 版。引擎是本地 Alpha-Beta 搜索（Kotlin 移植自 iOS 版），" +
                        "四档难度；杀法题库 981 道，解法由引擎离线算出。",
                    color = Palette.ink3, fontSize = 11.sp,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                save()
                onClose()
            }) { Text("完成", color = Palette.jade, fontWeight = FontWeight.Medium) }
        },
    )

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("清空全部记录？", color = Palette.ink, fontWeight = FontWeight.SemiBold) },
            text = { Text("对局记录与练习进度都会被删掉，不可恢复。", color = Palette.ink2, fontSize = 14.sp) },
            confirmButton = {
                TextButton(onClick = {
                    store.resetAll()
                    confirmClear = false
                }) { Text("清空", color = Palette.red, fontWeight = FontWeight.Medium) }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) { Text("取消", color = Palette.ink3) }
            },
        )
    }
}
