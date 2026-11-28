package ru.university.dronecv.oneturn

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import ru.university.dronecv.BuildConfig
import ru.university.dronecv.diagnostics.DiagnosticFrames
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/** Loopback reaches the Mac only through the explicitly installed ADB reverse rule. No retry. */
internal class AdbOneTurnTransport(private val token: String) : OneTurnTransport {
    override suspend fun send(request: OneTurnRequest): OneTurnReply = withContext(Dispatchers.IO) {
        try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress("127.0.0.1", 18765), 2000)
                socket.soTimeout = 12_000
                val age = request.signal.stamp.ageAt(SystemClock.elapsedRealtimeNanos())
                if (!request.stillAllowed()) return@withContext OneTurnReply("cancelled", "Источник камеры изменён до отправки")
                if (age == null || age > ONE_TURN_MAX_AGE_MS) return@withContext OneTurnReply("rejected", "Кадр устарел до отправки")
                val output = socket.getOutputStream()
                output.write((request.copy(ageMs = age).json(token) + "\n").toByteArray(Charsets.UTF_8)); output.flush()
                val input = socket.getInputStream()
                val response = StringBuilder()
                while (true) {
                    val b = input.read()
                    require(b >= 0) { "Mac закрыл канал без ответа" }
                    if (b == 10) break
                    require(response.length < 16_384) { "Слишком длинный ответ Mac" }
                    response.append(b.toChar())
                }
                val json = JSONObject(response.toString())
                require(json.getString("attempt_id") == request.attemptId) { "Ответ другой попытки" }
                val status = json.getString("status")
                require(status in setOf("success", "error", "timeout", "rejected")) { "Неизвестный статус Mac" }
                fun angle(key: String): Double? = if (json.isNull(key)) null else json.getDouble(key).also { require(it.isFinite()) }
                val before = angle("yaw_before"); val after = angle("yaw_after")
                val message = when (status) {
                    "success" -> "DJI: поворот выполнен · yaw $before → $after°"
                    "timeout" -> "Тайм-аут DJI: поворот мог произойти, повтор не отправлен"
                    "rejected" -> "Mac отклонил запрос: ${json.optString("message")}"
                    else -> "Ошибка DJI: ${json.optString("message")}. Повтор не отправлен"
                }
                OneTurnReply(status, message, before, after)
            }
        } catch (_: SocketTimeoutException) {
            OneTurnReply("timeout", "Тайм-аут канала: поворот мог произойти, повтор не отправлен")
        }
    }
}

class OneTurnViewModel internal constructor(
    transport: OneTurnTransport,
    val configured: Boolean,
    now: () -> Long = SystemClock::elapsedRealtimeNanos,
) : ViewModel() {
    constructor() : this(
        AdbOneTurnTransport(BuildConfig.ONE_TURN_TOKEN),
        BuildConfig.DEBUG && BuildConfig.ONE_TURN_TOKEN.isNotBlank(),
    )

    val controller = OneTurnController(viewModelScope, now, transport)
    val state = controller.state
    fun arm(source: Long, frames: DiagnosticFrames): Boolean {
        if (!configured) return false
        val token = frames.currentToken() ?: return false
        if (!frames.hasTimeline(token)) return false
        return controller.arm(source) { event -> frames.event(token, "one_turn", event.json(), event.timeNs) }
    }
    override fun onCleared() { controller.close() }
}
