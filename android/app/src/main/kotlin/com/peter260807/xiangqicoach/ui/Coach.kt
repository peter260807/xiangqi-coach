package com.peter260807.xiangqicoach.ui

import com.peter260807.xiangqicoach.ai.AIConfig
import com.peter260807.xiangqicoach.ai.LLMClient
import com.peter260807.xiangqicoach.ai.Prompts
import com.peter260807.xiangqicoach.engine.CandidateMove
import com.peter260807.xiangqicoach.engine.Engine
import com.peter260807.xiangqicoach.engine.Notation
import com.peter260807.xiangqicoach.engine.Rules
import com.peter260807.xiangqicoach.engine.Side

/**
 * 局面点评 / 整局复盘。
 *
 * 关键设计（与 iOS 一致）：**把棋盘图、引擎评估、候选着法一起喂给模型**。
 * 只给 FEN 的话模型得自己解析局面，出错概率高得多；
 * 而候选着法是引擎算出来并验证过合法的，模型只要"在正确选项里解释"。
 */
object Coach {

    /** 局面点评。候选着法由调用方从引擎取（`requestHint` 的回调）。 */
    suspend fun ask(vm: GameViewModel, config: AIConfig, candidates: List<CandidateMove>): String {
        val board = vm.board
        val side = vm.turn
        val ctx = Prompts.PositionContext(
            board = board,
            side = side,
            moveText = Notation.movesToText(vm.scene.startFen, vm.history.map { it.move }),
            engineScore = vm.redScore,
            candidates = candidates,
            inCheck = Rules.inCheck(board, side),
        )
        val r = LLMClient.chat(
            messages = Prompts.coach(ctx, null),
            config = config,
            // 点评的思维链实测 770~6800，所以跟随设置里的预算（默认 5 万）
            maxTokens = null,
            temperature = 0.4,
        )
        return bodyOrExplain(r, "局面点评")
    }

    /**
     * 整局复盘。
     *
     * 分两层，顺序是有意的：
     *  1. **本地复盘卡**（不需要 Key、不需要网络，毫秒出）—— 直接读已经算好的逐手数据；
     *  2. **大模型讲解**（可选）—— 把①那份结构化事实整段喂进去，模型只负责讲「为什么」和「练什么」。
     *
     * 这两层原来是绑死的（点复盘先要求配好 Key），于是没配 Key 就完全用不了复盘 ——
     * 而复盘最有价值的那部分信息本来就在本地。
     */
    suspend fun review(vm: GameViewModel, config: AIConfig): String {
        val digest = vm.reviewDigest()
            ?: return "这盘还没有逐手分析数据（可能一手都没走，或者是很老的存档）。"
        if (!config.isConfigured) {
            // 退化路径：把本地那份直接给用户，而不是报错
            return digest.text
        }
        val record = vm.currentRecord
        val ctx = Prompts.ReviewContext(
            moveText = vm.exportMoveText,
            result = record?.resultLabel ?: "未完",
            endBoard = vm.board,
            evalTrace = record?.evals?.map { "第${it.ply}手 ${it.redScore}" } ?: emptyList(),
            digestLines = digest.promptLines,
        )
        val r = LLMClient.chat(
            messages = Prompts.review(ctx),
            config = config,
            maxTokens = null,
            temperature = 0.5,
        )
        val body = bodyOrExplain(r, "复盘")
        return "【本地复盘卡】（引擎算出来的，不需要网络）\n\n${digest.text}\n\n" +
            "──────────\n\n【大模型讲解】\n\n$body"
    }

    /**
     * 连通性测试：用很小的预算问一句，图快。
     *
     * 短问答的思维链实测约 43，所以这里显式给 1500 而不是跟随设置里的 5 万 ——
     * 测试要的是「几秒内知道通不通」。
     */
    suspend fun ping(config: AIConfig): String {
        val r = LLMClient.chat(
            messages = Prompts.ping(),
            config = config,
            maxTokens = 1500,
            temperature = 0.3,
        )
        return bodyOrExplain(r, "连通性测试")
    }

    /**
     * 取出正文；正文为空而思维链非空时，给一句能看出问题所在的说明。
     *
     * 这个分支很常见（推理模型把预算全用在思维链上），而 HTTP 状态码是 200、
     * 界面上什么都不显示 —— 不写清楚的话用户只会以为"点了没反应"。
     */
    private fun bodyOrExplain(r: LLMClient.Result, what: String): String {
        val body = r.content.trim()
        if (body.isNotEmpty()) {
            return if (r.truncated) "$body\n\n⚠️ 输出被 max_tokens 截断了（finish_reason=length），" +
                "可以到设置里把「模型输出上限」调大。" else body
        }
        if (r.reasoning.isNotBlank()) {
            return "模型只输出了思维链，正文是空的。\n\n" +
                "这次用了 ${r.maxTokensUsed} 的 max_tokens，而思维链本身约占 ${r.reasoningTokens}。" +
                "客户端会自动加倍重试一次；仍然为空的话，请到设置里把「模型输出上限」调大。"
        }
        return "$what 没有返回任何内容（completion_tokens=${r.completionTokens}）。"
    }
}
