package com.peter260807.xiangqicoach

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.peter260807.xiangqicoach.ui.GameViewModel
import com.peter260807.xiangqicoach.ui.Palette
import com.peter260807.xiangqicoach.ui.RootScreen
import com.peter260807.xiangqicoach.ui.XiangqiTheme

class MainActivity : ComponentActivity() {

    private lateinit var container: AppContainer

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = AppContainer(this)
        enableEdgeToEdge()
        setContent {
            XiangqiTheme {
                Surface(color = Palette.paper, modifier = Modifier.fillMaxSize()) {
                    AppRoot(container)
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        // 退出后台时把进行中的对局落一次盘，避免被系统回收后丢进度
        container.store.load()
    }
}

/**
 * 应用入口。
 *
 * ⚠️ **`GameViewModel` 必须由 Activity 持有，不能放进 composable 的局部 `remember`**：
 * 旋转屏幕 / 分屏 / 折叠屏展开时，Compose 会重建整个树 —— 状态放在局部 remember 里，
 * 用户一旋转整盘棋就没了。放在 ViewModel 里则由框架保管，重组不会丢。
 *
 * 这也正是 iOS 那边「iPad 竖屏曾经走了分栏」那类问题的等价物：
 * 两端的生命周期模型不同，**不能把一端的写法直译到另一端**。
 */
@Composable
private fun AppRoot(container: AppContainer) {
    val vm: GameViewModel = viewModel(
        factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                GameViewModel(container.library, container.store, container.engine) as T
        },
    )
    RootScreen(
        vm = vm,
        store = container.store,
        aiConfig = container.aiConfig,
    )
}
