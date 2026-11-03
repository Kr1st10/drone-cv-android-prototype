package ru.university.dronecv.diagnostics

import java.util.concurrent.Executor
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.LiveBackend
import ru.university.dronecv.camera.LiveController
import ru.university.dronecv.camera.LiveInference

class DiagnosticControllerTest {
    class Frame : AutoCloseable { var closed = false; override fun close() { closed = true } }
    @Test fun analyzerRecordsMeasuredStagesAndClosesFrame() {
        val frames = DiagnosticFrames(); val token = frames.start(0)
        val backend = object : LiveBackend<Frame> {
            override fun infer(frame: Frame, confidence: Float) = LiveInference(emptyList(), 640, 480, 3.0, 1.0, 2.0, 4.0)
            override fun close() = Unit
        }
        val times = ArrayDeque(listOf(100L, 10_000_100L))
        val controller = LiveController(backend, Executor { it.run() }, frames) { times.removeFirst() }
        controller.configure(true, .5f)
        val f = Frame(); controller.analyze(f)
        val snapshot = frames.stop(token, 20_000_000, false, null)!!
        assertTrue(f.closed); assertEquals(1, snapshot.frames.size); assertEquals(1L, snapshot.analyzerCallbacks)
        val sample = snapshot.frames.single()
        assertEquals(1.0, sample.conversionMs, 0.0); assertEquals(2.0, sample.preprocessMs, 0.0)
        assertEquals(3.0, sample.inferenceMs, 0.0); assertEquals(4.0, sample.postprocessMs, 0.0)
        assertEquals(10.0, sample.pipelineMs, 0.0)
        controller.close()
    }
    @Test fun inFlightCompletionCannotContaminateNextSession() {
        val frames = DiagnosticFrames(); val old = frames.start(0); var next = 0L
        val backend = object : LiveBackend<Frame> {
            override fun infer(frame: Frame, confidence: Float): LiveInference {
                frames.stop(old, 200, true, "interrupted"); next = frames.start(200)
                return LiveInference(emptyList(), 640, 480, 3.0, 1.0, 2.0, 4.0)
            }
            override fun close() = Unit
        }
        val times = ArrayDeque(listOf(100L, 300L))
        val controller = LiveController(backend, Executor { it.run() }, frames) { times.removeFirst() }
        controller.configure(true, .5f); val f = Frame(); controller.analyze(f)
        val after = frames.stop(next, 400, false, null)!!
        assertTrue(f.closed); assertEquals(0L, after.completedFrames); assertEquals(0L, after.analyzerCallbacks)
        controller.close()
    }
}
