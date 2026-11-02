package ru.university.dronecv.camera

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.NormalizedBox

class CameraGeometryTest {
    @Test fun uprightCropMapsOntoPortraitViewportWithoutSecondRotationOrLetterboxing() {
        assertArrayEquals(floatArrayOf(108f, 384f, 432f, 1152f),
            CameraGeometry.map(NormalizedBox(0.1f, 0.2f, 0.4f, 0.6f), 1080f, 1920f), 0.001f)
    }

    @Test fun uprightCropMapsOntoLandscapeViewport() {
        assertArrayEquals(floatArrayOf(384f, 108f, 1536f, 972f),
            CameraGeometry.map(NormalizedBox(0.2f, 0.1f, 0.8f, 0.9f), 1920f, 1080f), 0.001f)
    }

    @Test fun cropEdgesAndCenterStayAlignedAfterViewportResize() {
        val full = NormalizedBox(0f, 0f, 1f, 1f)
        val center = NormalizedBox(0.5f, 0.5f, 0.5f, 0.5f)
        for ((width, height) in listOf(333f to 777f, 777f to 333f, 100f to 100f)) {
            assertArrayEquals(floatArrayOf(0f, 0f, width, height), CameraGeometry.map(full, width, height), 0f)
            assertArrayEquals(floatArrayOf(width / 2, height / 2, width / 2, height / 2),
                CameraGeometry.map(center, width, height), 0f)
        }
    }

    @Test fun rejectsUnmeasuredViewport() {
        val box = NormalizedBox(0f, 0f, 1f, 1f)
        assertThrows(IllegalArgumentException::class.java) { CameraGeometry.map(box, 0f, 1920f) }
        assertThrows(IllegalArgumentException::class.java) { CameraGeometry.map(box, 1080f, -1f) }
    }
}
