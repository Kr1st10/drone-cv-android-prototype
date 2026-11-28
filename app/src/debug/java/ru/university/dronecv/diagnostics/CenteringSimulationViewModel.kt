package ru.university.dronecv.diagnostics

import android.app.Application
import android.os.SystemClock
import android.util.Log
import androidx.annotation.MainThread
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import ru.university.dronecv.camera.LiveController
import ru.university.dronecv.camera.TargetSignal
import ru.university.dronecv.journals.JournalArchives
import ru.university.dronecv.journals.JournalKind
import ru.university.dronecv.timeline.TimelineWriter

internal const val SIMULATION_DEAD_ZONE_PERCENT = CENTERING_DEAD_ZONE_PERCENT
// The packaged YOLO took 418 ms from exposure to publication on Pixel Tablet.
private const val FRAME_AGE_MS = 1_000L
private const val FRAME_TIMEOUT_MS = 1_500L
private const val EVENT_TYPE = "centering_simulation"

internal data class CenteringSimulationScenario(
    val stepDelayMs: Long = 180,
    val stepTimeoutMs: Long = 1_500,
    val stepLimit: Int = 5,
)

internal enum class CenteringSimulationPhase { IDLE, WAITING_FRAME, STEPPING, FINISHED }

internal data class CenteringSimulationUi(
    val session: Long = 0,
    val phase: CenteringSimulationPhase = CenteringSimulationPhase.IDLE,
    val offsetPercent: Double? = null,
    val completedSteps: Int = 0,
    val reason: CenteringStop? = null,
    val journalIssue: String? = null,
) {
    val running: Boolean
        get() = phase == CenteringSimulationPhase.WAITING_FRAME || phase == CenteringSimulationPhase.STEPPING
}

internal class CenteringSimulationViewModel(
    application: Application,
    private val scenario: CenteringSimulationScenario,
) : AndroidViewModel(application) {
    constructor(application: Application) : this(application, CenteringSimulationScenario())

    val stepLimit: Int get() = scenario.stepLimit

    private val archive = JournalArchives.get(application)
    private val mutableUi = MutableStateFlow(CenteringSimulationUi())
    val ui = mutableUi.asStateFlow()
    private var active: Job? = null

    @MainThread
    fun start(controller: LiveController<*>) {
        if (active != null) return
        val startNs = SystemClock.elapsedRealtimeNanos()
        val session = mutableUi.value.session + 1
        mutableUi.value = CenteringSimulationUi(session, phase = CenteringSimulationPhase.WAITING_FRAME)
        val job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            runSession(controller, session, startNs)
        }
        active = job
        job.start()
    }

    @MainThread
    fun stop() {
        active?.cancel()
    }

    private suspend fun runSession(controller: LiveController<*>, session: Long, startNs: Long) {
        val sessionJob = checkNotNull(currentCoroutineContext()[Job])
        val frames = Channel<TargetSignal>(Channel.CONFLATED)
        val observation = controller.observeActiveYolo(
            onSignal = { frames.trySend(it) },
            onInvalidated = { sessionJob.cancel(SourceChanged()) },
        )
        var reason = CenteringStop.STOPPED
        var writer: TimelineWriter? = null
        try {
            if (observation == null) {
                reason = CenteringStop.SOURCE_CHANGED
                return
            }
            writer = openJournal(session)
            writer.record("header", JSONObject()
                .put("mode", EVENT_TYPE)
                .put("simulation", true)
                .put("clock", "elapsed_realtime_ns")
                .put("start_ns", startNs.toString())
                .put("dead_zone_percent", SIMULATION_DEAD_ZONE_PERCENT)
                .put("step_limit", scenario.stepLimit)
                .put("target_source", "yolo")
                .put("max_frame_age_ms", FRAME_AGE_MS)
                .toString(), startNs)
            currentCoroutineContext().ensureActive()
            reason = simulate(controller, frames, writer, startNs)
        } catch (_: SourceChanged) {
            reason = CenteringStop.SOURCE_CHANGED
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Log.w("CenteringSimulation", "Simulation session failed", error)
            reason = CenteringStop.ERROR
        } finally {
            observation?.close()
            frames.cancel()
            val stopNs = SystemClock.elapsedRealtimeNanos()
            val finalState = mutableUi.value
            writer?.finish(
                stopNs, interrupted = reason in setOf(CenteringStop.STOPPED, CenteringStop.SOURCE_CHANGED),
                reason = reason.code,
                finalRecord = EVENT_TYPE to {
                    simulationEvent("finished")
                        .put("reason", reason.code)
                        .put("completed_steps", finalState.completedSteps)
                        .put("offset_percent", finalState.offsetPercent ?: JSONObject.NULL)
                        .toString()
                },
            )
            mutableUi.update { it.copy(phase = CenteringSimulationPhase.FINISHED, reason = reason) }
            active = null
        }
    }

    private suspend fun openJournal(session: Long): TimelineWriter = withContext(NonCancellable) {
        withContext(Dispatchers.IO) {
            archive.reserve(JournalKind.DIAGNOSTIC).use { reservation ->
                reservation.openWriter(SystemClock::elapsedRealtimeNanos, onIssue = { issue ->
                    mutableUi.update { if (it.session == session) it.copy(journalIssue = issue) else it }
                })
            }
        }
    }

    private suspend fun simulate(
        controller: LiveController<*>,
        frames: Channel<TargetSignal>,
        writer: TimelineWriter,
        startNs: Long,
    ): CenteringStop {
        val context = currentCoroutineContext()
        val simulator = VirtualDji(scenario.stepDelayMs)
        return runCenteringLoop(
            frames, startNs, CenteringPolicy(FRAME_AGE_MS, FRAME_TIMEOUT_MS, scenario.stepLimit),
            SystemClock::elapsedRealtimeNanos,
            onFrame = { frame, afterNs, issue ->
                if (issue == null) {
                    mutableUi.update { it.copy(offsetPercent = frame.horizontalOffsetPercent) }
                    writer.record(EVENT_TYPE, frame.event("frame").toString())
                } else {
                    writer.record(EVENT_TYPE, frame.event("frame_ignored")
                        .put("reason", frame.timingIssue ?: issue.code)
                        .put("required_after_ns", afterNs.toString()).toString())
                }
            },
        ) { step, direction, frame, _ ->
            val requested = controller.withActiveYoloSource {
                context.ensureActive()
                writer.record(EVENT_TYPE, frame.event("step_requested").put("step", step)
                    .put("direction", direction.code).toString())
                mutableUi.update { it.copy(phase = CenteringSimulationPhase.STEPPING) }
            }
            if (!requested) return@runCenteringLoop CenteringStepResult.Stopped(CenteringStop.SOURCE_CHANGED)

            val reply = withTimeoutOrNull(scenario.stepTimeoutMs) { simulator.step(direction) }
                ?: return@runCenteringLoop CenteringStepResult.Stopped(CenteringStop.STEP_TIMEOUT)
            val acknowledged = controller.withActiveYoloSource {
                context.ensureActive()
                writer.record(EVENT_TYPE, simulationEvent("step_completed").put("step", step)
                    .put("completed_ns", reply.completedNs.toString())
                    .put("simulated_position_steps", reply.position).toString(), reply.completedNs)
                mutableUi.update { it.copy(phase = CenteringSimulationPhase.WAITING_FRAME, completedSteps = step) }
            }
            if (acknowledged) CenteringStepResult.Completed(reply.completedNs)
            else CenteringStepResult.Stopped(CenteringStop.SOURCE_CHANGED)
        }
    }

    private class SourceChanged : CancellationException()
}

private fun simulationEvent(kind: String): JSONObject =
    JSONObject().put("simulation", true).put("kind", kind)

private fun TargetSignal.event(kind: String): JSONObject = simulationEvent(kind)
    .put("frame_id", frameId.toString())
    .put("source_id", sourceId.toString())
    .put("captured_ns", stamp.captureNs?.toString() ?: JSONObject.NULL)
    .put("signal_publication_ns", dispatchNs.toString())
    .put("capture_to_signal_ms", captureToSignalMs ?: JSONObject.NULL)
    .put("offset_percent", horizontalOffsetPercent ?: JSONObject.NULL)

private class VirtualDji(private val stepDelayMs: Long) {
    data class Reply(val completedNs: Long, val position: Int)

    private var position = 0

    suspend fun step(direction: CenteringDirection): Reply {
        delay(stepDelayMs)
        position += if (direction == CenteringDirection.RIGHT) 1 else -1
        return Reply(SystemClock.elapsedRealtimeNanos(), position)
    }
}
