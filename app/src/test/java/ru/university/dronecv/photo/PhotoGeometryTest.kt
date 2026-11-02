package ru.university.dronecv.photo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.university.dronecv.detection.NormalizedBox

class PhotoGeometryTest {
    private val fullImage = NormalizedBox(0f, 0f, 1f, 1f)

    @Test
    fun landscapePhotoInPortraitViewportHasVerticalMargins() {
        val viewport = PhotoViewport.fit(4000, 2000, 1000f, 1600f)
        assertEquals(0f, viewport.left, 0f)
        assertEquals(550f, viewport.top, 0f)
        assertEquals(1000f, viewport.width, 0f)
        assertEquals(500f, viewport.height, 0f)
        assertEquals(PhotoScreenBox(0f, 550f, 1000f, 1050f), viewport.map(fullImage))
        assertEquals(
            PhotoScreenBox(250f, 675f, 750f, 925f),
            viewport.map(NormalizedBox(0.25f, 0.25f, 0.75f, 0.75f)),
        )
    }

    @Test
    fun portraitPhotoInLandscapeViewportHasHorizontalMargins() {
        val viewport = PhotoViewport.fit(1000, 2000, 1600f, 1000f)
        assertEquals(PhotoScreenBox(550f, 0f, 1050f, 1000f), viewport.map(fullImage))
        assertEquals(
            PhotoScreenBox(600f, 200f, 950f, 800f),
            viewport.map(NormalizedBox(0.1f, 0.2f, 0.8f, 0.8f)),
        )
    }

    @Test
    fun squarePhotoAndViewportNeedNoOffsets() {
        val viewport = PhotoViewport.fit(640, 640, 320f, 320f)
        assertEquals(PhotoScreenBox(0f, 0f, 320f, 320f), viewport.map(fullImage))
        assertEquals(PhotoScreenBox(160f, 160f, 160f, 160f), viewport.map(NormalizedBox(0.5f, 0.5f, 0.5f, 0.5f)))
    }

    @Test
    fun oddAspectRatioPreservesFitScaleWithoutIntegerRounding() {
        val viewport = PhotoViewport.fit(4031, 3023, 393f, 701f)
        val expectedHeight = 3023.0 * 393.0 / 4031.0
        assertEquals(393f, viewport.width, 0.0001f)
        assertEquals(expectedHeight.toFloat(), viewport.height, 0.0001f)
        assertEquals(((701.0 - expectedHeight) / 2).toFloat(), viewport.top, 0.0001f)
        val box = viewport.map(NormalizedBox(0.3f, 0.1f, 0.9f, 0.7f))
        assertEquals(0.6f * viewport.width, box.right - box.left, 0.0001f)
        assertEquals(0.6f * viewport.height, box.bottom - box.top, 0.0001f)
    }

    @Test
    fun viewportSupportsUpscalingAndRotatedImageDimensions() {
        val landscape = PhotoViewport.fit(2, 1, 100f, 100f)
        val upright = PhotoViewport.fit(1, 2, 100f, 100f)
        assertEquals(PhotoScreenBox(0f, 25f, 100f, 75f), landscape.map(fullImage))
        assertEquals(PhotoScreenBox(25f, 0f, 75f, 100f), upright.map(fullImage))
    }

    @Test
    fun viewportCalculationsAvoidOverflowForLargeDimensions() {
        val viewport = PhotoViewport.fit(Int.MAX_VALUE, Int.MAX_VALUE, 1080f, 1920f)
        assertEquals(PhotoScreenBox(0f, 420f, 1080f, 1500f), viewport.map(fullImage))
        val hugeViewport = PhotoViewport.fit(1, 1, Float.MAX_VALUE, Float.MAX_VALUE)
        val bounds = hugeViewport.map(fullImage)
        assertTrue(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom).all { it.isFinite() })
        assertEquals(Float.MAX_VALUE, bounds.right, 0f)
        assertEquals(Float.MAX_VALUE, bounds.bottom, 0f)
    }

    @Test
    fun viewportRejectsEmptyAndNonFiniteSizes() {
        for (bad in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            assertThrows(IllegalArgumentException::class.java) { PhotoViewport.fit(100, 100, bad, 10f) }
            assertThrows(IllegalArgumentException::class.java) { PhotoViewport.fit(100, 100, 10f, bad) }
        }
        assertThrows(IllegalArgumentException::class.java) { PhotoViewport.fit(0, 100, 10f, 10f) }
        assertThrows(IllegalArgumentException::class.java) { PhotoViewport.fit(100, -1, 10f, 10f) }
    }

    @Test
    fun decodeFitBoundsLandscapePortraitAndSquare() {
        assertEquals(PhotoDecodeSize(2048, 1536), PhotoDecodeSize.fit(8000, 6000))
        assertEquals(PhotoDecodeSize(1536, 2048), PhotoDecodeSize.fit(6000, 8000))
        assertEquals(PhotoDecodeSize(2048, 2048), PhotoDecodeSize.fit(8000, 8000))
    }

    @Test
    fun decodeFitNeverUpscalesAndHandlesExtremeHeaders() {
        assertEquals(PhotoDecodeSize(17, 23), PhotoDecodeSize.fit(17, 23))
        assertEquals(PhotoDecodeSize(2048, 1), PhotoDecodeSize.fit(Int.MAX_VALUE, 1))
        assertEquals(PhotoDecodeSize(1, 2048), PhotoDecodeSize.fit(1, Int.MAX_VALUE))
        assertEquals(PhotoDecodeSize(1, 1), PhotoDecodeSize.fit(Int.MAX_VALUE, Int.MAX_VALUE, 1))
        val odd = PhotoDecodeSize.fit(4031, 3023)
        assertEquals(2048, odd.width)
        assertTrue(kotlin.math.abs(odd.height - 3023.0 * 2048 / 4031) <= 0.5)
    }

    @Test
    fun sampleSizeAccountsForOddDimensionsAndDoesNotOverflow() {
        assertEquals(1, PhotoDecodeSize.sampleSize(2048, 1024))
        assertEquals(2, PhotoDecodeSize.sampleSize(2049, 1000))
        assertEquals(4, PhotoDecodeSize.sampleSize(8000, 6000))
        assertEquals(4, PhotoDecodeSize.sampleSize(4097, 1))
        assertEquals(1 shl 20, PhotoDecodeSize.sampleSize(Int.MAX_VALUE, 1))
        assertEquals(1 shl 30, PhotoDecodeSize.sampleSize(Int.MAX_VALUE, 1, 2))
        assertThrows(IllegalArgumentException::class.java) { PhotoDecodeSize.sampleSize(Int.MAX_VALUE, 1, 1) }
    }

    @Test
    fun decodingRejectsInvalidDimensions() {
        for ((width, height, maxSide) in listOf(Triple(0, 1, 2048), Triple(1, -1, 2048), Triple(1, 1, 0))) {
            assertThrows(IllegalArgumentException::class.java) { PhotoDecodeSize.fit(width, height, maxSide) }
            assertThrows(IllegalArgumentException::class.java) { PhotoDecodeSize.sampleSize(width, height, maxSide) }
        }
    }
}
