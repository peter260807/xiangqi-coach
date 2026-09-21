# 引擎策略评估：Pikafish 接入 / 自训练 / 许可证边界

> 本文所有数字均为**本机实测**，测试环境：Apple M1 Pro（10 核）、Pikafish 2026-09-06（自行编译，arm64 + NEON）、单进程单线程引擎。
> 复现脚本在 `tools/` 下（`pk-match.js`、`data-quality-probe.js`、`engine-latency-probe.js`）。
> 评测日期：2026-09-21。

---

## 结论速览

| 思路 | 法律可行 | 技术可行 | 真实成本 | 卡点 |
|---|---|---|---|---|
| **一、自对弈训练自研引擎** | ✅ 数据不受 GPL 约束 | ⚠️ 有条件 | 数据生成**很便宜**，训练要 1~2 周 | **训练工具链没有公开可用版本**；引擎得先换成原生语言 |
| **二、引擎独立服务器 + 客户端隔离** | ✅ 有明确法理依据 | ✅ 已验证 | 1~2 天工作量 | 服务器运维；海外部署会让对局慢一倍 |

**两条路不冲突，应该先走第二条。** 理由在最后一节。

---

## 思路一：和 Pikafish 对弈训练

### 1.1 要先纠正三个认知偏差

#### 偏差一：2080Ti 对"生成数据"几乎没用

Pikafish 官方 FAQ 原文：

> **Can Pikafish use my GPU?**
> No, Pikafish is a chess engine that uses the CPU only for chess evaluation. Its NNUE evaluation ... is very effective on CPUs. With extremely short inference times (sub-micro-second), this network can not be efficiently evaluated on GPUs, in particular with the alpha-beta search that Pikafish employs. **However, for training networks**, Pikafish employs GPUs ...

也就是说 GPU 只在**训练网络**阶段有用。**自对弈生成数据是纯 CPU 任务**——靠的是"多个单线程引擎进程并行"。

#### 偏差二：用 `movetime` 测吞吐会低估一个数量级

我第一轮测试用 `go movetime 50` 得到 21.7 局面/秒，据此推算一周只有 1 亿局面。**这个测法是错的**——`movetime` 会让引擎把时间用满，即使它 2ms 就找到了最优着法。

改用 `go depth N` 重测（单进程，每个配置采样 60 步）：

| 限流方式 | 单步均耗 | 单进程吞吐 | 8 进程 × 一周 | 数据质量 |
|---|---|---|---|---|
| `go movetime 20` | 20ms | 49.9 /s | 2.4 亿 | 低（浅搜索，噪声大） |
| `go movetime 50` | 50ms | 20.0 /s | 0.97 亿 | 中低 |
| `go movetime 200` | 200ms | 5.0 /s | 0.24 亿 | 中 |
| **`go depth 8`** | **2ms** | **468.8 /s** | **22.7 亿** | 中高（官方常用档） |
| `go depth 12` | 11ms | 88.9 /s | 4.3 亿 | 高 |
| `go nodes 50000` | 49ms | 20.4 /s | 0.99 亿 | 中高（按算力定量） |

**结论：数据生成根本不是瓶颈。** 用 `depth 8~12`，一台 8 核机器一周能产出 **4 亿 ~ 20 亿局面**。

生成训练数据必须用 `go depth N` / `go nodes N` 这类"确定性限流"，**不能用 `movetime`**——后者会把算力浪费在已经找到最优解之后的空转上。

> ⚠️ 这个数字是开局到中局早期的均值（采样 60 步）。残局阶段分支少、反而更快；中局最复杂处会慢一些。整体量级可信。

#### 偏差三：这一周的自对弈，官方生态已经做完了

Pikafish 的 README 里写着：

> Pikafish uses neural networks trained on **data provided by the Pika Xiangqi Zero (Px0) project**, which is made available under the **Open Database License (ODbL)**.

而这份数据的下载地址就在 FAQ 里：**`kaggle.com/datasets/pikacat/px0data`**

实测该数据集现状：

| 项 | 值 |
|---|---|
| 文件 | `data.bin`（NNUE 训练用的二进制格式） |
| 大小 | **11.12 GB** |
| 版本 | 727（仍在更新，最近更新 2026-09） |
| 下载量 | 19.3K |
| 许可 | README 称 ODbL；**但 Kaggle 页面标的是 `Unknown`** ⚠️ |

按 NNUE binpack 每局面约 40~50 字节估算，**11.12 GB ≈ 2 ~ 3 亿局面**。

**也就是说：自己跑一周（4 亿~20 亿）确实比公开数据集多，但公开数据是社区持续更新的、配置经过调优的版本。** 如果目标只是"训一个比现在强的网络"，**直接下载比自己跑更划算**——省掉整整一周的机器占用。

### 1.2 真正的卡点：训练工具链没有公开可用版本

我把官方仓库翻了一遍，结果不太乐观：

| 寻找目标 | 结果 |
|---|---|
| `official-pikafish/nnue-pytorch` | ❌ **404，不存在** |
| `official-pikafish/pikafish-nnue-pytorch` | ❌ **404，不存在**（FAQ 里链接的就是这个） |
| `Pikafish` 仓库的 `tools` 分支 | ❌ **不存在**。实际分支只有 `main / master / tune / wasm / HalfKAv2_hm / Switch / draw_head / jieqi / jieqi_old / wasm-try-merge` |
| `pxzero-training`（lczero-training 的 fork） | ⚠️ 存在但**2024-07 后未更新**，README 还是国际象棋的，数据路径指向 `storage.lczero.org` |
| **`official-stockfish/nnue-pytorch`** | ✅ 可用。GPL-3.0，★497，2026-07 仍在更新 |

**结论：官方 FAQ 和 Advanced-topics 里指向训练器的链接已经全部失效。** 现成能用的只有**国际象棋版**的训练器，要用来训象棋网络，必须自己改造特征层（象棋用的是 `HalfKAv2_xq` 特征，源码在 `src/nnue/features/half_ka_v2_hm.*`，另有 `full_threats.*`）。

这不是写不出来的东西，但是**实打实的工程量**——要对齐特征编码、数据格式、量化方案，且没有官方参考实现可对拍。

### 1.3 法律边界：先把两道门分清楚

这里有**两个独立的许可**，很多人只盯着 GPL，忽略了第二个。

#### 第一道门：GPL-3.0 —— 数据这一侧没问题

FSF 的 GPL FAQ 明确回答：

> **In what cases is the output of a GPL program covered by the GPL too?**
> **The output of a program is not, in general, covered by the copyright on the code of the program.** So the license of the code of the program does not apply to the output...

同一份 FAQ 的另一条：

> ...when a program translates its input into some other form, **the copyright status of the output inherits that of the input it was generated from.**

**所以：用 Pikafish 跑自对弈产生的局面数据，不受 GPL 覆盖。** 拿这些数据训练自己的网络，GPL 层面是干净的。

#### 第二道门：NNUE-License —— 真正的风险点在这里

`pikafish.nnue` 权重**不是** GPL 覆盖的，它有自己的许可（发布包里单独有一份 `NNUE-License.md`）：

> The weights file (pikafish.nnue) released with the Pikafish and **the weights file further derived from them** are:
> 1. Only for legal use, any consequences caused by any use beyond the legal scope (e.g. online cheating) shall be borne by the user.
> 2. **No commercial use without permission.**

关键在 **"the weights file further derived from them"** 这句。如果把 `pikafish.nnue` 当老师做蒸馏（knowledge distillation），产出的新网络**很可能被认定为"由其进一步衍生"**，从而受这条约束。

（有意思的是，同一份文档说明了逃逸路径：为 Fairy-Stockfish 的象棋变体训练的网络虽然"派生自 Pikafish 训练数据、遵循相同训练流程"，但采用 **CC0**，不受此限。）

**风险等级划分：**

| 用途 | GPL | NNUE-License | 判定 |
|---|---|---|---|
| 自己 / 教学用，不外发 | 无义务 | 无义务（非商业） | 🟢 安全 |
| 开源发布、非商业 | 注意分发时提供源码 | 无义务 | 🟢 基本安全 |
| **商用 / 上架收费** | 分发才触发 | **需取得授权** | 🟡 **需要处理** |
| 帮人对弈作弊 | — | **明确禁止** | 🔴 不可行 |

> 第 4 条要划清界限：本项目是**教学 App 的人机对弈**，不是帮用户在真人平台上作弊，这不触犯该条。但产品定位上不要往"对弈辅助"方向漂移。

### 1.4 最硬的前置条件：引擎得先从 JavaScript 换出来

**当前引擎是 JS 写的。NNUE 在这个形态下跑不动。**

NNUE 的核心工程技巧是**增量更新**——走一步只需重算受影响的少量特征，而不是整张网络前向一次。要做到这点，需要：

- **SIMD 向量指令**（AVX2 / NEON）做批量乘加 —— JS 没有
- **紧凑的内存布局**（int8 量化 + 定长累加器）—— JS 的数组和对象做不到
- **可控的内存分配**，避免 GC 抖动 —— JS 做不到

Pikafish 官方的说法是 NNUE 推理是"亚微秒级"，这是靠上述手段堆出来的。在 JS 里复现，性能会低到不可用。

**所以思路一的实际第一步不是训练，是重写引擎**：C++ / Rust / 或 Swift + NEON（iOS 侧）。这一步本身有独立价值（搜索速度也会提升），但它不是一周的量。

---

## 思路二：引擎独立服务器 + 客户端隔离

### 2.1 法律依据：比想象的清晰

**（1）GPL-3.0 的义务只在「分发」时触发。**

Pikafish README 自己写得很直白：

> The only real limitation is that **whenever you distribute Pikafish** in some way, you MUST always include the license and the full source code...

FSF 的说法一致：

> The GPL does not require you to release your modified version, or any part of it. You are free to make modifications and use them privately... **But *if* you release the modified version to the public in some way, the GPL requires you to make the modified source code available.**

**服务器上跑，用户通过网络用 —— 不构成"分发"。** 所以不触发源码提供义务。

**（2）这正是 GPL 与 AGPL 的分水岭。**

AGPL 专门加了一条：通过网络远程交互即触发源码提供义务。**Pikafish 是 GPL-3.0，不是 AGPL** —— 这个方案才成立。如果它是 AGPL，整条路直接堵死。

> 📌 **落地前务必再确认一次许可证类型**。这是整个方案的地基。

**（3）"代码隔离"的标准是什么？**

FSF 对"两个程序还是一个程序"给了可操作的判据：

> Where's the line between two separate programs, and one program with two parts? ... We believe that a proper criterion depends both on **the mechanism of communication** (exec, pipes, rpc, function calls within a shared address space, etc.) and **the semantics of the communication** (what kinds of information are interchanged).
>
> If the modules are included in the same executable file, they are definitely combined in one program. If modules are designed to run linked together in a shared address space, that almost surely means combining them into one program.
>
> By contrast, **pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs.** ... **But if the semantics of the communication are intimate enough, exchanging complex internal data structures, that too could be a basis to consider the two parts as combined into a larger program.**

翻译成本项目的操作规则：

| ✅ 安全 | ❌ 危险 |
|---|---|
| 引擎是**独立可执行进程** | 把 Pikafish 编译成 .so/.framework 链进 App |
| 通过 **socket / 管道** 通信 | 共享内存里传位棋盘、置换表 |
| 协议是**纯文本 UCI**（或简单 JSON） | 自定义协议传输内部数据结构 |
| 传给引擎的是 `position startpos moves ...` | 传二进制局面对象 + 内部评估缓存 |

**一句话：保持 UCI 的"文本语义"，别让它变成"进程内的函数调用换了个壳"。**

### 2.2 技术验证：延迟实测

我写了一个最小原型（`tools/engine-latency-probe.js`）：把 Pikafish 包成 HTTP 服务（引擎是**独立子进程**，通过 UCI 文本协议通信），客户端按真实对局节奏逐步请求。

**先看协议本身的开销**（本机回环，逐级测思考时间）：

| 引擎思考 | 客户端实测往返 | 协议额外开销 | 占比 |
|---|---|---|---|
| 50ms | 51ms | 2ms | 3.9% |
| 200ms | 201ms | 1ms | 0.5% |
| 500ms | 500ms | 0ms | 0.0% |
| 1000ms | 1000ms | 1ms | 0.1% |
| 2000ms | 2001ms | 2ms | 0.1% |

一局 40 手的完整对弈：**协议开销占比 0.4%**。协议本身不是问题。

**真正的问题是把网络延迟加进去。** 注入不同 RTT 后（一局 40 手、每步思考 200ms、纯引擎时间 8.0s）：

| 网络场景 | RTT | 对局墙钟 | 额外耗时 | 相对增幅 | **单步体感** |
|---|---|---|---|---|---|
| 同机回环（引擎在本地） | 0ms | 8.1s | +0.1s | +2% | 200ms |
| 同城机房 / 家里同网段 | 5ms | 8.2s | +0.2s | +3% | 205ms |
| **同区域云服务器** | 30ms | 9.4s | +1.4s | +17% | **230ms** |
| 跨省服务器 | 60ms | 10.6s | +2.6s | +32% | 260ms |
| 海外服务器 | 200ms | 16.2s | +8.2s | +102% | 400ms |
| 跨境弱网（4G 抖动） | 400ms | 24.2s | +16.2s | +202% | 600ms |

**读法：不要看"增幅百分比"，要看"单步体感"。**

同区域服务器让单步从 200ms 变成 230ms —— 用户**根本感觉不出来**。海外服务器变成 400ms，开始有"卡顿感"。跨境弱网 600ms，体验明显受损。

一个反直觉的推论：**把思考时间调长反而能掩盖网络延迟**。200ms 思考 + 30ms RTT = 230ms（延迟占 13%）；如果难度调到 50ms 思考，同样 30ms RTT 就占 37%，体感会很明显。所以低难度档位反而要小心。

### 2.3 架构建议

```
┌──────────────┐        ┌────────────────────────────┐
│  iOS / iPad  │  HTTPS │  引擎网关（自研，无 GPL）    │
│  App（无GPL）│ ─────► │  · 鉴权 / 限流 / 对局状态     │
│              │        │  · 局面合法性校验             │
└──────────────┘        └──────────┬─────────────────┘
                                   │ UCI 文本协议（stdin/stdout）
                                   │  ← 独立进程边界在这里
                        ┌──────────▼─────────────────┐
                        │  pikafish（GPL-3.0，独立进程）│
                        └────────────────────────────┘
```

要点：

1. **网关自己写**，不放任何 GPL 代码，只做协议转换
2. **引擎以子进程方式拉起**，通过 stdin/stdout 说 UCI —— 通信机制和语义都符合 FSF 说的"独立程序"
3. **服务端不对外提供 Pikafish 二进制下载** —— 一旦发布二进制，就变回"分发"，义务立刻触发
4. **客户端只发"着法序列 + 时间预算"，只收"最佳着法 + 评分"** —— 简单数据结构，不碰引擎内部状态

### 2.4 顺带解决的事：App Store 的 GPL 冲突

这条路的额外收益很大。**把 Pikafish 内置进 iOS App 上架，是有实际障碍的**：

- GPLv3 第 6 条的"安装信息"要求（反 Tivoization）与 App Store 的 DRM 条款相冲突
- 这是历史上有真实案例的（VLC 因此从 App Store 下架）

而走服务器方案后，**App bundle 里不含任何 GPL 代码**，这个冲突**自动消失**。

### 2.5 成本

| 方案 | 成本 | 说明 |
|---|---|---|
| 云服务器（8 核） | ¥200~500 / 月 | 同区域，体验最佳 |
| **自己的 2080Ti 机器 + 内网穿透** | **电费** | 你已有 cpolar 经验；零额外成本，代价是机器要常开 |

第二条思路值得一提：把这台机器直接当引擎服务器，用 cpolar 暴露给 App。**零服务器成本、不分发二进制、能上架。** 唯一的代价是家宽的稳定性和上行带宽。

---

## 推荐路线

### 立刻做：思路二（1~2 天）

**性价比压倒性。** 一天工作量就拿到职业级棋力，同时解决 App Store 的许可证障碍。

具体：
1. 写引擎网关（协议转换 + 鉴权 + 合法性校验），确认**不能有 GPL 代码**
2. 部署在你那台 2080Ti 机器（或轻量云服务器），同区域部署
3. 客户端加一条"远程引擎"通道，保留本地引擎作离线兜底
4. 难度档位映射到 Pikafish 的 `Skill Level` 或 `go depth N`（这样可以让它"陪你下"而不是碾压你）

> 💡 用 Pikafish 做**难度可调**很关键 —— 职业级引擎直接下会把人打崩。`Skill Level` 选项 + 低 `depth` 组合，能做出"会下但会犯错"的陪练。

### 中期：把引擎换成原生（这是思路一的前置条件）

无论是否训练 NNUE，JS 引擎的性能天花板都在那里。移植到 Swift（iOS 侧）或 C++，顺带：
- 给 NNUE 铺路
- 搜索速度提升（预计数倍）
- 为"本地离线也能有不错棋力"打基础

### 长期：思路一（训练自己的网络）

**把顺序调整成：**

1. ~~跑一周自对弈生成数据~~ → **跳过。直接下载 PX0 数据集**（11 GB，2~3 亿局面），省一周机器时间
2. **改造训练器**：fork `official-stockfish/nnue-pytorch`，把特征层换成象棋的 `HalfKAv2_xq` —— **这是整个项目最不确定的一步，没有官方参考实现可对拍**
3. **训练**：2080Ti 训练几亿样本，预计数天到 1~2 周
4. **验收**：用 `tools/pk-match.js` 跑对局，对比"改造前 / 改造后"

如果第 2 步走通了，也可以自己补跑自对弈来扩充数据（`depth 8` 一周 20 亿+ 局面，不是瓶颈）。

**预期效果**：能做到明显强于当前手写引擎（当前约业余 5~8 级）。
**但要预期管理**：追平 Pikafish 不可能 —— 那是 Stockfish 框架 + 社区 Fishtest 十万级核时的积累，不是一台机器一周能做到的。

---

## 待确认的参数

评估里有两个变量会明显改变结论，需要你确认：

1. **那台 2080Ti 机器的 CPU 是什么型号、多少核？**
   本文吞吐数据来自 M1 Pro（10 核）。数据生成速度完全取决于 CPU 核心数和单核性能，与 GPU 无关。如果 CPU 是 6 核的 i5-9400 之类，一周产出大约是本机的一半。

2. **是否打算商业化 / 上架 App Store？**
   决定 NNUE-License 的风险等级，也决定架构选择：
   - 纯自用/教学 → 可以直接内置 Pikafish，不用搞服务器
   - 要上架 → 走服务器方案，把 GPL 完全隔离在 App 之外

3. **那台机器能长期开机当引擎服务器吗？**
   如果可以，"自建服务器 + cpolar"能把服务器成本压到零。

---

## 附：本文用到的实测脚本

| 脚本 | 用途 |
|---|---|
| `tools/pk-match.js` | Pikafish vs 本项目引擎对局，支持 `--pika-ms` / `--pika-depth` |
| `tools/data-quality-probe.js` | 不同限流方式下的数据产出速率与质量权衡 |
| `tools/engine-latency-probe.js` | 引擎服务端到端延迟，含不同 RTT 场景的对局耗时 |
| `tools/engine-server-probe.js` | 引擎服务的协议开销拆解 |
