package ru.university.dronecv.camera

import java.util.concurrent.Executor
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.detection.highestConfidenceVisibleDetection
import ru.university.dronecv.detection.yolo.Letterbox
import ru.university.dronecv.detection.yolo.YoloPostprocessor
import ru.university.dronecv.detection.yolo.toDetection
import ru.university.dronecv.diagnostics.DiagnosticFrames
import ru.university.dronecv.photo.PhotoBackend
import ru.university.dronecv.photo.PhotoController
import ru.university.dronecv.photo.PhotoInference
import ru.university.dronecv.photo.PhotoPhase

@OptIn(ExperimentalCoroutinesApi::class)
class VisibleDetectionContractTest {
    private val decoded = YoloPostprocessor(listOf("drone")).decode(
        floatArrayOf(100f, 100f, 20f, 280f, 20f, 20f, 20f, 20f, .95f, .8f),
        longArrayOf(1, 5, 2), Letterbox.compute(640, 480, 640),
    ).map { it.toDetection(640, 480) }
    private val empty = decoded[0]
    private val visible = decoded[1]
    private val clipped = YoloPostprocessor(listOf("drone")).decode(
        floatArrayOf(0f, 80f, 20f, 20f, .7f), longArrayOf(1, 5, 1),
        Letterbox.compute(640, 480, 640),
    ).single().toDetection(640, 480)
    private val tiny = Detection("drone", .6f, NormalizedBox(.5f, .5f, .50000006f, .50000006f))
    private val cases get() = listOf(
        listOf(empty) to emptyList(),
        listOf(empty, visible) to listOf(visible),
        listOf(clipped) to listOf(clipped),
        listOf(tiny) to listOf(tiny),
    )

    @Test fun rawPostprocessKeepsParityButTargetIgnoresLetterboxOnlyDetection() {
        assertEquals(2, decoded.size)
        assertEquals(0f, empty.box.top)
        assertEquals(0f, empty.box.bottom)
        assertEquals(visible, decoded.highestConfidenceVisibleDetection())
        val selected = selectTarget(decoded, 640, 480)!!
        assertEquals(100.0, selected.center.x, .001)
        assertEquals(200.0, selected.center.y, .001)
        assertEquals(.8f, selected.confidence)
    }

    @Test fun onlyEmptyFramePublishesNoTargetAndNoConfidence() {
        val target = selectTarget(listOf(empty), 640, 480)
        assertNull(listOf(empty).highestConfidenceVisibleDetection())
        val signal = targetSignal(1, 1, FrameStamp(1, CaptureTimebase.ELAPSED_REALTIME, 1), 1, 640, 480, target)
        assertEquals(TargetStatus.NO_TARGET, signal.status)
        assertNull(signal.center)
        assertNull(signal.confidence)
    }

    @Test fun partiallyClippedAndArbitrarilySmallPositiveBoxesRemainTargets() {
        assertEquals(NormalizedBox(0f, 0f, 10f / 640, 10f / 480), clipped.box)
        for (detection in listOf(clipped, tiny)) {
            assertEquals(detection.confidence, selectTarget(listOf(detection), 640, 480)!!.confidence)
        }
    }

    @Test fun liveOverlayResultsSignalAndDiagnosticCountsUseTheSameVisibleList() {
        for ((input, expected) in cases) {
            val frames = DiagnosticFrames()
            val session = frames.start(0)
            val backend = object : LiveBackend<Frame> {
                override fun infer(frame: Frame, confidence: Float) = LiveInference(input, 640, 480, 3.0, 1.0, 2.0, 4.0)
                override fun close() = Unit
            }
            val controller = LiveController(backend, Executor { it.run() }, frames, eventTime = { 2L })
            controller.configure(true, .5f)
            controller.analyze(Frame(), stamp = FrameStamp(1, CaptureTimebase.ELAPSED_REALTIME, 1))
            assertEquals(expected, controller.state.value.result!!.detections)
            val signal = controller.state.value.target!!
            assertEquals(if (expected.isEmpty()) TargetStatus.NO_TARGET else TargetStatus.DETECTED, signal.status)
            assertEquals(expected.maxOfOrNull { it.confidence }, signal.confidence)
            val recorded = frames.stop(session, Long.MAX_VALUE, false, null)!!.frames.single()
            assertEquals(expected.size, recorded.detectionCount)
            controller.close()
        }
    }

    @Test fun photoPhaseOverlayAndListCountUseVisibleDetections() = runTest {
        for ((input, expected) in cases) {
            val backend = object : PhotoBackend<String> {
                override fun load(uri: String) = uri
                override fun infer(image: String) = PhotoInference(input, 3.0)
                override fun discard(image: String) = Unit
                override fun close() = Unit
            }
            val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
            controller.select("image"); runCurrent()
            controller.recognize(); runCurrent()
            assertEquals(if (expected.isEmpty()) PhotoPhase.EMPTY else PhotoPhase.DETECTIONS, controller.state.value.phase)
            assertEquals(expected, controller.state.value.result!!.detections)
            controller.close(); runCurrent()
        }
    }

    private class Frame : AutoCloseable { override fun close() = Unit }
}
