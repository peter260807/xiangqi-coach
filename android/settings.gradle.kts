/* 象棋教练 Android 版 —— 工程定义
 *
 * 目录结构与 ios/ 平级：
 *   android/engine/   纯 Kotlin JVM 库：规则 + 搜索 + 记谱（零 Android 依赖）
 *   android/app/      Android 应用（Compose）
 *   tools/uci-kotlin/ UCI 前端：把 engine 编成 CLI，交给 tools/match.js 当选手
 *
 * engine 单独拆成模块的三个理由：
 *   1. 纯算法、零 Android 依赖 → 单测在 JVM 上跑，秒级反馈，不用模拟器；
 *   2. tools/ 里的对局台能直接把它当 UCI 引擎测（仓库已有整套 Elo 验收设施）；
 *   3. 模块边界防止引擎里偷偷用 Context。
 */
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "XiangqiCoach"
include(":engine")
include(":app")
// UCI 前端：把 engine 包成命令行程序，交给 tools/match.js 当选手测 Elo
include(":uci-kotlin")
project(":uci-kotlin").projectDir = file("tools/uci")
