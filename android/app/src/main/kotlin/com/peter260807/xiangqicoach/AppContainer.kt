package com.peter260807.xiangqicoach

import android.content.Context
import com.peter260807.xiangqicoach.ai.AIConfig
import com.peter260807.xiangqicoach.data.GameStore
import com.peter260807.xiangqicoach.engine.Engine
import com.peter260807.xiangqicoach.engine.XiangqiLibrary
import kotlinx.serialization.json.Json
import java.io.File

/**
 * 应用级依赖容器。
 *
 * 刻意不引 Hilt/Koin：整个 App 只有三样东西需要共享
 * （棋谱库、存档、AI 配置），一个手写的容器比一套依赖注入框架
 * 更好读、也更容易在测试里替换。
 *
 * 生命周期与 `Application` 一致 —— 棋谱库有 400 KB JSON，
 * 每次旋转屏幕重新解析一遍是浪费。
 */
class AppContainer(context: Context) {

    private val appContext = context.applicationContext

    /**
     * 棋谱库。
     *
     * 读的是 APK 里的 `assets/library.json`，由 `tools/sync-library.js` 从
     * `shared/library.json` 同步过来（**不要手改 assets 里那份**）。
     * 解析失败时退化成空库而不是崩启动：宁可显示"题库为空"，
     * 也不要用户连棋盘都看不到 —— 而日志里会留下原因。
     */
    val library: XiangqiLibrary by lazy {
        try {
            val text = appContext.assets.open("library.json")
                .bufferedReader(Charsets.UTF_8).use { it.readText() }
            Json { ignoreUnknownKeys = true }
                .decodeFromString(XiangqiLibrary.serializer(), text)
        } catch (e: Exception) {
            android.util.Log.e("XiangqiCoach", "棋谱库读取失败，退化成空库", e)
            XiangqiLibrary.EMPTY
        }
    }

    /** 存档：应用私有目录下的一个 JSON 文件。 */
    val store: GameStore by lazy {
        GameStore(File(appContext.filesDir, "xiangqi-archive.json"))
    }

    val aiConfig: AIConfig by lazy { AIConfig(appContext) }

    /** 引擎：进程内共享。界面与提示都走它。 */
    val engine: Engine get() = Engine.shared
}
