package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
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
import com.peter260807.xiangqicoach.engine.SceneCatalog
import com.peter260807.xiangqicoach.engine.SearchLevel
import com.peter260807.xiangqicoach.engine.XQScene
import kotlinx.coroutines.launch

/**
 * 对弈页。
 *
 * 竖屏手机是主场景：竖着排「评估条 / 棋盘 / 状态 / 按钮」，棋盘吃掉剩余的全部高度。
 * 与 iOS 的 iPad 竖屏那套「棋盘全屏 + 操作收进浮层」是同一个思路 ——
 * 手机上最宝贵的是棋盘面积，场景、难度、模式这些低频操作收进「更多」与弹窗。
 */
@Composable
fun PlayScreen(
    vm: GameViewModel,
    aiConfig: AIConfig,
    onOpenSettings: () -> Unit,
    onGoTrain: (String) -> Unit,
) {
    var showMore by remember { mutableStateOf(false) }
    var showScenes by remember { mutableStateOf(false) }
    var coachText by remember { mutableStateOf<String?>(null) }
    var coachBusy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("象棋教练", color = Palette.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    if (vm.thinking) "思考中…" else vm.engineInfo,
                    color = Palette.ink3,
                    fontSize = 12.sp,
                )
            }
            SmallButton("题库", onClick = { onGoTrain("") })
            Spacer(Modifier.width(6.dp))
            SmallButton("设置", onClick = onOpenSettings)
        }

        EvalBar(redScore = vm.redScore, override = vm.evalOverride)

        Box(
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentAlignment = Alignment.Center,
        ) {
            XiangqiBoard(
                state = BoardRenderState(
                    board = vm.board,
                    selected = vm.selected,
                    targets = vm.targets,
                    lastMove = vm.lastMove,
                    hintMove = vm.hintMove,
                    checkSide = vm.checkSide,
                    animPiece = vm.animPiece,
                    animFrom = vm.animFrom,
                    animTo = vm.animTo,
                    animProgress = vm.animProgress,
                    animCaptured = vm.animCaptured,
                ),
                onTapSquare = { vm.tap(it) },
            )
            ToastOverlay(
                text = vm.toast,
                kind = vm.toastKind,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 10.dp),
            )
        }

        StatusBar(vm.statusText, vm.statusWarn)

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ActionButton("提示", Modifier.weight(1f)) { vm.requestHint() }
            ActionButton("悔棋", Modifier.weight(1f)) { vm.undo() }
            ActionButton("重开", Modifier.weight(1f)) { vm.requestRestart() }
            ActionButton(if (coachBusy) "点评中" else "点评", Modifier.weight(1f)) {
                if (coachBusy) return@ActionButton
                if (!aiConfig.isConfigured) {
                    coachText = "还没有配置 API Key。\n\n到「设置」里填一次即可 —— " +
                        "不配 Key 也能用「战绩」页的本地复盘卡（那份数据完全由引擎算出来，不需要网络）。"
                    return@ActionButton
                }
                coachBusy = true
                // 先问引擎要候选着法（点评要把它们一起喂给模型），拿到再调模型
                vm.requestHint { cands ->
                    scope.launch {
                        coachText = try {
                            Coach.ask(vm, aiConfig, cands)
                        } catch (e: Exception) {
                            "点评失败：${e.message}"
                        }
                        coachBusy = false
                    }
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SmallButton(vm.scene.title.take(8), onClick = { showScenes = true }, modifier = Modifier.weight(1f))
            SmallButton(SearchLevel.named(vm.levelKey).label, onClick = { showMore = true }, modifier = Modifier.width(84.dp))
            SmallButton("存档", onClick = { vm.saveCurrentGame() }, modifier = Modifier.width(72.dp))
        }
    }

    if (showMore) MoreSheet(vm = vm, onDismiss = { showMore = false })

    if (showScenes) {
        ScenePickerDialog(
            vm = vm,
            onDismiss = { showScenes = false },
            onPick = { scene ->
                showScenes = false
                vm.requestScene(scene)
            },
        )
    }

    coachText?.let { text ->
        AlertDialog(
            onDismissRequest = { coachText = null },
            title = { Text("局面点评", color = Palette.ink, fontWeight = FontWeight.SemiBold) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(text, color = Palette.ink2, fontSize = 14.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = { coachText = null }) { Text("知道了", color = Palette.jade) }
            },
        )
    }
}

@Composable
private fun MoreSheet(vm: GameViewModel, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("对局设置", color = Palette.ink, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                SectionTitle("难度")
                SegmentRow(
                    options = SearchLevel.all.map { it.key to it.label },
                    selected = vm.levelKey,
                    onSelect = { vm.setLevel(it) },
                )
                SectionTitle("对弈模式")
                SegmentRow(
                    options = listOf(
                        "engine" to "本地引擎",
                        "hybrid" to "混合",
                    ),
                    selected = vm.modeKey,
                    onSelect = { vm.setMode(it) },
                )
                Text(
                    "混合模式下由引擎算出合法候选，大模型从中挑一个并说明理由；" +
                        "模型给的着法会用引擎再验一遍，不合法就自动回退。",
                    color = Palette.ink3,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(top = 8.dp),
                )
                if (vm.canDemo) {
                    SectionTitle("打谱演示")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SmallButton(if (vm.demoPlaying) "暂停" else "播放") { vm.demoToggle() }
                        SmallButton("下一手") { vm.demoStep() }
                        SmallButton("退出演示") { vm.exitDemo() }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("完成", color = Palette.jade) } },
    )
}

/**
 * 场景选择。
 *
 * ⚠️ 杀法库有 981 道 —— **绝不能**把 `SceneCatalog.all()` 渲染成一张长列表。
 * 这里只列「分类入口」：标准开局 / 8 条开局谱 / 3 个残局 / 名局 / 手写浅题，
 * 导入的那 970 道去训练页按来源分组翻。这是 iOS 侧踩过的同一个性能坑。
 */
@Composable
private fun ScenePickerDialog(
    vm: GameViewModel,
    onDismiss: () -> Unit,
    onPick: (XQScene) -> Unit,
) {
    val lib = vm.library
    // 只构造一次浅题的场景（11 道 + 21 道两步杀），不碰那 949 道深题
    val shallow = remember(lib) { lib.mates.filter { it.tier <= 2 }.map { SceneCatalog.mateScene(it) } }
    val classics = remember(lib) { SceneCatalog.all(lib).filter { it.id.startsWith("classic:") } }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择场景", color = Palette.ink, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                SceneRow(XQScene.standard()) { onPick(it) }
                SectionTitle("开局谱（${lib.openings.size}）")
                for (o in lib.openings) SceneRow(SceneCatalog.openingScene(o)) { onPick(it) }
                SectionTitle("实用残局（${lib.studies.size}）")
                for (s in lib.studies) SceneRow(SceneCatalog.studyScene(s)) { onPick(it) }
                if (classics.isNotEmpty()) {
                    SectionTitle("古谱名局（${classics.size}）")
                    for (c in classics) SceneRow(c) { onPick(it) }
                }
                SectionTitle("手写杀法（${shallow.size} 道）")
                for (m in shallow) SceneRow(m) { onPick(it) }
                Text(
                    "导入的 ${lib.mates.count { it.tier > 2 }} 道杀法题在「训练」页按来源分组。",
                    color = Palette.ink3,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消", color = Palette.ink3) } },
    )
}
