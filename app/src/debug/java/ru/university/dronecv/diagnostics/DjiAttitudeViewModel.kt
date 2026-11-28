package ru.university.dronecv.diagnostics

import android.app.Application
import android.os.SystemClock
import android.util.Log
import androidx.annotation.MainThread
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference
import kotlin.random.Random
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import ru.university.dronecv.camera.LiveController
import ru.university.dronecv.camera.TargetSignal
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Outcome
import ru.university.dronecv.gimbal.DjiRsAttitudeReader
import ru.university.dronecv.gimbal.DjiRsAttitudeReply
import ru.university.dronecv.weact.ClassicStreamProfile
import ru.university.dronecv.weact.GimbalNudge
import ru.university.dronecv.weact.NudgeAttitudeUnavailable
import ru.university.dronecv.weact.NudgeAxis
import ru.university.dronecv.weact.NudgeEvent
import ru.university.dronecv.weact.NudgePositionInvalid
import ru.university.dronecv.weact.NudgePositionRejected
import ru.university.dronecv.weact.NudgePositionTimeout
import ru.university.dronecv.weact.NudgeSample
import ru.university.dronecv.weact.SerialIo
import ru.university.dronecv.weact.SlcanCanTransmitUnconfirmed
import ru.university.dronecv.weact.SlcanDjiRsTransport
import ru.university.dronecv.weact.deltaFrom

private val profile = ClassicStreamProfile(bitrate = 1_000_000, txId = 0x223, rxId = 0x222)
private const val TIMEOUT_NS = 2_000_000_000L
private const val RECONNECT_TIMEOUT_MS = 10_000L
private const val RECONNECT_POLL_MS = 200L
private const val TAG = "DjiAttitude"
private const val CENTERING_TAG = "DjiCentering"

internal data class DjiAttitudeUi(
    val action: DjiAction? = null,
    val cancelling: Boolean = false,
    val firmware: String? = null,
    val status: String? = null,
    val turn: DjiTurnUi? = null,
)

internal enum class DjiAction(val progress: String, val sequenceCount: Int) {
    READ("Читаем углы DJI…", 1), TURN("Выполняем один поворот DJI…", 4),
    CENTER("Выполняется автоцентрирование DJI…", 5),
}

internal data class DjiTurnUi(
    val transmission: String = "Не начата",
    val confirmation: String = "Не отправлена",
    val yawDelta: Double? = null,
)

internal class DjiAttitudeViewModel(
    application: Application,
    private val openWeAct: suspend () -> WeActConnection,
    private val nowNs: () -> Long = SystemClock::elapsedRealtimeNanos,
    initialSequence: Int = Random.nextInt(0x10000),
    private val reconnectTimeoutMs: Long = RECONNECT_TIMEOUT_MS,
) : AndroidViewModel(application) {
    constructor(application: Application) : this(application, AndroidWeActUsb(application)::open)

    private val mutableUi = MutableStateFlow(DjiAttitudeUi())
    val ui = mutableUi.asStateFlow()
    private val mutableCentering = MutableStateFlow(PhysicalCenteringUi())
    val centering = mutableCentering.asStateFlow()
    private var nextSequence = initialSequence
    private var activeAttempt: Attempt? = null
    private var centeringJob: Job? = null

    @MainThread
    fun readOnce() = start(DjiAction.READ)

    @MainThread
    fun turnOnce() = start(DjiAction.TURN)

    @MainThread
    fun cancelTurn() {
        val attempt = activeAttempt ?: return
        if (attempt.action != DjiAction.TURN || !attempt.cancelAdmission()) return
        mutableUi.update { it.copy(cancelling = true) }
        attempt.job.cancel()
    }

    @MainThread
    fun startCentering(controller: LiveController<*>) {
        if (activeAttempt != null || centeringJob != null) return
        val manualUi = mutableUi.value
        val startNs = nowNs()
        mutableUi.value = DjiAttitudeUi(action = DjiAction.CENTER)
        mutableCentering.value = PhysicalCenteringUi(running = true)
        val job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            val session = checkNotNull(currentCoroutineContext()[Job])
            val frames = Channel<TargetSignal>(32)
            val port = CenteringPort()
            // The observer and the final USB admission both run under the controller's source lock.
            var latestObservation: TargetSignal? = null
            var lastUnsafe: TargetSignal? = null
            var reason = CenteringStop.SOURCE_CHANGED
            val observation = controller.observeActiveYolo(
                onSignal = { frame ->
                    latestObservation = frame
                    if (frame.center == null || frame.centeringIssue(startNs, nowNs(), PHYSICAL_CENTERING_POLICY.maxFrameAgeMs)?.stop != null) {
                        lastUnsafe = frame
                    }
                    if (frames.trySend(frame).isFailure) session.cancel(CenteringCancelled(CenteringStop.FRAME_OVERFLOW))
                },
                onInvalidated = { session.cancel(CenteringCancelled(CenteringStop.SOURCE_CHANGED)) },
            )
            try {
                if (observation != null) {
                    reason = runCenteringLoop(frames, startNs, PHYSICAL_CENTERING_POLICY, nowNs, ::recordFrame) { step, direction, frame, afterNs ->
                        runCenteringStep(port, step, direction) { admit ->
                            val sourceActive = controller.withActiveYoloSource { source ->
                                session.ensureActive()
                                val latest = checkNotNull(latestObservation)
                                if (source != frame.sourceId || source != latest.sourceId) {
                                    throw CenteringCancelled(CenteringStop.SOURCE_CHANGED)
                                }
                                checkCenteringAdmission(frame, latest, lastUnsafe, direction, afterNs, nowNs())?.let {
                                    throw FrameDisqualified(it)
                                }
                                admit()
                            }
                            if (!sourceActive) throw CenteringCancelled(CenteringStop.SOURCE_CHANGED)
                        }
                    }
                } else if (controller.withActiveYoloSource {}) {
                    reason = CenteringStop.SOURCE_BUSY
                }
            } catch (cancelled: CenteringCancelled) {
                reason = cancelled.reason
            } catch (cancelled: CancellationException) {
                reason = CenteringStop.STOPPED
                throw cancelled
            } catch (error: Exception) {
                Log.w(CENTERING_TAG, "Centering session failed", error)
                reason = CenteringStop.ERROR
            } finally {
                observation?.close()
                frames.cancel()
                if (port.opened != null) {
                    mutableCentering.update { it.copy(stopping = true) }
                    withContext(NonCancellable) {
                        try {
                            withContext(Dispatchers.IO) { port.close() }
                        } catch (error: Exception) {
                            Log.w(CENTERING_TAG, "Could not close WeAct CAN channel", error)
                            mutableCentering.update { it.copy(detail = it.detail ?:
                                (error as? IOException)?.displayFailure() ?: "Не удалось закрыть порт WeAct") }
                            if (reason == CenteringStop.CENTERED || reason == CenteringStop.STEP_LIMIT) reason = CenteringStop.ERROR
                        }
                    }
                }
                val result = mutableCentering.value.copy(running = false, stopping = false, reason = reason)
                Log.i(CENTERING_TAG, "finished reason=${reason.code} completed_steps=${result.completedSteps} " +
                    "offset_percent=${result.offsetPercent} frame_age_ms=${result.frameAgeMs} detail=${result.detail}")
                centeringJob = null
                mutableUi.value = manualUi
                mutableCentering.value = result
            }
        }
        centeringJob = job
        job.start()
    }

    @MainThread
    fun stopCentering(reason: CenteringStop = CenteringStop.STOPPED) {
        val job = centeringJob?.takeIf { it.isActive } ?: return
        activeAttempt?.cancelAdmission()
        mutableCentering.update { it.copy(stopping = true) }
        job.cancel(CenteringCancelled(reason))
    }

    private fun recordFrame(frame: TargetSignal, afterNs: Long, issue: CenteringFrameIssue?) {
        if (issue != CenteringFrameIssue.EARLY) recordFrame(frame)
        Log.i(CENTERING_TAG, "frame=${frame.frameId} capture_ns=${frame.stamp.captureNs} required_after_ns=$afterNs " +
            "capture_to_yolo_ms=${frame.captureToSignalMs} offset_percent=${frame.horizontalOffsetPercent} issue=${issue?.code}")
    }

    private fun recordFrame(frame: TargetSignal) {
        mutableCentering.update { it.copy(offsetPercent = frame.horizontalOffsetPercent,
            captureToSignalMs = frame.captureToSignalMs, frameAgeMs = frame.stamp.ageAt(nowNs())) }
    }

    private suspend fun runCenteringStep(
        port: CenteringPort,
        step: Int,
        direction: CenteringDirection,
        permit: (() -> Unit) -> Unit,
    ): CenteringStepResult {
        val attempt = Attempt(DjiAction.CENTER, direction, permit) { attempt ->
            val record = attempt.stepResult(step, direction)
            mutableCentering.update { ui ->
                ui.copy(steps = ui.steps.take(step - 1) + record, detail = attempt.status,
                    completedSteps = if (record.verified) step else ui.completedSteps)
            }
        }
        activeAttempt = attempt
        val sequence = reserveSequence(attempt.action)
        var rejectedBeforeSend = false
        try {
            attempt.publish()
            exchange(attempt, sequence, port)
            val completedNs = attempt.completedNs
            if (completedNs != null && attempt.status == null) {
                return CenteringStepResult.Completed(completedNs)
            }
            return CenteringStepResult.Stopped(if (attempt.timedOut) CenteringStop.STEP_TIMEOUT else CenteringStop.ERROR)
        } catch (rejected: FrameDisqualified) {
            rejectedBeforeSend = true
            val (frame, result) = rejected.rejection
            if (result is CenteringStepResult.Stopped) recordFrame(frame)
            Log.i(CENTERING_TAG, "step=$step direction=${direction.code} frame=${frame.frameId} admission=$result")
            return result
        } finally {
            if (rejectedBeforeSend) {
                mutableCentering.update { it.copy(steps = it.steps.take(step - 1)) }
            } else {
                attempt.publish()
                Log.i(CENTERING_TAG, "step=${attempt.stepResult(step, direction)} completed_ns=${attempt.completedNs}")
            }
            activeAttempt = null
        }
    }

    private class CenteringCancelled(val reason: CenteringStop) : CancellationException(reason.code)
    private class FrameDisqualified(val rejection: CenteringRejection) : RuntimeException()

    private fun start(action: DjiAction) {
        if (activeAttempt != null || centeringJob != null) return
        val attempt = Attempt(action)
        activeAttempt = attempt
        mutableUi.value = DjiAttitudeUi(action = action)
        val sequence = reserveSequence(action)
        attempt.job = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                exchange(attempt, sequence)
            } finally {
                activeAttempt = null
                mutableUi.value = attempt.result()
            }
        }
    }

    private fun reserveSequence(action: DjiAction): Int = nextSequence.also {
        nextSequence = (nextSequence + action.sequenceCount) and 0xFFFF
    }

    private suspend fun exchange(attempt: Attempt, sequence: Int, port: CenteringPort? = null) = withContext(Dispatchers.IO + UsbPermissionNotice { active ->
        if (active) showReconnect(attempt, "Подтвердите доступ к WeAct в Android")
        else showReconnect(attempt, if (attempt.needsMeasurement) "Ожидаем подключения WeAct…" else attempt.action.progress)
    }) {
        attempt.status = try {
            performExchange(attempt, sequence, port)
        } catch (_: NudgePositionRejected) {
            if (attempt.action == DjiAction.CENTER) "DJI отклонил команду" else null
        } catch (error: SecurityException) {
            Log.w(TAG, "USB permission failed", error)
            "Доступ к WeAct не предоставлен"
        } catch (error: IOException) {
            Log.w(TAG, "USB–CAN exchange failed", error)
            attempt.timedOut = error is SocketTimeoutException ||
                (error is NudgeAttitudeUnavailable && error.outcome == Outcome.Timeout)
            error.displayFailure()
        }
    }

    private suspend fun performExchange(attempt: Attempt, sequence: Int, port: CenteringPort?): String? {
        val exchangeContext = currentCoroutineContext()
        var reopen = port?.reopen
        val open: suspend () -> SerialIo = {
            val connection = openWeAct()
            reopen = connection.reopenAfterDetach
            connection.serial
        }
        val perform: (SlcanDjiRsTransport) -> String? = { transport ->
            exchangeContext.ensureActive()
            when (attempt.action) {
                DjiAction.READ -> DjiRsAttitudeReader(transport, sequence, nowNs).readOnce(TIMEOUT_NS).outcome.display()
                DjiAction.TURN, DjiAction.CENTER -> measureTurn(attempt, sequence, transport, exchangeContext::ensureActive)
            }
        }
        try {
            if (port == null) return withTransport(attempt, open, perform)
            // Keep the original USB handle between steps so only read-only recovery can reopen it.
            val transport = port.opened ?: openTransport(attempt, open).also {
                port.opened = it
                port.reopen = reopen
            }
            return runInterruptible { perform(transport.can) }
        } catch (error: IOException) {
            if (!attempt.needsMeasurement || !error.isWeActDetached()) throw error
            exchangeContext.ensureActive()
            if (port != null) {
                try {
                    port.close()
                } catch (closeError: IOException) {
                    Log.w(CENTERING_TAG, "Could not close detached WeAct", closeError)
                }
            }
        }

        showReconnect(attempt, "Ожидаем подключения WeAct…")
        withTransport(attempt, open = { awaitSerial(checkNotNull(reopen)) }) { transport ->
            showReconnect(attempt, "Повторно читаем углы DJI…")
            val followup = if (attempt.direction == null) readDjiTurnFollowup(transport, sequence, nowNs)
                else readDjiYaw(transport, (sequence + 4) and 0xFFFF, nowNs)
            attempt.recordYaw(followup)
        }
        return if (attempt.direction == null) null else "WeAct отключился. Угол прочитан после переподключения"
    }

    private fun measureTurn(
        attempt: Attempt,
        sequence: Int,
        transport: SlcanDjiRsTransport,
        ensureActive: () -> Unit,
    ): String? {
        val direction = attempt.direction
        val measurement = GimbalNudge(NudgeAxis.YAW, positive = direction != CenteringDirection.LEFT).measure(
            transport, TIMEOUT_NS, nowNs,
            pauseMs = { Thread.sleep(it); ensureActive() },
            attitudeSequence = sequence,
            positionSequence = (sequence + if (direction == null) 2 else 3) and 0xFFFF,
            sampleSettling = direction != null,
            admitPosition = { ensureActive(); attempt.admitPosition() },
            observe = attempt::observe,
        )
        if (direction == null) {
            attempt.recordYaw(measurement.after)
            return null
        }
        val issue = checkYawMovement(direction, measurement.before, measurement.after, checkNotNull(measurement.settled))
        if (issue == null) attempt.completedNs = nowNs()
        return issue?.label
    }

    private fun showReconnect(attempt: Attempt, status: String) {
        if (attempt.direction == null) {
            mutableUi.update { it.copy(firmware = attempt.firmware, turn = attempt.turn, status = status) }
        } else {
            attempt.status = status
            attempt.publish()
        }
    }

    private suspend fun awaitSerial(reopen: suspend () -> SerialIo): SerialIo =
        awaitWeActReconnect(reconnectTimeoutMs, RECONNECT_POLL_MS, SystemClock::elapsedRealtime, reopen)

    private suspend fun <T> withTransport(
        attempt: Attempt,
        open: suspend () -> SerialIo,
        block: (SlcanDjiRsTransport) -> T,
    ): T = openTransport(attempt, open).use { transport -> runInterruptible { block(transport.can) } }

    private suspend fun openTransport(attempt: Attempt, open: suspend () -> SerialIo): OpenTransport {
        val exchangeContext = currentCoroutineContext()
        val serial = open()
        val can = SlcanDjiRsTransport(serial, profile, TIMEOUT_NS, nowNs)
        val transport = OpenTransport(serial, can)
        try {
            runInterruptible {
                exchangeContext.ensureActive()
                attempt.firmware = can.version()
                exchangeContext.ensureActive()
                can.open()
                exchangeContext.ensureActive()
            }
            return transport
        } catch (error: Throwable) {
            try {
                transport.close()
            } catch (closeError: Throwable) {
                error.addSuppressed(closeError)
            }
            throw error
        }
    }

    private class OpenTransport(private val serial: SerialIo, val can: SlcanDjiRsTransport) : AutoCloseable {
        override fun close() = serial.use { can.close() }
    }

    private class CenteringPort : AutoCloseable {
        var opened: OpenTransport? = null
        var reopen: (suspend () -> SerialIo)? = null

        override fun close() {
            val transport = opened
            opened = null
            transport?.close()
        }
    }

    private class Attempt(
        val action: DjiAction,
        val direction: CenteringDirection? = null,
        private val permit: ((() -> Unit) -> Unit) = { it() },
        private val progress: (Attempt) -> Unit = {},
    ) {
        private enum class Admission { OPEN, ADMITTED, CANCELLED }

        private val admission = AtomicReference(Admission.OPEN)
        lateinit var job: Job
        var firmware: String? = null
        var status: String? = null
        private var before: DjiRsAttitudeReply.Angles? = null
        private var after: DjiRsAttitudeReply.Angles? = null
        private var settled: DjiRsAttitudeReply.Angles? = null
        private var recovered: DjiRsAttitudeReply.Angles? = null
        private var accepted = false
        var completedNs: Long? = null
        var timedOut = false
        var turn = if (action == DjiAction.READ) null else DjiTurnUi()
            private set
        val needsMeasurement get() = accepted && if (direction == null) turn?.yawDelta == null else settled == null

        // The UI can invalidate the admission while serial I/O is still unwinding.
        fun cancelAdmission(): Boolean = admission.getAndSet(Admission.CANCELLED) != Admission.CANCELLED

        fun admitPosition() = permit {
            if (!admission.compareAndSet(Admission.OPEN, Admission.ADMITTED)) {
                throw CancellationException("DJI position transmission cancelled before admission")
            }
        }

        fun observe(event: NudgeEvent) {
            val result = checkNotNull(turn)
            turn = when (event) {
                is NudgeEvent.PositionRequested -> result.copy(
                    transmission = "Не подтверждена",
                    confirmation = "Подтверждение не получено",
                )
                NudgeEvent.PositionTransmitted -> result.copy(transmission = "Подтверждена")
                is NudgeEvent.PositionAccepted -> {
                    accepted = true
                    result.copy(confirmation = "Принята")
                }
                is NudgeEvent.PositionRejected -> result.copy(confirmation = "Отклонена (код ${event.code})")
                is NudgeEvent.Attitude -> {
                    val angle = (event.exchange.outcome as? Outcome.Reply)?.value as? DjiRsAttitudeReply.Angles
                    when (event.sample) {
                        NudgeSample.BEFORE -> before = angle
                        NudgeSample.AFTER -> after = angle
                        NudgeSample.SETTLED -> settled = angle
                    }
                    if (direction != null && angle != null && event.sample != NudgeSample.BEFORE) {
                        result.copy(yawDelta = angle.deltaFrom(checkNotNull(before)).yawDegrees)
                    } else result
                }
            }
            publish()
        }

        fun recordYaw(after: DjiRsAttitudeReply.Angles) {
            turn = checkNotNull(turn).copy(yawDelta = after.deltaFrom(checkNotNull(before)).yawDegrees)
            if (direction != null) recovered = after
        }

        fun publish() = progress(this)

        fun stepResult(number: Int, direction: CenteringDirection) = PhysicalStepUi(number, direction,
            checkNotNull(turn), before?.yawDegrees, after?.yawDegrees, settled?.yawDegrees, recovered?.yawDegrees,
            verified = completedNs != null)

        fun result() = DjiAttitudeUi(
            firmware = firmware,
            status = if (admission.get() == Admission.CANCELLED) "Попытка поворота отменена" else status,
            turn = turn,
        )
    }

    private fun Outcome.display(): String = when (this) {
        is Outcome.Reply -> value.display()
        Outcome.Timeout -> "DJI не ответил"
        is Outcome.TransportError -> throw cause
    }

    private fun Throwable.isWeActDetached(): Boolean =
        (this is WeActUsbException && issue == WeActUsbIssue.DETACHED) ||
            cause?.isWeActDetached() == true || suppressed.any { it.isWeActDetached() }

    private fun IOException.displayFailure(): String {
        if (suppressed.any { it is WeActUsbException && it.issue == WeActUsbIssue.DETACHED }) {
            return "Адаптер WeAct отключён"
        }
        return when (this) {
            is WeActUsbException -> when (issue) {
                WeActUsbIssue.ABSENT -> "Адаптер WeAct не найден"
                WeActUsbIssue.ACCESS_DENIED -> "Доступ к WeAct не предоставлен"
                WeActUsbIssue.PERMISSION_TIMEOUT -> "Истекло время ожидания USB-разрешения WeAct"
                WeActUsbIssue.DETACHED -> "Адаптер WeAct отключён"
                WeActUsbIssue.AMBIGUOUS -> "Не удалось однозначно определить исходный WeAct"
            }
            is SlcanCanTransmitUnconfirmed -> if (cause is java.net.SocketTimeoutException) "Тайм-аут подтверждения передачи CAN от WeAct" else "WeAct отклонил передачу CAN"
            is NudgePositionTimeout -> "DJI не подтвердил команду за 2 с"
            is NudgePositionInvalid -> "Некорректное подтверждение DJI (${reason.name})"
            is NudgeAttitudeUnavailable -> {
                val stage = if (sample == NudgeSample.BEFORE) "Исходный угол" else "Угол после поворота"
                val reason = (outcome as? Outcome.TransportError)?.cause?.displayFailure() ?: outcome.display()
                "$stage: $reason"
            }
            is WeActReconnectTimeout -> "Истекло время ожидания исходного WeAct"
            is SocketTimeoutException -> "Тайм-аут обмена через WeAct"
            else -> "Ошибка обмена через WeAct"
        }
    }

    private fun DjiRsAttitudeReply.display(): String = when (this) {
        is DjiRsAttitudeReply.Angles -> String.format(
            Locale.getDefault(), "yaw %.1f° · pitch %.1f° · roll %.1f°", yawDegrees, pitchDegrees, rollDegrees,
        )
        is DjiRsAttitudeReply.Invalid -> "Некорректный ответ DJI (${reason.name})"
        is DjiRsAttitudeReply.DeviceError -> "DJI вернул ошибку (код $code)"
        DjiRsAttitudeReply.NotReady -> "DJI ещё не готов передать углы"
    }
}

internal fun readDjiTurnFollowup(
    transport: SlcanDjiRsTransport,
    turnSequence: Int,
    nowNs: () -> Long,
): DjiRsAttitudeReply.Angles = readDjiYaw(transport, (turnSequence + 3) and 0xFFFF, nowNs)

private fun readDjiYaw(
    transport: SlcanDjiRsTransport,
    sequence: Int,
    nowNs: () -> Long,
): DjiRsAttitudeReply.Angles {
    val outcome = DjiRsAttitudeReader(transport, sequence, nowNs)
        .readOnce(TIMEOUT_NS).outcome
    return (outcome as? Outcome.Reply)?.value as? DjiRsAttitudeReply.Angles
        ?: throw NudgeAttitudeUnavailable(NudgeSample.AFTER, outcome)
}
