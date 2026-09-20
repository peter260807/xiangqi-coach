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

| 任务 | 思维链消耗 | 建议 max_tokens |
|---|---|---|
| 短问答 | ~43 | 1500 |
| 局面点评 | ~770 | **4000** |
| 整局复盘 | 4855~5284 | **8000** |

实测 `max_tokens=5000` 做复盘时，正文 179 字**中途被截断**（`finish_reason=length`）。
客户端已内置三道保险：正文为空但有思维链则自动加倍重试、检测到截断会明确提示、
流式失败自动退回一次性请求。

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

## 已知限制

- 引擎是手写的 Alpha-Beta 搜索，约业余 5~8 级水平；**远不及皮卡鱼（Pikafish）这类职业级引擎**
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
