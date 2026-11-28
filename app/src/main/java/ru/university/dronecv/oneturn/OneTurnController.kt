package ru.university.dronecv.oneturn

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import ru.university.dronecv.camera.TargetSignal
import ru.university.dronecv.timeline.quote
import java.util.UUID

const val ONE_TURN_MAX_AGE_MS = 2500.0
const val ONE_TURN_DEAD_ZONE_FRACTION = 0.10

data class OneTurnRequest(val attemptId: String, val armedNs: Long, val signal: TargetSignal, val ageMs: Double, val stillAllowed: () -> Boolean = { true }) {
    val offsetX get() = checkNotNull(signal.center).x - signal.width / 2.0
    fun json(token: String): String = "{\"schema\":1,\"token\":${quote(token)},\"attempt_id\":${quote(attemptId)}," +
        "\"frame_id\":${signal.frameId},\"source_id\":${signal.sourceId},\"capture_ns\":${quote(signal.stamp.captureNs.toString())}," +
        "\"armed_ns\":${quote(armedNs.toString())},\"age_ms\":$ageMs,\"offset_x\":$offsetX,\"width\":${signal.width},\"direction\":\"right\"}"
}
data class OneTurnReply(val status: String, val message: String, val yawBefore: Double? = null, val yawAfter: Double? = null)
fun interface OneTurnTransport { suspend fun send(request: OneTurnRequest): OneTurnReply }
enum class OneTurnPhase { IDLE, ARMED, SENDING }
data class OneTurnState(val phase: OneTurnPhase = OneTurnPhase.IDLE, val message: String = "Ожидание нажатия", val attemptId: String? = null)
data class OneTurnEvent(val attemptId: String, val timeNs: Long, val kind: String, val request: OneTurnRequest? = null, val reply: OneTurnReply? = null) {
    fun json(): String = "{\"schema_version\":1,\"attempt_id\":${quote(attemptId)},\"time_ns\":${quote(timeNs.toString())},\"kind\":${quote(kind)}," +
        "\"frame_id\":${request?.signal?.frameId},\"source_id\":${request?.signal?.sourceId}," +
        "\"armed_ns\":${request?.armedNs?.let { quote(it.toString()) } ?: "null"},\"capture_ns\":${request?.signal?.stamp?.captureNs?.let { quote(it.toString()) } ?: "null"}," +
        "\"offset_x_px\":${request?.offsetX},\"width\":${request?.signal?.width},\"direction\":${if (request == null) "null" else "\"right\""}," +
        "\"age_ms\":${request?.ageMs},\"max_age_ms\":$ONE_TURN_MAX_AGE_MS,\"dead_zone_fraction\":$ONE_TURN_DEAD_ZONE_FRACTION," +
        "\"status\":${reply?.status?.let(::quote) ?: "null"},\"message\":${reply?.message?.let(::quote) ?: "null"}," +
        "\"yaw_before\":${reply?.yawBefore},\"yaw_after\":${reply?.yawAfter}}"
}

/** A permit is consumed before starting I/O. Only a new explicit arm can create another attempt. */
class OneTurnController(private val scope: CoroutineScope, private val now: () -> Long,
                        private val transport: OneTurnTransport, private val newId: () -> String = { UUID.randomUUID().toString() }) {
    private val lock = Any()
    private val mutableState = MutableStateFlow(OneTurnState())
    val state = mutableState.asStateFlow()
    private data class Permit(val id: String, val source: Long, val armedNs: Long, val audit: (OneTurnEvent) -> Unit, val valid: java.util.concurrent.atomic.AtomicBoolean = java.util.concurrent.atomic.AtomicBoolean(true))
    private var permit: Permit? = null
    private var active: Permit? = null
    private var activeRequest: OneTurnRequest? = null
    private var auditClosed = false
    private var seenFrame = 0L
    private var timer: Job? = null
    private var closed = false

    fun arm(source: Long, audit: (OneTurnEvent) -> Unit): Boolean = synchronized(lock) {
        if (closed || mutableState.value.phase != OneTurnPhase.IDLE) return false
        val p = Permit(newId(), source, now(), audit)
        permit = p; seenFrame = 0; auditClosed = false
        mutableState.value = OneTurnState(OneTurnPhase.ARMED, "Жду новый кадр с рамкой справа · до 30 с", p.id)
        p.audit(OneTurnEvent(p.id, p.armedNs, "armed"))
        timer = scope.launch { delay(30_000); synchronized(lock) {
            if (permit === p) finishWaiting(p, "Ожидание кадра завершено", "arm_timeout")
        } }
        true
    }

    fun observe(signal: TargetSignal): Unit = synchronized(lock) {
        val p = permit ?: return
        if (signal.sourceId != p.source) { finishWaiting(p, "Источник камеры изменён", "source_changed"); return }
        if (signal.frameId <= seenFrame) return
        seenFrame = signal.frameId
        val currentNs = now()
        val age = signal.stamp.ageAt(currentNs)
        val capture = signal.stamp.captureNs
        val reason = when {
            signal.timingIssue != null || age == null -> "unknown_clock"
            capture == null || capture <= p.armedNs -> "before_arm"
            age > ONE_TURN_MAX_AGE_MS -> "stale_frame"
            signal.center == null -> "no_target"
            signal.center.x - signal.width / 2.0 <= signal.width * ONE_TURN_DEAD_ZONE_FRACTION -> "not_right_of_dead_zone"
            else -> null
        }
        if (reason != null) {
            p.audit(OneTurnEvent(p.id, currentNs, reason))
            return
        }
        val request = OneTurnRequest(p.id, p.armedNs, signal, checkNotNull(age), p.valid::get)
        permit = null; active = p; activeRequest = request; timer?.cancel()
        mutableState.value = OneTurnState(OneTurnPhase.SENDING, "Одна попытка: вправо на 3° · ожидаю DJI", p.id)
        p.audit(OneTurnEvent(p.id, currentNs, "selected", request))
        scope.launch {
            val reply = try {
                // The coroutine may have waited for a dispatcher; recheck exposure age before transport.
                val sendAge = signal.stamp.ageAt(now())
                if (!p.valid.get()) OneTurnReply("cancelled", "Источник камеры изменён до отправки")
                else if (sendAge == null || sendAge > ONE_TURN_MAX_AGE_MS) OneTurnReply("rejected", "Кадр устарел до отправки")
                else withTimeout(15_000) { transport.send(request.copy(ageMs = sendAge)) }
            } catch (_: TimeoutCancellationException) {
                OneTurnReply("timeout", "Тайм-аут: поворот мог произойти, повтор не отправлен")
            } catch (_: CancellationException) {
                OneTurnReply("cancelled", "Попытка прервана: поворот мог произойти")
            } catch (e: Exception) {
                OneTurnReply("error", "Ошибка канала: ${e.message ?: e.javaClass.simpleName}. Повтор не отправлен")
            }
            synchronized(lock) {
                if (!auditClosed) p.audit(OneTurnEvent(p.id, now(), "result", request, reply))
                if (active === p) {
                    active = null; activeRequest = null
                    mutableState.value = OneTurnState(message = "${reply.message} · ожидание нового нажатия", attemptId = p.id)
                }
            }
        }
    }
    fun invalidate(): Unit = synchronized(lock) {
        active?.valid?.set(false)
        permit?.let { finishWaiting(it, "Разрешение снято: камера остановлена или изменена", "invalidated") }
    }
    private fun finishWaiting(p: Permit, message: String, kind: String) {
        permit = null; timer?.cancel()
        p.audit(OneTurnEvent(p.id, now(), kind))
        mutableState.value = OneTurnState(message = message, attemptId = p.id)
    }
    /** Record uncertainty before a diagnostic writer is sealed; an already sent command cannot be recalled. */
    fun endDiagnostic(): Unit = synchronized(lock) {
        invalidate()
        active?.let { p ->
            if (!auditClosed) p.audit(OneTurnEvent(p.id, now(), "result", activeRequest,
                OneTurnReply("interrupted", "Диагностика закрыта до ответа; поворот мог произойти, итог на Mac")))
            auditClosed = true
        }
    }
    fun close() = synchronized(lock) { closed = true; invalidate() }
}
