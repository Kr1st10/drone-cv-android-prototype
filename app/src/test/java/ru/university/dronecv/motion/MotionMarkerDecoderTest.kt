package ru.university.dronecv.motion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.rotated

class MotionMarkerDecoderTest {
    private fun marker(corrupt: Boolean = false, brokenQuiet: Boolean = false): ArgbImage {
        val data = intArrayOf(0xd1, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0)
        var crc = 0
        for (i in 0..8) {
            crc = crc xor data[i]
            repeat(8) { crc = if (crc and 128 != 0) ((crc shl 1) xor 7) and 255 else (crc shl 1) and 255 }
        }
        data[9] = crc xor if (corrupt) 1 else 0
        val width = 160; val height = 140; val module = 6
        val pixels = IntArray(width * height) { 0xff000000.toInt() }
        for (y in 0 until 10 * module) for (x in 0 until 12 * module) {
            val col = x / module; val row = y / module
            val bit = (row - 1) * 10 + col - 1
            val black = row in 1..8 && col in 1..10 && data[bit / 8] and (1 shl (7 - bit % 8)) != 0
            pixels[(20 + y) * width + 25 + x] = if (black) 0xff000000.toInt() else -1
        }
        if (brokenQuiet) for (y in 20 until 26) for (x in 49 until 55) pixels[y * width + x] = 0xff000000.toInt()
        return ArgbImage(width, height, pixels)
    }

    @Test fun decodesUnsignedValuesInAllCameraRotations() {
        val upright = marker()
        for (rotation in listOf(0, 90, 180, 270)) {
            val raw = upright.rotated((360 - rotation) % 360)
            assertEquals(MotionMarker("89abcdef", 0xfedcba98L), MotionMarkerDecoder.decode(raw, rotation))
        }
    }

    @Test fun decodesShearedMarker() {
        val source = marker()
        val pixels = IntArray(source.width * source.height) { 0xff000000.toInt() }
        for (y in 0 until source.height) for (x in 0 until source.width) {
            val shifted = x + y / 10
            if (shifted < source.width) pixels[y * source.width + shifted] = source[x, y]
        }
        assertEquals(MotionMarker("89abcdef", 0xfedcba98L), MotionMarkerDecoder.decode(ArgbImage(source.width, source.height, pixels), 0))
    }

    @Test fun reusesScratchAcrossDifferentFrameSizesAndRejectsOversizedFrame() {
        assertEquals(MotionMarker("89abcdef", 0xfedcba98L), MotionMarkerDecoder.decode(marker(), 0))
        assertNull(MotionMarkerDecoder.decode(ArgbImage(1025, 1024, IntArray(1025 * 1024)), 0))
        assertEquals(MotionMarker("89abcdef", 0xfedcba98L), MotionMarkerDecoder.decode(marker(), 0))
    }

    @Test fun rejectsCorruptCrcAndQuietZone() {
        assertNull(MotionMarkerDecoder.decode(marker(corrupt = true), 0))
        assertNull(MotionMarkerDecoder.decode(marker(brokenQuiet = true), 0))
    }
}
