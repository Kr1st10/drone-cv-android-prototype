package ru.university.dronecv.detection

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import org.junit.AfterClass
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import ru.university.dronecv.detection.onnx.ModelFiles
import ru.university.dronecv.detection.onnx.YoloOnnxEngine
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.ModelNotFoundException
import ru.university.dronecv.detection.yolo.PixelBox

/**
 * Реальный инференс экспортированной модели тем же Kotlin-кодом, что и в приложении (ONNX Runtime JVM),
 * и сравнение с Python-эталоном `ml/scripts/make_android_reference.py`.
 *
 * Требует (git-ignored): `ml/weights/yolo11s-drone-640.onnx` и `ml/data/android_parity/`.
 * Модель и её SHA-256 обязательны. Только два сравнения с Python пропускаются без локальных parity fixtures.
 */
class OnnxParityTest {

    companion object {
        private val modelFile = File(System.getProperty("drone.model.path", "ml/weights/yolo11s-drone-640.onnx"))
        private val expectedSha = System.getProperty("drone.model.sha256", "")
        private val parityDir = File(System.getProperty("drone.parity.dir", "ml/data/android_parity"))
        private var engine: YoloOnnxEngine? = null

        @BeforeClass
        @JvmStatic
        fun setUp() {
            check(modelFile.isFile) { "Model missing: $modelFile; run ml/scripts/install_android_model.py" }
            check(expectedSha.isNotEmpty() && ModelFiles.sha256(modelFile) == expectedSha) { "Model SHA-256 mismatch" }
            engine = YoloOnnxEngine.fromFile(modelFile)
        }

        @AfterClass
        @JvmStatic
        fun tearDown() {
            engine?.close()
        }

        /** Binary PPM (P6, maxval 255), записанный make_android_reference.py. */
        fun loadPpm(file: File): ArgbImage {
            val bytes = file.readBytes()
            var pos = 0
            fun token(): String {
                while (bytes[pos].toInt().toChar().isWhitespace()) pos++
                val start = pos
                while (!bytes[pos].toInt().toChar().isWhitespace()) pos++
                return String(bytes, start, pos - start)
            }
            check(token() == "P6") { "not a P6 PPM: $file" }
            val w = token().toInt(); val h = token().toInt(); check(token() == "255")
            pos++ // один пробельный символ после maxval
            val px = IntArray(w * h) { i ->
                val o = pos + 3 * i
                argb(bytes[o].toInt() and 255, bytes[o + 1].toInt() and 255, bytes[o + 2].toInt() and 255)
            }
            return ArgbImage(w, h, px)
        }

        fun readFloats(file: File): FloatArray {
            val bb = ByteBuffer.wrap(file.readBytes()).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
            return FloatArray(bb.remaining()).also { bb.get(it) }
        }
    }

    private fun requireEngine(): YoloOnnxEngine {
        assumeTrue("Model not found: $modelFile (run ml/scripts/fetch_and_export.py)", engine != null)
        return engine!!
    }

    private data class Case(
        val id: String, val image: File, val rotation: Int, val width: Int, val height: Int,
        val inputTensor: File?, val outputTensor: File?, val dets: List<Pair<PixelBox, Float>>,
    )

    private fun cases(): List<Case> {
        val tsv = File(parityDir, "reference.tsv")
        assumeTrue("Parity reference not found: $tsv (run ml/scripts/make_android_reference.py)", tsv.isFile)
        return tsv.readLines().filter { it.isNotBlank() && !it.startsWith("#") }.map { line ->
            val f = line.split('\t')
            val dets = if (f[7] == "-") emptyList() else f[7].split(';').map { d ->
                val v = d.split(',').map(String::toFloat)
                PixelBox(v[0], v[1], v[2], v[3]) to v[4]
            }
            Case(f[0], File(parityDir, f[1]), f[2].toInt(), f[3].toInt(), f[4].toInt(),
                f[5].takeIf { it != "-" }?.let { File(parityDir, it) },
                f[6].takeIf { it != "-" }?.let { File(parityDir, it) }, dets)
        }
    }

    @Test
    fun modelFileMatchesManifestSha256() {
        assumeTrue(modelFile.isFile && expectedSha.isNotEmpty())
        assertEquals(expectedSha, ModelFiles.sha256(modelFile))
    }

    @Test
    fun inputAndOutputTensorShapes() {
        val spec = requireEngine().spec
        assertEquals("images", spec.inputName)
        assertEquals("output0", spec.outputName)
        assertEquals(listOf(1L, 3L, 640L, 640L), spec.inputShape.toList())
        assertEquals(listOf(1L, 5L, 8400L), spec.outputShape.toList())
        assertEquals(listOf("drone"), spec.labels)
    }

    @Test
    fun runsOnUniformImagesAndReturnsWellFormedResults() {
        val e = requireEngine()
        for (color in listOf(argb(114, 114, 114), argb(0, 0, 0), argb(255, 255, 255))) {
            val r = e.detect(solid(1280, 720, color))
            assertEquals(1280, r.imageWidth); assertEquals(720, r.imageHeight)
            for (d in r.detections) {
                assertTrue(d.confidence > 0.25f && d.confidence <= 1f)
                assertTrue(d.box.left >= 0f && d.box.right <= 1280f && d.box.left <= d.box.right)
                assertTrue(d.box.top >= 0f && d.box.bottom <= 720f && d.box.top <= d.box.bottom)
            }
            println("uniform ${Integer.toHexString(color)}: ${r.detections.size} detections, " +
                "pre ${"%.1f".format(r.preprocessMs)} ms, infer ${"%.1f".format(r.inferenceMs)} ms (JVM CPU, not phone)")
        }
    }

    @Test
    fun rejectsWrongInputSizeAndClosedEngine() {
        val e = YoloOnnxEngine.fromFile(modelFile.takeIf { it.isFile } ?: run { assumeTrue(false); modelFile })
        assertThrows(IllegalArgumentException::class.java) { e.runRaw(FloatArray(10)) }
        e.close(); e.close() // повторное закрытие безопасно
        assertThrows(IllegalStateException::class.java) { e.detect(solid(10, 10, 0)) }
    }

    @Test
    fun missingModelFileIsReported() {
        assertThrows(ModelNotFoundException::class.java) { YoloOnnxEngine.fromFile(File("/nonexistent/model.onnx")) }
    }

    /** Тензор Kotlin-предобработки vs Python; сырой выход ORT JVM vs ORT Python на одном и том же входе. */
    @Test
    fun tensorsMatchPythonReference() {
        val e = requireEngine()
        val withTensors = cases().filter { it.inputTensor != null }
        assumeTrue("no tensor dumps", withTensors.isNotEmpty())
        for (c in withTensors) {
            val pyInput = readFloats(c.inputTensor!!)
            val (ktInput, _) = e.preprocessOnly(loadPpm(c.image), c.rotation)
            var maxIn = 0f; var nDiff = 0
            for (i in pyInput.indices) {
                val d = abs(pyInput[i] - ktInput[i]); if (d > 0f) nDiff++; maxIn = max(maxIn, d)
            }
            val pyOut = readFloats(c.outputTensor!!)
            val ktOut = e.runRaw(pyInput)
            var maxOut = 0f
            for (i in pyOut.indices) maxOut = max(maxOut, abs(pyOut[i] - ktOut[i]))
            println("PARITY_TENSOR ${c.id}: input max|d|=$maxIn (values differing: $nDiff/${pyInput.size}), " +
                "raw output (same input) max|d|=$maxOut")
            if (c.id.endsWith("_orig")) {
                assertArrayEquals("letterbox without resize must be bit-exact (${c.id})", pyInput, ktInput, 0f)
            } else {
                // cv2 считает билинейную интерполяцию в фиксированной точке: допускаем ±1 уровень яркости.
                assertTrue("resize differs by more than 1/255 (${c.id}): $maxIn", maxIn <= 1f / 255f + 1e-6f)
            }
            assertTrue("ORT JVM vs Python raw output differ (${c.id}): $maxOut", maxOut < 1e-3f)
        }
    }

    private fun isExact(c: Case) = c.id.endsWith("_orig") || c.id.endsWith("_rot90")

    /** Итоговые рамки Kotlin-конвейера vs Python-эталон на всех контрольных изображениях. */
    @Test
    fun detectionsMatchPythonReference() {
        val e = requireEngine()
        val all = cases()
        var refTotal = 0; var ktTotal = 0; var matched = 0
        // Отдельно: точные случаи (orig/rot90 — тот же тензор) и с масштабированием (up150 — ±1/255 во входе).
        var maxCoordExact = 0f; var maxScoreExact = 0f; var maxCoordResized = 0f; var maxScoreResized = 0f
        val report = StringBuilder()
        for (c in all) {
            val img = loadPpm(c.image)
            val r = e.detect(img, c.rotation)
            assertEquals(c.width, r.imageWidth); assertEquals(c.height, r.imageHeight)
            refTotal += c.dets.size; ktTotal += r.detections.size
            val used = BooleanArray(r.detections.size)
            var caseMatches = 0
            for ((box, score) in c.dets) {
                val j = r.detections.indices.filter { !used[it] }.maxByOrNull { r.detections[it].box.iou(box) }
                if (j != null && r.detections[j].box.iou(box) > 0.9f) {
                    used[j] = true; matched++; caseMatches++
                    val k = r.detections[j]
                    val dc = maxOf(abs(k.box.left - box.left), abs(k.box.top - box.top),
                        abs(k.box.right - box.right), abs(k.box.bottom - box.bottom))
                    val ds = abs(k.confidence - score)
                    if (isExact(c)) {
                        maxCoordExact = max(maxCoordExact, dc); maxScoreExact = max(maxScoreExact, ds)
                    } else {
                        maxCoordResized = max(maxCoordResized, dc); maxScoreResized = max(maxScoreResized, ds)
                        if (dc > 1f) println("  ${c.id}: ref=$box kotlin=${k.box} |d|=$dc px, score ${score} vs ${k.confidence}")
                    }
                }
            }
            report.append("${c.id}: ref=${c.dets.size} kotlin=${r.detections.size}\n")
            if (isExact(c)) {
                // Тот же тензор -> те же рамки (с точностью float32).
                assertEquals("detections count (${c.id})", c.dets.size, r.detections.size)
                assertEquals("matched detections (${c.id})", c.dets.size, caseMatches)
            }
        }
        println(report)
        println("PARITY_DETECTIONS cases=${all.size} ref_boxes=$refTotal kotlin_boxes=$ktTotal matched_iou_gt_0.9=$matched " +
            "exact: max|d|coord_px=$maxCoordExact max|d|score=$maxScoreExact; " +
            "resized: max|d|coord_px=$maxCoordResized max|d|score=$maxScoreResized")
        assertTrue("too few matches: $matched of $refTotal", matched >= refTotal - refTotal / 50) // >= 98 %
        assertTrue("exact-case coordinate mismatch $maxCoordExact px", maxCoordExact < 1e-2f)
        assertTrue("exact-case score mismatch $maxScoreExact", maxScoreExact < 1e-4f)
        // Масштабирование: вход отличается на ±1/255 (фиксированная точка cv2) -> малые сдвиги рамок.
        assertTrue("resized-case score mismatch $maxScoreResized", maxScoreResized < 0.02f)
    }
}
