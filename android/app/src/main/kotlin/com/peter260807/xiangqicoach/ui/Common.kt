package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peter260807.xiangqicoach.engine.Engine

/** 卡片：白底、圆角、极细描边。 */
@Composable
fun Card(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Palette.card)
            .border(1.dp, Palette.lineSoft, RoundedCornerShape(14.dp))
            .padding(14.dp),
        content = content,
    )
}

/** 一行小标题 + 内容的设置行。 */
@Composable
fun SettingRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = Palette.ink2, fontSize = 13.sp)
        Box(Modifier.weight(1f))
        Text(value, color = Palette.ink3, fontSize = 13.sp)
    }
}

/**
 * 胜率条。
 *
 * ⚠️ 文案分两层：**分数**与**措辞**。
 * 判和 / 长将判负结束时，棋盘上根本没有杀棋，这时不能再写「红方已成杀」——
 * 所以 [override] 优先（只有对局结束时才由 ViewModel 给出）。
 */
@Composable
fun EvalBar(redScore: Int, override: String? = null, modifier: Modifier = Modifier) {
    val redPct = (Engine.winRate(redScore) * 100).toInt()
    val mid = override ?: Engine.scoreText(redScore)
    Card(modifier = modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("红方", color = Palette.ink2, fontSize = 13.sp)
            Text(
                " $redPct%",
                color = Palette.red,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
            )
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                Text(mid, color = Palette.ink2, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
            Text(
                "${100 - redPct}%",
                color = Palette.black,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(" 黑方", color = Palette.ink2, fontSize = 13.sp)
        }
        Box(
            modifier = Modifier
                .padding(top = 8.dp)
                .fillMaxWidth()
                .height(8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(Palette.paperDeep),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(redPct / 100f)
                    .height(8.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(Palette.red),
            )
        }
    }
}

/** 状态条：一个小圆点 + 一句话。 */
@Composable
fun StatusBar(text: String, warn: Boolean, modifier: Modifier = Modifier) {
    Card(modifier = modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .padding(end = 8.dp)
                    .size(9.dp)
                    .clip(RoundedCornerShape(50))
                    .background(if (warn) Palette.red else Palette.jade),
            )
            Text(
                text,
                color = if (warn) Palette.red else Palette.ink,
                fontSize = 14.sp,
                fontWeight = if (warn) FontWeight.Medium else FontWeight.Normal,
            )
        }
    }
}

/** 极简分段控件，用来切难度 / 对弈模式。 */
@Composable
fun <T> SegmentRow(
    options: List<Pair<T, String>>,
    selected: T,
    modifier: Modifier = Modifier,
    onSelect: (T) -> Unit,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.paperDeep)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        for ((value, label) in options) {
            val on = value == selected
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (on) Palette.card else Color.Transparent)
                    .then(
                        if (on) Modifier.border(1.dp, Palette.line, RoundedCornerShape(8.dp))
                        else Modifier,
                    )
                    .padding(vertical = 7.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    color = if (on) Palette.ink else Palette.ink3,
                    fontSize = 13.sp,
                    fontWeight = if (on) FontWeight.Medium else FontWeight.Normal,
                    modifier = Modifier.then(
                        Modifier.padding(horizontal = 2.dp),
                    ),
                )
            }
        }
    }
}

/** 棋盘上方的浮层提示（吃子 / 将军 / 将死）。 */
@Composable
fun ToastOverlay(text: String?, kind: String, modifier: Modifier = Modifier) {
    if (text == null) return
    val bg = when (kind) {
        "capture" -> Palette.amber.copy(alpha = 0.92f)
        "check" -> Palette.red.copy(alpha = 0.92f)
        "mate" -> Palette.red.copy(alpha = 0.95f)
        "draw" -> Palette.accent.copy(alpha = 0.92f)
        else -> Palette.ink.copy(alpha = 0.82f)
    }
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(bg)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

/** 章节标题。 */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.padding(vertical = 6.dp),
        color = Palette.ink2,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
    )
}

/** 空态提示。 */
@Composable
fun EmptyHint(text: String) {
    Text(
        text,
        modifier = Modifier.padding(vertical = 10.dp),
        color = Palette.ink3,
        fontSize = 13.sp,
    )
}

/** 与 MaterialTheme 无关的固定字号标题，避免被主题覆盖成两端不一致的大小。 */
@Composable
fun TitleText(text: String, fontSize: Int = 17) {
    Text(text, color = Palette.ink, fontSize = fontSize.sp, fontWeight = FontWeight.SemiBold)
}

/** 供预览/调试：把颜色显示成色块。 */
@Composable
fun ColorChip(c: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.height(12.dp).fillMaxWidth(0.06f).background(c))
        Text(label, fontSize = 12.sp, color = Palette.ink3, modifier = Modifier.padding(start = 6.dp))
    }
}
