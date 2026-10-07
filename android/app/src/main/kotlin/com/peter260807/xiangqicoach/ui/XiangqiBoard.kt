package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer

/**
 * 棋盘控件。
 *
 * 两件事必须说清楚，不然很容易在这里悄悄错位：
 *
 * 1. **缩放**：`drawBoard` 全部用 420×464 的逻辑坐标画，
 *    真实像素靠一次 `scale` 变换映射过去 —— 这样换任何屏幕尺寸，
 *    棋子半径 / 线宽 / 字号之间的比例都不会变。
 * 2. **点击命中**：手势拿到的是**真实像素**，必须用同一个比例换算回逻辑坐标，
 *    再去比格点。直接拿像素去 `Rules.index` 会偏出好几列 ——
 *    而且症状是「点得中边上、点不中中间」，很难一眼看出是比例问题。
 *
 * 用 [layout] 强制自己保持 420:464 的宽高比：棋盘是正方形格子的，
 * 让父容器随便拉扁会得到一排长方形格子。
 */
@Composable
fun XiangqiBoard(
    state: BoardRenderState,
    modifier: Modifier = Modifier,
    onTapSquare: (Int) -> Unit,
) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current.density

    Canvas(
        modifier = modifier
            .aspectRatio420x464()
            .pointerInput(Unit) {
                detectTapGestures { offset ->
                    // 手势坐标(px) → 逻辑坐标
                    val s = size.width / BoardMetrics.LOGICAL_W
                    if (s <= 0f) return@detectTapGestures
                    val lx = offset.x / s
                    val ly = offset.y / s
                    // 找最近的交叉点；离得太远（超过半格）就不算点中
                    val col = Math.round((lx - BoardMetrics.MARGIN) / BoardMetrics.CELL)
                    val row = Math.round((ly - BoardMetrics.MARGIN) / BoardMetrics.CELL)
                    if (col < 0 || col > 8 || row < 0 || row > 9) return@detectTapGestures
                    val cx = BoardMetrics.x(col)
                    val cy = BoardMetrics.y(row)
                    val dist = Math.hypot((lx - cx).toDouble(), (ly - cy).toDouble())
                    if (dist > BoardMetrics.CELL * 0.62) return@detectTapGestures
                    onTapSquare(row * 9 + col)
                }
            },
    ) {
        val s = size.width / BoardMetrics.LOGICAL_W
        if (s <= 0f) return@Canvas
        /* ⚠️ 这里**只**乘 s，不乘 density。
         *
         * 第一版写的是 `scale(s * density)`，理由是「逻辑单位要按密度放大」——
         * 那是错的，而且错得很直观：整块棋盘被放大 2.57 倍（s≈2.57），
         * 棋子与坐标号全部溢出屏幕。
         * 根因是 `sp` 已经含了密度换算：`fontSize = 10.sp` 在 drawText 里
         * 会先变成 `10 * density` 像素，再被这个变换乘一次 —— 于是 density 被算了两遍。
         * 现在的口径：**画布只负责逻辑单位 → 像素的缩放**，
         * 而字号用 `logicalSp()` 换算（见 Board.kt）。 */
        withTransform({
            scale(s, s, pivot = Offset.Zero)
        }) {
            drawBoard(state, measurer, scale = s, density = density)
        }
    }
}

/** 让这个控件按 420:464 的固定比例撑满可用空间（取宽高里更紧的那一维）。 */
private fun Modifier.aspectRatio420x464(): Modifier = layout { measurable, constraints ->
    val maxW = constraints.maxWidth
    val maxH = if (constraints.maxHeight == Int.MAX_VALUE) maxW * 464 / 420 else constraints.maxHeight
    val ratio = BoardMetrics.LOGICAL_W / BoardMetrics.LOGICAL_H
    var w = maxW
    var h = (w / ratio).toInt()
    if (h > maxH) {
        h = maxH
        w = (h * ratio).toInt()
    }
    val placeable = measurable.measure(
        androidx.compose.ui.unit.Constraints.fixed(w, h),
    )
    layout(w, h) { placeable.place(0, 0) }
}

