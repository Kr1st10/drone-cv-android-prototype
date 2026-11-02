package ru.university.dronecv.detection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.university.dronecv.detection.yolo.Letterbox
import ru.university.dronecv.detection.yolo.PixelBox
import ru.university.dronecv.detection.yolo.PostprocessConfig
import ru.university.dronecv.detection.yolo.YoloPostprocessor
import ru.university.dronecv.detection.yolo.toDetection

/** Декодирование выхода [1, 5, 8400], порог, NMS и обратное преобразование координат (зеркало ml/tests). */
class PostprocessorTest {
    private val post = YoloPostprocessor(listOf("drone"))
    private val shape = longArrayOf(1, 5, 8400)
    private val lb640x480 = Letterbox.compute(640, 480, 640)
    private fun row(vararg v: Float) = v

    @Test
    fun emptyOutputReturnsEmptyList() {
        assertTrue(post.decode(FloatArray(5 * 8400), shape, lb640x480).isEmpty())
        assertTrue(post.decode(FloatArray(0), longArrayOf(1, 5, 0), lb640x480).isEmpty())
    }

    @Test
    fun scoresAtOrBelowThresholdAndNaNAreDropped() {
        val out = yoloOutput(listOf(row(100f, 300f, 10f, 10f, 0.25f), row(200f, 300f, 10f, 10f, Float.NaN)))
        assertTrue(post.decode(out, shape, lb640x480).isEmpty())
    }

    @Test
    fun invalidGeometryAndNonFiniteScoresAreDropped() {
        val valid = row(100f, 280f, 20f, 10f, 0.9f)
        val rows = mutableListOf(valid)
        for (channel in 0..4) {
            for (invalid in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
                rows += valid.copyOf().apply { this[channel] = invalid }
            }
        }
        for (channel in 2..3) {
            for (invalid in listOf(0f, -10f)) rows += valid.copyOf().apply { this[channel] = invalid }
        }
        val result = post.decode(yoloOutput(rows), shape, lb640x480)
        assertEquals(1, result.size)
        assertEquals(PixelBox(90f, 195f, 110f, 205f), result.single().box)
        result.single().toDetection(640, 480)
    }

    @Test
    fun decodeAndUndoLetterboxPadding() {
        // 640x480 -> pad_top 80. Центр (100, 280) во входе = (100, 200) в исходнике.
        val d = post.decode(yoloOutput(listOf(row(100f, 280f, 20f, 10f, 0.9f))), shape, lb640x480).single()
        assertEquals(PixelBox(90f, 195f, 110f, 205f), d.box)
        assertEquals(0.9f, d.confidence, 1e-6f)
        assertEquals("drone", d.label); assertEquals(0, d.classId)
    }

    @Test
    fun undoScale() {
        val lb = Letterbox.compute(1280, 1280, 640) // scale 0.5, без полей
        val d = post.decode(yoloOutput(listOf(row(320f, 320f, 64f, 64f, 0.8f))), shape, lb).single()
        assertEquals(PixelBox(576f, 576f, 704f, 704f), d.box)
    }

    @Test
    fun undoScaleAndHorizontalPaddingForPortrait() {
        val lb = Letterbox.compute(1080, 1920, 640) // scale 1/3, pad_left 140
        val d = post.decode(yoloOutput(listOf(row(320f, 320f, 30f, 60f, 0.5f))), shape, lb).single()
        assertEquals(495f, d.box.left, 1e-2f); assertEquals(870f, d.box.top, 1e-2f)
        assertEquals(585f, d.box.right, 1e-2f); assertEquals(1050f, d.box.bottom, 1e-2f)
    }

    @Test
    fun thresholdNmsOrderingAndClipping() {
        val lb = Letterbox.compute(640, 640, 640)
        val rows = listOf(
            row(100f, 100f, 40f, 40f, 0.9f), row(102f, 101f, 40f, 40f, 0.8f), // перекрываются -> одна
            row(400f, 400f, 30f, 30f, 0.6f),                                   // отдельная -> остаётся
            row(300f, 300f, 30f, 30f, 0.2f),                                   // ниже порога
            row(5f, 5f, 30f, 30f, 0.7f),                                       // выходит за край -> обрезка
        )
        val dets = post.decode(yoloOutput(rows), shape, lb, PostprocessConfig(0.25f, 0.7f))
        assertEquals(listOf(0.9f, 0.7f, 0.6f), dets.map { it.confidence })
        val clipped = dets[1].box
        assertEquals(0f, clipped.left, 0f); assertEquals(0f, clipped.top, 0f); assertEquals(20f, clipped.right, 1e-5f)
    }

    @Test
    fun lowerIouThresholdSuppressesMore() {
        val lb = Letterbox.compute(640, 640, 640)
        // IoU двух рамок 40x40 со сдвигом 10 px = 1200/2000 = 0.6
        val rows = listOf(row(100f, 100f, 40f, 40f, 0.9f), row(110f, 100f, 40f, 40f, 0.8f))
        assertEquals(2, post.decode(yoloOutput(rows), shape, lb, PostprocessConfig(iouThreshold = 0.7f)).size)
        assertEquals(1, post.decode(yoloOutput(rows), shape, lb, PostprocessConfig(iouThreshold = 0.5f)).size)
    }

    @Test
    fun maxDetectionsLimit() {
        val lb = Letterbox.compute(640, 640, 640)
        val rows = (0 until 50).map { row(10f + it * 12f, 50f, 10f, 10f, 0.3f + it * 0.01f) }
        val dets = post.decode(yoloOutput(rows), shape, lb, PostprocessConfig(maxDetections = 5))
        assertEquals(5, dets.size)
        assertEquals(0.79f, dets.first().confidence, 1e-5f)
    }

    @Test
    fun multiClassNmsIsPerClass() {
        val post2 = YoloPostprocessor(listOf("drone", "bird"))
        val n = 8400
        val out = FloatArray(6 * n)
        fun put(i: Int, vararg v: Float) = v.forEachIndexed { c, x -> out[c * n + i] = x }
        put(0, 100f, 100f, 40f, 40f, 0.9f, 0.1f)
        put(1, 101f, 100f, 40f, 40f, 0.1f, 0.8f) // та же область, другой класс -> не подавляется
        val dets = post2.decode(out, longArrayOf(1, 6, n.toLong()), Letterbox.compute(640, 640, 640))
        assertEquals(listOf("drone", "bird"), dets.map { it.label })
        assertEquals(listOf(0, 1), dets.map { it.classId })
    }

    @Test(expected = IllegalArgumentException::class)
    fun wrongShapeRank() {
        post.decode(FloatArray(5 * 8400), longArrayOf(5, 8400), lb640x480)
    }

    @Test(expected = IllegalArgumentException::class)
    fun wrongNumberOfClasses() {
        post.decode(FloatArray(6 * 8400), longArrayOf(1, 6, 8400), lb640x480)
    }

    @Test(expected = IllegalArgumentException::class)
    fun dataSizeMismatch() {
        post.decode(FloatArray(100), shape, lb640x480)
    }

    @Test
    fun normalizedDetectionMapping() {
        val d = post.decode(yoloOutput(listOf(row(100f, 280f, 20f, 10f, 0.9f))), shape, lb640x480).single()
        val n = d.toDetection(640, 480)
        assertEquals(90f / 640f, n.box.left, 1e-6f); assertEquals(195f / 480f, n.box.top, 1e-6f)
        assertEquals(110f / 640f, n.box.right, 1e-6f); assertEquals(205f / 480f, n.box.bottom, 1e-6f)
        assertEquals("drone", n.label); assertEquals(0.9f, n.confidence, 1e-6f)
        val px = n.box.toPixels(640, 480)
        assertEquals(90f, px[0], 1e-3f); assertEquals(205f, px[3], 1e-3f)
    }
}
