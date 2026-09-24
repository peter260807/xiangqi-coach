# 档位对局台 —— 量「每个难度档各是什么水平」

回答的问题：**App 里那五档难度，实际棋力差多少？**

## 为什么需要单独一套工具

`tools/match.js` 的 `--depth` 是**全局**的（`cfg.depth` 两侧共用），`--ms-a/--ms-b`
只能改时间。而**档位的天花板是 depth 而不是时间**：

| 档位 | 中局实际耗时 | 给的时间预算 |
|---|---|---|
| 中级（d5） | 3ms | 2200ms |
| 高级（d8） | 11ms | 3500ms |
| ~~大师（d12）~~ | 114ms | 6000ms |

高级档在中局 11ms 就把 8 层搜完了，剩下 3489ms 的预算根本用不上。
所以「把两档的时间调成不同」测不出档位差 —— 必须让两侧跑**不同的 depth 上限**。

> 上表里的「大师」是**测量当时的第五档**。它已按本台子的结论删除
> （与高级档差 −112 Elo、区间跨 0），现在只有四档。留着这一行是为了说明
> 「天花板是 depth 不是时间」这个判断从哪来。

办法：给每档生成一个 wrapper 引擎，把该档的 depth 上限烘进 `searchRoot`。

## 三个脚本

```bash
# ① 生成档位引擎到 build/（会拿 web/js/engine.js 的 LEVELS 回来对账，对不上就 exit 2）
node tools/level-match/gen-level-engines.js

# ② 自证 wrapper 真的卡住了深度，并打印各档实际到第几层
node tools/level-match/probe-level-engines.js

# ③ 相邻档循环赛（默认每对 16 局）
./tools/level-match/run-levels.sh          # 或 ./run-levels.sh 32
```

`run-levels.sh` 自带关卡：**② 不过就拒绝开赛**（exit 3）。
理由是踩过 —— 测量工具坏掉的样子跟否定结论一样（Swift 的 `searchSync` 把
`excluded` 写死成 `[]`，于是「新功能完全没作用」）。

另有一个不跑对局的刻度：

```bash
# 各档能解出多少道杀法题（首着命中率）—— 比 Elo 更好感知
node tools/level-match/puzzle-rate.js
node tools/level-match/puzzle-rate.js --sample 120 --ms-cap 2000
```

## 口径与坑

**1. 档位定义有三份，必须一致。**
`tools/level-match/gen-level-engines.js` 顶部的表、`web/js/engine.js` 的 `LEVELS`、
`ios/XiangqiCoach/Engine/Search.swift` 的 `SearchLevel.all`。
生成脚本会拿第 2 份回来对账；第 3 份靠 iOS 单测看着。

| 档 | depth | time | slack | 两端标签 |
|---|---|---|---|---|
| easy | 1 | 600ms | 320 | 入门 |
| normal | 3 | 1200ms | 110 | 初级 |
| hard | 5 | 2200ms | 35 | 中级 |
| expert | 8 | 3500ms | 0 | 高级 |

（原第五档 `master`（d12/6000ms）已删除 —— 与 `expert` 差 −112 Elo、区间跨 0。
`gen-level-engines.js` 现在会**双向**对账：少写一档会被抓「源里有 X 档、本表却没有」，
写多也会被抓「源里没有 X 档」。删档时忘了改这张表，以前是**静默通过**的。）

**2. wrapper 不含 `slack`。**
真实低档在最优着法 `slack` 分以内**随机挑一手**（「像人一样让子」）。
本工具量的是**纯搜索档位**，即该档的能力**上限** —— 用户实际感受到的只会更弱、
更不可预测。要量含 slack 的版本得另写（随机化会引入方差，需要更多局）。

**3. 局数 ≠ 独立样本数。**
`--games 16 --openings 8` 只有 **8 组**独立起手局面（成对设计，每组重放 2 遍）。
脚本会把「独立起手局面：N 组 / M 局」打出来核对，别看到 16 就以为有 16 个样本。

**4. 判断 `parseBoard` 的输入格式。**
它按 `/` 分段后**逐字符**读满 9 列、用 `.` 表示空格子 —— **不是标准 FEN 的数字记法**。
写 `9/1c5c1/…` 不会报错，而是把字符 `'9'` 当成棋子，崩在 `computeHash` 的
`zob[PI[p]]` 上。局面一律从 `shared/library.json` 取，别手写。

**5. 别把结果当绝对棋力。**
对局台给的是**内部相对量**（A 比 B 强多少 Elo）。
绝对刻度需要外部锚点，见 `docs/strength-levels.md` 里「为什么给不出人类 Elo」。

## 产出

都在 `results/` 下：

- `probe-levels.txt` —— 档位引擎自证表（各档在 3 个局面下实际到第几层）
- `lvl-<A>-vs-<B>.txt` —— 对局汇总（含得分率、Elo 差、置信区间、结束原因分布）
- `lvl-<A>-vs-<B>.jsonl` —— 逐局记录，支持中断续跑（改配置会拒绝续跑）
