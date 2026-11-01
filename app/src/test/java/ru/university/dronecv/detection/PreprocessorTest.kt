package ru.university.dronecv.detection

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.YoloPreprocessor
import ru.university.dronecv.detection.yolo.rotated

class PreprocessorTest {
    private val s = 640
    private val plane = s * s
    private val pad = 114f / 255f
    private val pre = YoloPreprocessor(s)
    private fun at(t: FloatArray, c: Int, y: Int, x: Int) = t[c * plane + y * s + x]

    @Test
    fun tensorShapePaddingAndNormalization() {
        val t = FloatArray(pre.tensorSize)
        assertEquals(3 * 640 * 640, t.size)
        val lb = pre.preprocess(solid(640, 480, argb(10, 20, 30)), 0, t)
        assertEquals(80, lb.padTop)
        // Поля сверху/снизу = 114/255 во всех каналах.
        for (c in 0..2) {
            assertEquals(pad, at(t, c, 0, 0), 0f); assertEquals(pad, at(t, c, 79, 639), 0f)
            assertEquals(pad, at(t, c, 560, 0), 0f); assertEquals(pad, at(t, c, 639, 639), 0f)
        }
        // Область изображения: RGB / 255, порядок каналов R, G, B.
        assertEquals(10f / 255f, at(t, 0, 80, 0), 0f)
        assertEquals(20f / 255f, at(t, 1, 300, 320), 0f)
        assertEquals(30f / 255f, at(t, 2, 559, 639), 0f)
    }

    @Test
    fun channelOrderIsRgbForPortraitImage() {
        val t = FloatArray(pre.tensorSize)
        val lb = pre.preprocess(solid(1080, 1920, argb(255, 0, 0)), 0, t)
        assertEquals(140, lb.padLeft)
        assertEquals(1f, at(t, 0, 320, 320), 0f)
        assertEquals(0f, at(t, 1, 320, 320), 0f)
        assertEquals(0f, at(t, 2, 320, 320), 0f)
        assertEquals(pad, at(t, 0, 320, 139), 0f)
        assertEquals(1f, at(t, 0, 320, 140), 0f)
        assertEquals(1f, at(t, 0, 320, 499), 0f)
        assertEquals(pad, at(t, 0, 320, 500), 0f)
    }

    @Test
    fun noResizeIsExactCopy() {
        val img = gradient(640, 480)
        val t = FloatArray(pre.tensorSize)
        pre.preprocess(img, 0, t)
        for (y in listOf(0, 1, 239, 479)) for (x in listOf(0, 1, 255, 639)) {
            val c = img[x, y]
            assertEquals(((c shr 16) and 255) / 255f, at(t, 0, y + 80, x), 0f)
            assertEquals(((c shr 8) and 255) / 255f, at(t, 1, y + 80, x), 0f)
            assertEquals((c and 255) / 255f, at(t, 2, y + 80, x), 0f)
        }
    }

    @Test
    fun bilinearDownscaleByTwoAveragesPixelPairs() {
        // cv2 INTER_LINEAR при уменьшении в 2 раза: src = 2*dst + 0.5 -> среднее двух соседних пикселей.
        val w = 1280; val h = 960
        val img = ArgbImage(w, h, IntArray(w * h) { i -> val x = i % w; argb((x * 2) % 256, 0, 0) })
        val t = FloatArray(pre.tensorSize)
        val lb = pre.preprocess(img, 0, t)
        assertEquals(0.5f, lb.scale)
        // dst x=10 -> src 20.5 -> (R(20) + R(21)) / 2 = (40 + 42) / 2 = 41
        assertEquals(41f / 255f, at(t, 0, 80 + 5, 10), 1e-6f)
    }

    @Test
    fun linearTableMatchesOpenCvCoordinateMapping() {
        val i0 = IntArray(4); val i1 = IntArray(4); val w = FloatArray(4)
        YoloPreprocessor.linearTable(srcSize = 2, dstSize = 4, i0, i1, w) // upscale x2
        // src = (d + 0.5) / 2 - 0.5 = -0.25, 0.25, 0.75, 1.25 -> clamp на краях.
        assertArrayEquals(intArrayOf(0, 0, 0, 1), i0)
        assertArrayEquals(intArrayOf(1, 1, 1, 1), i1)
        assertArrayEquals(floatArrayOf(0f, 0.25f, 0.75f, 0f), w, 1e-6f)
    }

    @Test
    fun rotationIsFoldedIntoSampling() {
        // Кадр 480x640 (портрет сенсора) с rotation=90 должен дать тот же тензор, что и заранее повёрнутый кадр.
        val raw = gradient(480, 640)
        for (deg in listOf(0, 90, 180, 270)) {
            val a = FloatArray(pre.tensorSize); val b = FloatArray(pre.tensorSize)
            val lbA = pre.preprocess(raw, deg, a)
            val lbB = pre.preprocess(raw.rotated(deg), 0, b)
            assertEquals(lbB, lbA)
            assertArrayEquals("rotation $deg", b, a, 0f)
        }
    }

    @Test
    fun explicitRotationMapping() {
        // 3x2:  a b c        90° по часовой:  d a        180°: f e d     270°: c f
        //       d e f                         e b              c b a           b e
        //                                     f c                              a d
        val img = ArgbImage(3, 2, intArrayOf(1, 2, 3, 4, 5, 6))
        assertArrayEquals(intArrayOf(4, 1, 5, 2, 6, 3), img.rotated(90).pixels)
        assertArrayEquals(intArrayOf(6, 5, 4, 3, 2, 1), img.rotated(180).pixels)
        assertArrayEquals(intArrayOf(3, 6, 2, 5, 1, 4), img.rotated(270).pixels)
        assertArrayEquals(img.pixels, img.rotated(90).rotated(270).pixels)
        assertArrayEquals(img.rotated(270).pixels, img.rotated(-90).pixels)
        assertEquals(2, img.rotated(90).width); assertEquals(3, img.rotated(90).height)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsNonRightAngleRotation() {
        pre.preprocess(solid(10, 10, 0), 45, FloatArray(pre.tensorSize))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsWrongBufferSize() {
        pre.preprocess(solid(10, 10, 0), 0, FloatArray(10))
    }
}
