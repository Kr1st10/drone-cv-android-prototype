package ru.university.dronecv.camera

import android.app.Application
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.SystemClock
import android.util.Log
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.diagnostics.DiagnosticViewModel
import ru.university.dronecv.journals.JournalArchives
import ru.university.dronecv.journals.JournalKind
import ru.university.dronecv.journals.JournalState
import ru.university.dronecv.motion.MotionViewModel
import ru.university.dronecv.oneturn.ONE_TURN_MAX_AGE_MS
import ru.university.dronecv.oneturn.OneTurnPhase
import ru.university.dronecv.oneturn.OneTurnReply
import ru.university.dronecv.oneturn.OneTurnRequest
import ru.university.dronecv.oneturn.OneTurnTransport
import ru.university.dronecv.oneturn.OneTurnViewModel
import ru.university.dronecv.ui.theme.DroneCvTheme

@RunWith(AndroidJUnit4::class)
class OneTurnDiagnosticInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
    private val archive = JournalArchives.get(app)
    private val simulator = DjiSimulator()
    private val clock = AtomicLong(SystemClock.elapsedRealtimeNanos())
    private lateinit var turn: OneTurnViewModel
    private val diagnostics = DiagnosticViewModel(app)
    private val motion = MotionViewModel(app)
    private val worker = Executors.newSingleThreadExecutor()
    private val pool = CameraFramePool()
    private val detectorFixture = DetectorFixture()
    private lateinit var controller: LiveController<CameraFrameSnapshot>
    private lateinit var now: () -> Long
    private var source = 0L
    private var initialJournalIds = emptySet<String>()

    private fun openDiagnostics(
        backend: LiveBackend<CameraFrameSnapshot> = detectorFixture,
        monotonicTime: () -> Long = clock::get,
    ) {
        now = monotonicTime
        turn = OneTurnViewModel(simulator, configured = true, now = now)
        controller = LiveController(
            backend, worker, diagnostics.frames, eventTime = now, motion = motion.journal,
            onYoloSignal = turn.controller::observe, onInputInvalidated = turn.controller::invalidate,
        )
        source = controller.newSource()
        initialJournalIds = archive.inventory().entries.map { it.id }.toSet()
        diagnostics.onBeforeStop = turn.controller::endDiagnostic
        compose.setContent {
            DroneCvTheme {
                val state by controller.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
                val threads by controller.threadConfiguration.collectAsStateWithLifecycle()
                var running by remember { mutableStateOf(false) }
                LiveControls(
                    state = state, running = running, confidence = confidence,
                    onRunningChange = {
                        running = it
                        controller.configure(it, confidence)
                    },
                    onConfidenceChange = controller::updateThreshold,
                    issue = null, diagnostics = diagnostics, motionModel = motion,
                    threadState = threads, onThreadsChange = controller::requestThreads,
                    probe = rememberCameraProbeState(), controller = controller, oneTurn = turn,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        compose.onNodeWithTag("camera-settings").performClick()
        compose.onNodeWithText("A: YOLO").performScrollTo().performClick()
        compose.onNodeWithText("Начать детекцию").performClick()
        compose.onNodeWithTag("camera-diagnostics").performClick()
        checkNotNull(submitFrame(640, 480) { it.fill(Color.BLACK) }.signal) {
            "Warm-up frame did not publish: ${controller.state.value.error}"
        }
        armButton().assertIsNotEnabled()
        compose.onNodeWithTag("diagnostic-start").performScrollTo().performClick()
        compose.waitUntil(10_000) { diagnostics.ui.value.recording }
    }

    @After fun releaseFixture() {
        if (::controller.isInitialized) compose.runOnIdle {
            diagnostics.stop(true, "Тест симулятора завершён")
            controller.close()
            turn.controller.close()
            turn.viewModelScope.cancel()
        }
        worker.shutdown()
        assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS))
    }

    @Test fun freshRightFrameSendsOneRequestAndCorrelatesUiWithDiagnosticResult() {
        openDiagnostics()
        val attemptId = arm()
        val signal = publishFrame(rightBox)
        val request = awaitRequest(count = 1, attemptId, signal)
        val reply = simulator.reply(request, "success", "поворот выполнен", 2.0, 5.0)
        expectResult(request, reply)

        val rows = finishDiagnostics()
        assertEquals(listOf("armed", "selected", "result"), rows.map { it.getString("kind") })
        assertTrue(rows.all { it.getString("attempt_id") == attemptId })
        checkResult(rows.last(), request, reply)
        assertEquals(1, simulator.requests.size)
    }

    @Test fun centerMissingTargetAndPreArmExposureDoNotSend() {
        openDiagnostics()
        val preArm = nextExposure()
        nextExposure()
        val attemptId = arm()
        publishFrame(centerBox)
        publishFrame(null)
        publishFrame(rightBox, captureNs = preArm)
        compose.waitForIdle()

        assertTrue(simulator.requests.isEmpty())
        assertEquals(OneTurnPhase.ARMED, turn.state.value.phase)
        armButton().assertIsNotEnabled()
        val rows = finishDiagnostics()
        assertEquals(
            listOf("armed", "not_right_of_dead_zone", "no_target", "before_arm", "invalidated"),
            rows.map { it.getString("kind") },
        )
        assertTrue(rows.all { it.getString("attempt_id") == attemptId })
        assertTrue(simulator.requests.isEmpty())
    }

    @Test fun repeatedRightFramesNeedAnotherPressAfterSimulatedErrorAndTimeout() {
        openDiagnostics()
        val firstId = arm()
        val first = awaitRequest(1, firstId, publishFrame(rightBox))
        publishFrame(rightBox)
        publishFrame(rightBox)
        armButton().assertIsNotEnabled()
        compose.onNodeWithTag("diagnostic-stop").performScrollTo().assertIsNotEnabled()
        assertEquals(1, simulator.requests.size)

        val error = simulator.reply(first, "error", "ошибка поворота")
        expectResult(first, error)
        publishFrame(rightBox)
        compose.waitForIdle()
        assertEquals(1, simulator.requests.size)

        val secondId = arm()
        assertNotEquals(firstId, secondId)
        val second = awaitRequest(2, secondId, publishFrame(rightBox))
        publishFrame(rightBox)
        assertEquals(2, simulator.requests.size)
        val timeout = simulator.reply(second, "timeout", "тайм-аут ответа")
        expectResult(second, timeout)
        publishFrame(rightBox)
        compose.waitForIdle()
        assertEquals(2, simulator.requests.size)

        val rows = finishDiagnostics()
        assertEquals(listOf("armed", "selected", "result", "armed", "selected", "result"), rows.map { it.getString("kind") })
        assertEquals(List(3) { firstId } + List(3) { secondId }, rows.map { it.getString("attempt_id") })
        checkResult(rows[2], first, error)
        checkResult(rows[5], second, timeout)
    }

    @Test fun packagedYoloFindsBenchPhotoAndSendsOneSimulatedRequest() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val photo = assets.open("one-turn/bench-right.png").use { checkNotNull(BitmapFactory.decodeStream(it)) }
        try {
            openDiagnostics(AndroidLiveBackend(app), SystemClock::elapsedRealtimeNanos)
            val attemptId = arm()
            val submitted = submitFrame(photo.width, photo.height) { pixels ->
                photo.getPixels(pixels, 0, photo.width, 0, 0, photo.width, photo.height)
            }
            val signal = submitted.signal
            val publicationMs = signal?.let { (it.dispatchNs - submitted.offeredNs) / 1_000_000.0 }
            Log.i(ONNX_TAG, "attempt_id=$attemptId frame_to_publication_ms=$publicationMs " +
                "capture_to_publication_ms=${signal?.captureToSignalMs} target=${signal?.status} " +
                "center=${signal?.center} confidence=${signal?.confidence} threshold=$confidence " +
                "ort_ms=${controller.state.value.result?.takeIf { signal != null }?.inferenceMs}")

            try {
                compose.waitUntil(5_000) {
                    simulator.requests.isNotEmpty() || turn.state.value.phase != OneTurnPhase.SENDING
                }
            } catch (error: ComposeTimeoutException) {
                throw AssertionError("Simulator dispatch did not finish. frame_to_publication_ms=$publicationMs", error)
            }
            if (simulator.requests.isEmpty()) {
                val rows = finishDiagnosticRows()
                val attempt = turnEvents(rows).filter { it.getString("attempt_id") == attemptId }
                val lastEvent = attempt.lastOrNull { it.getString("kind") !in listOf("armed", "invalidated") }
                val discard = rows.lastOrNull { it.getString("type") == "discard" }?.getJSONObject("data")
                val reason = lastEvent?.let { "${it.getString("kind")} ${it.optString("message", "")}".trim() }
                    ?: discard?.getString("reason") ?: controller.state.value.error ?: "no request after frame"
                fail("No simulated request: $reason. frame_to_publication_ms=$publicationMs; " +
                    "capture_to_publication_ms=${signal?.captureToSignalMs}; target=${signal?.status}")
                return
            }

            val target = checkNotNull(signal)
            val center = checkNotNull(target.center)
            assertEquals(TargetStatus.DETECTED, target.status)
            // Rounded image rectangle from the saved bench rendering.
            assertTrue("Model selected an area outside the bench photo: $center",
                center.x in 713.0..1077.0 && center.y in 184.0..426.0)
            val request = awaitRequest(1, attemptId, target)
            assertTrue(request.ageMs in 0.0..ONE_TURN_MAX_AGE_MS)
            val reply = simulator.reply(request, "success", "поворот выполнен", 2.0, 5.0)
            expectResult(request, reply)

            val timeline = finishDiagnosticRows()
            assertEquals(confidence.toDouble(),
                timeline.first { it.getString("type") == "header" }.getJSONObject("data").getDouble("confidence"), 0.0)
            val rows = turnEvents(timeline)
            assertEquals(listOf("armed", "selected", "result"), rows.map { it.getString("kind") })
            assertTrue(rows.all { it.getString("attempt_id") == attemptId })
            checkResult(rows.last(), request, reply)
            assertEquals(1, simulator.requests.size)
            Log.i(ONNX_TAG, "attempt_id=$attemptId requests=1 direction=right request_age_ms=${request.ageMs} " +
                "ui_and_diagnostic_attempt_match=true")
        } finally {
            photo.recycle()
        }
    }

    private fun nextExposure(): Long = clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1))

    private fun publishFrame(box: NormalizedBox?, captureNs: Long = nextExposure()): TargetSignal {
        detectorFixture.detections = box?.let { listOf(Detection("drone", 0.9f, it)) }.orEmpty()
        val signal = checkNotNull(submitFrame(640, 480, captureNs) {}.signal)
        assertEquals(if (box == null) TargetStatus.NO_TARGET else TargetStatus.DETECTED, signal.status)
        return signal
    }

    private data class FrameSubmission(val offeredNs: Long, val signal: TargetSignal?)

    private fun submitFrame(
        width: Int,
        height: Int,
        captureNs: Long? = null,
        copyPixels: (IntArray) -> Unit,
    ): FrameSubmission {
        val lease = checkNotNull(pool.acquire(width, height))
        try {
            copyPixels(lease.pixels)
        } catch (error: Throwable) {
            lease.close()
            throw error
        }
        val frame = CameraFrameSnapshot(ArgbImage(width, height, lease.pixels), 0, 0.0, lease)
        val entryNs = now()
        val stamp = FrameStamp(captureNs ?: entryNs, CaptureTimebase.ELAPSED_REALTIME, entryNs)
        val before = controller.signals.value?.frameId
        val token = controller.beginFrame(source, stamp)
        val offeredNs = now()
        if (token == null) {
            frame.close()
            return FrameSubmission(offeredNs, null)
        }
        controller.offerFrame(frame, token, stamp, preparationMs = 0.0)
        worker.submit {}.get(45, TimeUnit.SECONDS)
        val signal = controller.signals.value?.takeIf { it.frameId != before && it.stamp == stamp }
        return FrameSubmission(offeredNs, signal)
    }

    private fun armButton() = compose.onNodeWithTag("one-turn-arm")

    private fun arm(): String {
        armButton().performScrollTo().assertIsEnabled().performClick()
        assertEquals(OneTurnPhase.ARMED, turn.state.value.phase)
        return checkNotNull(turn.state.value.attemptId)
    }

    private fun awaitRequest(count: Int, attemptId: String, signal: TargetSignal): OneTurnRequest {
        compose.waitUntil(10_000) { simulator.requests.size >= count }
        assertEquals(count, simulator.requests.size)
        val request = simulator.requests.last()
        assertEquals(attemptId, request.attemptId)
        assertEquals(signal, request.signal)
        assertTrue(checkNotNull(signal.stamp.captureNs) > request.armedNs)
        val json = JSONObject(request.json("simulator"))
        assertEquals(attemptId, json.getString("attempt_id"))
        assertEquals("right", json.getString("direction"))
        assertEquals(signal.frameId, json.getLong("frame_id"))
        return request
    }

    private fun expectResult(request: OneTurnRequest, reply: OneTurnReply) {
        val label = "${reply.message} · ожидание нового нажатия"
        compose.waitUntil(10_000) { compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("one-turn-status").performScrollTo()
        compose.onNodeWithText(label).assertIsDisplayed()
        assertEquals(request.attemptId, turn.state.value.attemptId)
        assertEquals(OneTurnPhase.IDLE, turn.state.value.phase)
        armButton().assertIsEnabled()
    }

    private fun newDiagnosticJournal() = archive.inventory().entries.singleOrNull {
        it.kind == JournalKind.DIAGNOSTIC && it.id !in initialJournalIds
    }

    private fun turnEvents(rows: List<JSONObject>): List<JSONObject> =
        rows.filter { it.getString("type") == "one_turn" }.map { it.getJSONObject("data") }

    private fun finishDiagnostics(): List<JSONObject> = turnEvents(finishDiagnosticRows())

    private fun finishDiagnosticRows(): List<JSONObject> {
        compose.onNodeWithTag("diagnostic-stop").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(10_000) { newDiagnosticJournal()?.state == JournalState.COMPLETE }
        val id = checkNotNull(newDiagnosticJournal()).id
        val buffer = ByteArrayOutputStream()
        archive.selectExport(id).use { it.copy(openOutput = { buffer }) }
        val rows = buffer.toString(Charsets.UTF_8.name()).lineSequence().filter(String::isNotBlank)
            .map(::JSONObject).toList()
        val footer = rows.last().getJSONObject("data")
        assertEquals("session_end", rows.last().getString("type"))
        assertTrue(footer.getBoolean("recording_complete"))
        assertEquals("0", footer.getString("dropped_count"))
        return rows
    }

    private fun checkResult(data: JSONObject, request: OneTurnRequest, reply: OneTurnReply) {
        assertEquals("result", data.getString("kind"))
        assertEquals(request.attemptId, data.getString("attempt_id"))
        assertEquals(request.signal.frameId, data.getLong("frame_id"))
        assertEquals("right", data.getString("direction"))
        assertEquals(reply.status, data.getString("status"))
        assertEquals(reply.message, data.getString("message"))
        reply.yawBefore?.let { assertEquals(it, data.getDouble("yaw_before"), 0.0) }
        reply.yawAfter?.let { assertEquals(it, data.getDouble("yaw_after"), 0.0) }
    }

    private class DetectorFixture : LiveBackend<CameraFrameSnapshot> {
        @Volatile var detections = emptyList<Detection>()

        override fun infer(frame: CameraFrameSnapshot, confidence: Float) =
            LiveInference(detections, frame.image.width, frame.image.height, 0.0, conversionMs = 0.0, preprocessMs = 0.0, postprocessMs = 0.0)

        override fun close() = Unit
    }

    private class DjiSimulator : OneTurnTransport {
        val requests = CopyOnWriteArrayList<OneTurnRequest>()
        private val replies = Channel<OneTurnReply>(Channel.UNLIMITED)

        override suspend fun send(request: OneTurnRequest): OneTurnReply {
            requests += request
            return replies.receive()
        }

        fun reply(request: OneTurnRequest, status: String, message: String,
                  yawBefore: Double? = null, yawAfter: Double? = null): OneTurnReply {
            val reply = OneTurnReply(status, "Симулятор DJI · $message · ${request.attemptId}", yawBefore, yawAfter)
            check(replies.trySend(reply).isSuccess)
            return reply
        }
    }

    private companion object {
        const val confidence = 0.5f
        const val ONNX_TAG = "OneTurnOnnxTest"
        val rightBox = NormalizedBox(0.72f, 0.3f, 0.82f, 0.5f)
        val centerBox = NormalizedBox(0.45f, 0.3f, 0.55f, 0.5f)
    }
}
