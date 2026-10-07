package com.peter260807.xiangqicoach.engine

/**
 * 走子方。
 *
 * `v` 与 Swift `enum Side: Int8`、JS 里的 `'r' / 'b'` 一一对应；
 * 持久化（存档 JSON）里存的是 key 字符串，**不要存序号** —— 序号会随枚举顺序漂移。
 */
enum class Side(val v: Int) {
    RED(0),
    BLACK(1);

    val other: Side get() = if (this == RED) BLACK else RED

    /** 界面文案，与 iOS `Side.label` 一致。 */
    val label: String get() = if (this == RED) "红方" else "黑方"

    /** 短文案，与 iOS `Side.shortLabel` 一致。 */
    val shortLabel: String get() = if (this == RED) "红" else "黑"

    /** 存档 / 接口里的 key。 */
    val key: String get() = if (this == RED) "red" else "black"

    companion object {
        fun ofKey(key: String?): Side = if (key == "black" || key == "b") BLACK else RED
    }
}

/**
 * 棋子编码。
 *
 * - `0` 空
 * - `1..7`  红：帅 仕 相 马 车 炮 兵
 * - `8..14` 黑：将 士 象 马 车 炮 卒
 *
 * ⚠️ **刻意不用 enum class**：搜索里每个节点都要按格比较棋子，
 * 枚举会带来装箱与 `values()` 数组访问，在几十万节点/秒的量级上是实打实的成本。
 * 这里用 `Int` 常量 + `ByteArray`，与 iOS 的 `Int8` 布局逐位对应。
 */
object Piece {
    const val EMPTY: Int = 0

    /** 棋子类型，与红黑无关：0 将 1 士 2 象 3 马 4 车 5 炮 6 兵。 */
    const val TYPE_KING: Int = 0
    const val TYPE_ADVISOR: Int = 1
    const val TYPE_ELEPHANT: Int = 2
    const val TYPE_HORSE: Int = 3
    const val TYPE_ROOK: Int = 4
    const val TYPE_CANNON: Int = 5
    const val TYPE_PAWN: Int = 6

    const val TYPE_COUNT: Int = 7

    fun isRed(code: Int): Boolean = code in 1..7

    fun side(code: Int): Side = if (code <= 7) Side.RED else Side.BLACK

    /**
     * 棋子编码 → 类型。
     *
     * ⚠️ 传 0（空格）进来是调用方的 bug，这里不抛异常、返回 TYPE_KING 以外没有好答案，
     * 所以显式要求调用方先判空；函数本身用 `Math.floorMod` 语义即可。
     */
    fun type(code: Int): Int = if (code <= 7) code - 1 else code - 8

    fun code(type: Int, side: Side): Byte = (if (side == Side.RED) type + 1 else type + 8).toByte()

    /**
     * 显示用汉字，索引即编码。
     *
     * ⚠️ 下标 4（红马）与 11（黑马）看着重复是**对的** —— 马在两边的写法相同。
     */
    val chars: CharArray = charArrayOf(
        '.', '帅', '仕', '相', '马', '车', '炮', '兵',
        '将', '士', '象', '马', '车', '炮', '卒',
    )

    fun name(code: Int): String =
        if (code > 0 && code < chars.size) chars[code].toString() else "?"

    /** 从 FEN 字符解析（K=帅 A=仕 B=相 N=马 R=车 C=炮 P=兵，小写为黑）。 */
    val fromChar: Map<Char, Byte> = mapOf(
        'K' to 1, 'A' to 2, 'B' to 3, 'N' to 4, 'R' to 5, 'C' to 6, 'P' to 7,
        'k' to 8, 'a' to 9, 'b' to 10, 'n' to 11, 'r' to 12, 'c' to 13, 'p' to 14,
    )

    /**
     * 编码 → FEN 字符，索引即编码。
     *
     * ⚠️ iOS 侧是用 `fromChar.first(where: { $0.value == p })` **线性反查**的，
     * 依赖字典序恰好正确。这里改成一张固定的反查表：既快，
     * 也不会因为 `fromChar` 的书写顺序变化而悄悄改变 FEN 输出
     * （那会让「重复局面」的判定跟着变）。
     */
    val toChar: CharArray = charArrayOf(
        '.', 'K', 'A', 'B', 'N', 'R', 'C', 'P',
        'k', 'a', 'b', 'n', 'r', 'c', 'p',
    )

    fun charOf(code: Byte): Char {
        val i = code.toInt()
        return if (i > 0 && i < toChar.size) toChar[i] else '.'
    }
}

/**
 * 一手棋：起点格与终点格（索引 = row * 9 + col）。
 *
 * 热路径对象，**刻意不用 data class**：搜索里会创建几十万个，
 * 手写 equals/hashCode 比 data class 生成的版本少一层类型检查。
 */
class Move(val from: Int, val to: Int) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Move) return false
        return from == other.from && to == other.to
    }

    override fun hashCode(): Int = from * 31 + to

    /** 调试用坐标串，与 UCI 的 `a0`…`i9` 表示一致。 */
    override fun toString(): String = "${sq(from)}${sq(to)}"

    companion object {
        fun sq(i: Int): String = "${('a' + i % 9)}${i / 9}"

        /** 解析 "h2e2" 这样的 UCI 着法串；不合法返回 null。 */
        fun parse(s: String): Move? {
            if (s.length != 4) return null
            val f = parseSq(s[0], s[1]) ?: return null
            val t = parseSq(s[2], s[3]) ?: return null
            return Move(f, t)
        }

        private fun parseSq(f: Char, r: Char): Int? {
            if (f !in 'a'..'i') return null
            if (r !in '0'..'9') return null
            return (r - '0') * 9 + (f - 'a')
        }
    }
}

/** 对局层的终局裁决。`winner` 为 null 表示和棋。 */
class Adjudication(val winner: Side?, val reason: String) {
    override fun toString(): String = "Adjudication(winner=$winner, reason=$reason)"
}
