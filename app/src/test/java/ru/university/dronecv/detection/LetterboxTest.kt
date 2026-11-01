package ru.university.dronecv.detection

import org.junit.Assert.assertEquals
import org.junit.Test
import ru.university.dronecv.detection.yolo.Letterbox

/** Геометрия letterbox; ожидаемые значения совпадают с ml/tests/test_postprocess.py и Ultralytics LetterBox. */
class LetterboxTest {

    @Test
    fun landscape640x480() {
        val lb = Letterbox.compute(640, 480, 640)
        assertEquals(1f, lb.scale)
        assertEquals(640, lb.resizedWidth); assertEquals(480, lb.resizedHeight)
        assertEquals(0, lb.padLeft); assertEquals(80, lb.padTop)
    }

    @Test
    fun portrait1080x1920() {
        val lb = Letterbox.compute(1080, 1920, 640)
        assertEquals(640f / 1920f, lb.scale, 1e-7f)
        assertEquals(360, lb.resizedWidth); assertEquals(640, lb.resizedHeight)
        assertEquals(140, lb.padLeft); assertEquals(0, lb.padTop)
    }

    @Test
    fun landscape4000x3000() {
        val lb = Letterbox.compute(4000, 3000, 640)
        assertEquals(0.16f, lb.scale, 1e-7f)
        assertEquals(640, lb.resizedWidth); assertEquals(480, lb.resizedHeight)
        assertEquals(0, lb.padLeft); assertEquals(80, lb.padTop)
    }

    @Test
    fun oddPaddingUsesUltralyticsRounding() {
        // 1001x1000: newH = round(639.36) = 639, dh = 0.5 -> top = round(0.4) = 0, bottom = round(0.6) = 1.
        val lb = Letterbox.compute(1001, 1000, 640)
        assertEquals(640, lb.resizedWidth); assertEquals(639, lb.resizedHeight)
        assertEquals(0, lb.padLeft); assertEquals(0, lb.padTop)
        // 640x477: dh = 81.5 -> top = round(81.4) = 81.
        assertEquals(81, Letterbox.compute(640, 477, 640).padTop)
    }

    @Test
    fun upscalingSmallImage() {
        val lb = Letterbox.compute(320, 240, 640)
        assertEquals(2f, lb.scale)
        assertEquals(640, lb.resizedWidth); assertEquals(480, lb.resizedHeight); assertEquals(80, lb.padTop)
    }

    @Test
    fun inverseMappingToSource() {
        val lb = Letterbox.compute(1080, 1920, 640)
        // Центр входа (320, 320) -> центр изображения (540, 960).
        assertEquals(540f, lb.toSourceX(320f), 1e-3f)
        assertEquals(960f, lb.toSourceY(320f), 1e-3f)
        assertEquals(0f, lb.toSourceX(140f), 1e-4f)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsEmptyImage() {
        Letterbox.compute(0, 10, 640)
    }
}
