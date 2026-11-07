package ru.university.dronecv

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.GrayFrame
import ru.university.dronecv.tracking.OpenCvLkTracker
import ru.university.dronecv.tracking.TrackBox
import kotlin.random.Random

@RunWith(AndroidJUnit4::class)
class OpenCvLkInstrumentedTest {
    @Test fun tracksActualTranslatedPixelsAndLosesDisappearingPatch() {
        OpenCvLkTracker().use { tracker ->
            assertNotNull(tracker.initialize(frame(1, 0, 0), TrackBox(32.0, 24.0, 64.0, 56.0)))
            for (i in 1..5) {
                val result = tracker.update(frame(i + 1, i * 4, i * 2))
                assertNotNull("Lost synthetic textured patch at step $i", result)
                assertEquals(48.0 + i * 4, result!!.box.centerX, 1.0)
                assertEquals(40.0 + i * 2, result.box.centerY, 1.0)
                assertTrue(result.quality.points >= 4)
            }
            assertNull(tracker.update(frame(7, 0, 0, visible = false)))
            assertNull(tracker.update(frame(8, 0, 0)))
        }
    }

    @Test fun refusesTexturelessOrTinyTargetAndRejectsNewSource() {
        OpenCvLkTracker().use { tracker ->
            val box = TrackBox(32.0, 24.0, 64.0, 56.0)
            assertNull(tracker.initialize(frame(1, 0, 0, visible = false), box))
            assertNull(tracker.initialize(frame(1, 0, 0), TrackBox(32.0, 24.0, 38.0, 30.0)))
            assertNotNull(tracker.initialize(frame(1, 0, 0), box))
            assertNull(tracker.update(frame(2, 4, 2, source = 9)))
        }
    }

    private fun frame(sequence: Int, dx: Int, dy: Int, visible: Boolean = true, source: Long = 2): GrayFrame {
        val pixels = ByteArray(128 * 96) { 30 }
        val texture = Random(71)
        for (y in 0 until 32) for (x in 0 until 32) {
            val value = texture.nextInt(40, 240).toByte()
            if (visible) pixels[(24 + dy + y) * 128 + 32 + dx + x] = value
        }
        val entry = 1_000_000_000L + sequence * 33_000_000L
        return GrayFrame.copyOf(FrameKey(1, source, sequence.toLong()),
            FrameStamp(entry, CaptureTimebase.ELAPSED_REALTIME, entry), 128, 96, pixels)
    }
}
