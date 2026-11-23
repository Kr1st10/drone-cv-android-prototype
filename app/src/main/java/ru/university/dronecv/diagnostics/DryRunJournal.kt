package ru.university.dronecv.diagnostics

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import ru.university.dronecv.camera.TrackingSignal
import ru.university.dronecv.centering.BoxState
import ru.university.dronecv.centering.CameraCentering
import ru.university.dronecv.centering.CenteringAction
import ru.university.dronecv.centering.CenteringConfig
import ru.university.dronecv.centering.CenteringDecision
import ru.university.dronecv.centering.CenteringReason
import ru.university.dronecv.centering.CenteringSession
import ru.university.dronecv.timeline.TimelineWriter
import ru.university.dronecv.tracking.ClassConfirmation
import ru.university.dronecv.tracking.VisualPhase

/** Per recording. Camera callbacks only offer commands; the writer owns serialization and disk IO. */
internal class DryRunJournal private constructor(
    private val writer: TimelineWriter,
    private val clock: () -> Long,
    config: CenteringConfig,
    dispatcher: CoroutineDispatcher,
) {
    private sealed interface Input {
        data class Start(val session: CenteringSession) : Input
        data class Signal(val session: CenteringSession, val signal: TrackingSignal) : Input
        data class Clear(val session: CenteringSession, val previous: TrackingSignal) : Input
        data class Stop(val session: CenteringSession, val reason: CenteringReason) : Input
    }

    private class Admission(val session: CenteringSession) {
        var latest: TrackingSignal? = null
        var invalidThrough = 0L
    }
    private data class Overflow(val session: CenteringSession, val timeNs: Long)

    private val input = Channel<Input>(capacity = 64)
    private val finishWriter = CompletableDeferred<() -> Unit>()
    private val scope = CoroutineScope(dispatcher + Job())

    // The same monitor orders camera invalidation, recording cutoff and admission to the writer.
    private var admission: Admission? = null
    private var overflow: Overflow? = null
    private var stopNs: Long? = null

    init {
        scope.launch {
            val centering = CameraCentering(config, scope, ::decisionTime, ::publish)
            for (command in input) {
                if (inputOverflow() != null) break
                when (command) {
                    is Input.Start -> centering.start(command.session)
                    is Input.Signal -> {
                        val observation = command.signal.observation
                        if (observation.phase == VisualPhase.LOST ||
                            accepts(command.session, observation.key.sequence)) {
                            centering.onSignal(command.signal)
                        }
                    }
                    is Input.Clear -> centering.clear(command.session, command.previous)
                    is Input.Stop -> centering.stop(command.session, command.reason)
                }
            }
            input.cancel()
            val failure = inputOverflow()
            if (failure == null) {
                centering.stopActive(CenteringReason.RECORDING_STOPPED)
            } else if (!centering.stopActive(CenteringReason.INPUT_OVERFLOW)) {
                publish(CenteringDecision(failure.timeNs, failure.session, BoxState.MISSING,
                    ClassConfirmation.NONE, false, null, CenteringAction.STOP, CenteringReason.INPUT_OVERFLOW))
            }
            finishWriter.await().invoke()
            scope.cancel()
        }
    }

    @Synchronized fun start(session: CenteringSession) {
        if (stopNs != null || overflow != null || admission?.session == session) return
        admission = Admission(session)
        offer(Input.Start(session), session)
    }

    @Synchronized fun signal(signal: TrackingSignal) {
        val current = admission ?: return
        val observation = signal.observation
        val key = observation.key
        if (!current.session.matches(key) || !accepts(current.session, key.sequence)) return
        val previous = current.latest
        if (previous != null && (key.sequence < previous.observation.key.sequence ||
                (key.sequence == previous.observation.key.sequence && signal.dispatchNs <= previous.dispatchNs))) return

        current.latest = signal
        if (observation.phase == VisualPhase.LOST) current.invalidThrough = key.sequence
        offer(Input.Signal(current.session, signal), current.session)
    }

    @Synchronized fun clear(session: CenteringSession) {
        val current = admission?.takeIf { it.session == session } ?: return
        val previous = current.latest?.takeIf { it.observation.estimate != null } ?: return
        current.invalidThrough = previous.observation.key.sequence
        current.latest = null
        offer(Input.Clear(session, previous), session)
    }

    @Synchronized fun stop(session: CenteringSession, reason: CenteringReason) {
        if (admission?.session != session) return
        admission = null
        offer(Input.Stop(session, reason), session)
    }

    /** Freeze elapsedRealtime before building the report or waiting for any background work. */
    @Synchronized fun seal(): Long = stopNs ?: clock().also {
        stopNs = it
        admission = null
        input.close()
    }

    /** The footer follows the terminal STOP and uses the cutoff captured on the caller. */
    fun finish(finalize: (Long) -> Unit) {
        val cutoff = seal()
        finishWriter.complete { finalize(cutoff) }
    }

    @Synchronized private fun accepts(session: CenteringSession, sequence: Long): Boolean {
        val current = admission ?: return false
        return current.session == session && sequence > current.invalidThrough
    }

    @Synchronized private fun decisionTime(): Long = overflow?.timeNs ?: stopNs ?: clock()

    @Synchronized private fun inputOverflow(): Overflow? = overflow

    @Synchronized private fun publish(decision: CenteringDecision) {
        if (decision.action == CenteringAction.STOP ||
            decision.frameId?.let { accepts(decision.session, it) } == true) {
            writer.record("dry_run", decision::toTimelineJson, decision.timeNs)
        }
    }

    private fun offer(command: Input, session: CenteringSession) {
        val result = input.trySend(command)
        if (!result.isSuccess && !result.isClosed && overflow == null) {
            overflow = Overflow(session, clock())
            admission = null
            input.close()
        }
    }

    companion object {
        @OptIn(ExperimentalCoroutinesApi::class)
        private val serialDispatcher = Dispatchers.Default.limitedParallelism(1)
        private val defaultConfig = CenteringConfig(deadZoneWidthPx = 40.0)

        fun open(
            enabled: Boolean,
            writer: TimelineWriter,
            clock: () -> Long,
            config: CenteringConfig = defaultConfig,
            dispatcher: CoroutineDispatcher = serialDispatcher,
        ): DryRunJournal? = if (enabled) DryRunJournal(writer, clock, config, dispatcher) else null
    }
}
