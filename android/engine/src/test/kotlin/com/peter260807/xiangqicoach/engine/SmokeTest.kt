package com.peter260807.xiangqicoach.engine

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * M0 冒烟测试：证明 `engine` 模块能被普通 JVM 单测直接跑起来。
 *
 * 真正的测试从 M1 开始（perft 对数、规则定点用例、交叉验证），
 * 见 docs/android-plan.md §5.3。
 */
class SmokeTest {
    @Test
    fun moduleIsWired() {
        assertEquals(90, Rules.SQUARES)
    }
}
