package com.peter260807.xiangqicoach.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peter260807.xiangqicoach.data.GameStore
import com.peter260807.xiangqicoach.engine.MateGroup
import com.peter260807.xiangqicoach.engine.MatePuzzle
import com.peter260807.xiangqicoach.engine.SceneCatalog
import com.peter260807.xiangqicoach.engine.XQScene

/**
 * 训练页：杀法 / 开局 / 残局三大类 + 进度。
 *
 * ## 性能上的一条硬约束
 *
 * 杀法库有 981 道，**不能一次性全部组合出来**。这里的做法：
 *  - 分组用 `LazyColumn`（只组合可见的行）；
 *  - 每组默认**只展开前 40 道**（几百个可见项会把首屏拖慢，
 *    这是 iOS 侧「列表每组只展开前 40 道」同一条约束）；
 *  - 生成场景对象是**按需**的（点到哪道才 `mateScene(它)`），
 *    不是先 `SceneCatalog.all()` 再筛 —— 后者每次重组都要新建近千个对象。
 */
@Composable
fun TrainScreen(
    vm: GameViewModel,
    store: GameStore,
    pendingSceneId: String?,
    onConsumed: () -> Unit,
    onPlayRequested: () -> Unit,
) {
    val lib = vm.library
    val solved = store.solvedIds
    var picker by remember { mutableStateOf<TrainCategory?>(null) }
    var expanded by remember { mutableStateOf<Set<String>>(emptySet()) }

    // 从战绩页/对弈页跳过来的目标场景：解析出来直接开局
    LaunchedEffect(pendingSceneId) {
        val id = pendingSceneId ?: return@LaunchedEffect
        val scene = sceneById(vm, id)
        if (scene != null) {
            vm.requestScene(scene)
            onPlayRequested()
        }
        onConsumed()
    }

    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 12.dp),
    ) {
        Text(
            "训练",
            color = Palette.ink,
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 10.dp, bottom = 6.dp),
        )

        ListRow(
            title = "杀法练习",
            subtitle = "${lib.mates.size} 道 · 已通 ${solved.count { it.startsWith("mate:") }} 道",
            trailing = "›",
            onClick = { picker = TrainCategory.MATE },
        )
        Divider()
        ListRow(
            title = "标准开局",
            subtitle = "${lib.openings.size} 条常见开局谱，可整段演示",
            trailing = "›",
            onClick = { picker = TrainCategory.OPENING },
        )
        Divider()
        ListRow(
            title = "实用残局",
            subtitle = "${lib.studies.size} 个基本胜残局",
            trailing = "›",
            onClick = { picker = TrainCategory.STUDY },
        )
        Divider()
        ListRow(
            title = "古谱名局",
            subtitle = "打谱演示 · ${lib.allClassics.size} 局",
            trailing = "›",
            onClick = { picker = TrainCategory.CLASSIC },
        )
        Divider()

        Spacer(Modifier.height(10.dp))

        val groups = remember(lib, solved) { lib.mateGroups(solved) }

        /* ⚠️ 不能写成「外层 LazyColumn + items(分组) + 分组里再 items(题目)」——
         * `LazyListScope.items` 的 lambda 接收者会变成 `LazyItemScope`（单项作用域），
         * 在那一层再调 `items` 编译不过（隐式接收者不对）。所以这里把分组**摊平**成
         * 一个行列表，交给一个 LazyColumn 渲染。摊平之后每组的「前 40 道」也只算一次。 */
        val rows = remember(groups, expanded, solved) { buildRows(groups, expanded, solved) }

        Text("杀法题库（按来源）", color = Palette.ink2, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        LazyColumn(Modifier.weight(1f).padding(top = 6.dp)) {
            items(rows, key = { it.key }) { row ->
                when (row) {
                    is TrainRow.Header -> {
                        GroupHeader(row.group, row.open) {
                            expanded = if (row.open) expanded - row.group.label else expanded + row.group.label
                        }
                    }
                    is TrainRow.Puzzle -> MateRow(
                        m = row.puzzle,
                        solved = row.solved,
                        onClick = {
                            vm.requestScene(SceneCatalog.mateScene(row.puzzle))
                            onPlayRequested()
                        },
                    )
                    is TrainRow.More -> ListRow(
                        title = "展开其余 ${row.count} 道",
                        subtitle = "（一次只画 40 行，几百行会把首屏拖慢）",
                        onClick = { expanded = expanded + row.label },
                    )
                }
            }
        }
    }

    picker?.let { cat ->
        CategoryDialog(
            vm = vm,
            category = cat,
            solved = solved,
            onDismiss = { picker = null },
            onPick = { scene ->
                picker = null
                vm.requestScene(scene)
                onPlayRequested()
            },
        )
    }
}

enum class TrainCategory { MATE, OPENING, STUDY, CLASSIC }

/**
 * 摊平后的训练列表行。
 *
 * ⚠️ **`key` 必须两两不同**。这不是洁癖：`LazyColumn` 一旦收到重复的 key 就直接抛
 * `IllegalArgumentException: Key ... was already used` 崩掉整个页面 ——
 * 而且**只在真正渲染到那一行时才崩**，所以跑编译、跑不打开训练页的测试都发现不了。
 * 我正是在模拟器上点开训练页才撞到的（原因见 `buildRows` 的注释）。
 * `GameFlowTest.trainingRowsHaveUniqueKeys` 现在守着这条。
 */
internal sealed class TrainRow {
    abstract val key: String

    class Header(val group: MateGroup, val open: Boolean) : TrainRow() {
        override val key: String get() = "h:${group.label}"
    }

    class Puzzle(val puzzle: MatePuzzle, val solved: Boolean) : TrainRow() {
        override val key: String get() = "p:${puzzle.id}"
    }

    class More(val label: String, val count: Int) : TrainRow() {
        override val key: String get() = "m:$label"
    }
}

/**
 * 每组默认只展开前 40 道，其余折成一行「展开」。
 *
 * ⚠️ 这一层是**必需的**，不是可选优化：`LazyColumn` 的 `items(分组)` 那个 lambda 里
 * 接收者是 `LazyItemScope`（单项作用域），在那一层再调 `items` 编译不过（隐式接收者不对）。
 * 摊平之后 key 的唯一性要自己保证 —— 见 `TrainRow` 的注释。
 */
internal fun buildRows(
    groups: List<MateGroup>,
    expanded: Set<String>,
    solved: Set<String>,
): List<TrainRow> {
    val out = ArrayList<TrainRow>(128)
    for (g in groups) {
        val open = expanded.contains(g.label)
        out.add(TrainRow.Header(g, open))
        val shown = if (open) g.items else g.items.take(40)
        for (m in shown) out.add(TrainRow.Puzzle(m, solved.contains("mate:${m.id}")))
        if (!open && g.items.size > 40) out.add(TrainRow.More(g.label, g.items.size - 40))
    }
    return out
}

@Composable
private fun GroupHeader(g: MateGroup, open: Boolean, onToggle: () -> Unit) {
    ListRow(
        title = (if (g.label.isEmpty()) "手写入门杀法" else g.label) + "（${g.items.size}）",
        trailing = if (open) "收起" else "展开",
        onClick = onToggle,
    )
    Divider()
}

@Composable
private fun MateRow(m: MatePuzzle, solved: Boolean, onClick: () -> Unit) {
    ListRow(
        title = m.name,
        subtitle = m.difficultyText + (if (m.tier == 1) " · 入门" else ""),
        badge = if (solved) "已通" else null,
        trailing = if (solved) "✓" else null,
        onClick = onClick,
    )
    Divider()
}

@Composable
private fun CategoryDialog(
    vm: GameViewModel,
    category: TrainCategory,
    solved: Set<String>,
    onDismiss: () -> Unit,
    onPick: (XQScene) -> Unit,
) {
    val lib = vm.library
    val title = when (category) {
        TrainCategory.MATE -> "杀法练习"
        TrainCategory.OPENING -> "标准开局"
        TrainCategory.STUDY -> "实用残局"
        TrainCategory.CLASSIC -> "古谱名局"
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, color = Palette.ink, fontWeight = FontWeight.SemiBold) },
        text = {
            LazyColumn(Modifier.height(420.dp)) {
                when (category) {
                    TrainCategory.MATE -> {
                        // 这里也只画前 60 道；要全部翻用上面按来源分组的列表
                        items(lib.mates.take(60), key = { it.id }) { m ->
                            ListRow(
                                title = m.name,
                                subtitle = m.difficultyText,
                                badge = if (solved.contains("mate:${m.id}")) "已通" else null,
                                onClick = { onPick(SceneCatalog.mateScene(m)) },
                            )
                            Divider()
                        }
                    }
                    TrainCategory.OPENING -> items(lib.openings, key = { it.id }) { o ->
                        ListRow(
                            title = o.name,
                            subtitle = "${o.style} · ${o.desc.take(24)}",
                            onClick = { onPick(SceneCatalog.openingScene(o)) },
                        )
                        Divider()
                    }
                    TrainCategory.STUDY -> items(lib.studies, key = { it.id }) { s ->
                        ListRow(
                            title = s.name,
                            subtitle = s.desc.take(30),
                            onClick = { onPick(SceneCatalog.studyScene(s)) },
                        )
                        Divider()
                    }
                    TrainCategory.CLASSIC -> {
                        val scenes = SceneCatalog.all(lib).filter { it.id.startsWith("classic:") }
                        items(scenes, key = { it.id }) { c ->
                            ListRow(
                                title = c.title,
                                subtitle = c.note.split("\n").firstOrNull()?.take(30),
                                onClick = { onPick(c) },
                            )
                            Divider()
                        }
                    }
                }
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) {
                Text("取消", color = Palette.ink3)
            }
        },
    )
}

/** 按 id 找场景。只按需构造，不做全库展开。 */
private fun sceneById(vm: GameViewModel, id: String): XQScene? {
    val lib = vm.library
    return when {
        id == "start" -> XQScene.standard()
        id.startsWith("mate:") -> lib.mates.firstOrNull { "mate:${it.id}" == id }
            ?.let { SceneCatalog.mateScene(it) }
        id.startsWith("opening:") -> lib.openings.firstOrNull { "opening:${it.id}" == id }
            ?.let { SceneCatalog.openingScene(it) }
        id.startsWith("study:") -> lib.studies.firstOrNull { "study:${it.id}" == id }
            ?.let { SceneCatalog.studyScene(it) }
        id.startsWith("classic:") -> SceneCatalog.all(lib).firstOrNull { it.id == id }
        else -> null
    }
}
