package ru.university.dronecv.photo

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.detection.yolo.ModelIntegrityException

@OptIn(ExperimentalCoroutinesApi::class)
class PhotoControllerTest {
    private data class Image(val uri: String)
    private class Backend : PhotoBackend<Image> {
        val loaded = mutableListOf<String>()
        val discarded = mutableListOf<Image>()
        var closed = 0
        var inferCount = 0
        var onLoad: (String) -> Unit = {}
        var onInfer: () -> Unit = {}
        var result = PhotoInference(emptyList(), 12.5)
        override fun load(uri: String): Image { loaded += uri; onLoad(uri); return Image(uri) }
        override fun infer(image: Image): PhotoInference { inferCount++; onInfer(); return result }
        override fun discard(image: Image) { discarded += image }
        override fun close() { closed++ }
    }

    @Test fun emptyResultIsFinishedWithTimingAndCanRepeat() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        assertEquals(PhotoPhase.IDLE, controller.state.value.phase)
        assertFalse(controller.state.value.canRecognize)
        controller.recognize()
        controller.select("A")
        assertEquals(PhotoPhase.LOADING, controller.state.value.phase)
        assertNull(controller.state.value.image)
        runCurrent()
        assertEquals(PhotoPhase.READY, controller.state.value.phase)
        assertTrue(controller.state.value.canRecognize)
        controller.recognize()
        assertEquals(PhotoPhase.RUNNING, controller.state.value.phase)
        assertFalse(controller.state.value.canRecognize)
        controller.recognize() // Double tap must not enqueue another inference.
        runCurrent()
        assertEquals(1, backend.inferCount)
        assertEquals(PhotoPhase.EMPTY, controller.state.value.phase)
        assertEquals(12.5, controller.state.value.result!!.inferenceMs, 0.0)
        assertTrue(controller.state.value.result!!.detections.isEmpty())
        controller.recognize(); runCurrent()
        assertEquals(2, backend.inferCount)
        controller.close(); runCurrent()
        assertEquals(1, backend.closed)
    }

    @Test fun detectionsAndTimingArePublishedAndClearedOnNextSelection() = runTest {
        val backend = Backend().apply { result = PhotoInference(listOf(
            Detection("drone", 0.91f, NormalizedBox(0.1f, 0.2f, 0.4f, 0.5f))
        ), 45.0) }
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); runCurrent(); controller.recognize(); runCurrent()
        assertEquals(PhotoPhase.DETECTIONS, controller.state.value.phase)
        assertEquals(backend.result, controller.state.value.result)
        controller.select("B")
        assertEquals(PhotoPhase.LOADING, controller.state.value.phase)
        assertNull(controller.state.value.result)
        assertNull(controller.state.value.image)
        runCurrent()
        assertEquals(Image("B"), controller.state.value.image)
        assertNull(controller.state.value.result)
        controller.close(); runCurrent()
    }

    @Test fun rapidSelectionOnlyDecodesLatestQueuedPhoto() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); controller.select("B"); controller.select("C"); runCurrent()
        assertEquals(listOf("C"), backend.loaded)
        assertEquals(Image("C"), controller.state.value.image)
        controller.close(); runCurrent()
    }

    @Test fun nonCancellableOldDecodeIsDiscardedAndNeverPublished() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        backend.onLoad = { if (it == "A") {
            controller.select("B")
            assertEquals(PhotoPhase.LOADING, controller.state.value.phase)
        } }
        controller.select("A"); runCurrent()
        assertEquals(listOf(Image("A")), backend.discarded)
        assertEquals(Image("B"), controller.state.value.image)
        controller.close(); runCurrent()
    }

    @Test fun nonCancellableOldInferenceCannotOverwriteNewPhoto() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); runCurrent()
        backend.onInfer = { controller.select("B") }
        controller.recognize(); runCurrent()
        assertEquals(PhotoPhase.READY, controller.state.value.phase)
        assertEquals(Image("B"), controller.state.value.image)
        assertNull(controller.state.value.result)
        assertTrue(backend.discarded.isEmpty()) // Published images belong to the renderer/GC.
        controller.close(); runCurrent()
    }

    @Test fun lateFailureCannotOverwriteNewPhoto() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); runCurrent()
        backend.onInfer = { controller.select("B"); throw IllegalStateException("old inference failed") }
        controller.recognize(); runCurrent()
        assertEquals(PhotoPhase.READY, controller.state.value.phase)
        assertNull(controller.state.value.error)
        assertEquals(Image("B"), controller.state.value.image)
        controller.close(); runCurrent()
    }

    @Test fun permissionErrorAndNextSelectionRecover() = runTest {
        val backend = Backend().apply { onLoad = { throw SecurityException("revoked URI") } }
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); runCurrent()
        assertEquals(PhotoPhase.ERROR, controller.state.value.phase)
        assertEquals(PhotoError.ACCESS, controller.state.value.error)
        assertFalse(controller.state.value.canRecognize)
        backend.onLoad = {}
        controller.select("B"); runCurrent()
        assertEquals(PhotoPhase.READY, controller.state.value.phase)
        assertNull(controller.state.value.error)
        controller.close(); runCurrent()
    }

    @Test fun modelErrorRetainsPhotoForRetryAndClearsOldResult() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); runCurrent()
        backend.onInfer = { throw ModelIntegrityException("bad hash") }
        controller.recognize(); runCurrent()
        assertEquals(PhotoPhase.ERROR, controller.state.value.phase)
        assertEquals(PhotoError.MODEL_INTEGRITY, controller.state.value.error)
        assertEquals(Image("A"), controller.state.value.image)
        assertTrue(controller.state.value.canRecognize)
        assertNull(controller.state.value.result)
        backend.onInfer = {}
        controller.recognize(); runCurrent()
        assertEquals(PhotoPhase.EMPTY, controller.state.value.phase)
        controller.close(); runCurrent()
    }

    @Test fun memoryErrorIsReportedWithoutKillingWorker() = runTest {
        val backend = Backend().apply { onLoad = { throw OutOfMemoryError("decode") } }
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); runCurrent()
        assertEquals(PhotoError.MEMORY, controller.state.value.error)
        backend.onLoad = {}
        controller.select("B"); runCurrent()
        assertEquals(PhotoPhase.READY, controller.state.value.phase)
        controller.close(); runCurrent()
    }

    @Test fun closeDuringNativeInferenceRejectsResultAndClosesBackendOnce() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); runCurrent()
        backend.onInfer = { controller.close() }
        controller.recognize(); runCurrent()
        assertEquals(PhotoPhase.IDLE, controller.state.value.phase)
        assertNull(controller.state.value.image)
        assertEquals(1, backend.closed)
        controller.close(); controller.select("B"); controller.recognize(); runCurrent()
        assertEquals(listOf("A"), backend.loaded)
        assertEquals(1, backend.closed)
    }

    @Test fun closeBeforeFirstDispatchClosesBackendAndDropsPendingWork() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        controller.select("A"); controller.close(); runCurrent()
        assertEquals(1, backend.closed)
        assertTrue(backend.loaded.isEmpty())
        assertEquals(PhotoPhase.IDLE, controller.state.value.phase)
    }

    @Test fun closeDuringDecodeDiscardsUnpublishedBitmap() = runTest {
        val backend = Backend()
        val controller = PhotoController(backend, StandardTestDispatcher(testScheduler))
        backend.onLoad = { controller.close() }
        controller.select("A"); runCurrent()
        assertEquals(listOf(Image("A")), backend.discarded)
        assertEquals(1, backend.closed)
        assertNull(controller.state.value.image)
    }
}
