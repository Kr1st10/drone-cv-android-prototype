package ru.university.dronecv.tracking

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.rotated

class GrayFrameTest {
    private val key = FrameKey(1, 2, 1)
    private val stamp = FrameStamp(10, CaptureTimebase.ELAPSED_REALTIME, 20)

    @Test fun `grayscale shares upright geometry with detector for every rotation`() {
        val source = ArgbImage(3, 2, intArrayOf(0xffff0000.toInt(), 0xff00ff00.toInt(), 0xff0000ff.toInt(),
            0xff000000.toInt(), 0xffffffff.toInt(), 0xff808080.toInt()))
        for (rotation in listOf(0, 90, 180, 270)) {
            val gray = GrayFrame.fromArgb(key, stamp, source, rotation)
            val upright = source.rotated(rotation)
            val reference = GrayFrame.fromArgb(key, stamp, upright, 0)
            assertEquals(upright.width, gray.width)
            assertEquals(upright.height, gray.height)
            assertArrayEquals(reference.copyPixels(), gray.copyPixels())
        }
        val gray = GrayFrame.fromArgb(key, stamp, source, 0)
        assertEquals(77, gray[0, 0]); assertEquals(149, gray[1, 0]); assertEquals(29, gray[2, 0])
        source.pixels.fill(0)
        assertEquals(255, gray[1, 1])
    }

    @Test fun `input and output arrays cannot mutate an owned gray frame`() {
        val pixels = byteArrayOf(5, 6)
        val frame = GrayFrame.copyOf(key, stamp, 2, 1, pixels)
        pixels.fill(9)
        frame.copyPixels().fill(10)
        assertEquals(5, frame[0, 0])
        assertEquals(6, frame[1, 0])
    }

    @Test fun `appearance sampling is continuous across subpixel motion`() {
        val frame = GrayFrame.copyOf(key, stamp, 2, 2, byteArrayOf(0, 100, 200.toByte(), 240.toByte()))
        assertEquals(135.0, frame.sample(.5, .5), .00001)
        assertEquals(170.0, frame.sample(1.0, .5), .00001)
        assertEquals(frame.sample(1.0, .5), frame.sample(.99999, .5), .01)
        assertEquals(240.0, frame.sample(10.0, 10.0), .00001)
    }

    @Test fun `history bounds frames and bytes and detects evicted replay anchor`() {
        val history = GrayHistory(maxFrames = 3, maxBytes = 8)
        val frames = (1L..4).map { GrayFrame.copyOf(FrameKey(1, 2, it), stamp, 2, 2, ByteArray(4)) }
        frames.forEach(history::add)
        assertEquals(8, history.bytes)
        assertNull(history.from(frames[1].key))
        assertEquals(listOf(frames[2], frames[3]), history.from(frames[2].key))
        history.clear()
        assertEquals(0, history.bytes)
        assertNull(history.latest)
    }

    @Test fun `oversized or invalid frames fail before retention`() {
        assertThrows(IllegalArgumentException::class.java) {
            GrayFrame.copyOf(key, stamp, 1025, 1024, ByteArray(1025 * 1024))
        }
        assertThrows(IllegalArgumentException::class.java) { GrayFrame.copyOf(key, stamp, 0, 1, byteArrayOf()) }
        assertThrows(IllegalArgumentException::class.java) {
            GrayFrame.fromArgb(key, stamp, ArgbImage(1, 1, intArrayOf(0)), 45)
        }
    }
}
