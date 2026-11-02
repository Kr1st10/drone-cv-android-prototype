package ru.university.dronecv.detection

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.detection.onnx.OnnxDroneDetector

/**
 * Реальный инференс на устройстве/эмуляторе (модель из assets APK, ONNX Runtime Android).
 * Запуск: `./gradlew connectedDebugAndroidTest` (нужна модель в assets, см. ml/scripts/install_android_model.py).
 */
@RunWith(AndroidJUnit4::class)
class OnnxDroneDetectorInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun pattern(w: Int, h: Int): Bitmap {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        for (y in 0 until h) for (x in 0 until w) bmp.setPixel(x, y, Color.rgb(x % 256, y % 256, (x * y) % 256))
        return bmp
    }

    @Test
    fun loadsModelAndRunsInference() {
        OnnxDroneDetector.create(context).use { det ->
            assertEquals(listOf("drone"), det.labels)
            val bmp = pattern(1280, 720)
            val r = det.detectDetailed(bmp, 0)
            assertEquals(1280, r.imageWidth); assertEquals(720, r.imageHeight)
            Log.i("OnnxDroneDetectorTest", "detections=${r.detections.size} pre=${r.preprocessMs} ms " +
                "infer=${r.inferenceMs} ms post=${r.postprocessMs} ms")
            det.detect(bmp, 0).forEach { assertTrue(it.confidence in 0f..1f) }
        }
    }

    @Test
    fun rotationGivesSameResultAsPreRotatedBitmap() {
        OnnxDroneDetector.create(context).use { det ->
            val upright = pattern(720, 1280)
            val sensor = Bitmap.createBitmap(upright, 0, 0, 720, 1280, Matrix().apply { postRotate(-90f) }, false)
            // sensor — кадр, который нужно повернуть на 90° по часовой стрелке, чтобы получить upright.
            assertEquals(det.detect(upright, 0), det.detect(sensor, 90))
        }
    }

    @Test
    fun mainThreadIsRejectedAndCloseIsFinal() {
        val det = OnnxDroneDetector.create(context)
        val bmp = pattern(64, 64)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            assertThrows(IllegalStateException::class.java) { det.detect(bmp, 0) }
        }
        det.close()
        assertThrows(IllegalStateException::class.java) { det.detect(bmp, 0) }
    }
}
