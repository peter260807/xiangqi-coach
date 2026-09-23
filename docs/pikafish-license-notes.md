# 集成 Pikafish 的许可证注意事项（2026-09-24 核实）

> 结论先行：**GPL 不是最难的那一关，NNUE 权重的「非商业」限制才是。**
> 而且这条限制**与服务端/设备端无关** —— 官方给「远程引擎」单列了一类授权。
>
> ⚠️ **2026-09-24 追加**：官方发行包里的 `NNUE-License.md` 原文透露了一条**可能绕开
> 「商用需授权」的路径** —— 见文末「三、一条可能的绕行路」。

## 〇、许可证原文（从官方 2026-09-06 发行包里取的，最权威）

`NNUE-License.md` 全文（要点）：

> ### NNUE-License
> Any usage of the Pikafish weights constitutes agreement to this License.
>
> The weights file (pikafish.nnue) released with the Pikafish and the weights file further
> derived from them are:
> 1. Only for legal use, any consequences caused by any use beyond the legal scope
>    (e.g. online cheating) shall be borne by the user.
> 2. **No commercial use without permission.**
>
> The use of nnue weights for commercial purposes by [these individuals and organizations]
> (https://pikafish.org/list.html) is permitted.
>
> However, the weights we train for the xiangqi variant of the
> [Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish) are licensed under
> **[CC0 license]** … Even though they are derived from the Pikafish training data and follow
> the same training procedure, **they are not constrained by this license**.

引擎代码那边是 GPL-3.0（`Copying.txt` 是 GPLv3 全文）。

## 三层，触发条件各不相同

| # | 管什么 | 什么时候触发 | 你要做什么 |
|---|---|---|---|
| ① | **引擎代码**：GPL-3.0 | **分发**时。设备端打包 = 分发；**服务端跑不触发** | 附 GPL-3.0 全文 +「完整对应源码**或指向源码位置的说明**」（分发未改动的官方二进制，给个链接即可）。改动过源码则改动也要以 GPL-3.0 开放 |
| ② | **权重文件** `pikafish.nnue` | **使用**时 —— 不分设备端还是服务端 | 官方原文：**「非商业使用永久免费」**，商业用途需**单独取得授权** |
| ③ | **远程引擎**授权 | 服务端 / 远程调用形态 | 官方授权列表里**把「远程引擎授权」单列**，说明服务端不是免费区 |

另有独立的 `NNUE-License.txt`（随发行包/仓库提供）。本机那份引擎目录里**没有**许可证文件，
只有二进制 + 权重 + `把引擎放这里.txt`；要正式用之前从官网/仓库取一份存档。

## 关键：你的 app 会不会被 GPL「传染」

取决于**集成方式**，两者法律后果完全不同：

| 方式 | 是否构成 GPL 衍生作品 | 后果 |
|---|---|---|
| **独立可执行文件 + UCI 管道**（app 内放辅助进程，走 stdin/stdout） | 通常**不是**（属「聚合」） | **你的 app 代码保持私有**；GPL 义务缩到「附许可证 + 源码链接」 |
| **静态/动态链接进 app**（把引擎编成库直接调用） | **是** → 整个 app 落入 GPL-3.0 | 必须开放**你 app 的全部源码**；且不能与专有第三方 SDK 混用 |

→ **必须走前者。** 这条路项目里已经走通：`tools/uci` 就是把 Swift 引擎编成 UCI 子进程，
`tools/match.js` 用同一套协议驱动它 —— 换二进制就行，协议不用改。
⚠️ 但 iOS 沙箱不允许随意 `exec`：要在 app bundle 里放一个辅助可执行文件 + `posix_spawn`，
能跑但脆。**ad-hoc 分发反而绕过了 App Store 审核这一关**（本来就不上架）。

## 官方是会执行许可的

官网有一栏「**耻辱柱 👎**」，逐名列出「违反了皮卡鱼许可政策、禁止使用权重文件」的组织/个人
（十余家）。同时授权列表里有「象棋助手」「象棋迷 APP」「象棋智囊」这类已获授权的 App，
以及单独的「远程引擎授权」通道（联系方式在官网授权列表页）。

→ 说明：**这不是一条没人管的条款**；要商用就走授权，别赌。

## 所以，先回答一个问题就够了

**这个 app 算不算「商业使用」？**

- **个人 / 家里孩子学棋（非商业）** → 许可上干净。设备端集成只需要「附 GPL 全文 + 源码链接」，
  权重也免费。**没有法律障碍。**
- **公司对外经营 / 销售 / 商业培训** → 无论设备端还是服务端，**都要取得商用授权**。
  好消息是这条路是通的：官网有现成的授权流程和已授权的同行。

## 不想走授权时的两条替代路

1. **离线预计算**：用 Pikafish 在本地把「名局 / 杀法 / 残局 / 常见开局」的深度分析**算成数据**，
   只把**结果数据**随 app 分发。引擎代码与权重都不随 app 走 —— GPL 与权重许可都管不到「程序输出」。
   覆盖面有限，但对固定内容是够的。⚠️ 灰区安全线：**绝不要把 `pikafish.nnue` 一起打包**。
2. **换许可证宽松的引擎**：搜到一个候选 —— **ChessAI**（Rust，MIT 许可，u128 位棋盘、
   Alpha-Beta + 换位表 + 空着裁剪 + Lazy SMP，约 4K SLoC）。MIT 意味着可商用、可闭源、
   没有权重限制。但**棋力未知**（大概率远不如 Pikafish），要判断「分析够不够准」必须实测；
   且 Rust → iOS 要编成静态库再做 FFI。

## 附：本项目的现状

现在仓库里放 `trainer/engine/pikafish` 只用于**内部研发**（perft 三方对数、绝对锚点测量），
没有随 app 分发 → 风险很低，不用处理。真正要做决定的是「把它接进 app」那一步。

---

# 三、一条可能的绕行路：CC0 的象棋权重（2026-09-24 发现）

`NNUE-License.md` 最后一段说：**Fairy-Stockfish 象棋变体那套权重是 CC0 许可**，
「派生自同一批训练数据、同一套训练流程，但**不受本许可约束**」。

如果这条成立，那「商用必须向 Pikafish 团队取得授权」这道**最硬的坎就不存在了** ——
剩下的只有引擎代码的 GPL，而 GPL 在**服务端**不触发分发义务、在**离线预计算**里
管不到「程序输出」。也就是说：**商用可以完全不用谈授权**。

**要核实的三件事**（还没做，别当成结论）：
1. 那批 CC0 权重从哪下、最新版是哪一版（在 Fairy-Stockfish 的 release / networks 页面）
2. **能不能直接喂给 Pikafish 用**（Fairy-Stockfish 支持多种变体，权重与引擎的
   NNUE 架构必须匹配；不匹配就没法混用）
3. 棋力差多少（同源数据同流程，理论上接近，但要实测）

⚠️ 另外注意：`Fairy-Stockfish` 本身是 Stockfish 的分支，**也是 GPL-3.0**。
所以这条路换掉的是**权重许可**，不是引擎许可。价值在于：
- 商用不再需要单独谈判（省掉一个不可控的外部依赖）
- 服务端 / 离线预计算这两种用法下，连 GPL 都不触发

## 附：本项目的现状（同前）

`trainer/engine/pikafish` 只用于内部研发，没有随 app 分发 → 不用处理。
决定点是「把它接进 app」或「用它的输出做商用数据」那一步。

---

# 上架 App Store 能不能内置？（2026-09-24 追加）

分两层：**法律是第一道硬门，技术是第二道。**

## 第一层（法律）：两道，都绕不开

### ① 权重许可是「非商业」—— 这是最硬的那道

上架 App Store（尤其收费 / 内购 / 带广告 / 公司主体发布）＝ **商业使用** →
按 Pikafish 官网与 NNUE 许可原文，**必须先取得商用授权**。这一步不过，后面全都白谈。

### ② GPL 与 App Store 条款本身有众所周知的冲突

- GPL-3.0 §10 禁止「附加限制」；而 App Store 的使用限制与 DRM 正是这类限制。
  FSF 有正式声明（`fsf.org/news/2010-05-app-store-compliance`）；历史上 **VLC、GNU Go 都被下架过**。
- **但 App Store 上确实长期有 GPLv3 引擎 app**：官方 **Stockfish Chess**（Daylen Yang，
  2014 年上架至今，31.8~70.4 MB，免费无广告，明确写着 GPLv3）。
- ⚠️ 这个先例**不是「合规」，是「版权人默许」** —— 实质形成双授权。正如社区里的说法：
  只有版权人能追究，Stockfish 作者不追究就成了事实默认；**但任何一个贡献者都能要求 Apple 下架**。
  Pikafish 的情况更微妙：它已经**明确划分了商用授权**，还挂着「耻辱柱」——**它显然会追究**。

## 第二层（技术）：想在 iOS 保住「独立进程 = 聚合」这条路，很难

- 业界常说的护身符是「引擎作为**独立可执行文件** + UCI 管道 ⇒ 属聚合 ⇒ 你的 app 代码不被传染」。
  **这在桌面成立，在 iOS 上基本失效**：
  - iOS 没有 `fork()`；要用 `posix_spawn` 起 bundle 里嵌套的可执行文件。技术上可行
    （Xcode 会给嵌套 Mach-O 签名），但**很少见、审核有风险**
  - 更常见的做法是**把引擎链接进 app** → 那你**整个 app 变成 GPL-3.0，必须开源全部源码**
    （Stockfish 官方 app 就是这么干的 —— 它整个开源，作者接受了这一点）
- **而你不愿意开源自己的 app**（里面有讲解链路、内容库等业务逻辑）→ 所以「内置引擎」这条路
  在 App Store 场景下基本被封。

## 审核规则原文（`2.5.2`）

> Apps should be **self-contained in their bundles**, and may not read or write data outside the
> designated container area, nor may they **download, install, or execute code** which introduces
> or changes features or functionality of the app, including other apps.

- 字面上禁的是「**下载 / 安装**」会引入或改变功能的代码 —— **随 bundle 一起提交、一起被审核的
  二进制不属于「下载」**，所以严格读法并非禁止
- 但 Apple 的关切实质是「别跑未经审核的代码」，**审查实践对「执行额外可执行文件」历来保守**，
  有拒审先例（2025-2026 的 Vibe Coding 一批 app 被 2.5.2 下架/卡更新）
- 另外 **体积**：`pikafish.nnue` 单文件 **48 MB**（+引擎 6 MB）→ IPA 从 896 KB 涨到约 55 MB

**结论**：App Store 上架**不要走「内置引擎」**。要么先拿 Pikafish 商用授权后走服务端 / 预计算，
要么改用**自研引擎**做预计算（零许可证风险）。详见 `docs/offline-precompute.md`。
