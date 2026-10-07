package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peter260807.xiangqicoach.ai.AIConfig
import com.peter260807.xiangqicoach.data.GameStore

/** 三个主页面。 */
enum class AppTab(val label: String) {
    PLAY("对弈"),
    TRAIN("训练"),
    STATS("战绩"),
}

/**
 * 应用根。
 *
 * 与 iOS 的 `RootView` 对应，但有两处**故意的差别**：
 *
 * 1. **二次确认弹窗挂在这里**（而不是各页面里）。iOS 那边是因为 TabView 的三个页面
 *    同时存在、挂进页面会弹两次；Compose 的 `when` 只会组合当前页，本来不会重复，
 *    但仍然挂在根上 —— 因为「重开 / 换局 / 载入」三个入口的触发点分布在两个页面里，
 *    挂在根上只有一处渲染、一处处理。
 * 2. **底部 tab 是自绘的**，不用 Material 的 `NavigationBar`：
 *    后者的高度、涟漪、指示器都是按 Material 3 规范来的，
 *    与 iOS 那套「顶部浮条」在观感上差得远，两端会看起来像两个 App。
 */
@Composable
fun RootScreen(
    vm: GameViewModel,
    store: GameStore,
    aiConfig: AIConfig,
    modifier: Modifier = Modifier,
) {
    var tab by remember { mutableStateOf(AppTab.PLAY) }
    var showSettings by remember { mutableStateOf(false) }
    // 训练页要跳到指定场景（战绩页的推荐项也走它）
    var pendingSceneId by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Palette.paper),
    ) {
        Box(Modifier.weight(1f)) {
            when (tab) {
                AppTab.PLAY -> PlayScreen(
                    vm = vm,
                    aiConfig = aiConfig,
                    onOpenSettings = { showSettings = true },
                    onGoTrain = { pendingSceneId = it; tab = AppTab.TRAIN },
                )
                AppTab.TRAIN -> TrainScreen(
                    vm = vm,
                    store = store,
                    pendingSceneId = pendingSceneId,
                    onConsumed = { pendingSceneId = null },
                    onPlayRequested = { tab = AppTab.PLAY },
                )
                AppTab.STATS -> StatsScreen(
                    vm = vm,
                    store = store,
                    aiConfig = aiConfig,
                    onOpenSettings = { showSettings = true },
                    onGoTrain = { pendingSceneId = it; tab = AppTab.TRAIN },
                    onLoadGame = {
                        vm.requestLoadGame(it)
                        tab = AppTab.PLAY
                    },
                )
            }
        }
        TabBar(current = tab, onSelect = { tab = it })
    }

    // 破坏性操作的二次确认：挂在根上，只渲染一次
    vm.pendingConfirm?.let { kind ->
        AlertDialog(
            onDismissRequest = { vm.dismissPending() },
            title = { Text(kind.title, color = Palette.ink, fontWeight = FontWeight.SemiBold) },
            text = { Text(kind.message, color = Palette.ink2, fontSize = 14.sp) },
            confirmButton = {
                TextButton(onClick = { vm.confirmPending() }) {
                    Text(kind.confirmLabel, color = Palette.red, fontWeight = FontWeight.Medium)
                }
            },
            dismissButton = {
                TextButton(onClick = { vm.dismissPending() }) {
                    Text("取消", color = Palette.ink3)
                }
            },
        )
    }

    if (showSettings) {
        SettingsScreen(aiConfig = aiConfig, store = store, onClose = { showSettings = false })
    }
}

/** 自绘底部 tab：只占高度、不做涟漪，观感与 iOS 顶部浮条一致。 */
@Composable
private fun TabBar(current: AppTab, onSelect: (AppTab) -> Unit) {
    Column {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.lineSoft))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Palette.card)
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            for (t in AppTab.entries) {
                val on = t == current
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable { onSelect(t) }
                        .padding(vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        t.label,
                        color = if (on) Palette.jade else Palette.ink3,
                        fontSize = 15.sp,
                        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                    )
                    Box(
                        Modifier
                            .padding(top = 3.dp)
                            .height(2.dp)
                            .fillMaxWidth(0.18f)
                            .background(if (on) Palette.jade else androidx.compose.ui.graphics.Color.Transparent),
                    )
                }
            }
        }
    }
}
