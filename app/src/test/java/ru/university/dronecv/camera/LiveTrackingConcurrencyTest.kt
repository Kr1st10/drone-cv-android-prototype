package ru.university.dronecv.camera

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.tracking.GrayFrame
import ru.university.dronecv.tracking.TrackingSession

class LiveTrackingConcurrencyTest {
    private class Frame : AutoCloseable {
        val closes = AtomicInteger()
        override fun close() { closes.incrementAndGet() }
    }

    @Test fun staleTrackingResultCannotEscapeDisposedController() = exerciseBlockedInference(false)
    @Test fun staleTrackingErrorCannotEscapeDisposedController() = exerciseBlockedInference(true)

    private fun exerciseBlockedInference(failOld: Boolean) {
        val vision = Executors.newSingleThreadExecutor { Thread(it, "tracking-test-vision") }
        val ml = Executors.newSingleThreadExecutor { Thread(it, "tracking-test-ml") }
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val newEntered = CountDownLatch(1)
        val events = Collections.synchronizedList(mutableListOf<String>())
        val oldCalls = AtomicInteger()
        val now = 1_000_000_000L
        val stamp = FrameStamp(null, CaptureTimebase.UNKNOWN, now)
        val oldBackend = object : LiveBackend<Frame> {
            override fun infer(frame: Frame, confidence: Float): LiveInference {
                oldCalls.incrementAndGet()
                events.add("old infer")
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                check(frame.closes.get() == 0)
                events.add("old infer end")
                if (failOld) error("obsolete inference failure")
                return LiveInference(emptyList(), 100, 100, 1.0)
            }
            override fun close() { events.add("old close:${Thread.currentThread().name}") }
        }
        val newBackend = object : LiveBackend<Frame> {
            override fun infer(frame: Frame, confidence: Float): LiveInference {
                events.add("new infer:${Thread.currentThread().name}")
                newEntered.countDown()
                return LiveInference(emptyList(), 100, 100, 1.0)
            }
            override fun close() { events.add("new close") }
        }
        fun tracking() = LiveTracking<Frame>(vision, TrackingSession({ error("no detection expected") })) { _, key, frameStamp ->
            GrayFrame.copyOf(key, frameStamp, 100, 100, ByteArray(10000))
        }
        val oldTracking = tracking()
        val old = LiveController(oldBackend, ml, eventTime = { now }, tracking = oldTracking, nanoTime = { now })
        val fresh = LiveController(newBackend, ml, eventTime = { now }, tracking = tracking(), nanoTime = { now })
        fun offer(controller: LiveController<Frame>, source: Long, snapshot: Frame) {
            val input = Frame()
            vision.submit {
                LiveFrameCapture<Frame, Frame>(controller) { PreparedLiveFrame(snapshot, 0.0) }
                    .analyze(input, source, stamp)
            }.get(5, TimeUnit.SECONDS)
            assertEquals(1, input.closes.get())
        }
        try {
            val source = old.newSource()
            old.configure(true, .5f)
            val held = Frame()
            offer(old, source, held)
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            old.configure(false, .5f)
            old.configure(true, .5f)
            val rejected = Frame()
            offer(old, source, rejected)
            assertTrue("reservation survives stop/start", oldTracking.inFlight)
            assertEquals(1, rejected.closes.get())
            assertEquals(1, oldCalls.get())
            assertEquals(0, held.closes.get())
            assertTrue(events.none { it.startsWith("old close") })

            old.close()
            val newSource = fresh.newSource()
            fresh.configure(true, .5f)
            val newFrame = Frame()
            offer(fresh, newSource, newFrame)
            assertEquals(1L, newEntered.count)
            assertEquals(0, held.closes.get())
            release.countDown()
            assertTrue(newEntered.await(5, TimeUnit.SECONDS))
            ml.submit {}.get(5, TimeUnit.SECONDS)
            vision.submit {}.get(5, TimeUnit.SECONDS)
            assertEquals(1, held.closes.get())
            assertEquals(1, newFrame.closes.get())
            assertEquals(LivePhase.STOPPED, old.state.value.phase)
            assertNull(old.state.value.result)
            assertNull(old.state.value.tracking)
            assertNull(old.state.value.error)
            assertEquals(LivePhase.RUNNING, fresh.state.value.phase)
            assertNull(fresh.state.value.error)
            assertEquals(1, oldCalls.get())
            assertFalse(oldTracking.inFlight)
            val order = events.toList()
            assertEquals("old infer", order[0])
            assertEquals("old infer end", order[1])
            val newIndex = order.indexOf("new infer:tracking-test-ml")
            assertTrue(newIndex > 2)
            assertTrue(order.subList(2, newIndex).all { it == "old close:tracking-test-ml" })
        } finally {
            release.countDown()
            old.close()
            fresh.close()
            ml.shutdown()
            assertTrue(ml.awaitTermination(5, TimeUnit.SECONDS))
            vision.shutdown()
            assertTrue(vision.awaitTermination(5, TimeUnit.SECONDS))
        }
    }
}
