/* engine —— 纯 Kotlin JVM 库：规则 + 搜索 + 记谱
 *
 * ⚠️ 这个模块不许依赖任何 Android / androidx 的东西。
 * 它要能被 tools/uci-kotlin 直接当 CLI 依赖去编 UCI 前端，
 * 也要能被模拟器以外的普通 JVM 单测直接跑（perft、规则定点用例）。
 */
plugins {
    alias(libs.plugins.kotlin.jvm)
    // 棋谱库与存档都是 JSON：用 kotlinx.serialization 而不是手写解析，
    // 字段缺失/多出来的处理交给 @Serializable 的默认值，比手工 map 可靠。
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // 引擎热路径上不想因为空安全插桩多一层判断；可空性由类型系统保证。
        freeCompilerArgs.add("-Xjvm-default=all")
    }
}

dependencies {
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.kotlin.test)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
