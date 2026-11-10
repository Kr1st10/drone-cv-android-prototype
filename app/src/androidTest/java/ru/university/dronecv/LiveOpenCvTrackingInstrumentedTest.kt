package ru.university.dronecv

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.Executor
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.LiveBackend
import ru.university.dronecv.camera.LiveController
import ru.university.dronecv.camera.LiveInference
import ru.university.dronecv.camera.LiveTracking
import ru.university.dronecv.camera.TrackingSampleKind
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.tracking.GrayFrame
import ru.university.dronecv.tracking.OpenCvLkTracker
import ru.university.dronecv.tracking.TrackingSession
import kotlin.random.Random

@RunWith(AndroidJUnit4::class)
class LiveOpenCvTrackingInstrumentedTest {
    @Test fun delayedFixtureDetectionIsReplayedAndTracksSubsequentMotion() {
        val vision = QueueExecutor()
        val worker = QueueExecutor()
        val backend = FixtureBackend()
        var now = 1_000_000_000L
        val session = TrackingSession(factory = { OpenCvLkTracker() })
        val tracking = LiveTracking<Frame>(vision, session) { frame, key, stamp ->
            GrayFrame.copyOf(key, stamp, 128, 96, frame.pixels)
        }
        val controller = LiveController(backend, worker, eventTime = { now }, tracking = tracking, nanoTime = { 0L })
        val frames = mutableListOf<Frame>()
        fun offer(step: Int) {
            now = 1_000_000_000L + step * 33_000_000L
            val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
            val frame = Frame(pixels(step * 4, step * 2)).also { frames += it }
            val token = checkNotNull(controller.beginFrame(0, stamp))
            controller.offerFrame(frame, token, stamp, 0.0)
        }
        try {
            controller.configure(true, 0.5f)
            vision.drain()
            offer(0) // The fixture detection is anchored to this image.
            offer(1) // Arrives before the detector returns.
            assertEquals(0, backend.calls)
            worker.runNext() // infer
            vision.runNext() // prepare replay through frame 1
            worker.runNext() // replay with real OpenCV LK
            offer(2) // A further image arrives before correction commits.
            vision.runNext() // commit also advances through that tail image

            val corrected = checkNotNull(controller.state.value.tracking)
            assertEquals(TrackingSampleKind.CORRECTION, corrected.kind)
            assertEquals(3L, corrected.observation.key.sequence)
            assertEquals(56.0, checkNotNull(corrected.box).centerX, 1.0)
            assertEquals(44.0, corrected.box!!.centerY, 1.0)
            assertEquals(1, backend.calls)

            offer(3)
            val tracked = checkNotNull(controller.state.value.tracking)
            assertEquals(TrackingSampleKind.FRAME, tracked.kind)
            assertEquals(4L, tracked.observation.key.sequence)
            assertEquals(60.0, checkNotNull(tracked.box).centerX, 1.0)
            assertEquals(46.0, tracked.box!!.centerY, 1.0)
            assertEquals(1, backend.calls)
            assertTrue(frames.all { it.closes == 1 })
        } finally {
            controller.close()
            vision.drain()
            worker.drain()
        }
    }

    private class Frame(val pixels: ByteArray) : AutoCloseable {
        var closes = 0
        override fun close() { closes++ }
    }

    private class QueueExecutor : Executor {
        private val tasks = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { tasks.addLast(command) }
        fun runNext() { tasks.removeFirst().run() }
        fun drain() { while (tasks.isNotEmpty()) runNext() }
    }

    // This output is a scripted test fixture, not a YOLO inference or accuracy measurement.
    private class FixtureBackend : LiveBackend<Frame> {
        var calls = 0
        override fun infer(frame: Frame, confidence: Float): LiveInference {
            calls++
            return LiveInference(listOf(Detection("drone", 0.9f,
                NormalizedBox(32f / 128, 24f / 96, 64f / 128, 56f / 96))), 128, 96, 0.0)
        }
        override fun close() = Unit
    }

    private fun pixels(dx: Int, dy: Int): ByteArray {
        val pixels = ByteArray(128 * 96) { 30 }
        val texture = Random(71)
        for (y in 0 until 32) for (x in 0 until 32) {
            pixels[(24 + dy + y) * 128 + 32 + dx + x] = texture.nextInt(40, 240).toByte()
        }
        return pixels
    }
}
