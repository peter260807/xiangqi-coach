# 公开渠道能拿到什么棋谱 / 题库（2026-09-24 核实）

> 结论先行：**能丰富，但真正"拿来就能用"的只是其中一小部分。**
> 大量古谱排局是**很深的杀**（十几到几十步），按我们的算力代价不成比例；
> 而短杀（一步到四步）那部分便宜、可批量、教学价值也最高 —— 应该只取那一层。

本文件是「看下公开渠道能否丰富名局/杀法」这个问题的落地记录，
配套工具：`tools/import-puzzles.js`（下载 / 审计 / 求解 / 入册）、
`tools/test-import.js`（自证测试）、`tools/lib/position-check.js`（局面合法性校验）。

---

## 一、逐个来源的评估

| 来源 | 内容量 | 格式 | 许可 | 结论 |
|---|---|---|---|---|
| **[xiangqi-pwa-offline](https://github.com/dffge552/xiangqi-pwa-offline)**（棋弈江湖） | 1884 个局面：基本/进阶杀法、梦入神机、适情雅趣、江湖残局、极难残局 | JSON（标准 FEN + 题名） | **MIT**（仓库 LICENSE 原文核对过） | ✅ **主用** |
| [zizai/chinese-chess-PGN](https://gitee.com/zizai/chinese-chess-PGN)（Gitee） | 宣称 141,556 盘对局（世界象棋联合会 41,743 + 东萍象棋 99,813） | ICCS | 未声明（聚合品） | ❌ **判死**（见 §六，仓库里其实没有数据） |
| [djac/chinese-chess](https://gitee.com/djac/chinese-chess)（Gitee） | 开局库：`client/res/openLib.txt` 48 KB + `openLibAll.pu` / `gambit.all.js` 各 582 KB | 走法串（`h2e2 h7e7 …`，6 手开头） | **Apache-2.0** | 🔲 **可用但未取用**：格式能直接喂我们的解析层，是候选的**开局谱**补充（当前开局库只有 8 条手写谱） |
| [摩搭 xiangqi_train_data](https://modelscope.cn/datasets/nowcan/xiangqi_train_data) | 约 2000 万盘（SQLite + PGN） | PGN | 未声明 | ⚠️ 训练用数据，不是题目；权属不明 |
| [lichess 开放库](https://database.lichess.org/) | 数十亿盘 | PGN/CSV/JSONL | **CC0**（最干净） | ❌ 官网变体列表里**没有中国象棋**（只有 Antichess / Atomic / Chess960 等）—— 亲测翻过页面 |
| 古谱原典（橘中秘、梅花谱、适情雅趣、百局象棋谱、渊深海阔…） | — | 纸质/影印 | **公版**（明/清） | ✅ 着法是事实、不受版权保护；但**现代整理版的注释受版权保护**，注释要自己写 |
| [awesome-xiangqi](https://github.com/lucaferranti/awesome-xiangqi) | 索引（书单、引擎、工具、YouTube） | — | 索引本身 | ✅ **找来源的入口**，本表的几个主要候选都是从这里找到的 |

### 关于 MIT 那个仓库的一条保留意见

它的 README 的 Acknowledgments 里写着题库部分来自「**从寬象棋 YouTube 频道**」。
仓库自己声明 MIT，但**上游来源是否同意以 MIT 再分发，我无法核实**。
→ 内部自用没问题；**如果要对外经营**，建议自己去确认一次这部分的权属。
（古谱那两份——《梦入神机》《适情雅趣》—— 原典是明代公版，不在此列。）

---

## 二、能转成我们的格式吗？—— 审计结果

`node tools/import-puzzles.js audit`

| 题库 | 总数 | FEN 坏 | 非法 | 重复 | 与现有库重 | 红先 | 可用 |
|---|---|---|---|---|---|---|---|
| 基本杀法 | 66 | 0 | 1 | 11 | 0 | 54 | 54 |
| 进阶杀法 | 574 | 0 | 0 | 0 | 0 | 574 | 574 |
| 梦入神机 | 151 | 0 | 0 | 3 | 0 | 148 | 148 |
| 适情雅趣 | 544 | 0 | 0 | 10 | 0 | 534 | 534 |
| 江湖残局 | 366 | 2 | 6 | 8 | 0 | 350 | 350 |
| 极难残局 | 183 | 0 | 1 | 8 | 0 | 174 | 174 |
| **合计** | **1884** | 2 | 8 | 40 | 0 | **1834** | **1834** |

**97.3% 合法。** 被剔掉的三类，每一个都有具体原因：

- **FEN 坏（2 条）**：源文件里就是坏的，例如
  `339/9/4k4/...`（一行展开后 15 格）、`302ck5/4P4/...`（12 格）。
- **非法（8 条）**：真实存在的错局面 ——
  黑卒在自己底线、红兵在第 9 行、**象不在象位**（如 `(7,3)`，红象根本走不到那里）。
  这类局面会让 Pikafish **直接退出进程**（`Unsupported position`），必须提前剔掉。
- **重复（40 条）**：按「完整棋盘串 + 走子方」去重（不用哈希）。

> ⚠️ **FEN 方言的坑**：外部用标准 FEN，空格压缩成数字（`3a5`）；
> 我们的 `parseBoard` 是逐格取字符的 —— 直接把 `3a5` 喂进去，
> 字符 `'3'` 会被当成一枚棋子，**引擎照算不误，只是算的是另一盘棋**。
> 必须过 `stdFenToInternal()`。

> ⚠️ **走子方**：标准 FEN 用 `w`/`b`。杀法练习假定**红先**，所以黑先的局面（50 条）
> 暂时不进 `mates` —— 要支持它们得先让练习模式能选边。

---

## 三、⚠️ 最要紧的一条：这些题**大部分不是"拿来就能用"的**

审计只回答"局面合不合法"。真正决定能不能当题目的，是**它到底有没有解**。
按深度分层实测（每库均匀取 30 题，`--budget 15000`）：

| 题库 | d9 | d11 | d13 | 趋势 |
|---|---|---|---|---|
| 基本杀法 | 11 (37%) | 15 (50%) | 17 (57%) | 上升 |
| 进阶杀法 | 6 (20%) | 8 (27%) | 12 (40%) | 上升 |
| 梦入神机 | 5 (17%) | 5 (17%) | 8 (27%) | 上升 |
| 适情雅趣 | 3 (10%) | 4 (13%) | 7 (23%) | **上升且远未见底** |

**读法（这条最容易被误读）：**

1. **通过率随深度持续上升，没有饱和。** 到 d13 还在涨 —— 说明没解出来的那些
   **多数不是"题目有问题"，而是"杀得很深"**。古谱排局动辄十几到几十步，是正常的。
2. 所以「可用 1834 条」这个数字**只是"局面合法"**，不等于"都能当题目"。

---

## 四、实际跑完的结果（2026-09-24）

`bash tools/solve-puzzles.sh 13 30000 6` —— 1310 个候选（杀法类 + 红先），
6 路并行，**29 分钟**跑完。求解通过的四条判据见文末。

| 题库 | 候选 | 通过 | 通过率 |
|---|---|---|---|
| 进阶杀法 | 574 | 276 | 48.1% |
| 基本杀法 | 54 | 26 | 48.1% |
| 梦入神机 | 148 | 34 | 23.0% |
| 适情雅趣 | 534 | 109 | 20.4% |
| **合计** | **1310** | **445** | **34.0%** |

**通过的手数分布**（手数取自引擎的杀棋分，不是数线路长度）：

| 手数 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| 条数 | **2** | 19 | 60 | 113 | 123 | 127 | 1 |

**未通过的 865 条，失败原因**：

| 条数 | 原因 |
|---|---|
| 740 | 深度内看不到杀棋（**已经搜到 depth 13**）→ 杀得比 6.5 手更深 |
| 124 | 深度内看不到杀棋（depth 9~12）→ 被 30 秒时间预算截断 |
| 1 | 路线不是最短 / 未走到死局 |

单条耗时：中位 **2.9 秒**、平均 7.1 秒、最长 30.0 秒（撞预算的那些）。

### 三个要记住的判断

1. **只有约三分之一能直接用。** 另外那 740 条是真的更深的杀（depth 13 = 6.5 手还看不到），
   不是坏数据。要用它们得上 d17~d21 —— 按之前标定的代价（d16 单局面曾到 **179 秒**）
   算，性价比不成立。**这也解释了为什么"古谱排局"不能整体搬进来。**
2. **通过的手数严重偏难：只有 2 道一步杀。** 这些题库的定位是"残局/排局选集"，
   不是"入门杀法训练"。想要一步杀/两步杀的入门题，**得自己出，或者从别处找**。
   —— 所以现在库里 456 道题里，最"入门"的一层仍然是手写那 11 道。
3. **深度 13 的天花板正好卡在六手杀**（6 手 = 11 步 ≤ 13 层）。第 7 手只有 1 条，
   是深度边界造成的截断，不是真实分布。
   → **这一条当天就被推翻了**：不是"只能加深度"，而是"该换引擎"。剩下 865 条体检下来
   有 **340 条连 Pikafish 也看不到杀**、525 条解得开 —— 见 §六。

### 落库

`node tools/import-puzzles.js emit` 把这 445 条写进 `shared/library.json`
（mates 11 → 456），id 形如 `x0001`，带 `set`（来源）与 `tier`（1/2/3）。
**求解结果是我们自己的产出**（见下节），所以进仓库；源题库不进（`shared/external/` 已 gitignore）。

体积：`shared/library.json` 9.6 KB → 224 KB；生成的 `web/js/library-data.js` 10.6 KB → 149 KB
（紧凑 JSON，gzip 后约 50 KB）。

之后又用 Pikafish 解了剩下那批（见 §六），**mates 456 → 981**：

| 阶段 | mates | library.json | library-data.js（紧凑） | gzip 后 |
|---|---|---|---|---|
| 手写 11 道 | 11 | 9.6 KB | 10.6 KB | — |
| + 自研引擎 d13 解出 445 | 456 | 224 KB | 149 KB | ~50 KB |
| + Pikafish 解出 525 | **981** | **618 KB** | **408 KB** | **72 KB** |

> ⚠️ **`web/js/library-data.js` 是网页首屏必须加载的文件**（不能 fetch，file:// 要能直接打开），
> 408 KB 是它的真实代价。想瘦身的话**优先砍最深的那几十道**
> （13 手以上共 62 道，线路 25~59 步，占了相当比例的体积，教学价值却最低）。

---

## 五、怎么再生一遍

```bash
node tools/import-puzzles.js fetch                      # 下载源题库到 shared/external/
node tools/import-puzzles.js audit                      # 看审计表
node tools/import-puzzles.js audit --json               # 看被剔除的完整清单

# 求解（可多进程分片；每个分片写自己的文件，互不干扰）
for i in 0 1 2 3 4 5; do
  node tools/import-puzzles.js solve --out /tmp/s$i.jsonl --shard $i/6 \
    --depth 13 --budget 30000 &
done
wait

node tools/import-puzzles.js emit --in /tmp/s0.jsonl,/tmp/s1.jsonl,/tmp/s2.jsonl,/tmp/s3.jsonl,/tmp/s4.jsonl,/tmp/s5.jsonl --dry
node tools/import-puzzles.js emit --in ...        # 去掉 --dry 才真写回
node tools/sync-library.js                        # 重新生成网页端与 iOS bundle 两份棋谱库
node tools/check-library.js                       # 入册后再校验一遍
node tools/test-import.js                         # 自证测试

# —— 剩下那批「自研引擎看不到的」改用 Pikafish 再解一轮（§六）——
bash tools/solve-puzzles-pika.sh 3000 6 64        # 每局面 3s / 6 片 / depth 上限 64
node tools/solve-mates-pika.js report --in /tmp/xq-pika/shard0.jsonl,/tmp/xq-pika/shard1.jsonl,/tmp/xq-pika/shard2.jsonl,/tmp/xq-pika/shard3.jsonl,/tmp/xq-pika/shard4.jsonl,/tmp/xq-pika/shard5.jsonl
node tools/import-puzzles.js emit --in <同上> --dry
node tools/import-puzzles.js emit --in <同上>    # 去掉 --dry
node tools/sync-library.js && node tools/check-library.js && node tools/test-import.js
```

> ⚠️ 分片也要 `--random-plies` 那种「独立性」检查：`report` 会打印
> 「分片 N 行 / 读入总数 / 通过率」，三个分片文件加起来必须等于候选池大小
> （865）。少了就是有 worker 没跑完或写同一个文件了（见 `--shardout` 那个坑）。

### 解法是谁算的？

**外部题库只给局面和名字，不给解法**（`bestMove` 字段是空的）。
这是好事：解法由**我们自己的引擎**离线算出来，是我们自己的产出，
不存在"解法是否受版权保护"的问题；而且口径与 `tools/gen-lines.js` 一致 ——
双方都走引擎首选，得到的是"最顽强防守下仍然成立的最短杀法"。

### 求解通过的四条判据（缺一条就不能给学生看）

`tools/import-puzzles.js` 的 `solveLine()` 同时要求：

1. 走子方**每一步**都看得到杀棋分（否则它只是"碰巧赢"）；
2. 对手**每一步**都是引擎首选（否则不是最顽强防守）；
3. 最终局面确实无合法着法（真成杀）；
4. **线路长度 === 2×mateIn − 1**（说明路线是最优的，没被浅深度拉长）。

手数从引擎的**杀棋分**读（`MATE - ply`），不是数线路长度 ——
数长度会被浅深度人为拉长，`mateIn` 偏大、难度分档跟着全错。

---

## 六、Gitee 深挖 + 云库裁判 + 用 Pikafish 解「自研引擎看不到的杀」（2026-09-24 下半场）

### 1. Gitee 那条线索：判死（附证据）

`zizai/chinese-chess-PGN` 宣称 14 万盘对局。逐项核过：

- `GET /repos/zizai/chinese-chess-PGN/git/trees/main?recursive=1` → **只有 1 个 blob**：`README.md`（2,498 字节）
- `license: null`、`stargazers_count: 0`、`created_at == pushed_at`（单次提交）
- README 里数据指向 **Google Drive 两个文件夹**（世界象棋联合会 41,743 盘 + 东萍象棋 99,813 盘）
- `curl https://drive.google.com/...` → **HTTP 000 / Connection reset**（本机不可达）

→ 从「量大但暂不用」升级为**判死**：不是权属问题，是**仓库里根本没有数据**。

**顺手找到真正能用的那条**：`djac/chinese-chess`（Gitee，**Apache-2.0**，53 star / 21 fork）

- `client/res/openLib.txt`（48,950 字节）—— 开局库
- `openLibAll.pu` / `gambit.all.js`（各 582,266 字节）—— 含 6 手开头的变例库
- 格式是 `h2e2 h7e7 …` 这种 **UCI 走格串**，`tools/lib/coord.js` 的 `uciToMove` 直接能解析

→ 是**开局谱**的补充候选（当前开局库只有 8 条手写谱）。**尚未取用。**

### 2. 中国象棋云库（chessdb.cn）—— 可当权威裁判

- ⚠️ 端点是 **`chessdb.php`**，**不是**国际象棋的 `cdb.php` —— 用错会一直返回 `invalid board`
- `https://www.chessdb.cn/chessdb.php?action=queryall&board=<标准FEN>&egtbmetric=dtm`
  → `move:h2h4,score:29976,depth:24,...`；`action=querypv` 给主变
- **距离单位是「步」**：`30000 − |eval|` = 步数，与我们的线路长度 `2N−1` 完全对齐
  （mateIn=1→1 步、2→3 步、4→7 步，逐条验过）
- 覆盖 DTM/DTC 残局库（8,705 个局面、9.85 TB）→ **只对子力很少的残局有效**，不能当全库裁判

用途：把 Pikafish 解出的线路逐手问云库，攻方每步 ~29976、终点 `checkmate`
→ 独立于 Pikafish 的第二意见。

### 3. 那 865 条「未通过」：改用 Pikafish 解

`node tools/solve-mates-pika.js`（分片跑：`bash tools/solve-puzzles-pika.sh`）

| | 自研引擎 d13 | Pikafish 3s |
|---|---|---|
| 同一批候选的通过率 | **34%** | **60.7%（525/865）** |

- **手数：最短 3 手、中位 9 手、最深 30 手**（分布 3:1 6:18 7:107 8:80 9:71 10:51
  11:39 12:28 13:25 14:22 15:17 16:17 17:6 18:4 19:8 20:2 21:6 22:7 23:3 24:1 25:2 26:5 27:2 28:2 30:1）
- 按来源：进阶杀法 76%、基本杀法 64%、梦入神机 54%、适情雅趣 52%
- 求解路径：**全部 525 条都走「根搜索的 PV 一次到底」**（1 次搜索 + 纯规则层重放，中位 **2.8 秒/题**），
  没有一条需要逐手重搜 —— 逐手重搜那条路（每条 N+1 次完整搜索，几十秒/题）只在 PV 被截断时才用
- 未通过的 340 条**体检**（`report` 模式）：
  `win 161`（必胜但 3 秒内也未见杀 → 是残局技巧题，该进 `studies` 不是 `mates`）、
  `flat 155`（接近均势 → 源题库里的坏数据/和棋题）、
  `lost 22`（红方反而落后 → 题目本身有问题）、`mate-unverified 2`（报了杀但线路没验过）
  → **「未通过」不等于坏数据**，报告必须把这个区分说清楚

**四条判据原样保留，只换「谁来算」**：走子方每步看得到杀棋分 / 对手每步是引擎首选 /
终局用**我们自己的规则层**判无合法着法 / 线路长度 === `2×mateIn−1`。

**落库前再过一次规则层自证**：525 条新线路全部走一遍 `XQ.adjudicate`，
**0 条**被判成长将判负 / 三次重复 / 无吃子和棋。

### 4. 「海底捞月」那条矛盾（未查清，留档）

- 云库 `querypv` → **12 手**（`score:29976, depth:24, pv:h2h4`）
- Pikafish 在 **3s / 10s / 30s 下都**报 `score mate 22`（43 步），30 秒后节点数不再增长
  （7,767,281），`d64` 树已耗尽仍是 22 手

两边**各自自洽**（云库 eval 递增、Pikafish 树耗尽）。已排除「云库那条 12 手线是长将线」
（12 步里只有 2 步将军）。**没查清谁对。**
→ 猜测方向：某一侧把 FEN 方言读成了另一盘棋。留档待查。

### 5. ✅ 已修：iOS bundle 里的库是旧的（本轮补完）

**当时的问题**：`ios/XiangqiCoach/Resources/library.json`（XcodeGen 把 `ios/XiangqiCoach`
整目录收作源）**停留在导入之前的状态 —— mates 只有 11 道**（9,612 字节）；
而 `tools/sync-library.js` 只生成 `web/js/library-data.js`，**不碰 iOS 那一份**
→ iOS 端从没见过那 445 道，更别说新的 525 道。

实测（把完整库塞进 bundle 再跑单测）：`LibraryTests.testEveryMatePuzzleIsPlayableAndActuallyWins`
立刻大面积失败，例如 `第260局 金创满身：引擎在 6 层内没找到成杀（实际评估 183）`。
原因：它断言「每道题自研引擎在 **6 层**内都能看到杀」，而这**只对 `mateIn ≤ 2` 成立**。
→ **这条断言一直只是靠「bundle 里恰好只有 11 道浅题」才绿的。**

**三处一起改的**：

| 改动 | 内容 |
|---|---|
| 同步链 | `tools/sync-library.js` 现在**同时**生成 `web/js/library-data.js` 与 `ios/XiangqiCoach/Resources/library.json`（都是紧凑格式，各约 399 KB）。iOS 那份不再靠手工 cp。 |
| 判据 | `testEveryMatePuzzleIsPlayableAndActuallyWins` 换成**沿库里的解法路线走一遍判**（纯规则层，与网页端 `XQLIB.validateLibrary` 同一口径）。引擎断言拆出去成 `testShallowMatePuzzlesAreFoundByEngine`，只对 `mateIn ≤ 2` 的 32 道。 |
| 守门 | 新增 `testBundleIsNotTheStaleCopy`（条数 ≥ 900 + 抽查 `m1`/`x0010`/`x0446`/`x0970` + 最深 ≥ 20 手）—— 这个洞当初能藏住，正是因为所有单测都只断言「非空」，而那些浅题也非空。 |

**顺带修的一处 UI 隐患**：对局页的场景切换菜单原来是
`ForEach(scenes.filter { $0.kind == .mate })` 平铺 —— 981 道题就是近千个菜单项。
现改成按来源分组、每组只列前 40 道（与训练页 `matePageSize` 同一套做法）。
另外 `SceneCatalog` 拆出了 `mateScene` / `openingScene` / `studyScene` 三个单件构造函数：
`SceneCatalog.all()` 会给 981 道题各建一个场景对象，不能再放在每手棋都要重算的 `body` 里。

**「引擎 6 层看不到杀」的实测边界**（用编出来的 Swift 引擎逐题量，是上面判据取舍的依据）：

| mateIn | 通过 / 总数 |
|---|---|
| ≤ 2 | **32 / 32** |
| = 3 | 59 / 61 |
| ≤ 4 | 91 / 206（4 手杀要 7 层才看得到，113 道**全部**失败） |

→ depth 6 的搜索判据最多只覆盖到 `mateIn ≤ 2`，拿它当「全库体检」必然误报。
