package com.peter260807.xiangqicoach.ai

import com.peter260807.xiangqicoach.engine.CandidateMove
import com.peter260807.xiangqicoach.engine.Piece
import com.peter260807.xiangqicoach.engine.ReviewDigest
import com.peter260807.xiangqicoach.engine.Rules
import com.peter260807.xiangqicoach.engine.Side

/**
 * 提示词构造。棋盘用等宽文字画给模型看 —— 比只给 FEN 准确得多。
 *
 * 与 iOS `Prompts.swift` **逐字对齐**：提示词是"模型行为"的一部分，
 * 两端不一致会让同一个局面在两个平台上得到不同的点评质量，
 * 而这种差异极难归因（看起来都"挺像回事"）。
 */
object Prompts {

    const val SYSTEM_COACH =
        "你是一位中国象棋教练，面向初学者讲解。回答要求：只讲最关键的东西；用简体中文；" +
            "不堆砌术语，每个术语首次出现时用一句话解释；" +
            "涉及具体着法时必须用标准中文棋谱记法（如「炮二平五」「马八进七」）。"

    /** 把棋盘画成等宽文字。 */
    fun boardAscii(b: ByteArray): String {
        val lines = ArrayList<String>(13)
        lines.add("     a  b  c  d  e  f  g  h  i")
        for (r in 0 until 10) {
            val sb = StringBuilder()
            sb.append(' ').append(9 - r).append("   ")
            for (c in 0 until 9) {
                val p = b[r * 9 + c].toInt()
                sb.append(if (p == 0) "·" else Piece.name(p)).append("  ")
            }
            lines.add(sb.toString())
        }
        lines.add("     a  b  c  d  e  f  g  h  i")
        lines.add("（红方在下（第 9 行），黑方在上（第 0 行）；字母为纵线，数字为横线）")
        return lines.joinToString("\n")
    }

    class PositionContext(
        val board: ByteArray,
        val side: Side,
        val moveText: String,
        val engineScore: Int,
        val candidates: List<CandidateMove>,
        val inCheck: Boolean,
    )

    fun positionBrief(ctx: PositionContext): String {
        val lines = ArrayList<String>()
        lines.add("【当前局面】")
        lines.add(boardAscii(ctx.board))
        lines.add("")
        lines.add("到谁走：${ctx.side.label}")
        if (ctx.moveText.isNotEmpty()) lines.add("已走着法：${ctx.moveText}")
        lines.add("本地引擎评估（红方视角，单位厘兵，正数红优）：${ctx.engineScore}")
        if (ctx.candidates.isNotEmpty()) {
            lines.add("引擎筛选出的候选着法（已验证合法）：")
            for ((i, c) in ctx.candidates.withIndex()) {
                lines.add("  ${i + 1}. ${c.label}（评估 ${c.score}）")
            }
        }
        if (ctx.inCheck) lines.add("注意：当前有一方正被将军。")
        return lines.joinToString("\n")
    }

    fun coach(ctx: PositionContext, question: String?): List<Map<String, String>> {
        var user = positionBrief(ctx)
        if (!question.isNullOrEmpty()) {
            user += "\n\n【棋友提问】$question"
        } else {
            user += "\n\n【任务】点评这个局面，告诉我现在该怎么想、推荐走哪一步、为什么。不要超过 220 字。"
        }
        return listOf(
            mapOf("role" to "system", "content" to SYSTEM_COACH),
            mapOf("role" to "user", "content" to user),
        )
    }

    class ReviewContext(
        val moveText: String,
        val result: String,
        val endBoard: ByteArray,
        val evalTrace: List<String>,
        /**
         * 结构化事实，来自 [ReviewDigest.promptLines]。
         * 有它的时候优先用它，[evalTrace] 只是旧存档的退路。
         */
        val digestLines: List<String> = emptyList(),
    )

    /**
     * 赛后复盘。
     *
     * 这里改过一版，值得说明为什么：原来只把「第 N 手 <分数>」这一串数字
     * 连成一长条给模型，而每手的 grade / loss / bestLabel / phase / missedMate
     * 明明都算出来了却没传 —— 模型拿到一串没有语义的分数，只能靠猜去指认
     * 「哪一步是转折点」，指错的时候人还看不出来（因为输出很像回事）。
     *
     * 现在的事实来自 ReviewDigest：哪一手、丢了多少分、评价是什么、
     * 引擎建议走哪里，都是确定的。模型只负责把「为什么」讲清楚、给练习建议。
     * 并且明确禁止它另造着法 —— 复盘里出现的着法必须能对回引擎给的那一条。
     */
    fun review(ctx: ReviewContext): List<Map<String, String>> {
        val lines = ArrayList<String>()
        lines.add("【对局记录】")
        lines.add(if (ctx.moveText.isEmpty()) "（无）" else ctx.moveText)
        lines.add("")
        lines.add("【结果】${ctx.result}")
        if (ctx.digestLines.isNotEmpty()) {
            lines.add("")
            lines.addAll(ctx.digestLines)
        } else if (ctx.evalTrace.isNotEmpty()) {
            lines.add("")
            lines.add("【引擎评估变化】（每手红方视角，单位厘兵）")
            lines.add(ctx.evalTrace.joinToString("，"))
        }
        lines.add("")
        lines.add("【终局面】")
        lines.add(boardAscii(ctx.endBoard))
        lines.add("")
        lines.add("【任务】写一份复盘报告，用小标题分成三段：")
        lines.add("1. 开局：布局是否合理，有没有明显失先手；")
        lines.add("2. 中局：从上面「关键时刻」里挑最重要的 1～2 处，说明这一步错在哪、为什么引擎建议的那一步更好；")
        lines.add("3. 总结：给 2～3 条可以马上练习的改进建议，并指出对应上面哪个阶段。")
        lines.add("【硬性要求】")
        lines.add("· 只允许引用上面已经列出的着法与分数，不要自己另算或另造着法；")
        lines.add("· 如果某个阶段的数据不足（手数很少），就直说「样本太少，先不下结论」；")
        lines.add("· 全文不要超过 500 字。")
        return listOf(
            mapOf("role" to "system", "content" to SYSTEM_COACH + "你正在做赛后复盘。"),
            mapOf("role" to "user", "content" to lines.joinToString("\n")),
        )
    }

    /** 混合对弈：不让模型直接下棋，而是从引擎候选里挑一个并说明理由。 */
    fun pickMove(board: ByteArray, side: Side, candidates: List<CandidateMove>): List<Map<String, String>> {
        val lines = ArrayList<String>()
        lines.add("【局面】")
        lines.add(boardAscii(board))
        lines.add("")
        lines.add("你执${side.shortLabel}方。")
        lines.add("")
        lines.add("【可选着法】下面是引擎算出的合法着法，你只能从中选一个：")
        for ((i, c) in candidates.withIndex()) {
            lines.add("  ${i + 1}. ${c.label}（引擎评估 ${c.score}）")
        }
        lines.add("")
        lines.add("【输出格式】严格只输出一行 JSON，不要任何其他内容：")
        lines.add("{\"move\":\"这里填着法名称，必须与上面列表完全一致\",\"reason\":\"一句话理由，不超过 40 字\"}")
        return listOf(
            mapOf("role" to "system", "content" to "你是一位中国象棋高手，现在正处于对局中。只输出 JSON。"),
            mapOf("role" to "user", "content" to lines.joinToString("\n")),
        )
    }

    /** 连通性测试用的短问答（预算小、要快）。 */
    fun ping(): List<Map<String, String>> = listOf(
        mapOf("role" to "system", "content" to "你是中国象棋助手，回答尽量短。"),
        mapOf("role" to "user", "content" to "用一句话说明「炮二平五」是什么意思。"),
    )

    /** 把局面导出成 FEN（给提示词里偶尔要用的场景）。 */
    fun fenOf(board: ByteArray): String = Rules.fen(board)
}
