/* uci-kotlin —— 把 engine 模块包成命令行 UCI 前端（纯 JVM，不是 Android 应用）。
 *
 * 产物：`build/install/uci-kotlin/bin/uci-kotlin`（Gradle 的 application 插件生成），
 * 由 `tools/uci/run.sh` 包一层的启动脚本指向它，好让对局台按 `uci:<路径>` 直接用。
 */
plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(project(":engine"))
}

application {
    mainClass.set("com.peter260807.xiangqicoach.uci.MainKt")
    // 引擎是 CPU 密集的，不需要给启动脚本套 Gradle 的 default JVM 参数；
    // 这里显式关掉「守护式」启动开销之外的额外东西，并保证中文输出不变成问号。
    applicationDefaultJvmArgs = listOf("-Dfile.encoding=UTF-8", "-Xss8m")
    applicationName = "uci-kotlin"
}
