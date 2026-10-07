package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peter260807.xiangqicoach.ai.AIConfig
import com.peter260807.xiangqicoach.data.GameStore
import com.peter260807.xiangqicoach.engine.Ability
import com.peter260807.xiangqicoach.engine.GameRecord
import kotlinx.coroutines.launch

/**
 * 战绩页：能力画像 + 对局列表 + 复盘。
 *
 * 复盘**分两层**，顺序是有意的：
 *  1. **本地复盘卡**（不需要 Key、不需要网络，毫秒出）—— 直接读已经算好的逐手数据；
 *  2. **大模型讲解**（可选）—— 把①那份结构化事实整段喂进去。
 *
 * 这两层原来是绑死的（点复盘先要求配好 Key），于是没配 Key 就完全用不了复盘 ——
 * 而复盘最有价值的那部分信息本来就在本地。
 */
@Composable
fun StatsScreen(
    vm: GameViewModel,
    store: GameStore,
    aiConfig: AIConfig,
    onOpenSettings: () -> Unit,
    onGoTrain: (String) -> Unit,
    onLoadGame: (GameRecord) -> Unit,
) {
    val games = store.payload.games
    val rep = remember(games, store.solvedIds, vm.library.mates.size) {
        Ability.abilities(games, store.solvedIds, vm.library.mates.size)
    }
    val drills = remember(games, store.solvedIds, vm.library.mates.size) {
        Ability.drills(games, store.solvedIds, vm.library, limit = 3)
    }
    var showReview by remember { mutableStateOf(false) }
    var reviewText by remember { mutableStateOf("") }
    var reviewBusy by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LazyColumn(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text(
                "战绩",
                color = Palette.ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
            )
        }

        // ---- 能力画像 ----
        item {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("综合", color = Palette.ink2, fontSize = 13.sp)
                        Text(
                            if (rep.hasData) "${rep.overall}" else "—",
                            color = Palette.ink, fontSize = 28.sp, fontWeight = FontWeight.Bold,
                        )
                    }
                    Column {
                        Text("对局 ${rep.games} 局（完赛 ${rep.finished}）", color = Palette.ink2, fontSize = 12.sp)
                        Text(
                            "胜率 ${if (rep.finished > 0) "${rep.winRate}%" else "—"}　平均 ${rep.avgPly} 手",
                            color = Palette.ink2, fontSize = 12.sp,
                        )
                        Text(
                            "杀法已通 ${rep.solvedMates}/${rep.mateTotal}",
                            color = Palette.ink2, fontSize = 12.sp,
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                for (d in rep.dimensions) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(d.name, color = Palette.ink, fontSize = 13.sp, modifier = Modifier.width(72.dp))
                        ProgressBar(d.score / 100f, Modifier.weight(1f))
                        Text(
                            " ${d.score}",
                            color = when (d.level) {
                                "good" -> Palette.jade
                                "mid" -> Palette.amber
                                else -> Palette.red
                            },
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.width(38.dp),
                        )
                    }
                    Text(d.note, color = Palette.ink3, fontSize = 11.sp, modifier = Modifier.padding(start = 72.dp))
                }
            }
        }

        // ---- 针对性训练推荐 ----
        if (drills.isNotEmpty()) {
            item { SectionTitle("针对性训练") }
            items(drills, key = { it.id }) { d ->
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(d.title, color = Palette.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                            Text(d.desc, color = Palette.ink3, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
                        }
                        SmallButton("去练") { onGoTrain(d.sceneId) }
                    }
                }
            }
        }

        // ---- 复盘 ----
        item {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("整局复盘", color = Palette.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                        Text(
                            if (aiConfig.isConfigured) "本地复盘卡 + 大模型讲解"
                            else "只出本地复盘卡（不需要 Key、不需要网络）",
                            color = Palette.ink3, fontSize = 12.sp,
                        )
                    }
                    SmallButton(if (reviewBusy) "生成中" else "复盘") {
                        if (reviewBusy) return@SmallButton
                        reviewBusy = true
                        scope.launch {
                            reviewText = try {
                                Coach.review(vm, aiConfig)
                            } catch (e: Exception) {
                                "复盘失败：${e.message}"
                            }
                            reviewBusy = false
                            showReview = true
                        }
                    }
                }
                if (vm.history.isEmpty()) {
                    Text(
                        "（需要先下完一盘棋；当前这局一手都还没走）",
                        color = Palette.ink3, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp),
                    )
                }
                if (!aiConfig.isConfigured) {
                    TextButton(onClick = onOpenSettings) {
                        Text("配置 API Key 以获取讲解 →", color = Palette.accent, fontSize = 12.sp)
                    }
                }
            }
        }

        // ---- 对局列表 ----
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SectionTitle("对局记录（${games.size}）", Modifier.weight(1f))
                if (games.isNotEmpty()) {
                    TextButton(onClick = { confirmReset = true }) {
                        Text("清空", color = Palette.red, fontSize = 12.sp)
                    }
                }
            }
        }

        if (games.isEmpty()) {
            item { EmptyHint("还没有对局记录。去「对弈」页下几盘，或者去「训练」页做杀法练习。") }
        } else {
            items(games, key = { it.id }) { g ->
                ListRow(
                    title = "${g.sceneName} · ${g.resultLabel}",
                    subtitle = "${g.level} · ${g.ply} 手 · 失误 ${g.flags.blunders} / 漏杀 ${g.flags.missedMate}",
                    trailing = g.savedAt.take(10),
                    onClick = { onLoadGame(g) },
                )
                Divider()
            }
        }

        item { Spacer(Modifier.height(12.dp)) }
    }

    if (showReview) {
        AlertDialog(
            onDismissRequest = { showReview = false },
            title = { Text("复盘", color = Palette.ink, fontWeight = FontWeight.SemiBold) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(reviewText, color = Palette.ink2, fontSize = 13.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = { showReview = false }) { Text("知道了", color = Palette.jade) }
            },
        )
    }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("清空全部记录？", color = Palette.ink, fontWeight = FontWeight.SemiBold) },
            text = {
                Text(
                    "会删掉 ${games.size} 盘对局记录与全部练习进度，不可恢复。",
                    color = Palette.ink2, fontSize = 14.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    store.resetAll()
                    confirmReset = false
                }) { Text("清空", color = Palette.red, fontWeight = FontWeight.Medium) }
            },
            dismissButton = {
                TextButton(onClick = { confirmReset = false }) { Text("取消", color = Palette.ink3) }
            },
        )
    }
}
