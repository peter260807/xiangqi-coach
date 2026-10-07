package com.peter260807.xiangqicoach.engine

import kotlinx.serialization.json.Json
import java.io.File

/**
 * 测试共用的小工具。
 *
 * 其中 [sharedLibrary] 解决的是「测试进程的工作目录到底是哪」这个问题：
 * Gradle 跑 `:engine:test` 时的工作目录**不保证**是 `android/engine`，
 * 单写 `../shared/library.json` 会在换个跑法（IDE 里点运行、从仓库根跑）时找不到文件，
 * 而报错是 `NoSuchElementException: Collection contains no element matching the predicate`
 * —— 完全指不到「找不到库文件」这个真正的原因。所以这里显式搜若干个候选路径，
 * 全都找不到时给一条说清楚的话。
 */
object TestFixtures {

    private val json = Json { ignoreUnknownKeys = true }

    fun repoFile(relative: String): File {
        val here = File("").absoluteFile
        val candidates = ArrayList<File>()
        var dir: File? = here
        repeat(5) {
            if (dir != null) {
                candidates.add(File(dir, relative))
                dir = dir.parentFile
            }
        }
        return candidates.firstOrNull { it.exists() }
            ?: error(
                "找不到 $relative。已试过：\n  " +
                    candidates.joinToString("\n  ") { it.absolutePath } +
                    "\n（工作目录：${here.absolutePath}）",
            )
    }

    val sharedLibrary: XiangqiLibrary by lazy {
        val f = repoFile("shared/library.json")
        json.decodeFromString(XiangqiLibrary.serializer(), f.readText())
    }

    val jsonStrict: Json get() = json
}
