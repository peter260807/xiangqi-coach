package com.peter260807.xiangqicoach.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.sp
import com.peter260807.xiangqicoach.engine.Move
import com.peter260807.xiangqicoach.engine.Piece
import com.peter260807.xiangqicoach.engine.Rules
import com.peter260807.xiangqicoach.engine.Side

/**
 * 棋盘几何。
 *
 * 与 iOS 的 `BoardMetrics` **逐值一致**：格子 44、边距 34，于是逻辑尺寸 420×464。
 * 这个比例（而不是「随便一个 9:10」）决定了棋子半径与留白的关系 ——
 * 坐标号要挤在 0.26 格的留白里才不会被底线棋子压住。
 *
 * 实际渲染时整块按可用空间**等比缩放**：所以布局只需要按 [logicalW]/[logicalH]
 * 的纵横比让出位置，具体像素由缩放决定。
 */
object BoardMetrics {
    const val CELL = 44f
    const val MARGIN = 34f
    const val LOGICAL_W = 8 * CELL + 2 * MARGIN  // 420
    const val LOGICAL_H = 9 * CELL + 2 * MARGIN  // 464

    fun x(c: Int): Float = MARGIN + c * CELL
    fun y(r: Int): Float = MARGIN + r * CELL
}

/** 木纹底色（与 iOS `drawWood` 的三段渐变一致）。 */
private val woodTop = Color(0.953f, 0.890f, 0.765f)
private val woodMid = Color(0.929f, 0.863f, 0.722f)
private val woodBottom = Color(0.890f, 0.812f, 0.651f)
private val woodVignette = Color(0.588f, 0.463f, 0.282f)
private val gridLine = Color(0.580f, 0.439f, 0.251f)
private val gridOuter = Color(0.502f, 0.373f, 0.204f)
private val markLine = Color(0.549f, 0.416f, 0.227f)
private val riverInk = Color(0.541f, 0.408f, 0.235f)
private val pieceRedRing = Color(0.659f, 0.157f, 0.110f)
private val pieceBlackRing = Color(0.141f, 0.133f, 0.125f)
private val pieceBlackText = Color(0.149f, 0.141f, 0.133f)
private val pieceShadow = Color(0.376f, 0.275f, 0.141f)
private val pieceFaceHi = Color(1.0f, 0.992f, 0.965f)
private val pieceFaceMid = Color(0.973f, 0.925f, 0.843f)
private val pieceFaceLo = Color(0.910f, 0.839f, 0.706f)

/** 「一」到「九」，红方纵线号用。 */
private val RED_FILE_NUMS = listOf("一", "二", "三", "四", "五", "六", "七", "八", "九")

/**
 * 把「逻辑单位」的字号换算成 `sp`。
 *
 * ⚠️ 这一步是必需的，而且是这个文件里最容易写错的地方：
 * `drawBoard` 是在一个 `scale(s)` 变换里画的（`s` 通常 1~3，视屏幕宽度而定），
 * 而 `fontSize = N.sp` 会被 Compose 按**设备密度**再乘一次。
 * 于是「逻辑 10」最终会画成 `10 * s * density` 像素 —— 比预期大 s 倍，
 * 表现是棋子里的字与坐标号直接撑爆格子（第一版就是这样，整块棋盘被放大 2.57 倍）。
 * 除以 `s * density` 之后，最终像素才正好等于逻辑值。
 */
private fun logicalSp(logical: Float, scale: Float, density: Float) =
    (logical / (scale * density)).sp

/** 需要画在棋盘上的东西。由界面从 `GameUiState` 组装。 */
class BoardRenderState(
    val board: ByteArray,
    val selected: Int,
    val targets: List<Move>,
    val lastMove: Move?,
    val hintMove: Move?,
    val checkSide: Side?,
    /** 正在滑动的棋子（0 = 没有动画）。 */
    val animPiece: Byte = 0,
    val animFrom: Int,
    val animTo: Int,
    /** 0 → 1：滑动进度。 */
    val animProgress: Float,
    /** 被吃掉的子（动画期间留在原地）。 */
    val animCaptured: Byte,
    val flip: Boolean = false,
)

/**
 * 画一整块棋盘。
 *
 * 调用方负责把画布尺寸**等比缩放到逻辑尺寸**（见 `XiangqiBoard`），
 * 所以这里一律用 `BoardMetrics` 的逻辑坐标，不需要关心真实像素。
 *
 * 绘制顺序与 iOS 一致：木纹 → 网格 → 楚河汉界 → 高亮 → 棋子 → 坐标号。
 * 顺序不能换：高亮要压在格线上、但被棋子盖住（否则选中环会盖住棋子本身）。
 */
fun DrawScope.drawBoard(
    state: BoardRenderState,
    measurer: TextMeasurer,
    scale: Float,
    density: Float,
) {
    // 落子动画期间：被吃的子还留在目标格上，等滑动结束才消失
    val capturedDuringAnim = state.animProgress < 1f && state.animCaptured.toInt() != 0

    drawWood()
    drawGrid(scale)
    drawRiver(measurer, scale, density)
    drawHighlights(state, scale)
    drawPieces(state, measurer, scale, density, capturedDuringAnim)
    drawCoords(measurer, scale, density)
}

private fun DrawScope.drawWood() {
    val w = BoardMetrics.LOGICAL_W
    val h = BoardMetrics.LOGICAL_H
    val radius = 14f
    drawRoundRect(
        brush = androidx.compose.ui.graphics.Brush.linearGradient(
            colors = listOf(woodTop, woodMid, woodBottom),
            start = androidx.compose.ui.geometry.Offset(0f, 0f),
            end = androidx.compose.ui.geometry.Offset(w * 0.35f, h),
        ),
        size = androidx.compose.ui.geometry.Size(w, h),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius, radius),
    )
    // 四角压暗，模拟木料边缘
    drawRoundRect(
        brush = androidx.compose.ui.graphics.Brush.radialGradient(
            colors = listOf(Color.Transparent, woodVignette.copy(alpha = 0.18f)),
            center = androidx.compose.ui.geometry.Offset(w / 2f, h / 2f),
            radius = h * 0.78f,
        ),
        size = androidx.compose.ui.geometry.Size(w, h),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius, radius),
    )
}

private fun DrawScope.drawGrid(scale: Float) {
    val grid = Path()
    for (r in 0 until 10) {
        grid.moveTo(BoardMetrics.x(0), BoardMetrics.y(r))
        grid.lineTo(BoardMetrics.x(8), BoardMetrics.y(r))
    }
    for (c in 0 until 9) {
        if (c == 0 || c == 8) {
            grid.moveTo(BoardMetrics.x(c), BoardMetrics.y(0))
            grid.lineTo(BoardMetrics.x(c), BoardMetrics.y(9))
        } else {
            // 中间七条竖线在楚河汉界处断开
            grid.moveTo(BoardMetrics.x(c), BoardMetrics.y(0))
            grid.lineTo(BoardMetrics.x(c), BoardMetrics.y(4))
            grid.moveTo(BoardMetrics.x(c), BoardMetrics.y(5))
            grid.lineTo(BoardMetrics.x(c), BoardMetrics.y(9))
        }
    }
    // 九宫斜线
    grid.moveTo(BoardMetrics.x(3), BoardMetrics.y(0)); grid.lineTo(BoardMetrics.x(5), BoardMetrics.y(2))
    grid.moveTo(BoardMetrics.x(5), BoardMetrics.y(0)); grid.lineTo(BoardMetrics.x(3), BoardMetrics.y(2))
    grid.moveTo(BoardMetrics.x(3), BoardMetrics.y(7)); grid.lineTo(BoardMetrics.x(5), BoardMetrics.y(9))
    grid.moveTo(BoardMetrics.x(5), BoardMetrics.y(7)); grid.lineTo(BoardMetrics.x(3), BoardMetrics.y(9))

    drawPath(grid, color = gridLine.copy(alpha = 0.62f), style = Stroke(width = 1f))

    // 外框加重
    val m = BoardMetrics.MARGIN
    drawRect(
        color = gridOuter.copy(alpha = 0.85f),
        topLeft = androidx.compose.ui.geometry.Offset(m, m),
        size = androidx.compose.ui.geometry.Size(8 * BoardMetrics.CELL, 9 * BoardMetrics.CELL),
        style = Stroke(width = 2f),
    )

    // 传统定位点（炮位、兵位）
    val full = listOf(-1 to -1, 1 to -1, -1 to 1, 1 to 1)
    val left = listOf(1 to -1, 1 to 1)
    val right = listOf(-1 to -1, -1 to 1)
    mark(2, 1, full, scale); mark(2, 7, full, scale)
    mark(7, 1, full, scale); mark(7, 7, full, scale)
    mark(3, 0, left, scale); mark(3, 2, full, scale); mark(3, 4, full, scale)
    mark(3, 6, full, scale); mark(3, 8, right, scale)
    mark(6, 0, left, scale); mark(6, 2, full, scale); mark(6, 4, full, scale)
    mark(6, 6, full, scale); mark(6, 8, right, scale)
}

private fun DrawScope.mark(r: Int, c: Int, quadrants: List<Pair<Int, Int>>, scale: Float) {
    val x = BoardMetrics.x(c)
    val y = BoardMetrics.y(r)
    val d = 5f
    val len = 9f
    val p = Path()
    for ((qx, qy) in quadrants) {
        val sx = x + qx * d
        val sy = y + qy * d
        p.moveTo(sx, sy + qy * len)
        p.lineTo(sx, sy)
        p.lineTo(sx + qx * len, sy)
    }
    drawPath(p, color = markLine.copy(alpha = 0.65f), style = Stroke(width = 1f))
}

private fun DrawScope.drawRiver(measurer: TextMeasurer, scale: Float, density: Float) {
    val style = TextStyle(
        fontSize = logicalSp(17f, scale, density),
        fontWeight = FontWeight.SemiBold,
        fontFamily = FontFamily.Serif,
        color = riverInk.copy(alpha = 0.5f),
    )
    drawCenteredText(measurer, "楚  河", style, BoardMetrics.x(2), BoardMetrics.y(4) + BoardMetrics.CELL / 2)
    drawCenteredText(measurer, "汉  界", style, BoardMetrics.x(6), BoardMetrics.y(4) + BoardMetrics.CELL / 2)
}

private fun DrawScope.drawHighlights(state: BoardRenderState, scale: Float) {
    // 上一步落点
    state.lastMove?.let { lm ->
        for (idx in listOf(lm.from, lm.to)) {
            val topLeft = androidx.compose.ui.geometry.Offset(
                BoardMetrics.x(idx % 9) - BoardMetrics.CELL * 0.42f,
                BoardMetrics.y(idx / 9) - BoardMetrics.CELL * 0.42f,
            )
            val size = androidx.compose.ui.geometry.Size(BoardMetrics.CELL * 0.84f, BoardMetrics.CELL * 0.84f)
            val r = androidx.compose.ui.geometry.CornerRadius(8f, 8f)
            drawRoundRect(Palette.accent.copy(alpha = 0.10f), topLeft, size, r)
            drawRoundRect(
                Palette.accent.copy(alpha = 0.28f), topLeft, size, r,
                style = Stroke(width = 1f),
            )
        }
    }

    // 选中 + 可落点
    if (state.selected >= 0) {
        drawPath(
            ringPath(state.selected),
            color = Palette.accent.copy(alpha = 0.95f),
            style = Stroke(width = 3f),
        )
        for (m in state.targets) {
            val cx = BoardMetrics.x(m.to % 9)
            val cy = BoardMetrics.y(m.to / 9)
            if (state.board[m.to].toInt() != 0) {
                drawCircle(
                    color = Palette.accent.copy(alpha = 0.55f),
                    radius = BoardMetrics.CELL * 0.45f,
                    center = androidx.compose.ui.geometry.Offset(cx, cy),
                    style = Stroke(width = 3f),
                )
            } else {
                drawCircle(
                    color = Palette.accent.copy(alpha = 0.45f),
                    radius = 5.5f,
                    center = androidx.compose.ui.geometry.Offset(cx, cy),
                )
            }
        }
    }

    // 建议着法箭头（虚线 + 两端圈）
    state.hintMove?.let { hm ->
        val ax = BoardMetrics.x(hm.from % 9)
        val ay = BoardMetrics.y(hm.from / 9)
        val bx = BoardMetrics.x(hm.to % 9)
        val by = BoardMetrics.y(hm.to / 9)
        val ang = Math.atan2((by - ay).toDouble(), (bx - ax).toDouble())
        val off = BoardMetrics.CELL * 0.36f
        val line = Path()
        line.moveTo(
            ax + Math.cos(ang).toFloat() * off,
            ay + Math.sin(ang).toFloat() * off,
        )
        line.lineTo(
            bx - Math.cos(ang).toFloat() * off,
            by - Math.sin(ang).toFloat() * off,
        )
        drawPath(
            line,
            color = Palette.accent.copy(alpha = 0.95f),
            style = Stroke(
                width = 2.6f,
                cap = androidx.compose.ui.graphics.StrokeCap.Round,
                pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(
                    floatArrayOf(6f, 5f),
                ),
            ),
        )
        for ((px, py) in listOf(ax to ay, bx to by)) {
            drawCircle(
                color = Palette.accent.copy(alpha = 0.95f),
                radius = BoardMetrics.CELL * 0.47f,
                center = androidx.compose.ui.geometry.Offset(px, py),
                style = Stroke(width = 2.6f),
            )
        }
    }

    // 将军：把被将一方的将/帅圈红
    state.checkSide?.let { side ->
        val ki = Rules.kingIndex(state.board, side)
        if (ki >= 0) {
            drawCircle(
                color = Palette.red.copy(alpha = 0.8f),
                radius = BoardMetrics.CELL * 0.5f,
                center = androidx.compose.ui.geometry.Offset(
                    BoardMetrics.x(ki % 9),
                    BoardMetrics.y(ki / 9),
                ),
                style = Stroke(width = 3.2f),
            )
        }
    }
}

/** 选中棋子的四角括号（不是整圈 —— 整圈会与棋子边重合，看不出选中）。 */
private fun ringPath(i: Int): Path {
    val x = BoardMetrics.x(i % 9)
    val y = BoardMetrics.y(i / 9)
    val h = BoardMetrics.CELL * 0.44f
    val s = h * 0.52f
    val p = Path()
    for ((c0, c1) in listOf(-1.0f to -1.0f, 1.0f to -1.0f, -1.0f to 1.0f, 1.0f to 1.0f)) {
        val sx = x + c0 * h
        val sy = y + c1 * h
        p.moveTo(sx, sy - c1 * s)
        p.lineTo(sx, sy)
        p.lineTo(sx - c0 * s, sy)
    }
    return p
}

private fun DrawScope.drawPieces(
    state: BoardRenderState,
    measurer: TextMeasurer,
    scale: Float,
    density: Float,
    capturedDuringAnim: Boolean,
) {
    for (i in 0 until Rules.SQUARES) {
        val p = state.board[i]
        if (p.toInt() == 0) continue
        // 正在滑动的棋子稍后再画（要盖在最上层）
        if (state.animProgress < 1f && i == state.animTo && state.animPiece.toInt() != 0) continue
        drawPiece(measurer, p, BoardMetrics.x(i % 9), BoardMetrics.y(i / 9), 1f, 1f, scale, density)
    }

    // 被吃的子：动画期间留在原地，滑动结束后自然消失（board 上已经没有了）
    if (capturedDuringAnim) {
        val i = state.animTo
        drawPiece(
            measurer, state.animCaptured,
            BoardMetrics.x(i % 9), BoardMetrics.y(i / 9),
            pieceScale = 1f, alpha = 1f - state.animProgress, scale = scale, density = density,
        )
    }

    // 滑动中的棋子
    if (state.animProgress < 1f && state.animPiece.toInt() != 0) {
        val fx = BoardMetrics.x(state.animFrom % 9)
        val fy = BoardMetrics.y(state.animFrom / 9)
        val tx = BoardMetrics.x(state.animTo % 9)
        val ty = BoardMetrics.y(state.animTo / 9)
        val t = state.animProgress
        val eased = t * t * (3 - 2 * t) // smoothstep：起步与收尾都缓一下，更像真实走子
        drawPiece(
            measurer, state.animPiece,
            fx + (tx - fx) * eased, fy + (ty - fy) * eased,
            pieceScale = 1.06f, alpha = 1f, scale = scale, density = density,
        )
    }
}

private fun DrawScope.drawPiece(
    measurer: TextMeasurer,
    p: Byte,
    cx: Float,
    cy: Float,
    pieceScale: Float,
    alpha: Float,
    scale: Float,
    density: Float,
) {
    val code = p.toInt()
    if (code == 0) return
    val red = Piece.isRed(code)
    val rad = BoardMetrics.CELL * 0.43f * pieceScale
    val ring = if (red) pieceRedRing else pieceBlackRing

    // 影子
    drawOval(
        color = pieceShadow.copy(alpha = alpha * 0.22f),
        topLeft = androidx.compose.ui.geometry.Offset(cx - rad * 0.95f, cy + rad * 0.42f - rad * 0.34f),
        size = androidx.compose.ui.geometry.Size(rad * 1.9f, rad * 0.68f),
    )

    // 棋面
    drawCircle(
        brush = androidx.compose.ui.graphics.Brush.radialGradient(
            colors = listOf(pieceFaceHi, pieceFaceMid, pieceFaceLo),
            center = androidx.compose.ui.geometry.Offset(cx - rad * 0.34f, cy - rad * 0.42f),
            radius = rad * 1.08f,
        ),
        radius = rad,
        center = androidx.compose.ui.geometry.Offset(cx, cy),
        alpha = alpha,
    )
    drawCircle(
        color = ring,
        radius = rad,
        center = androidx.compose.ui.geometry.Offset(cx, cy),
        alpha = alpha,
        style = Stroke(width = maxOf(1.5f, rad * 0.09f)),
    )
    drawCircle(
        color = ring.copy(alpha = ring.alpha * 1f),
        radius = rad * 0.82f,
        center = androidx.compose.ui.geometry.Offset(cx, cy),
        alpha = alpha * 0.34f,
        style = Stroke(width = 1f),
    )

    // 汉字
    drawCenteredText(
        measurer = measurer,
        text = Piece.name(code),
        style = TextStyle(
            fontSize = logicalSp(rad * 1.32f, scale, density),
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Serif,
            color = if (red) Palette.red else pieceBlackText,
        ),
        cx = cx,
        cy = cy + rad * 0.04f,
        alpha = alpha,
    )
}

/**
 * 棋盘上下的方位标注。
 *
 * 用象棋的标准记法，**不是**国际象棋的 a~i / 9~0 —— 后者在棋盘上写着 h3，
 * 棋谱里却是「炮二平五」，两套编号谁都对不上。
 *   下边（红方）：纵线自右向左为「一」到「九」
 *   上边（黑方）：纵线自左向右为「1」到「9」
 *
 * 编号规则与 `Notation.fileNumber` 是同一套：红方 `9-col`，黑方 `col+1`。
 * 横线方向在记法里只有「进/退 + 步数」，本身没有编号，所以左右两侧不标数字。
 */
private fun DrawScope.drawCoords(measurer: TextMeasurer, scale: Float, density: Float) {
    /* 位置要挑在「棋子够不到」的那条留白里：棋子半径 0.43 格（=18.9），
       底线/顶线的棋子从 y ≈ 44-18.9 = 25 处开始，所以标注只能贴到 0.26 格处。
       ⚠️ 字号也必须跟着收：留白只有 MARGIN = 34 逻辑单位，
       字号 10 时文字块高约 14，居中在 8.8 处就会有 2 逻辑单位被画到棋盘外面
       （实测坐标号被裁掉一半）。7.5 时文字块高约 10.7，正好落在 3.5~13.9 之间。 */
    val yTop = BoardMetrics.MARGIN * 0.26f
    val yBottom = BoardMetrics.LOGICAL_H - BoardMetrics.MARGIN * 0.26f
    for (c in 0 until 9) {
        drawCenteredText(
            measurer, RED_FILE_NUMS[8 - c],
            TextStyle(
                fontSize = logicalSp(7.5f, scale, density), fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Serif, color = Palette.red.copy(alpha = 0.62f),
            ),
            BoardMetrics.x(c), yBottom,
        )
        drawCenteredText(
            measurer, "${c + 1}",
            TextStyle(
                fontSize = logicalSp(7.5f, scale, density), fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace, color = Palette.ink.copy(alpha = 0.55f),
            ),
            BoardMetrics.x(c), yTop,
        )
    }
}

/**
 * 居中画一段文字。
 *
 * ⚠️ 这里**手动居中**（拿 `TextLayoutResult.size` 自己算偏移），
 * 而不是用 `drawText(topLeft=…)` 的省略号/对齐参数：棋盘上的汉字必须**完整**画出来，
 * 被约束截断成「…」的话棋子就变成了方块。
 * 所以 `Constraints()` 给的是无上限，宽度由文字自己决定。
 */
private fun DrawScope.drawCenteredText(
    measurer: TextMeasurer,
    text: String,
    style: TextStyle,
    cx: Float,
    cy: Float,
    alpha: Float = 1f,
) {
    val layout: TextLayoutResult = measurer.measure(
        text = text,
        style = style,
        constraints = Constraints(),
    )
    drawText(
        textLayoutResult = layout,
        topLeft = androidx.compose.ui.geometry.Offset(
            cx - layout.size.width / 2f,
            cy - layout.size.height / 2f,
        ),
        alpha = alpha,
    )
}
