package ru.university.dronecv.photo

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Device/emulator checks: real Android codecs, EXIF and the photo-to-ORT adapter, no mocked predictions. */
@RunWith(AndroidJUnit4::class)
class PhotoDecoderInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun jpeg(): File {
        val bitmap = Bitmap.createBitmap(40, 20, Bitmap.Config.ARGB_8888)
        for (y in 0 until 20) for (x in 0 until 40) {
            bitmap.setPixel(x, y, when {
                x < 20 && y < 10 -> Color.RED
                x >= 20 && y < 10 -> Color.GREEN
                x < 20 -> Color.BLUE
                else -> Color.YELLOW
            })
        }
        return File.createTempFile("photo-test", ".jpg", context.cacheDir).also { file ->
            try { file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, it)) } }
            finally { bitmap.recycle() }
        }
    }

    private fun assertColor(expected: Int, actual: Int) {
        assertEquals(Color.red(expected).toDouble(), Color.red(actual).toDouble(), 40.0)
        assertEquals(Color.green(expected).toDouble(), Color.green(actual).toDouble(), 40.0)
        assertEquals(Color.blue(expected).toDouble(), Color.blue(actual).toDouble(), 40.0)
    }

    @Test fun respectsAllEightExifOrientations() {
        val topLeft = listOf(Color.RED, Color.GREEN, Color.YELLOW, Color.BLUE,
            Color.RED, Color.BLUE, Color.YELLOW, Color.GREEN)
        val bottomRight = listOf(Color.YELLOW, Color.BLUE, Color.RED, Color.GREEN,
            Color.YELLOW, Color.GREEN, Color.RED, Color.BLUE)
        AndroidPhotoBackend(context).use { backend ->
            for (orientation in 1..8) {
                val file = jpeg()
                try {
                    ExifInterface(file).apply {
                        setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString()); saveAttributes()
                    }
                    val image = backend.load(Uri.fromFile(file).toString())
                    try {
                        assertEquals(if (orientation <= 4) 40 else 20, image.width)
                        assertEquals(if (orientation <= 4) 20 else 40, image.height)
                        assertColor(topLeft[orientation - 1], image.getPixel(image.width / 4, image.height / 4))
                        assertColor(bottomRight[orientation - 1], image.getPixel(3 * image.width / 4, 3 * image.height / 4))
                    } finally { image.recycle() }
                } finally { file.delete() }
            }
        }
    }

    @Test fun largeImageIsBoundedAndTransparentPixelsMatchDisplayedRgb() {
        AndroidPhotoBackend(context).use { backend ->
            val file = File.createTempFile("photo-large", ".png", context.cacheDir)
            try {
                val source = Bitmap.createBitmap(4100, 20, Bitmap.Config.ARGB_8888)
                try { file.outputStream().use { assertTrue(source.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
                finally { source.recycle() }
                val decoded = backend.load(Uri.fromFile(file).toString())
                try {
                    assertTrue(decoded.width <= 2048 && decoded.height <= 2048)
                    assertEquals(Bitmap.Config.ARGB_8888, decoded.config)
                    assertFalse(decoded.hasAlpha())
                    assertEquals(Color.BLACK, decoded.getPixel(0, 0))
                } finally { decoded.recycle() }
            } finally { file.delete() }
        }
    }

    @Test fun decodedPhotoRunsThroughRealLocalDetector() {
        val file = jpeg()
        try {
            AndroidPhotoBackend(context).use { backend ->
                val image = backend.load(Uri.fromFile(file).toString())
                try {
                    val result = backend.infer(image)
                    assertTrue(result.inferenceMs.isFinite() && result.inferenceMs >= 0)
                    result.detections.forEach { assertTrue(it.confidence in 0f..1f) }
                } finally { image.recycle() }
            }
        } finally { file.delete() }
    }

    @Test fun corruptImageIsRejected() {
        val file = File.createTempFile("photo-corrupt", ".jpg", context.cacheDir)
        try {
            file.writeText("not an image")
            AndroidPhotoBackend(context).use { backend ->
                assertThrows(Exception::class.java) { backend.load(Uri.fromFile(file).toString()) }
            }
        } finally { file.delete() }
    }
}
