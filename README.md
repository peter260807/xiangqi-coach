# 象棋教练 · Xiangqi Coach

一个面向**初学者**的中国象棋学习应用：本地引擎陪练、杀法残局训练、胜率与提示、
接入大模型做局面点评与复盘，并且会**根据你的对局数据总结强弱项、给出针对性训练**。

同一套引擎逻辑有两个前端：

| 前端 | 说明 |
|---|---|
| **iOS 原生**（SwiftUI） | iPhone + iPad，离线可用，界面动画完整 |
| **网页版**（纯前端） | 零依赖，手机浏览器打开后可「添加到主屏幕」当 App 用 |

---

## 功能

**对弈**
- 本地 Alpha-Beta 引擎，五档难度（入门 / 初级 / 中级 / 高级 / 大师）
- 入门档会**故意留破绽**，新手不至于被碾压
- 走子带动画：棋子滑到位约 0.46 秒，再停 0.52 秒，**合计约 1 秒**，
  期间明确提示「吃掉了什么子」「是否将军」「是否将死」
- 实时胜率条 + 下一步提示（棋盘上直接画出箭头）
- 悔棋、存档、载入、按棋谱回放

**训练**
- **11 个杀法练习**：马后炮、重炮、双车错、卧槽马、车兵闷宫、双马护车、
  兵坐龙庭、车炮镇宫、双车夹攻、车砍中士、双马送兵
- **8 条标准开局**：中炮对屏风马、反宫马、仙人指路、飞相局、起马局、过宫炮、单提马、五七炮
- **3 个实用残局**：单车例胜单士、车马例胜双士、马兵例胜单士

**打谱演示**
- 内置《橘中秘》名局 **「弃马十三着」**（25 着，第十三回合以重炮成杀），
  可整段自动播放，关键手旁带解说（弃马、弃车砍士、重炮成杀）
- 11 个杀法练习都附有**由引擎离线算出的最短杀法路线** ——
  红黑双方都走引擎首选，也就是「最顽强防守下仍然成立的杀法」，
  一键「看解法」逐步演示
- 8 条开局谱同样可以整段演示
- 演示期间不接受落子、也不叫电脑走棋，纯看谱

**棋谱导入导出**
- 导出三种形式：局面 FEN、中文棋谱、着法坐标串；可复制，也可走系统分享
- 导入时三种都能认，并且会先校验局面是否可用
  （必须恰好一个帅一个将、都在九宫内、不照面）

**AI 教练**（需自备 API Key）
- 局面点评：把棋盘图、引擎评估、候选着法一起喂给模型，流式输出讲解
- 整局复盘：带上棋谱和每手评分变化，输出开局 / 中局 / 总结三段报告
- **混合对弈**：不让模型直接下棋（LLM 下象棋又弱又会走非法棋），而是
  **引擎算出合法候选，模型从中挑一个并说明理由**，模型给的着法还会用引擎再验一遍，
  不合法就自动回退到引擎首选

**战绩**
- 每走一手都用引擎算一遍「最好能走成什么样」与「你实际走成什么样」，
  分差即失分，按开局 / 中局 / 残局分段汇总
- 五个能力维度：开局稳健、中局战术、残局收官、攻杀把握、防守意识
- 按最弱的维度**自动推荐训练内容**，点击直接进入对应练习

---

## 快速开始

### 网页版

```bash
cd web
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

> 注意：**不要直接双击 index.html**。走 `file://` 时浏览器会把脚本异常统一报成
> 无信息的 `Script error.`，出问题很难查。用本地 HTTP 服务。

### iOS 版

需要 Xcode 与 [XcodeGen](https://github.com/yonaskolb/XcodeGen)：

```bash
brew install xcodegen
cd ios
xcodegen generate          # 生成 XiangqiCoach.xcodeproj
open XiangqiCoach.xcodeproj
```

命令行编译到模拟器：

```bash
cd ios
xcodebuild -project XiangqiCoach.xcodeproj -scheme XiangqiCoach \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO build
```

> 工程文件由 `project.yml` 生成，**不纳入版本管理**，这样多人协作不会因为
> `project.pbxproj` 冲突。

**iPhone 与 iPad 都支持**，但两者的布局取向不同：

| 设备 | 布局 |
|---|---|
| iPhone | 竖屏为主（也允许横屏）。单列：棋盘在上，操作与记录在下 |
| **iPad 横屏** | 左右分栏：棋盘吃满左侧可用高度，操作与棋谱记录在右栏 |
| **iPad 竖屏** | **棋盘全屏**：取消分栏，棋盘按「宽、高里更紧的那一维」放大到极限；顶部只留胜率条 + 一条状态，底部一排按钮（提示 / 悔棋 / 重开 / 点评 / 更多），场景、难度、对弈模式、棋谱都收进「更多」浮层 |
| 训练 / 战绩页 | 列表按可用宽度自动分列，手机一列、iPad 三列 |

**为什么竖屏反而更好用**：iPad 竖屏的可用宽度就有约 1000pt，而横屏分栏时棋盘还要
让位给右栏，只剩约 620pt。所以竖屏改成单栏、棋盘铺满之后，**棋盘比横屏还大一截**
（宽度 620 → 约 990pt，面积约 2.6 倍）。

**判断横竖屏不能看尺寸类**：iPad 横屏、竖屏的 `horizontalSizeClass` / `verticalSizeClass`
**都是 regular/regular**，用尺寸类区分不开 —— 之前 iPad 竖屏因此也走了左右分栏，
棋盘被挤在左边。现在改成看几何（`geo.size.height > geo.size.width`），见
`PlayView.layoutMode(portrait:)`。

横屏下也能手动进全屏：右栏最上面那个「棋盘全屏」按钮；全屏时左上角会出现退出按钮。

> 模拟器没法用命令旋转屏幕，所以留了 `SIMCTL_CHILD_START_LAYOUT=focus|wide|compact`
> 这个环境变量口子，可以让自动化截图分别截到三套布局。

棋盘尺寸不是写死的：横屏先按「屏幕高度 − 胜率条 − 状态条」反推出棋盘能有多大，
再让右栏吃掉剩下的**全部**宽度 —— 这样两栏都不留空白，换任何尺寸的 iPad 都不会错位。

iPhone 侧则用 `horizontalSizeClass == .regular && verticalSizeClass == .regular`
判断要不要分栏。只看宽度是不够的：**iPhone 横屏的宽度同样算 `.regular`，但高度很紧**，
那时候竖排反而更好用。

#### 应用图标

`ios/XiangqiCoach/Resources/Assets.xcassets/AppIcon.appiconset/` 里的
`AppIcon-1024.png` 是脚本生成的（红底 + 淡棋盘网格 + 木质「帅」棋子），
同一份设计也导出到了网页侧：`web/icon-192.png`、`web/apple-touch-icon.png`、
`web/favicon-32.png`。

**注意**：`Contents.json` 里没有 `filename` 字段时，图标资源是空的 —— 编译不报错，
桌面上却是白图标。验证有没有真的编进包：

```bash
xcrun assetutil --info "…/象棋教练.app/Assets.car" | grep -A2 "Icon Image"
# 应能看到 RenditionName : AppIcon-1024.png
```

#### 装到真机（iPad / iPhone）

模拟器不用签名，真机要。仓库里带了一个打包脚本：

```bash
./ios/scripts/make-ipa.sh --devices               # 列设备 + 硬件 UDID + 开发者模式状态
./ios/scripts/make-ipa.sh --list-devices          # 列本机描述文件及其授权设备
./ios/scripts/make-ipa.sh --udid <设备UDID>        # 打 ad hoc 包，并校验该设备已授权
./ios/scripts/make-ipa.sh --development           # 开发签名（不需要 ad hoc 描述文件）
./ios/scripts/make-ipa.sh --udid <U> --install <U>  # 打完直接装到连着的数据线设备
```

产物落在 `.workbuddy/outputs/`（该目录不进仓库）。

**走数据线安装有两道互相独立的关卡，都得过：**

| 关卡 | 不过时的报错 | 怎么过 |
|---|---|---|
| 开发者模式 | `Developer Mode is disabled` | 设置 → 隐私与安全性 → 开发者模式 → 打开并重启 |
| 描述文件的设备名单 | `0xe8008012 / cannot be installed on this device` | 把 UDID 加进描述文件（见下） |

> 第一道**与签名方式无关**：实测 ad-hoc 签名的包走数据线同样被它拦住。
> 「ad hoc 免开发者模式」只对 OTA / Apple Configurator 那类安装方式成立。

**ad hoc 描述文件是唯一没法脚本化的部分** —— 它需要开发者后台权限：

1. https://developer.apple.com/account/resources/devices/list → `+` → 粘贴设备 UDID
2. https://developer.apple.com/account/resources/profiles/list → `+` → **Ad Hoc**
   → **App ID 选通配**（形如 `TEAMID.*`，本机叫 `XC Wildcard`）
   → 选 Apple Distribution 证书 → 勾上设备 → `Generate` → 下载
3. **双击安装**下载的 `.mobileprovision` 即可，不用再改任何配置

第 2 步**强烈建议选通配 App ID**：一份描述文件覆盖团队下所有 App，
以后新增 App 不用再走一遍后台流程。实测可用，且是分发签名（`get-task-allow=false`），
装的时候不需要开发者模式。

**为什么不用开发签名图省事**：iOS 16 起，开发签名的 App 要求设备先打开开发者模式并重启；
ad hoc 没有这个要求。自己临时试可以 `--development`，要交给别人装就走 ad hoc。

**拿 UDID**：直接跑 `--devices`，它会把硬件 UDID 列出来（**不是** devicectl 表格里那个
coredevice UUID，那个填到后台无效）。也可以设备连上后在「访达」左侧选中它，
点设备名下方那行信息循环切换，切到「序列号」时再点一下会变成 UDID。

打完之后脚本会**校验目标 UDID 在不在描述文件的授权名单里**，不在就直接报错。
这一步不能省：设备不在名单里时，iPad 上只会弹一句含糊的「无法安装此 App」，
完全看不出是签名名单的问题，能耗掉半天。

> 脚本会**自动识别**可用的 ad-hoc 描述文件（分发签名 + 带设备名单 + App 匹配或团队通配），
> 并在导出时现场生成对应的签名配置 —— 描述文件装在哪个目录都能找到
> （`~/Library/MobileDevice/` 或 `~/Library/Developer/Xcode/UserData/`，两处都扫）。

---

## 配置大模型

程序默认对接 DeepSeek，但**任何兼容 OpenAI `/chat/completions` 格式的接口都能用**。

**推荐做法**：直接在 App 或网页的「设置」里填一次，配置会存在本机。

**预填做法**（可选）：

```bash
# 网页版
cp web/js/config.example.js web/js/config.js
# 然后编辑 web/js/config.js 填入 apiKey

# iOS 版
cp ios/XiangqiCoach/Resources/AppConfig.plist \
   ios/XiangqiCoach/Resources/AppConfig.local.plist
# 然后编辑 AppConfig.local.plist 填入 apiKey
```

这两个带 Key 的文件都已在 `.gitignore` 中，不会被提交。

### ⚠️ 关于 token 预算

DeepSeek 的 `deepseek-flash` / `deepseek-v4-pro` 都是**推理模型**，
会先输出一长段思维链，而**思维链计入 `max_tokens`**。给少了正文就是空的，
而 HTTP 状态码依然是 200，没有任何报错。实测：

| 任务 | 思维链消耗 | 现在的预算 |
|---|---|---|
| 短问答（连通性测试） | ~43 | 1500（单独指定，图快） |
| 局面点评 | 770~6800 | 跟随设置，默认 **50000** |
| 整局复盘 | 4855~5284 | 跟随设置，默认 **50000** |
| 混合对弈里的选着法 | 5000+ | 跟随设置，默认 **50000** |

实测 `max_tokens=5000` 做复盘时，正文 179 字**中途被截断**（`finish_reason=length`）。
客户端有三道保险：正文为空但有思维链则自动加倍重试、检测到截断会明确提示、
流式失败自动退回一次性请求。

**预算给足不会多花钱**：`max_tokens` 只是上限，按**实际**产出计费。
所以默认值直接给到 5 万（接口实测连 20 万都收），需要时可在「设置 → 模型参数」里改。

> 曾经有个隐蔽的瓶颈：代码里写死 `min(base * 2, 16000)`，
> **设置里调多大都会被压回 16000**。这个硬顶已经去掉，只留一个远高于各家上限的
> 天花板；万一对端嫌 `max_tokens` 太大（各家上限 8K / 16K / 64K 都有），
> 会自动退到 8192 重试一次，而不是让整个功能报错。

---

## 测试

```bash
node tools/test-engine.js     # 规则 + 棋谱库全量校验（不需要网络）
node tools/test-ai.js         # 大模型联通性（会真实调用接口）
node tools/sync-library.js    # 改完棋谱库后同步到网页端
node tools/gen-lines.js       # 用引擎重算各杀局的解法路线
node tools/add-classics.js    # 录入并校验古谱名局
```

iOS 端另有一套 XCTest 单元测试（57 个用例）：

```bash
cd ios
xcodebuild test -project XiangqiCoach.xcodeproj -scheme XiangqiCoach \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```

| 测试文件 | 覆盖内容 |
|---|---|
| `RulesTests` | 走子规则逐项定点用例（含不该出现的着法）、开局 44 着基准、白脸将、困毙、走子/撤销还原 |
| `CheckCrossValidationTests` | **快速版将军判定 vs 参考实现**，随机对局里逐局面比对两版结论 |
| `NotationTests` | 中文记谱的红黑方向与前后区分，以及「记谱 → 反查」往返验证 |
| `LibraryTests` | 棋谱库每条都过引擎：可走、非退化、确实成杀；名局逐手合法并以将死收尾 |
| `SearchTests` | 搜索给出的着法必须合法、评估满足红黑镜像反对称、胜率映射 |
| `ArchiveTests` | 能力画像与训练推荐的算法，用构造数据把每一档钉住 |

其中最值得留着的是**将军判定的交叉验证**。`Rules.inCheck` 为了性能直接从将帅所在格
反查攻击者，`Rules.inCheckByGeneration` 则老老实实生成对方全部着法再比对。
快版一旦漏掉某种攻击方式（比如忘了「过河兵才能横吃」），搜索就会走出非法着法，
而且很难从对局表现上看出来 —— 所以用慢版一直盯着它。实测每次跑比对 1400 次以上。

`test-engine.js` 覆盖的内容：

- 走子规则：马腿、象眼、炮翻山、过河兵、九宫限制
- **开局双方合法着法数必须等于 44**（中国象棋公认值，用来校验规则实现是否正确）
- 白脸将（将帅照面）必须判为非法
- AI 自战 60 步不产生非法着法
- 棋谱库每一条都必须满足：红方有可行着法、**黑方也有可行着法**、黑方开局未被将军、
  引擎在 6 层内确认成杀

最后一条特别重要 —— 如果黑方开局就已经无子可走，那是个退化局面，
随便走一步就赢，不能拿来当练习。

---

## 项目结构

```
.
├── shared/
│   └── library.json          棋谱库唯一数据源（两端共用）
├── web/                      网页版
│   ├── index.html
│   ├── css/app.css
│   └── js/
│       ├── engine.js         规则 + 搜索 + 中文记谱
│       ├── library-data.js   由 tools/sync-library.js 生成，勿手改
│       ├── library.js        棋谱库访问层 + 校验
│       ├── ai.js             大模型客户端（流式 / 可配置）
│       ├── storage.js        存档 + 强弱项分析 + 训练推荐
│       ├── board.js          棋盘渲染 + 走子动画
│       ├── app.js            主控制器
│       └── config.js         本地配置（gitignore）
├── ios/                      iOS 版
│   ├── project.yml           XcodeGen 定义
│   └── XiangqiCoach/
│       ├── Engine/           规则 / 搜索 / 记谱
│       ├── AI/               配置 / 客户端 / 提示词
│       ├── Models/           棋谱库 / 存档 / 对局状态
│       ├── Views/            棋盘 / 对弈 / 训练 / 战绩 / 设置
│       └── Resources/
├── tools/                    测试、同步与数据脚本
│   ├── test-engine.js        规则与棋谱库校验
│   ├── test-ai.js            大模型联通性
│   ├── sync-library.js       shared/library.json → web/js/library-data.js
│   ├── gen-lines.js          用引擎离线算各杀局的解法路线
│   └── add-classics.js       录入并校验古谱名局
```

---

## 引擎实现要点

- **规则层**：完整实现马腿、象眼、塞象眼、炮翻山、过河兵、九宫限制、
  以及「白脸将」（将帅照面时走成这种局面属于非法）
- **搜索**：Zobrist 哈希 + 置换表、静态搜索（只搜吃子，消除水平线效应）、
  杀手着法 + 历史启发、PVS 空窗口、迭代加深 + 时间管理
- **评估**：子力价值 + 位置价值表（子、马、炮、车分别一套）
- **将军判定**：从将/帅所在格**直接反查攻击者**，而不是生成对方全部着法再比对 ——
  这个函数在搜索里会被调用几十万次，实测快一个数量级

性能（Mac / 中局局面，单线程）：

| 深度 | 耗时 | 时间受限 |
|---|---|---|
| 3 层 | 19ms | 600ms 可达 7 层 |
| 5 层 | 122ms | 2.2s 可达 6~7 层 |
| 6 层 | 417ms | 6s 可达 8 层 |
| 7 层 | 2.6s | |

---

## 与 Pikafish 的实测差距

"差距有多大"这种事靠嘴说没用，所以写了个裁判让它们真下：
`tools/pk-match.js` 以子进程方式拉起 Pikafish（走 UCI 协议），红方交给它、黑方交给本项目引擎，
每一手都用本项目自己的规则引擎复验合法性。

```bash
# 1. 编译 Pikafish（本机 Apple Silicon 约 20 秒）
git clone --depth 1 https://github.com/official-pikafish/Pikafish.git
cd Pikafish/src && make -j build ARCH=apple-silicon

# 2. 取 NNUE 权重 —— 它在 .gitignore 里，要从 GitHub Release 的 7z 包里拿
gh release download --repo official-pikafish/Pikafish --pattern "*.7z"

# 3. 开打
node tools/pk-match.js --pika /path/to/pikafish --nnue /path/to/pikafish.nnue \
                       --games 6 --pika-ms 100 --my-ms 1000
```

实测结果（Mac / Apple Silicon / 双方单线程）：

| 组 | Pikafish 拿到的资源 | 本项目引擎 | 结果 |
|---|---|---|---|
| A | 每步 100ms | 每步 1000ms（给足 10 倍时间） | **0 胜 6 负**，全部被将死，平均 35 手 |
| B | 每步 **10ms** | 每步 1000ms | **0 胜 4 负**，29~41 手 |
| C | **固定 2 层** | 每步 1000ms（实际搜到 5.5~6 层） | **0 胜 3 负 1 和**，105 手 |

**C 组最说明问题。** 把 Pikafish 压到只搜 2 层，让它比本项目引擎少搜近 3 倍深度，
它仍然一局没输。也就是说差距**不在搜索深度，而在评估函数** ——
本项目用的是手写的子力价值 + 位置价值表，Pikafish 用的是 NNUE 神经网络。

手数的变化也印证了这一点：100ms 时 35 手解决，压到 2 层后要 105 手。
限制确实削弱了它，但削弱的只是"赢得快不快"，不是"赢不赢"。

顺带一提，这个裁判本身也是给规则层做的一次实弹检验：
6 局共 200 多手，本项目引擎没有走出过一手非法着法。

### 下一步怎么走：完整评估在 `docs/engine-strategy.md`

既然差距在评估函数，自然的想法就是"训一个自己的神经网络"。但这条路和
"直接把 Pikafish 接进来"各有各的坎，我把两个方案都实测评估了一遍，结论写在
**[`docs/engine-strategy.md`](docs/engine-strategy.md)**，关键数据：

- **数据生成不是瓶颈**（但要用对限流方式）：`go depth 8` 单进程 468 局面/秒，
  8 核一周约 **22 亿局面**。用 `go movetime` 测会低估 20 倍以上 —— 它会让引擎把时间用满
- **2080Ti 对生成数据没有帮助**：Pikafish 是纯 CPU 引擎，GPU 只在训练网络时有
- **官方训练工具链没有公开可用版本**：`pikafish-nnue-pytorch` 与 `tools` 分支均不存在，
  只剩国际象棋版可改造 —— 这是最大的卡点，不是算力
- **许可有两道门**：GPL-3.0 的义务只在分发时触发（服务器方案成立，因为 Pikafish
  **不是** AGPL）；但 `pikafish.nnue` 权重另有独立许可，蒸馏产物可能受其约束
- **引擎服务化已实测**：协议开销仅 0.4%，同区域服务器 30ms RTT 下单步体感
  230ms（用户无感），边际成本可用自有机器压到零

复现脚本：`tools/data-quality-probe.js`（数据产出速率）、
`tools/engine-latency-probe.js`（网络延迟影响）、`tools/engine-server-probe.js`（协议开销）。

---

## 已知限制

- 引擎是手写的 Alpha-Beta 搜索，约业余 5~8 级水平。差距的量级可以看上面那组实测：
  **Pikafish 只搜 2 层也不输给搜到 5.5 层的本引擎** —— 瓶颈在评估函数，不在搜索深度
- 棋谱库是**精选小库**：1 局古谱名局 + 11 个杀法 + 8 条开局 + 3 个实用残局。
  没有几十万局那种在线棋谱库，也没有云库开局
- **没有拍照识局**。视觉模型实测可用（能读出棋子与坐标，名局的棋盘图也认得下来），
  但实测里会把棋子读偏一格 —— 所以真要做这个功能，必须同时配一个能手工修正的棋盘编辑器，
  否则用户拿到的是一个「看起来对、其实是错的」局面
- 杀法练习是**排局**（编排局面），部分子力位置在真实对局中走不到，
  这是杀法训练的常规做法，但和实战残局有区别
- 强弱项分析基于引擎评分，深度为 4 层，会有噪声

## 许可

MIT，见 [LICENSE](LICENSE)。
