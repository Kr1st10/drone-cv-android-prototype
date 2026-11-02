package ru.university.dronecv.camera

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.yolo.rotated

class RgbaFrameConverterTest {
    @Test fun readsRgbaChannelsWithCropStrideAndNonzeroBufferPosition() {
        // Three 3-pixel rows, 4 padding bytes per row; final row has no trailing padding.
        val prefix = 5
        val buffer = ByteBuffer.allocate(prefix + 16 * 2 + 12)
        for (y in 0 until 3) for (x in 0 until 3) {
            val at = prefix + y * 16 + x * 4
            buffer.put(at, (10 + y * 3 + x).toByte())
            buffer.put(at + 1, (80 + y).toByte())
            buffer.put(at + 2, (160 + x).toByte())
            buffer.put(at + 3, 0x17.toByte()) // Alpha must not be confused with red.
        }
        buffer.position(prefix)
        val image = RgbaFrameConverter().convert(buffer, 3, 3, 16, 4, 1, 1, 3, 3)
        assertEquals(2, image.width)
        assertEquals(2, image.height)
        assertArrayEquals(intArrayOf(0xff0e51a1.toInt(), 0xff0f51a2.toInt(),
            0xff1152a1.toInt(), 0xff1252a2.toInt()), image.pixels)
        assertEquals(prefix, buffer.position())
        assertEquals(buffer.capacity(), buffer.limit())
    }

    @Test fun croppedImageRotatesClockwiseInAllFourOrientations() {
        val source = ByteBuffer.allocate(3 * 2 * 4)
        for (value in 1..6) source.put(value.toByte()).put(0).put(0).put(0xff.toByte())
        source.flip()
        val cropped = RgbaFrameConverter().convert(source, 3, 2, 12, 4, 1, 0, 3, 2)
        val expected = mapOf(0 to listOf(2, 3, 5, 6), 90 to listOf(5, 2, 6, 3),
            180 to listOf(6, 5, 3, 2), 270 to listOf(3, 6, 2, 5))
        for ((rotation, values) in expected) {
            val image = cropped.rotated(rotation)
            assertEquals(2, image.width)
            assertEquals(2, image.height)
            assertEquals(values, image.pixels.map { (it ushr 16) and 0xff })
        }
    }

    @Test fun nonsquareFrameSwapsDimensionsOnlyForQuarterTurns() {
        val source = ByteBuffer.allocate(3 * 2 * 4)
        for (value in 1..6) source.put(value.toByte()).put(0).put(0).put(0xff.toByte())
        source.flip()
        val image = RgbaFrameConverter().convert(source, 3, 2, 12, 4, 0, 0, 3, 2)
        val clockwise = image.rotated(90)
        assertEquals(2, clockwise.width)
        assertEquals(3, clockwise.height)
        assertEquals(listOf(4, 1, 5, 2, 6, 3), clockwise.pixels.map { (it ushr 16) and 0xff })
        assertEquals(listOf(3, 6, 2, 5, 1, 4), image.rotated(270).pixels.map { (it ushr 16) and 0xff })
        assertEquals(3, image.rotated(180).width)
        assertEquals(2, image.rotated(180).height)
    }

    @Test fun honorsBufferLimitAndRejectsTruncatedPlane() {
        val buffer = ByteBuffer.allocate(32)
        buffer.limit(15)
        assertThrows(IllegalArgumentException::class.java) {
            RgbaFrameConverter().convert(buffer, 2, 2, 8, 4, 0, 0, 2, 2)
        }
    }

    @Test fun rejectsInvalidCropAndPixelOrRowStrides() {
        val converter = RgbaFrameConverter()
        val buffer = ByteBuffer.allocate(16)
        assertThrows(IllegalArgumentException::class.java) {
            converter.convert(buffer, 2, 2, 8, 3, 0, 0, 2, 2)
        }
        assertThrows(IllegalArgumentException::class.java) {
            converter.convert(buffer, 2, 2, 7, 4, 0, 0, 2, 2)
        }
        assertThrows(IllegalArgumentException::class.java) {
            converter.convert(buffer, 2, 2, 8, 4, -1, 0, 1, 2)
        }
        assertThrows(IllegalArgumentException::class.java) {
            converter.convert(buffer, 2, 2, 8, 4, 1, 0, 1, 2)
        }
        assertThrows(IllegalArgumentException::class.java) {
            converter.convert(buffer, 2, 2, 8, 4, 0, 0, 3, 2)
        }
    }

    @Test fun bufferReuseDoesNotRetainPixelsAfterClearOrSizeChange() {
        val converter = RgbaFrameConverter()
        val first = ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8))
        val firstPixels = converter.convert(first, 2, 1, 8, 4, 0, 0, 2, 1).pixels
        val nextPixels = converter.convert(first, 2, 1, 8, 4, 0, 0, 2, 1).pixels
        assertSame(firstPixels, nextPixels) // Borrowed worker buffer is intentionally reused.
        val smaller = converter.convert(first, 2, 1, 8, 4, 0, 0, 1, 1)
        assertEquals(1, smaller.pixels.size)
        assertEquals(0xff010203.toInt(), smaller.pixels.single())
        converter.clear()
        val afterClear = converter.convert(first, 2, 1, 8, 4, 0, 0, 1, 1)
        assertNotSame(smaller.pixels, afterClear.pixels)
        assertArrayEquals(smaller.pixels, afterClear.pixels)
    }
}
