package com.peter260807.xiangqicoach.data

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.peter260807.xiangqicoach.engine.GameRecord
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** 存档文件的结构。字段名与 iOS / 网页版保持一致，方便跨端迁移。 */
@Serializable
data class ArchivePayload(
    val games: List<GameRecord> = emptyList(),
    /** 已通关的练习 id（带 `"mate:"` 前缀）。 */
    val solved: Map<String, String> = emptyMap(),
    /** 每个练习点开过几次。 */
    val attempts: Map<String, Int> = emptyMap(),
)

/**
 * 存档落盘：一个 JSON 文件。
 *
 * 为什么不用 Room / DataStore：
 *  - 数据量很小（最多 200 盘棋），JSON 足够；
 *  - **跨端可迁移**：iOS 与网页版存的也是 JSON，字段同名，
 *    用户把文件拷到 Android 上就能接着看（`ArchivePayload` 因此刻意用默认值，
 *    任何一端加了新字段，另一端读到也不会崩）；
 *  - 单测不需要 Android 运行时（`GameRecord` 的序列化在纯 JVM 上就能验）。
 *
 * ⚠️ **写入必须原子**：先写临时文件再 rename。直接覆写的话，
 * 写到一半被杀进程会留下一个半截 JSON —— 下次启动整个存档都读不出来。
 */
class GameStore(private val file: File) {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    var payload: ArchivePayload by mutableStateOf(ArchivePayload())
        private set

    /** 读盘。文件不存在 / 内容坏了都退化成空存档，绝不抛异常炸启动。 */
    fun load() {
        payload = try {
            if (file.exists()) {
                json.decodeFromString(ArchivePayload.serializer(), file.readText())
            } else {
                ArchivePayload()
            }
        } catch (e: Exception) {
            // 坏文件不静默丢弃：改名留档，免得用户以为「战绩莫名其妙没了」
            try {
                file.renameTo(File(file.parentFile, file.name + ".corrupt"))
            } catch (_: Exception) {
                // 改名失败也只能继续
            }
            ArchivePayload()
        }
    }

    private fun persist() {
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(json.encodeToString(ArchivePayload.serializer(), payload))
            if (!tmp.renameTo(file)) {
                // 某些文件系统上 rename 到已存在的目标会失败，退回直接写
                file.writeText(tmp.readText())
                tmp.delete()
            }
        } catch (_: Exception) {
            // 落盘失败不该让界面崩掉；数据仍在内存里，下次操作会再试
        }
    }

    // ---------- 对局 ----------

    /** 最多留 200 盘，与 iOS 一致。 */
    private val maxGames = 200

    fun save(record: GameRecord) {
        val list = payload.games.toMutableList()
        val idx = list.indexOfFirst { it.id == record.id }
        if (idx >= 0) list[idx] = record else list.add(0, record)
        val sorted = list.sortedByDescending { it.savedAt }
        payload = payload.copy(games = sorted.take(maxGames))
        persist()
    }

    fun delete(id: String) {
        payload = payload.copy(games = payload.games.filterNot { it.id == id })
        persist()
    }

    fun clearGames() {
        payload = payload.copy(games = emptyList())
        persist()
    }

    fun resetAll() {
        payload = ArchivePayload()
        persist()
    }

    // ---------- 练习 ----------

    fun markAttempt(sceneId: String) {
        val a = payload.attempts.toMutableMap()
        a[sceneId] = (a[sceneId] ?: 0) + 1
        payload = payload.copy(attempts = a)
        persist()
    }

    /** @return 是否**首次**通关 */
    fun markSolved(sceneId: String): Boolean {
        if (payload.solved.containsKey(sceneId)) return false
        val s = payload.solved.toMutableMap()
        s[sceneId] = java.time.Instant.now().toString()
        payload = payload.copy(solved = s)
        persist()
        return true
    }

    val solvedIds: Set<String> get() = payload.solved.keys
}
