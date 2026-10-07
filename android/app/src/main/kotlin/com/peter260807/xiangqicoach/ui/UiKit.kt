package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peter260807.xiangqicoach.engine.XQScene

/** 主操作按钮：白底、圆角、带极细描边（观感与 iOS 一致）。 */
@Composable
fun ActionButton(
    title: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .height(46.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) Palette.card else Palette.paperDeep)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            title,
            color = if (enabled) Palette.ink else Palette.ink3,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

/** 次要小按钮（顶栏、场景名、难度名）。 */
@Composable
fun SmallButton(
    title: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .height(34.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.card)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            title,
            color = if (enabled) Palette.ink else Palette.ink3,
            fontSize = 13.sp,
            maxLines = 1,
        )
    }
}

/** 可整行点击的列表项（场景、题目、存档）。 */
@Composable
fun ListRow(
    title: String,
    subtitle: String? = null,
    trailing: String? = null,
    badge: String? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = onClick != null) { onClick?.invoke() }
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (badge != null) {
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .background(Palette.jadeSoft)
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    ) {
                        Text(badge, color = Palette.jade, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                    }
                    Box(Modifier.width(6.dp))
                }
                Text(title, color = Palette.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
            if (!subtitle.isNullOrEmpty()) {
                Text(
                    subtitle,
                    color = Palette.ink3,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
        }
        if (trailing != null) {
            Text(trailing, color = Palette.ink3, fontSize = 12.sp)
        }
    }
}

/** 列表分隔线。 */
@Composable
fun Divider() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.lineSoft))
}

/** 带标签的输入框。 */
@Composable
fun LabeledField(
    label: String,
    value: String,
    hint: String = "",
    onValueChange: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, color = Palette.ink2, fontSize = 12.sp)
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            singleLine = true,
            placeholder = { if (hint.isNotEmpty()) Text(hint, color = Palette.ink3, fontSize = 13.sp) },
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
        )
    }
}

/** 一列表项按钮，用于设置页内的动作。 */
@Composable
fun SettingAction(
    title: String,
    subtitle: String? = null,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (danger) Palette.redSoft else Palette.card)
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 11.dp),
    ) {
        Column {
            Text(
                title,
                color = if (danger) Palette.red else Palette.ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
            )
            if (!subtitle.isNullOrEmpty()) {
                Text(subtitle, color = Palette.ink3, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
}

/** 场景行：点击后把整个场景交给回调。 */
@Composable
fun SceneRow(scene: XQScene, onPick: (XQScene) -> Unit) {
    ListRow(
        title = scene.title,
        subtitle = scene.note.split("\n").firstOrNull()?.take(40),
        onClick = { onPick(scene) },
    )
}

/** 进度条（题库通关进度）。 */
@Composable
fun ProgressBar(ratio: Float, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(Palette.paperDeep),
    ) {
        Box(
            Modifier
                .fillMaxWidth(ratio.coerceIn(0f, 1f))
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(Palette.jade),
        )
    }
}
