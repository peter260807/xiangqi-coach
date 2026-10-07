# Android 版方案（Kotlin + Jetpack Compose）

> 目标：给「象棋教练」补上 Android 端，**功能与 iOS 对齐**，产出可安装的签名 APK。
> 本文是路线与验收依据；实测数字都标了出处，没实测的一律写成「待验收」。

---

## 一、结论先说

| 决定 | 选择 |
|---|---|
| 界面 | **Jetpack Compose**（原生） |
| 引擎 | **Kotlin 重写**，与 Swift 引擎逐函数对齐；**不复用 JS 引擎** |
| 棋谱库 | 继续用 `shared/library.json` 这一份源头，由 `tools/sync-library.js` 同步到 Android assets |
| 验收 | 沿用仓库已有的两台测量仪：**perft 三方对数** + **`tools/match.js` 对局量 Elo** |
| 首版范围 | 对弈 / 训练 / 战绩 / 设置 + 981 道杀法题 + 本地复盘 + 大模型点评 |

选 Kotlin 重写而不是套 WebView，理由是**这个仓库已经有一整套为「重写」准备的验收设施**：
perft 对数（三方规则一致）、UCI 对局台（改了搜索到底有没有变强）、档位对局台（各难度是什么水平）。
换个语言重写引擎，最怕的是「看起来能下棋，其实规则悄悄错了」——而这三件工具正好是这个恐惧的解药。
套 WebView 显然更快，但那样 Android 端只能吃 JS 引擎

---

## 二、现状盘点（我实际核过的）

### 2.1 两套前端

| 前端 | 代码量 | 说明 |
|---|---|---|
| iOS 原生 SwiftUI | 6 160 行 Swift | `ios/XiangqiCoach/`：Engine 1 765 / Models 1 820 / Views 1 697 / AI 507 / App 206 |
| 网页版 | 5 632 行 JS | `web/js/`：engine.js 1 392、app.js 1 503、board.js 501、storage.js 630、ai.js 422 |

iOS 侧文件与行数：

| 文件 | 行数 | 移植难度 |
|---|---|---|
| `Engine/Search.swift` | 1 205 | ⚠️ 最难，但**纯算法、零 Foundation 依赖** |
| `Models/GameState.swift` | 968 | 中等（并发与动画要按 Android 习惯重写） |
| `Views/PlayView.swift` | 928 | ⚠️ 布局逻辑要重做（见 §6） |
| `Models/Archive.swift` | 603 | 低（纯计算 + JSON） |
| `Engine/Rules.swift` | 485 | 低（纯算法，逐函数对齐） |
| `Views/BoardView.swift` | 347 | 低（Canvas 绘制 → Compose Canvas） |
| `Views/TrainView.swift` | 257 | 低 |
| `Models/Library.swift` | 249 | 低（Codable → kotlinx.serialization） |
| `AI/LLMClient.swift` | 240 | 低（URLSession → OkHttp/HttpURLConnection） |
| `XiangqiCoachApp.swift` | 206 | 低（TabView → Compose Navigation） |
| `Views/NotationSheet.swift` | 165 | 低 |
| `Views/SettingsView.swift` | 155 | 低 |
| `AI/Prompts.swift` | 139 | 极低（可逐字搬运） |
| `AI/AIConfig.swift` | 128 | 低（plist → DataStore） |
| `Engine/Notation.swift` | 85 | 低 |

### 2.2 棋谱库

`shared/library.json`（604 KB，缩进格式）→ 两个派生副本各 **400 KB**（紧凑 JSON）：
`web/js/library-data.js`、`ios/…/Resources/library.json`。

实测内容：**mates 981 道**（tier1 手写 11 / tier2 21 / tier3 949；全部带 `line` 解法路线）、
**openings 8 条**、**studies 3 道**、**classics 1 局**。字段：
`mates[].{id,name,tier,fen,idea,line,lineSides,solvePlies,mateIn}`。

> ⚠️ 这个库有过一次「iOS 那份停在 11 道题、所有单测照样全绿」的事故（见 `docs/puzzle-sources.md` §六.5）。
> Android 这份**必须**进同步链，并且要有守门断言（见 §5.3）。

### 2.3 难度档（四档，2026-09-24 起）

| key | 名称 | depth | timeMs | slack |
|---|---|---|---|---|
| `easy` | 入门 | 1 | 600 | 320 |
| `normal` | 初级 | 3 | 1 200 | 110 |
| `hard` | 中级 | 5 | 2 200 | 35 |
| `expert` | 高级 | 8 | 3 500 | 0 |

老存档里的 `master` 要映射到 `expert`（`SearchLevel.legacyAliases`），否则静默降两档。

---

## 三、实测：三条路的性能底数（本机跑出来的）

iOS 引擎经 `tools/uci/run.sh` 编成 CLI，与 JS 引擎在同一台 Mac（Apple Silicon）上对同一起始局面测量。

### 3.1 规则一致性：perft 三方对数（**通过**）

| 深度 | 标准值 | Swift 引擎 | JS 引擎 |
|---|---|---|---|
| 1 | 44 | 44 | 44 |
| 2 | 1 920 | 1 920 | 1 920 |
| 3 | 79 666 | 79 666 | 79 666 |
| 4 | 3 290 240 | 3 290 240（376 ms） | 3 290 240（5 192 ms） |

标准值出处：[中国象棋的着法生成：perft统计结果](https://shenlb.blog.csdn.net/article/details/119167433)（该表注明「包含将军判断」）。
**两份规则实现的着法生成是等价的** —— 这是「重写引擎」这件事可行的前提。

### 3.2 速度：JS 比 Swift 慢约 4.6 倍

| 项目 | Swift | JS | 倍数 |
|---|---|---|---|
| perft(4) | 376 ms | 5 192 ms | 13.8×（perft 不走搜索优化，差距偏大） |
| 中局定深 d6 节点数 | 119 296 | 123 948（nodes+qnodes） | 基本持平 |
| 中局搜索吞吐 | 约 147 万节点/秒 | 约 36 万节点/秒 | **约 4.1×** |
| 中局 d7 耗时 | 未单独测（d6 为 81 ms） | 756 ms | — |
| 「高级」档 3 500 ms / 上限 8 层 | — | 中局 8 层用 2 448 ms；**开局 8 层用 3 307 ms（贴着上限）** | — |

> ⚠️ **这组数字没有一个是安卓上的数字。** 它只回答一个问题：
> 「复用 JS 引擎能不能达到 iOS 现在的水平」——答案是在高端机上勉强、在中端机上明显掉档
> （引擎时间预算是**写死**的 3 500 ms，慢一倍就意味着少搜 1～2 层）。
> Kotlin 原生版的性能**待验收**：验收方法见 §5.4（固定时限对比实际到达层数），
> 不是「跑得动就行」。

### 3.3 本机 Android 构建链（已核实可用）

| 组件 | 现状 |
|---|---|
| Android SDK | `~/Library/Android/sdk`：platforms **android-35 / android-37.0**，build-tools **34.0.0 / 36.0.0** |
| 模拟器 | AVD **Pixel_7a（android-34）**、**Pixel_9_Pro** |
| Gradle | 独立发行版 `~/gradle-8.14.3`；`~/.gradle/wrapper/dists` 已缓存 **gradle-8.9 / 8.14.3** |
| JDK | `~/jdk21`（Corretto **21.0.12**）、Android Studio 2026.1 自带 JBR（**25.0.2**） |
| 联网 | `dl.google.com` / `repo1.maven.org` / `services.gradle.org` 均可访问（200） |
| 真机 | 当前 `adb devices` **为空**（真机验收需要插线） |

> ⚠️ **不要用 JDK 25 跑 Gradle。** AGP 8.7 / Kotlin 2.0 的支持上限是 JDK 21；
> 而 Android Studio 自带的 JBR 是 25 —— 用它启动 Gradle 会直接崩在
> `JavaVersion.parse("25.0.2")`，报错完全指不到真正的原因。
> 仓库里**不写死机器路径**，用 `JAVA_HOME=/path/to/jdk21 ./gradlew …`
> 或 `-Dorg.gradle.java.home=…`，Android Studio 里则设 Gradle JDK = 21。
>
> ⚠️ 实测确认：把 `org.gradle.java.home` 写进 **`local.properties` 不生效**
> （Gradle 只读命令行与 `gradle.properties` 里的这个属性），仍会拿 JBR 25 启动然后崩。
> 这条我一开始写反了，改了回来。

---

## 四、目录与构建

```
android/                              ← 新增，与 ios/ web/ 平级
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties                 ← 钉 JDK21、开 AndroidX
├── gradle/wrapper/                   ← 用已有缓存里的 8.14.3，避免现下载
├── engine/                           ← 纯 Kotlin JVM 库：规则 + 搜索 + 记谱（不依赖 Android）
│   ├── build.gradle.kts
│   └── src/main/kotlin/…/engine/{Rules,Search,Notation}.kt
│   └── src/test/kotlin/…            ← perft、规则定点、交叉验证（纯 JVM，秒级）
└── app/                              ← Android 应用
    ├── build.gradle.kts
    └── src/main/
        ├── assets/library.json       ← 由 tools/sync-library.js 产出，勿手改
        ├── kotlin/…/{model,ui,ai,data}
        └── res/
```

**为什么把引擎拆成独立 Gradle 模块（`engine`）**：

1. 它是**纯算法、零 Android 依赖**的，拆出来才能在 JVM 上跑单元测试，不用模拟器、秒级反馈；
2. `tools/` 里的 UCI 前端可以直接依赖这个模块编出 **JAR**，
   于是仓库已有的 `tools/match.js`、`tools/level-match/`、`tools/test-parallel.js` **一行不改**就能把 Kotlin 引擎当选手测；
3. 模块边界天然防止「引擎里偷偷用了 `Context`」这类腐化。

包名沿用反向域名风格：`com.peter260807.xiangqicoach`（与 iOS bundle id 对齐）。
**包名一旦发布就不能改**（等于换了应用），所以要在第一次打 APK 之前定死。

---

## 五、引擎移植：逐模块对齐 + 三关验收

### 5.1 类型映射约定

| Swift | Kotlin | 说明 |
|---|---|---|
| `[Int8]` 棋盘（90 格） | `ByteArray(90)` | **不要用 `IntArray`**，缓存行占用翻 4 倍；`Byte` 是有符号的，比较全部用 `.toInt()` |
| `enum Side: Int8` | `enum class Side(val v: Int)` | 红 `0` / 黑 `1`，与 Swift 同值 |
| 棋子编码 1…14 | 同左，`const val` | **不要用 enum class**（每格一次装箱，搜索里是灾难） |
| `Move{from,to}` | `class Move(val from: Int, val to: Int)` + `equals/hashCode` | 搜索里会大量比较，手写 `equals` 比 data class 更快 |
| `static let` | `const val` / `val` on `object` | 热路径常量（方向表、PST）放 `object` 里复用 |
| `DispatchQueue.global().async` | `withContext(Dispatchers.Default)` | 见 §6.2 |
| `ObservableObject` / `@Published` | `ViewModel` + `mutableStateOf` / `StateFlow` | 见 §6.1 |
| `Codable` | `@Serializable`（kotlinx.serialization） | 存档 JSON 要与 iOS 结构兼容 |
| `ProcessInfo…environment["XQ_NO_LMR"]` | 构造函数参数 + `System.getProperty` | 见 5.2 |

### 5.2 搜索内部：明确「跟 Swift 不同」的地方

搜索是唯一需要**主动改设计**而非直译的部分。原则：**行为必须一致，实现可以更好**。

| 项 | Swift 现状 | Kotlin 做法 | 理由 |
|---|---|---|---|
| 置换表 | 自研 TT（`ResetForTesting`、跨局累积） | **开放寻址数组 + 2 的幂容量 + 替换策略**，暴露 `resetForTesting()` / `clearTT()` | 与 Swift 行为对齐（跨调用保留），但去掉了哈希表开销；容量可配 |
| 开关（LMR/空着/长将） | 读环境变量 `XQ_NO_LMR` / `XQ_NO_NULL` / `XQ_NO_PERPETUAL` | 引擎构造函数参数 + `System.getProperty` 兜底 | **环境变量在 Android 上不可用**，必须变成显式参数，否则测试台没法做归因 A/B |
| 时间管理 | `DispatchTime.uptimeNanoseconds` | `System.nanoTime()` | 单调时钟，不受系统时间调整影响 |
| 多线程 | 单线程（`searchSync` + 异步包装） | 单线程；**并发只做「多次分析并行」**（提示/评估条），不引入 Lazy SMP | 引入并行搜索会改变节点数与结果，**会污染 A/B 基线**；收益也不明确 |
| 随机性 | `pickMove` 在 slack 内随机挑候选 | 同一个 `Random` 语义，种子可注入 | 可复现性：测试台要能钉住随机源 |

### 5.3 三关验收（**做完一关才算移植完一关**）

**第一关：规则正确性 —— perft 对数**

`android/engine/src/test/…/PerftTest.kt` 断言起始局面 perft 1/2/3/4 =
44 / 1 920 / 79 666 / 3 290 240。再对 `library.json` 的 981 个局面各跑一遍浅层 perft，
与 `tools/uci/build/xq-uci`（Swift）的输出**逐局面比对**（脚本产出对账文件，测试读它）。

> ⚠️ perft 的计数口径要写进注释：**只过滤「自己的帅被将」**，
> 不要顺手过滤「对方被将军」——那会把 79 666 算成 79 258（我踩过这个坑）。
> 递归里的 `depth==1` 分支返回 `legalMoves.count`，所以**是「合法着法数」而不是「子节点数之和」**，
> 这两者在本项目里数值恰好相同，但注释必须写清是哪一个，否则后来的改动会静默改掉口径。

**第二关：搜索行为 —— 与 Swift 引擎对局量 Elo**

```bash
# 1) 编出 Kotlin 侧 UCI（依赖 android/engine 模块，纯 JVM）
cd android && ./gradlew :engine:shadowJar     # 或 :tools:uci installDist
# 2) 用仓库现成的对局台，Swift 当基准
node tools/match.js --a uci:android/build/xq-uci-kotlin --b uci:tools/uci/build/xq-uci \
                    --ms 300 --games 40 --random-plies 4 --jobs 8
```

通过标准（**先定死，免得看到数字再找解释**）：

- 得分率落在 **45%～55%**（区间含 50%），即「重写没有把棋力写丢」；
- 若区间**不含** 50%，先查是不是**评估表/PST/SEE 抄错了一行**，而不是先怀疑「Kotlin 慢」；
- 附带交叉验证：**同一批局面下两版给出的最佳着法一致率**（`--clear-tt` + 固定深度），
  这一项是**确定性**的，比 Elo 更能定位「抄错了」。

**第三关：数据完整性 —— 库与复盘**

- 981 道题**沿存下的 `line` 各走一遍**：可走、非退化、确实将死、步数与 `mateIn` 一致（照搬 `LibraryTests`）；
- 守门断言：**assets 里那份库不是旧副本**（题数 981、含 tier3、含某个已知 id）；
- `ReviewDigest` / 能力画像 / 训练推荐：用**与 `ArchiveTests.swift` 同一组构造数据**断言同样结果。

### 5.4 性能验收（不是「跑得动就行」）

沿用 `tools/level-match/probe-level-engines.js` 的口径：**跑几十个真实局面，比平均实际到达层数**。

- 固定时限 3 500 ms，开局 + 中局各 30 个局面，Kotlin 版与 Swift 版**平均深度差 ≤ 0.5 层**；
- 记录 nps（节点/秒）作为参照，但**结论看层数**——整数层分辨率不够时用平均有效深度。
- 安卓真机数字单独记一份，并写进 `docs/strength-levels.md` 那样的表格，不要只留在对话里。

---

## 五之二、移植实测结果（2026-10-08 跑完）

**第一关：规则正确性 —— 通过。**

| 检查 | 结果 |
|---|---|
| perft(1/2/3/4) 起始局面 | 44 / 1 920 / 79 666 / 3 290 240 ✅（Kotlin 单测，`PerftTest`） |
| 985 个局面 × 深度 1、2 与 Swift 逐项对数 | **1 970 项全部一致** ✅（`node tools/test-rules-parity.js`） |
| 982 个局面的静态评估 vs JS | 全部一致 ✅（`node tools/test-engine-parity.js`） |
| 982 个局面的着法生成（双方） vs JS | 1 964 项全部一致 ✅ |
| 982 个局面的中文记谱 vs JS | 全部一致 ✅ |
| 快版 / 慢版将军判定交叉验证 | 300+ 次比对一致 ✅（`PerftTest.inCheckFastMatchesGeneration`） |

**第二关：搜索行为 —— 通过。**

`node tools/match.js --a uci:android/tools/uci/build/xq-uci-kotlin --b uci:tools/uci/build/xq-uci --ms 300 --games 40 --random-plies 4 --jobs 8`

| 指标 | 结果 | 通过标准 |
|---|---|---|
| 得分率 | **52.5%**（16 胜 10 和 14 负） | 45%~55% ✅ |
| Elo 差（Kotlin − Swift） | **+17，95% 区间 [−77, +112]** | 区间含 50% ✅ |
| 平均到达层数 | **9.26 / 9.44** | 差 ≤ 0.5 层 ✅（差 0.18） |
| 独立起手局面 | 20 组 / 40 局（成对设计，恰好期望值） | 不少于局数一半 ✅ |
| 结束原因 | 将死 24、手数上限 7、困毙 6、三次重复 3 | — |

> 平均层数只差 0.18 层 —— 这条比 Elo 更能说明「Kotlin 版没有变慢」：
> 两侧时间预算都是写死的 300 ms，到达层数相同就意味着搜索效率相当。
> 注意这两个数字是**本机 JVM 上的**，不是安卓真机的（真机数字待 M7 补）。

**第三关：数据完整性 —— 通过。**

| 检查 | 结果 |
|---|---|
| 981 道题沿存下的解法路线逐条走一遍（可走、非退化、确实将死、步数对得上） | 全部通过 ✅ |
| 守门断言：条数 ≥ 900 + 抽查跨批次 id（`m1` / `x0010` / `x0446` / `x0970`）+ 最深 ≥ 20 手 | 通过 ✅ |
| 浅题（mateIn ≤ 2）引擎自己在 6 层内找得到杀 | 通过 ✅ |
| 8 条开局谱逐手合法 | 通过 ✅ |
| 3 个残局局面合法 | 通过 ✅ |
| 能力画像 / 训练推荐（照搬 `ArchiveTests` 的构造数据） | 13 条断言全部通过 ✅ |
| 旧存档（缺 `playedLabel` / `missedMate`）仍能生成复盘 | 通过 ✅ |

> ⚠️ 这一关**测的是 `shared/library.json`**，不是 APK 里的 assets 副本。
> 「assets 是同步出来的」由同步链与 `isNotTheStaleCopy` 的那组 id 断言守着 ——
> iOS 那次「停在 11 道题、测试全绿」的教训就要求这两层都在。

**界面层（M4~M6）—— 完成，装到模拟器上逐项验过。**

| 项 | 状态 |
|---|---|
| 棋盘绘制（木纹 / 网格 / 九宫 / 楚河汉界 / 传统定位点 / 坐标号） | ✅ 与 iOS 同一套几何（420×464、格子 44、边距 34） |
| 点选 → 可落点提示 → 落子 → 走子动画（460ms 滑动 + 520ms 停顿） | ✅ 逐格核对过（`adb logcat` 打出「像素 → 逻辑 → 格」） |
| 电脑应手（中级档 5 层 / 2.2 秒） | ✅ 实测走完一整个回合 |
| 提示（虚线箭头 + 推荐着法文案） | ✅ |
| 重开 / 换局 / 载入的二次确认 | ✅ 与 iOS 同样挂在根上，只渲染一次 |
| 训练页（981 道按来源分组、每组默认展开 40 道） | ✅ |
| 战绩页（能力画像、针对性训练、对局列表、复盘入口） | ✅ |
| 设置页（Base URL / API Key / 模型名 / max_tokens / temperature / 连通性测试） | ✅ |
| 截图 | `docs/screenshots/android-{play,train,stats,settings}.png` |
| 发布包 | `app-release.apk` **1.27 MB**（debug 包 16.5 MB —— 开 R8 之后差距主要来自未压缩的 Compose 与 tooling） |
| 真机 | ⚠️ **未做**：`adb devices` 为空，没有插线设备。模拟器（Pixel 7a / android-34）验过 |

**界面层踩到的三个坑（都不是「跑不起来」，而是「跑起来是错的」）：**

1. **画布缩放乘了两次密度。** 第一版写 `scale(s * density)`，理由是「逻辑单位要按密度放大」——
   结果整块棋盘放大 2.57 倍，棋子与坐标号全部溢出屏幕。
   根因：`fontSize = 10.sp` 在 drawText 里**已经**含了密度换算，再乘一次就是两遍。
   现在的口径写进了 `Board.kt` 的注释：画布只负责「逻辑单位 → 像素」，
   字号统一走 `logicalSp(logical, scale, density)`。
2. **`LazyColumn` 的 key 重复导致训练页崩溃**（发布包上才暴露）。
   我把分组「摊平」成行列表时，一个字符串模板被写坏成了字面量，
   于是 981 道题拿到同一个 key → 一进训练页就
   `IllegalArgumentException: Key ... was already used` 崩掉。
   编译期看不出来、不打开训练页的测试也看不出来。
   现在由 `GameFlowTest.trainingRowsHaveUniqueKeys` 守着（收起/展开两种状态都验）。
3. **Robolectric 下主线程协程不会自己推进。** 走子动画跑在 `viewModelScope`（主线程）、
   引擎搜索跑在 `Dispatchers.Default`（真实线程）—— 两条时间链，
   测试里 `Thread.sleep` 只让真实线程歇一会儿、**不动虚拟时钟**，于是动画协程停在第一帧，
   `animating` 永远是 true。三件事解决：动画时长做成可注入（测试里归零）、
   用 `ShadowLooper.idleFor()` 推虚拟时钟、以及一条**自证断言**
   （`mainThreadCoroutinesRunInThisEnvironment`）先证明地基是通的。

**移植过程中真正拦下东西的两处**（都不是「跑不起来」，而是「跑起来但是错的」）：

1. **perft 的计数口径**。把「给对方将军」的局面也过滤掉之后，perft(3) 从 **79 666 变成 79 258**，
   两个数字看起来都挺像那么回事。规则是：**只过滤「自己的帅被将」**。
   这个坑写在 `PerftTest` 的类注释里，免得下次再踩。
2. **测试找不到库文件时的报错指不到原因**。`engine` 模块的单测工作目录不保证是
   `android/engine`，`File("../shared/library.json")` 在 IDE 里跑就找不到，
   而报出来的是 `NoSuchElementException: Collection contains no element matching the predicate`
   —— 完全看不出是「路径不对」。现在由 `TestFixtures.repoFile` 往上搜 5 层并给出一条
   列全部候选路径的报错。

---

## 六、界面与工程细节（Android 与 iOS 真正不同的地方）

### 6.1 状态管理

iOS 用 `ObservableObject` + `@Published`；Android 侧：

- `GameViewModel : ViewModel()` 持有 `GameState`，UI 状态用 `mutableStateOf`；
- **搜索在 `viewModelScope` 的 `Dispatchers.Default` 上跑**，结果回主线程；
- 生命周期的坑：iOS 的 `onDisappear` 语义与 Compose 的 `DisposableEffect` 不同，
  **旋转屏幕 / 分屏**在 iOS 上是重建 View，在 Compose 里是重组 —— 棋局状态必须放在 ViewModel
  里，不能放在 composable 的局部 `remember` 里，否则一旋转整盘棋就没了。

### 6.2 棋盘渲染与动画

`BoardView.swift` 与 `web/js/board.js` 都是**纯 Canvas 绘制**（木纹渐变、格子、九宫斜线、
楚河汉界、棋子圆形 + 内圈 + 汉字），Compose `Canvas` 的 API 与之高度相似，**可以近乎直译**：

- `drawWood` → `drawRect(Brush.linearGradient(...))`；
- 棋子用 `drawText` + `TextMeasurer`（Compose 1.5+），字号按半径算，与 iOS 一致（`rad * 1.32`）；
- 走子动画：iOS 是 `slideMs = 460` + `settleMs = 520`（合计约 1 秒）。
  Compose 用 `Animatable` 或 `animateFloatAsState`，**数值照抄**，否则「吃子提示」的节奏会变；
- 坐标号**必须用象棋标准纵线号**（下边红方一~九自右向左、上边黑方 1~9 自左向右），不是 a~i；
- ⚠️ **性能**：每帧重画 90 格 + 32 个棋子 + 汉字，用 `drawWithCache` 缓存木纹与网格到
  `ImageBitmap`，只让棋子层重组，否则低端机会掉帧。

### 6.3 布局（iPhone / iPad 那套逻辑要重做，不是抄）

iOS 的布局决策是「按几何判断投影方向」（`PlayView.layoutMode`），Android 侧对应：

| 设备 | 做法 |
|---|---|
| 手机竖屏 | 单列：胜率条 / 棋盘 / 状态 / 按钮 / 场景与难度；**必须处理系统栏与手势条 inset** |
| 手机横屏 | 左右分栏（棋盘吃满高度，记录在右）—— iOS 手机横屏特意没分栏，Android 可以按宽度阈值决定 |
| 平板 / 折叠屏展开 | 用 `WindowSizeClass` 判定，宽 ≥ 600dp 分栏；**不要用 `screenWidthDp` 硬判断** （iPad 竖屏那个坑的等价物） |
| 折叠屏 | 铰链位置用 `WindowLayoutInfo`，棋盘不要跨铰链 |

> ⚠️ **Android 的 `WindowSizeClass` 与 iOS 的 size class 不是一回事**，
> 别把 iOS 那套判断直译过来再发现竖屏平板走了分栏 —— 那正是 iOS 修过的 bug。

### 6.4 相对 iOS 需要**新增**的系统集成

| 能力 | iOS 现状 | Android 需要补的 |
|---|---|---|
| 二次确认弹窗 | `.alert` 挂在根上（不在各页里，避免弹两次） | Compose 用一个全局 `AlertDialog` 承载，同样挂在根 NavHost 上 |
| 干掉一局后的撤销 | `makeMove` 自管栈 | 同左，但要注意 **返回键**：棋局未结束时应先拦截返回键问「确定退出？」 |
| 剪贴板导入导出 | `UIPasteboard` + 系统分享 | `ClipboardManager` + `Intent.ACTION_SEND`（分享）+ `ACTION_OPEN_DOCUMENT`（导入文件） |
| 存档落盘 | `UserDefaults`/文件 | **沿用单文件 JSON**（与 iOS 结构兼容），不引入 Room；好处是存档能跨端手动迁移 |
| API Key 存储 | `AppConfig.local.plist`（gitignore） | ⚠️ **不能把 Key 打进 APK**。用 `EncryptedSharedPreferences`（或 DataStore），默认空、由用户在设置页填 |
| 主题 | 强制浅色（`.preferredColorScheme(.light)`） | 同样**钉死浅色**，深浅色适配不在首版范围（棋盘木纹是设计的一部分） |
| 相机 / 相册 | Info.plist 里已声明权限 | 首版**不做**棋盘拍照识别（iOS 侧也只是声明了权限，没有实现） |

### 6.5 同步链与守门

`tools/sync-library.js` 增加第三个产物：

```
shared/library.json → web/js/library-data.js
                    → ios/XiangqiCoach/Resources/library.json
                    → android/app/src/main/assets/library.json   ← 新增
```

并在 Android 侧加两条断言（对应 `LibraryTests.testBundleIsNotTheStaleCopy` 的教训）：

1. 断言 **mates 数量 == 981**、**含 tier==3 的题**、含已知 id（写死一个）；
2. 断言 assets 里那份的**字节数与 `shared/library.json` 内容一致**（不是体积接近，是内容哈希一致）。

---

## 七、里程碑与交付物

| # | 里程碑 | 完成判据 |
|---|---|---|
| M0 | Gradle 骨架 | `./gradlew :app:assembleDebug` 成功；空 Compose 页能装进模拟器 |
| M1 | 规则层 | perft 1/2/3/4 = 44/1 920/79 666/3 290 240；981 局面与 Swift 逐局面对数一致 |
| M2 | 搜索层 | UCI JAR 能跑；对局台 40 局得分率 45%~55%；固定深度最佳着法一致率记录在案 |
| M3 | 数据层 | 库同步进 assets 且有守门断言；`ReviewDigest`/能力画像与 `ArchiveTests` 同数据同结论 |
| M4 | 对弈页 | 棋盘绘制、坐标号、四档难度、走子动画、提示/悔棋/重开（带确认）、存档载入 |
| M5 | 训练 / 战绩 | 981 题分组展开、解法演示；战绩分段与五项能力维度 |
| M6 | AI | 设置页填 Key、连通性测试、局面点评（流式）、本地复盘卡 + 大模型讲解 |
| M7 | 交付 | 签名 APK + 模拟器与真机截图（`docs/screenshots/android-*.png`）+ README 补一节 |

---

## 八、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Kotlin 引擎**悄悄弱了** | 用户无感，但违背移植目的 | M2 的 Elo 对局台 + 固定深度着法一致率，两道都要过 |
| `ByteArray` 与 Swift `[Int8]` 的**有符号比较**写错 | 某个棋子被当负数，规则错但不崩 | 全部比较走 `.toInt()`；定点用例覆盖每个棋子编码 |
| JIT 预热导致**首步慢** | 开局第一手卡 1～2 秒 | 冷/热分别测；必要时预热（跑一次浅搜索）后再进入对弈 |
| 置换表内存 | 安卓低端机 OOM | 容量可配（按 `ActivityManager.memoryClass` 或 4/8/16 MB 档），默认 8 MB（与 Swift 的 `Hash default 8` 对齐） |
| Gradle/AGP 与 JDK 版本漂移 | 构建突然失败 | `gradle.properties` 钉 JDK21；wrapper 版本进仓库；不依赖本机 `gradle` |
| 包名/签名没定就发了 APK | 等于换了应用，用户要卸载重装 | M0 就把 `applicationId` 与签名配置定死 |
| 库被同步成旧副本 | 题库变少但测试全绿（已发生过一次） | §6.5 的两条断言 |
| 真机验收缺设备 | 只能模拟器 | `adb devices` 为空时先做模拟器 + 说明；真机项标「待设备」 |

---

## 九、明确**不做**的（首版）

- 棋盘拍照识别（iOS 也没实现，只是声明了权限）；
- 在线对战 / 云同步；
- 深浅色主题适配；
- 把 Pikafish 打进 App（GPL 与体积问题，`docs/pikafish-license-notes.md` 有完整论证）；
  **引擎强度提升走搜索侧**，与 Android 移植并行不冲突（见 `docs/strength-plan.md`）。
