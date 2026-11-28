package ru.university.dronecv.diagnostics

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.SystemClock
import android.util.Log
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.camera.AndroidLiveBackend
import ru.university.dronecv.camera.CameraSection
import ru.university.dronecv.camera.CameraFramePool
import ru.university.dronecv.camera.CameraFrameSnapshot
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.LiveBackend
import ru.university.dronecv.camera.LiveController
import ru.university.dronecv.camera.LiveControls
import ru.university.dronecv.camera.LiveInference
import ru.university.dronecv.camera.TargetSignal
import ru.university.dronecv.camera.rememberCameraProbeState
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.journals.JournalArchives
import ru.university.dronecv.journals.JournalKind
import ru.university.dronecv.journals.JournalState
import ru.university.dronecv.motion.MotionViewModel
import ru.university.dronecv.oneturn.OneTurnTransport
import ru.university.dronecv.oneturn.OneTurnViewModel
import ru.university.dronecv.ui.theme.DroneCvTheme

@RunWith(AndroidJUnit4::class)
class CenteringSimulationInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
    private val archive = JournalArchives.get(app)
    private val worker = Executors.newSingleThreadExecutor()
    private val pool = CameraFramePool()
    private val detector = DetectorFixture()
    private val motion = MotionViewModel(app)
    private lateinit var controller: LiveController<CameraFrameSnapshot>
    private var source = 0L
    private var initialJournalIds = emptySet<String>()

    @Before fun rememberExistingJournals() {
        initialJournalIds = archive.inventory().entries.map { it.id }.toSet()
    }

    @After fun closeController() {
        if (::controller.isInitialized) controller.close()
        worker.shutdown()
        assertTrue(worker.awaitTermination(10, TimeUnit.SECONDS))
    }

    @Test fun narrowExpandedDiagnosticsKeepsStopVisibleWhileScrolling() {
        initialize(detector)
        check(controller.setTrackingEnabled(false))
        controller.configure(true, 0.5f)
        submit().get(10, TimeUnit.SECONDS)
        val model = DjiAttitudeViewModel(app, { error("No frame should start USB") })
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        val factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = model as T
        }
        ViewModelProvider(owner, factory)[DjiAttitudeViewModel::class.java]
        val diagnostics = DiagnosticViewModel(app)
        val turn = OneTurnViewModel(OneTurnTransport { error("Unexpected turn") }, configured = false)
        compose.setContent {
            CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
                DroneCvTheme {
                    val state by controller.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
                    val threads by controller.threadConfiguration.collectAsStateWithLifecycle()
                    LiveControls(state, true, 0.5f, {}, {}, null, diagnostics, motion, threads,
                        controller::requestThreads, rememberCameraProbeState(), controller, turn,
                        Modifier.width(320.dp).height(500.dp),
                        remember { mutableStateOf<CameraSection?>(CameraSection.DIAGNOSTICS) }, remember { mutableStateOf(true) })
                }
            }
        }
        compose.runOnIdle { model.startCentering(controller) }
        compose.onNodeWithTag("build-identity").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Свернуть").assertIsDisplayed()
        compose.onNodeWithText("Стоп автоцентрирования").assertIsDisplayed().performClick()
        owner.viewModelStore.clear()
    }

    @Test fun onePressRunsPackagedYoloUntilCenteredAndIgnoresInFlightExposure() {
        val publishInFlight = CountDownLatch(1)
        val backend = AndroidLiveBackend(app)
        initialize(object : LiveBackend<CameraFrameSnapshot> by backend {
            private var frames = 0
            override fun infer(frame: CameraFrameSnapshot, confidence: Float): LiveInference {
                val inference = backend.infer(frame, confidence)
                if (++frames == 3) check(publishInFlight.await(10, TimeUnit.SECONDS))
                return inference
            }
        })
        val diagnostics = DiagnosticViewModel(app)
        val turn = OneTurnViewModel(OneTurnTransport { error("The one-turn transport must stay idle") },
            configured = false)
        compose.setContent {
            DroneCvTheme {
                val state by controller.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
                val threads by controller.threadConfiguration.collectAsStateWithLifecycle()
                var running by remember { mutableStateOf(false) }
                LiveControls(
                    state = state, running = running, confidence = 0.5f,
                    onRunningChange = { running = it; controller.configure(it, 0.5f) },
                    onConfidenceChange = controller::updateThreshold,
                    issue = null, diagnostics = diagnostics, motionModel = motion,
                    threadState = threads, onThreadsChange = controller::requestThreads,
                    probe = rememberCameraProbeState(), controller = controller, oneTurn = turn,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        startButton().assertDoesNotExist()
        compose.onNodeWithTag("camera-settings").performClick()
        compose.onNodeWithText("A: YOLO").performScrollTo().performClick()
        compose.onNodeWithText("Начать детекцию").performClick()
        compose.onNodeWithTag("camera-diagnostics").performClick()
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val photo = assets.open("one-turn/bench-right.png").use { checkNotNull(BitmapFactory.decodeStream(it)) }
        try {
            submit(photo.width, photo.height).get(30, TimeUnit.SECONDS)
            startButton().performScrollTo().assertIsEnabled().performClick()
            val first = awaitSignal(sceneFrame(photo, shiftPx = 0))
            assertTrue("Initial YOLO box must be to the right of the dead zone",
                checkNotNull(first.center).x / first.width > 0.6)

            val inFlight = sceneFrame(photo, shiftPx = 0)
            expectSteps(1)
            publishInFlight.countDown()
            val old = awaitSignal(inFlight)
            assertTrue(old.center != null)
            compose.waitForIdle()

            val second = awaitSignal(sceneFrame(photo, shiftPx = -100))
            expectSteps(2)
            val third = awaitSignal(sceneFrame(photo, shiftPx = -200))
            val finalLabel = "Симуляция · По горизонтали в центре"
            compose.waitUntil(10_000) { compose.onAllNodesWithText(finalLabel).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(finalLabel).performScrollTo().assertIsDisplayed()

            val log = log("centered")
            assertEquals("yolo", log.header.getString("target_source"))
            assertEquals(1000, log.header.getInt("max_frame_age_ms"))
            val measured = log.ofKind("frame").map { it.getDouble("offset_percent") }
            val signals = listOf(first, second, third)
            assertEquals(signals.map { (checkNotNull(it.center).x / it.width - 0.5) * 100 }, measured)
            assertEquals(signals.map { it.frameId }, log.ofKind("frame").map { it.getLong("frame_id") })
            assertTrue(signals.all { checkNotNull(it.captureToSignalMs) in 0.0..1000.0 })
            assertTrue("Expected decreasing YOLO offsets, got $measured", measured.zipWithNext().all { (a,b) -> a > b })
            assertTrue(measured[1] > SIMULATION_DEAD_ZONE_PERCENT)
            assertTrue(kotlin.math.abs(measured.last()) <= SIMULATION_DEAD_ZONE_PERCENT)
            val requests = log.ofKind("step_requested")
            assertEquals(listOf("right", "right"), requests.map { it.getString("direction") })
            assertEquals(listOf(1, 2), requests.map { it.getInt("step") })
            assertEquals(measured.take(2), requests.map { it.getDouble("offset_percent") })
            val completions = log.ofKind("step_completed")
            assertEquals(listOf(1, 2), completions.map { it.getInt("simulated_position_steps") })
            val ignored = log.ofKind("frame_ignored").single()
            val firstCompletedNs = completions.first().getLong("completed_ns")
            assertEquals("before_required_capture", ignored.getString("reason"))
            assertEquals(firstCompletedNs, ignored.getLong("required_after_ns"))
            assertEquals(old.frameId, ignored.getLong("frame_id"))
            assertTrue(ignored.getLong("captured_ns") < firstCompletedNs)
            assertTrue(ignored.getLong("signal_publication_ns") > firstCompletedNs)
            assertTrue(requests.last().getLong("captured_ns") > firstCompletedNs)
            assertEquals(
                listOf("frame", "step_requested", "step_completed", "frame_ignored", "frame",
                    "step_requested", "step_completed", "frame", "finished"),
                log.events.map { it.getString("kind") },
            )
            assertEquals(2, log.result.getInt("completed_steps"))
            assertEquals(measured.last(), log.result.getDouble("offset_percent"), 0.0)
            Log.i("CenteringOnnxTest", "offsets=$measured capture_to_signal_ms=" +
                log.ofKind("frame").map { it.getDouble("capture_to_signal_ms") } +
                " rejected_frame=${old.frameId} completed_steps=2 reason=centered")
        } finally {
            publishInFlight.countDown()
            photo.recycle()
        }
    }

    @Test fun targetAlreadyInTheDeadZoneDoesNotRequestAStep() {
        start()
        publish(0.5f)
        expectFinished("По горизонтали в центре", "Шаги 0 / 5")
        val log = log("centered")
        assertEquals(listOf("frame", "finished"), log.events.map { it.getString("kind") })
    }

    @Test fun stopsAtTheStepLimitAfterConsideringAnotherFrame() {
        start(CenteringSimulationScenario(stepLimit = 1))
        publish(0.12f)
        expectSteps(1, limit = 1)
        publish(0.24f)
        expectFinished("Достигнут лимит шагов", "Шаги 1 / 1")
        val log = log("step_limit")
        assertEquals("left", log.ofKind("step_requested").single().getString("direction"))
        assertEquals(-1, log.ofKind("step_completed").single().getInt("simulated_position_steps"))
    }

    @Test fun stepTimeoutEndsSessionWithNoCompletedStep() {
        start(CenteringSimulationScenario(stepDelayMs = 2_000, stepTimeoutMs = 80))
        publish(0.88f)
        expectFinished("Истекло время ожидания шага", "Шаги 0 / 5")
        val log = log("step_timeout")
        assertEquals(listOf("frame", "step_requested", "finished"), log.events.map { it.getString("kind") })
    }

    @Test fun frameTimeoutEndsSessionWhenNoResultArrives() {
        start()
        expectFinished("Истекло время ожидания кадра", "Шаги 0 / 5")
        assertEquals(listOf("finished"), log("frame_timeout").events.map { it.getString("kind") })
    }

    @Test fun stopCancelsPendingStepAndClosesJournal() {
        start(CenteringSimulationScenario(stepDelayMs = 1_200))
        publish(0.88f)
        expectStatus("Выполняется шаг")
        startButton().assertIsNotEnabled()
        compose.onNodeWithTag("centering-simulation-stop").performClick()
        expectFinished("Остановлено", "Шаги 0 / 5")
        publish(0.88f)
        Thread.sleep(1_250)
        val log = log("stopped")
        assertEquals(listOf("frame", "step_requested", "finished"), log.events.map { it.getString("kind") })
        assertTrue(log.footer.getBoolean("interrupted"))
    }

    @Test fun changingSourceCancelsPendingStep() {
        start(CenteringSimulationScenario(stepDelayMs = 1_200))
        publish(0.88f)
        expectStatus("Выполняется шаг")
        source = controller.newSource()
        controller.configure(true, 0.5f)
        publish(0.88f)
        expectFinished("Источник или настройки камеры изменились", "Шаги 0 / 5")
        val log = log("source_changed")
        assertEquals(listOf("frame", "step_requested", "finished"), log.events.map { it.getString("kind") })
        assertTrue(log.footer.getBoolean("interrupted"))
    }

    @Test fun lossAfterAStepStopsSession() {
        start()
        publish(0.88f)
        expectSteps(1)
        publish(null)
        expectFinished("Цель потеряна", "Шаги 1 / 5")
        val log = log("target_lost")
        assertEquals(1, log.ofKind("step_requested").size)
        assertTrue(log.ofKind("frame").last().isNull("offset_percent"))
        assertTrue(log.result.isNull("offset_percent"))
    }

    private fun initialize(backend: LiveBackend<CameraFrameSnapshot>) {
        controller = LiveController(backend, worker, eventTime = SystemClock::elapsedRealtimeNanos,
            motion = motion.journal)
        source = controller.newSource()
    }

    private fun start(scenario: CenteringSimulationScenario = CenteringSimulationScenario()) {
        initialize(detector)
        check(controller.setTrackingEnabled(false))
        controller.configure(true, 0.5f)
        submit().get(10, TimeUnit.SECONDS)
        val model = CenteringSimulationViewModel(app, scenario)
        compose.setContent {
            DroneCvTheme {
                Column(Modifier.fillMaxSize().padding(12.dp)) {
                    CenteringSimulationPanel(controller, yoloReady = true, model = model)
                }
            }
        }
        startButton().performClick()
    }

    private fun publish(center: Float?) {
        detector.detections = center?.let {
            listOf(Detection("drone", 0.9f, NormalizedBox(it - 0.05f, 0.4f, it + 0.05f, 0.6f)))
        }.orEmpty()
        checkNotNull(submit().get(10, TimeUnit.SECONDS))
    }

    private fun sceneFrame(photo: Bitmap, shiftPx: Int): Future<TargetSignal?> {
        val scene = Bitmap.createBitmap(photo.width, photo.height, Bitmap.Config.ARGB_8888)
        try {
            Canvas(scene).apply {
                drawColor(photo.getPixel(photo.width - 1, 0))
                drawBitmap(photo, shiftPx.toFloat(), 0f, null)
            }
            return submit(scene.width, scene.height) { pixels ->
                scene.getPixels(pixels, 0, scene.width, 0, 0, scene.width, scene.height)
            }
        } finally {
            scene.recycle()
        }
    }

    private fun submit(
        width: Int = 640,
        height: Int = 480,
        fill: (IntArray) -> Unit = { it.fill(android.graphics.Color.BLACK) },
    ): Future<TargetSignal?> {
        val lease = checkNotNull(pool.acquire(width, height))
        try {
            fill(lease.pixels)
        } catch (error: Throwable) {
            lease.close()
            throw error
        }
        val now = SystemClock.elapsedRealtimeNanos()
        val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
        val frame = CameraFrameSnapshot(ArgbImage(width, height, lease.pixels), 0, 0.0, lease)
        val token = controller.beginFrame(source, stamp)
        if (token == null) {
            frame.close()
            error("Controller did not accept the frame")
        }
        controller.offerFrame(frame, token, stamp, preparationMs = 0.0)
        return worker.submit<TargetSignal?> { controller.signals.value?.takeIf { it.stamp == stamp } }
    }

    private fun awaitSignal(frame: Future<TargetSignal?>): TargetSignal =
        checkNotNull(frame.get(30, TimeUnit.SECONDS)) { "YOLO did not publish a signal for the submitted frame" }

    private fun startButton() = compose.onNodeWithTag("centering-simulation-start")

    private fun expectSteps(steps: Int, limit: Int = 5) {
        val label = "Шаги $steps / $limit"
        compose.waitUntil(10_000) { compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty() }
    }

    private class DetectorFixture : LiveBackend<CameraFrameSnapshot> {
        @Volatile var detections = emptyList<Detection>()
        override fun infer(frame: CameraFrameSnapshot, confidence: Float) =
            LiveInference(detections, frame.image.width, frame.image.height, 0.0)
        override fun close() = Unit
    }

    private fun expectStatus(status: String) {
        val label = "Симуляция · $status"
        compose.waitUntil(10_000) { compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(label).assertIsDisplayed()
    }

    private fun expectFinished(status: String, steps: String) {
        expectStatus(status)
        compose.onNodeWithText(steps).assertIsDisplayed()
        compose.onNodeWithTag("centering-simulation-start").assertIsEnabled()
        compose.onNodeWithTag("centering-simulation-stop").assertDoesNotExist()
    }

    private fun newJournal() = archive.inventory().entries.singleOrNull {
        it.kind == JournalKind.DIAGNOSTIC && it.id !in initialJournalIds
    }

    private fun log(reason: String): SimulationLog {
        compose.waitUntil(10_000) { newJournal()?.state == JournalState.COMPLETE }
        val id = checkNotNull(newJournal()).id
        val out = ByteArrayOutputStream()
        archive.selectExport(id).use { it.copy(openOutput = { out }) }
        val rows = out.toString(Charsets.UTF_8.name()).lineSequence().filter(String::isNotBlank)
            .map(::JSONObject).toList()
        val header = rows.first().getJSONObject("data")
        assertEquals("header", rows.first().getString("type"))
        assertTrue(header.getBoolean("simulation"))
        assertEquals("centering_simulation", header.getString("mode"))
        assertEquals("session_end", rows.last().getString("type"))
        val footer = rows.last().getJSONObject("data")
        assertTrue(footer.getBoolean("recording_complete"))
        assertEquals("0", footer.getString("dropped_count"))
        assertEquals(reason, footer.getString("reason"))
        assertEquals(reason in setOf("stopped", "source_changed"), footer.getBoolean("interrupted"))
        val events = rows.filter { it.getString("type") == "centering_simulation" }
            .map { it.getJSONObject("data") }
        assertFalse(events.isEmpty())
        assertTrue(events.all { it.getBoolean("simulation") })
        val finalRow = rows[rows.lastIndex - 1]
        assertEquals("centering_simulation", finalRow.getString("type"))
        val result = finalRow.getJSONObject("data")
        assertEquals("finished", result.getString("kind"))
        assertEquals(reason, result.getString("reason"))
        Log.i("CenteringOnnxTest", "journal_id=$id reason=$reason")
        return SimulationLog(header, events, result, footer)
    }

    private data class SimulationLog(
        val header: JSONObject,
        val events: List<JSONObject>,
        val result: JSONObject,
        val footer: JSONObject,
    ) {
        fun ofKind(kind: String): List<JSONObject> = events.filter { it.getString("kind") == kind }
    }
}
