import Foundation

// stdout 关掉缓冲：重定向到文件时 stdio 是块缓冲的（4KB），
// 跑几分钟都看不到一行进度，容易误判成卡死。
setvbuf(stdout, nil, _IONBF, 0)

// ============================================================================
// Swift 搜索引擎的体外测量台
//
// 把 ios/XiangqiCoach/Engine/{Rules,Notation,Search}.swift 和本文件一起用
// swiftc 编成命令行程序（见同目录 run.sh），不依赖 Xcode / 模拟器。
//
// 回答三个问题：
//   1. 搜索每秒能跑多少节点（决定「时间换算成深度」的效率）
//   2. 各难度档在给定时间预算内**实际**能搜到几层（标签上的 depth 是不是真的）
//   3. 开销花在哪：着法生成 / 合法性检查 / 评估 各占多少
// ============================================================================

func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
func ms(_ a: UInt64, _ b: UInt64) -> Double { Double(b - a) / 1_000_000 }

/// 只跑「难度档」那一段就退出（改搜索后想快速看档位收益时用）
let levelsOnly = CommandLine.arguments.contains("--levels-only")

// MARK: - 测试局面

// 记法：大写字=红（下方），小写字=黑（上方），行 0 是黑方底线、行 9 是红方底线
// r/n/b/a/k/c/p = 车马象士将炮卒（红方对应大写）
let testPositions: [(name: String, fen: String, note: String)] = [
    ("标准开局", Rules.startFEN, "22 个棋子，最宽的分支"),
    ("中局",
     "r.nbakar./........./.cn...n.c/p.p.p...p/......p.."
     + "/..P....../P...P.P.P/.C..C.N../........./RNBAKABR.",
     "中炮对屏风马 8 手，双方车在同一线上对峙"),
    ("残局",
     "..bakab.r/........./........./........./....P...."
     + "/...R...../........./....N..../........./....K....",
     "车马兵 vs 车士象全，分支少、残局快"),
]

// MARK: - 准备

var boards: [(name: String, board: [Int8])] = []
for p in testPositions {
    // 自证：光看 Rules.parse 的返回值是不够的 —— 行数写错（少一个 "."）时
    // 解析器照样吐出 90 格，只是整盘棋错位，看上去「解析成功」。
    // 所以这里逐行卡死：必须 10 行、每行 9 个字符。
    let rows = p.fen.split(separator: "/", omittingEmptySubsequences: false)
    guard rows.count == 10 else {
        FileHandle.standardError.write(
            "FEN 行数不对：\(p.name) 得到 \(rows.count) 行（应为 10）\n".data(using: .utf8)!)
        exit(1)
    }
    for (r, row) in rows.enumerated() where row.count != 9 {
        FileHandle.standardError.write(
            "FEN 第 \(r) 行不是 9 个字符：'\(row)'（\(row.count) 个）\n".data(using: .utf8)!)
        exit(1)
    }

    let b = Rules.parse(p.fen)
    guard b.count == 90 else {
        FileHandle.standardError.write("FEN 解析失败：\(p.name) 得到 \(b.count) 格\n".data(using: .utf8)!)
        exit(1)
    }
    // 局面自身也要健全：轮到的一方必须有棋可走
    let lm = Rules.legalMoves(b, .red).count
    guard lm > 0 else {
        FileHandle.standardError.write(
            "局面不合法（或 FEN 写错）：\(p.name) 红方 0 个合法着法\n".data(using: .utf8)!)
        exit(1)
    }
    boards.append((p.name, b))
}

print("==================================================================")
print("局面自检")
print("==================================================================")
for (i, p) in testPositions.enumerated() {
    let b = boards[i].board
    let n = b.filter { $0 != 0 }.count
    let pseudo = Rules.genMoves(b, .red).count
    let legal = Rules.legalMoves(b, .red).count
    print(String(format: "  %-8@ 子 %2d | 红方着法 伪合法 %2d / 真合法 %2d | 红被将 %@ 黑被将 %@ 照面 %@",
                 p.name as NSString, n, pseudo, legal,
                 Rules.inCheck(b, .red) ? "是" : "否",
                 Rules.inCheck(b, .black) ? "是" : "否",
                 Rules.kingsFacing(b) ? "是" : "否"))
    print("           \(p.note)")
}

// MARK: - 微观：着法生成 / 评估 / 合法性 的成本

print()
print("==================================================================")
print("微观成本（每项 5000 次取均值，中局局面）")
print("==================================================================")

// 防优化汇总器。
//
// 踩过的坑：写成 `_ = Rules.inCheck(mid, .red)` 时，-O 会把整个调用提出循环
// （纯函数 + 结果没人用），量出 0.06 µs/次 这种明显不可能的假数字。
// 所以每次调用都必须把结果喂进一个**可观测**的全局变量，
// 并且函数标记 @inline(never)、数组按值传入（带 retain/release），
// 让编译器无法证明「这个循环白跑」。
var sink: Int64 = 0

@inline(never)
func eat(_ v: Int) { sink = sink &* 31 &+ Int64(v) }

@inline(never)
func eatMoveCount(_ m: [Move]) -> Int { sink = sink &+ Int64(m.count); return m.count }

let mid = boards[1].board
let iterations = 5000

// 着法生成
var t0 = now()
var genCount = 0
for _ in 0..<iterations { genCount += eatMoveCount(Rules.genMoves(mid, .red)) }
var t1 = now()
let genUs = ms(t0, t1) * 1000 / Double(iterations)

// 真合法着法（含逐着试走 + 被将检测）
t0 = now()
var legalCount = 0
for _ in 0..<iterations { legalCount += eatMoveCount(Rules.legalMoves(mid, .red)) }
t1 = now()
let legalUs = ms(t0, t1) * 1000 / Double(iterations)

// 静态评估
t0 = now()
for _ in 0..<iterations { eat(Int(Engine.shared.evaluate(mid))) }
t1 = now()
let evalUs = ms(t0, t1) * 1000 / Double(iterations)

// 被将检测单独测（搜索每生成一个着法都要调一次）
t0 = now()
for _ in 0..<iterations { eat(Rules.inCheck(mid, .red) ? 1 : 0) }
t1 = now()
let checkUs = ms(t0, t1) * 1000 / Double(iterations)

print(String(format: "  genMoves(全量伪合法)   %7.2f µs/次  → 每次 %d 个着法", genUs, genCount / iterations))
print(String(format: "  legalMoves(逐着试走)   %7.2f µs/次  → 每次 %d 个着法", legalUs, legalCount / iterations))
print(String(format: "  每着试走的合法性成本    %7.2f µs/个", (legalUs - genUs) / Double(max(1, genCount / iterations))))
print(String(format: "  evaluate(静态评估)     %7.2f µs/次", evalUs))
print(String(format: "  inCheck(被将检测)      %7.2f µs/次", checkUs))
print("  （校验和 \(sink) 非 0 才说明循环没被优化掉）")

// MARK: - 各难度档实际到达的深度

print()
print("==================================================================")
print("难度档：时间预算内实际搜到多深")
print("==================================================================")
print("  档位      标签深度  时间预算   实际深度    节点数     耗时      千节点/秒   最佳着法")

for (name, b) in boards {
    print("  —— \(name) ——")
    for lv in SearchLevel.all {
        Engine.shared.resetForTesting()   // 清置换表，避免上一轮喂给下一轮
        let a = now()
        let r = Engine.shared.searchSync(board: b, side: .red, maxDepth: lv.depth, timeMs: lv.timeMs)
        let z = now()
        let dt = ms(a, z)
        let knps = dt > 0 ? Double(r.nodes) / dt : 0   // nodes/ms = 千节点/秒
        let flag = r.depth < lv.depth ? "  ← 没搜完" : ""
        // 把最佳着法也打出来 —— 「两个档位实际是同一档」这种结论靠推理不够，
        // 得看到它们真的给出同一手棋
        let mv = r.move.map { Notation.label(board: b, move: $0) } ?? "(无)"
        print(String(format: "  %@  %2d 层     %5d ms   %2d 层  %9d  %8.0f ms  %8.1f   %@%@",
                     lv.label as NSString, lv.depth, lv.timeMs, r.depth, r.nodes, dt, knps,
                     mv as NSString, flag as NSString))
    }
}

if levelsOnly { print(); exit(0) }

// MARK: - 固定深度下的裸吞吐

print()
print("==================================================================")
print("固定深度（45 秒兜底）的裸吞吐 —— 这才是引擎的真实速度")
print("==================================================================")
print("  局面        目标深度  实际深度    节点数     耗时      千节点/秒")

for (name, b) in boards {
    for d in [6, 8, 10] {
        Engine.shared.resetForTesting()
        let a = now()
        let r = Engine.shared.searchSync(board: b, side: .red, maxDepth: d, timeMs: 45_000)
        let z = now()
        let dt = ms(a, z)
        let knps = dt > 0 ? Double(r.nodes) / dt : 0
        let cut = r.depth < d ? "  ← 45 秒没搜完" : ""
        print(String(format: "  %-8@  %2d       %2d 层  %9d  %8.0f ms  %8.1f%@",
                     name as NSString, d, r.depth, r.nodes, dt, knps, cut as NSString))
    }
}
print()
