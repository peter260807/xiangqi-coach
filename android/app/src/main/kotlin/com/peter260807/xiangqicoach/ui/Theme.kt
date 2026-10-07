package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * 配色。
 *
 * 数值直接取自 iOS 的 `Palette`（ios/XiangqiCoach/Views/BoardView.swift），
 * 两端必须一致 —— 棋盘木纹、红黑棋子、玉色主色是这套设计的一部分，
 * 随手换一个「更现代的绿」会让两端看起来像两个 App。
 */
object Palette {
    val paper = Color(0.957f, 0.945f, 0.918f)      // #f4f1ea
    val paperDeep = Color(0.922f, 0.902f, 0.859f)
    val card = Color.White
    val ink = Color(0.129f, 0.114f, 0.094f)
    val ink2 = Color(0.361f, 0.333f, 0.294f)
    val ink3 = Color(0.576f, 0.545f, 0.494f)
    val red = Color(0.706f, 0.153f, 0.114f)
    val redSoft = Color(0.992f, 0.941f, 0.933f)
    val black = Color(0.173f, 0.165f, 0.153f)
    val jade = Color(0.059f, 0.431f, 0.337f)       // #0f6e56
    val jadeSoft = Color(0.902f, 0.957f, 0.937f)
    val amber = Color(0.604f, 0.416f, 0.071f)
    val accent = Color(0.122f, 0.435f, 0.922f)     // #1f6feb
    val line = Color.Black.copy(alpha = 0.10f)
    val lineSoft = Color.Black.copy(alpha = 0.05f)
}

private val XqColorScheme = lightColorScheme(
    primary = Palette.jade,
    onPrimary = Color.White,
    primaryContainer = Palette.jadeSoft,
    onPrimaryContainer = Palette.jade,
    secondary = Palette.accent,
    onSecondary = Color.White,
    background = Palette.paper,
    onBackground = Palette.ink,
    surface = Palette.card,
    onSurface = Palette.ink,
    surfaceVariant = Palette.paperDeep,
    onSurfaceVariant = Palette.ink2,
    error = Palette.red,
    onError = Color.White,
    outline = Palette.line,
)

/**
 * 应用主题。
 *
 * ⚠️ **刻意不支持深色模式**：棋盘是一张木纹桌面，深色反色会把它变成另一个东西；
 * iOS 侧也是 `.preferredColorScheme(.light)` 钉死的。这里同样写死浅色，
 * 系统切深色时本应用不受影响 —— 这是设计决定，不是遗漏。
 * （参数 `darkTheme` 保留只是为了将来真要适配时有地方下手。）
 */
@Composable
fun XiangqiTheme(
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = XqColorScheme,
        typography = Typography(),
        content = content,
    )
}
