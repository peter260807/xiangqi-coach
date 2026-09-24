import Foundation

/// 提示词构造。棋盘用等宽文字画给模型看 —— 比只给 FEN 准确得多。
enum Prompts {

    static let systemCoach = """
    你是一位中国象棋教练，面向初学者讲解。回答要求：只讲最关键的东西；用简体中文；\
    不堆砌术语，每个术语首次出现时用一句话解释；\
    涉及具体着法时必须用标准中文棋谱记法（如「炮二平五」「马八进七」）。
    """

    /// 把棋盘画成等宽文字
    static func boardASCII(_ b: [Int8]) -> String {
        var lines: [String] = ["     a  b  c  d  e  f  g  h  i"]
        for r in 0..<10 {
            var row = " " + String(9 - r) + "   "
            for c in 0..<9 {
                let p = b[r * 9 + c]
                row += (p == 0 ? "·" : Piece.name(p)) + "  "
            }
            lines.append(row)
        }
        lines.append("     a  b  c  d  e  f  g  h  i")
        lines.append("（红方在下（第 9 行），黑方在上（第 0 行）；字母为纵线，数字为横线）")
        return lines.joined(separator: "\n")
    }

    struct PositionContext {
        var board: [Int8]
        var side: Side
        var moveText: String
        var engineScore: Int32
        var candidates: [CandidateMove]
        var inCheck: Bool
    }

    static func positionBrief(_ ctx: PositionContext) -> String {
        var lines: [String] = []
        lines.append("【当前局面】")
        lines.append(boardASCII(ctx.board))
        lines.append("")
        lines.append("到谁走：\(ctx.side.label)")
        if !ctx.moveText.isEmpty { lines.append("已走着法：\(ctx.moveText)") }
        lines.append("本地引擎评估（红方视角，单位厘兵，正数红优）：\(ctx.engineScore)")
        if !ctx.candidates.isEmpty {
            lines.append("引擎筛选出的候选着法（已验证合法）：")
            for (i, c) in ctx.candidates.enumerated() {
                lines.append("  \(i + 1). \(c.label)（评估 \(c.score)）")
            }
        }
        if ctx.inCheck { lines.append("注意：当前有一方正被将军。") }
        return lines.joined(separator: "\n")
    }

    static func coach(_ ctx: PositionContext, question: String?) -> [[String: String]] {
        var user = positionBrief(ctx)
        if let q = question, !q.isEmpty {
            user += "\n\n【棋友提问】" + q
        } else {
            user += "\n\n【任务】点评这个局面，告诉我现在该怎么想、推荐走哪一步、为什么。不要超过 220 字。"
        }
        return [
            ["role": "system", "content": systemCoach],
            ["role": "user", "content": user]
        ]
    }

    struct ReviewContext {
        var moveText: String
        var result: String
        var endBoard: [Int8]
        var evalTrace: [String]
        /// 结构化事实，来自 `ReviewDigest.promptLines`。
        /// 有它的时候优先用它，`evalTrace` 只是旧存档的退路。
        var digestLines: [String] = []
    }

    /// 赛后复盘。
    ///
    /// 这里改过一版，值得说明为什么：原来只把「第 N 手 <分数>」这一串数字
    /// 连成一长条给模型，而每手的 grade / loss / bestLabel / phase / missedMate
    /// 明明都算出来了却没传 —— 模型拿到一串没有语义的分数，只能靠猜去指认
    /// 「哪一步是转折点」，指错的时候人还看不出来（因为输出很像回事）。
    ///
    /// 现在的事实来自 ReviewDigest：哪一手、丢了多少分、评价是什么、
    /// 引擎建议走哪里，都是确定的。模型只负责把「为什么」讲清楚、给练习建议。
    /// 并且明确禁止它另造着法 —— 复盘里出现的着法必须能对回引擎给的那一条。
    static func review(_ ctx: ReviewContext) -> [[String: String]] {
        var lines: [String] = []
        lines.append("【对局记录】")
        lines.append(ctx.moveText.isEmpty ? "（无）" : ctx.moveText)
        lines.append("")
        lines.append("【结果】\(ctx.result)")
        if !ctx.digestLines.isEmpty {
            lines.append("")
            lines.append(contentsOf: ctx.digestLines)
        } else if !ctx.evalTrace.isEmpty {
            lines.append("")
            lines.append("【引擎评估变化】（每手红方视角，单位厘兵）")
            lines.append(ctx.evalTrace.joined(separator: "，"))
        }
        lines.append("")
        lines.append("【终局面】")
        lines.append(boardASCII(ctx.endBoard))
        lines.append("")
        lines.append("【任务】写一份复盘报告，用小标题分成三段：")
        lines.append("1. 开局：布局是否合理，有没有明显失先手；")
        lines.append("2. 中局：从上面「关键时刻」里挑最重要的 1～2 处，说明这一步错在哪、为什么引擎建议的那一步更好；")
        lines.append("3. 总结：给 2～3 条可以马上练习的改进建议，并指出对应上面哪个阶段。")
        lines.append("【硬性要求】")
        lines.append("· 只允许引用上面已经列出的着法与分数，不要自己另算或另造着法；")
        lines.append("· 如果某个阶段的数据不足（手数很少），就直说「样本太少，先不下结论」；")
        lines.append("· 全文不要超过 500 字。")
        return [
            ["role": "system", "content": systemCoach + "你正在做赛后复盘。"],
            ["role": "user", "content": lines.joined(separator: "\n")]
        ]
    }

    static func pickMove(board: [Int8], side: Side, candidates: [CandidateMove]) -> [[String: String]] {
        var lines: [String] = []
        lines.append("【局面】")
        lines.append(boardASCII(board))
        lines.append("")
        lines.append("你执\(side.shortLabel)方。")
        lines.append("")
        lines.append("【可选着法】下面是引擎算出的合法着法，你只能从中选一个：")
        for (i, c) in candidates.enumerated() {
            lines.append("  \(i + 1). \(c.label)（引擎评估 \(c.score)）")
        }
        lines.append("")
        lines.append("【输出格式】严格只输出一行 JSON，不要任何其他内容：")
        lines.append("{\"move\":\"这里填着法名称，必须与上面列表完全一致\",\"reason\":\"一句话理由，不超过 40 字\"}")
        return [
            ["role": "system", "content": "你是一位中国象棋高手，现在正处于对局中。只输出 JSON。"],
            ["role": "user", "content": lines.joined(separator: "\n")]
        ]
    }
}
